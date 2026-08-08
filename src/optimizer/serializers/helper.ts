import { MaterializedNode } from '../../evidence/types.js';
import { RepresentationLevel } from '../budget-allocator.js';
import { EXTENSION_MAP } from '../../parse/lang-detect.js';

/**
 * Markdown fence tag for a file, so returned source syntax-highlights in the client.
 * Reuses the parser's extension table rather than duplicating it — anything creed can
 * parse, it can tag. `tsx`/`jsx` are mapped to their base language because that is what
 * markdown renderers actually recognise.
 */
export function fenceLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const lang = EXTENSION_MAP[ext];
  if (!lang) return '';
  if (lang === 'tsx') return 'typescript';
  if (lang === 'jsx') return 'javascript';
  return lang;
}

export function getDisplayName(node: any, fallbackId: string): string {
  if (!node) return fallbackId;
  return node.qualifiedName || node.name || fallbackId;
}

/**
 * Renders a suffix flagging how confidently an edge was resolved.
 * `global_fallback` is the resolver's last-resort, name-only match — it can
 * silently point at the wrong symbol, so it's called out distinctly from the
 * higher-confidence methods (import/scope/qualified_name).
 */
export function formatResolutionConfidence(resolutionMethod?: string): string {
  if (!resolutionMethod) return '';
  if (resolutionMethod === 'global_fallback') {
    return ' [⚠ low-confidence: name-only match]';
  }
  return ` [resolved-via: ${resolutionMethod}]`;
}

export function formatUnresolvedRefs(node: MaterializedNode): string {
  if (!node.unresolvedRefs || node.unresolvedRefs.length === 0) return '';
  // Reference rawNames can be whole multi-line method chains (e.g. a `fetch(...).then(...)`
  // block); collapse whitespace and truncate so one sprawling call doesn't dump 20 lines.
  const clean = (raw: string) => {
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    return oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine;
  };
  // De-dupe after cleaning (the chain often produces several near-identical prefixes).
  const uniq = Array.from(new Set(node.unresolvedRefs.map(r => clean(r.rawName))));
  const names = uniq.slice(0, 5).join(', ');
  const more = uniq.length > 5 ? ` (+${uniq.length - 5} more)` : '';
  return `  ⚠ ${uniq.length} unresolved reference(s) from here: ${names}${more}\n`;
}

/** `hasCoveringTests === false` means a test file was checked and none referenced this symbol. */
export function formatTestCoverage(node: MaterializedNode): string {
  if (node.hasCoveringTests === false) {
    return `  ⚠️ no covering tests found\n`;
  }
  return '';
}

/**
 * One-line rollup of how many edges/dependents are high- vs low-confidence, so a caller
 * can judge overall trust in a result before reading every individually-tagged line.
 */
export function formatConfidenceSummary(
  items: { resolutionMethod?: string }[],
  label: string
): string {
  if (items.length === 0) return '';
  const lowConfidence = items.filter(i => i.resolutionMethod === 'global_fallback').length;
  const highConfidence = items.length - lowConfidence;
  const parts = [`${items.length} ${label}`];
  const breakdown: string[] = [];
  if (highConfidence > 0) breakdown.push(`${highConfidence} high-confidence`);
  if (lowConfidence > 0) breakdown.push(`${lowConfidence} low-confidence (name-only match)`);
  if (breakdown.length > 0) parts.push(`— ${breakdown.join(', ')}`);
  return parts.join(' ') + '\n';
}

/** A contiguous run of source lines destined for one fenced block. */
interface SourceSpan {
  startLine: number;   // 1-indexed
  endLine: number;
  text: string;
}

/**
 * Renders the source section: verbatim, line-numbered code grouped by file.
 *
 * The line-number prefix is `<n>\t<text>`, matching what the `Read` tool returns, so a
 * caller can cite `file.ts:42` from what it was given instead of re-opening the file to
 * find out where anything lives. Fences are language-tagged for highlighting.
 *
 * Nodes allocated SNIPPET/FULL by the budget allocator contribute their real source
 * (already fetched and span-merged upstream by `QueryContextOptimizer.optimize`).
 * SIGNATURE-level nodes contribute only their declaration line — enough to know the
 * symbol exists and what it looks like, without spending budget on the body.
 */
export function serializeSourceSection(
  nodes: MaterializedNode[],
  levels: Map<string, RepresentationLevel>,
  excludeNodeIds: string[] = []
): string {
  const targetNodes = nodes.filter(n => {
    if (excludeNodeIds.includes(n.nodeId)) return false;
    if (!n.file) return false;
    return (levels.get(n.nodeId) || 'SIGNATURE') !== 'OMIT';
  });

  if (targetNodes.length === 0) return '';

  const fileGroups = new Map<string, MaterializedNode[]>();
  for (const node of targetNodes) {
    const list = fileGroups.get(node.file) || [];
    list.push(node);
    fileGroups.set(node.file, list);
  }

  let output = '**Source Code**\n\n';
  output +=
    '> The code below is the verbatim, current on-disk source of these symbols, ' +
    'line-numbered. Treat it as a Read you have already performed — no need to reopen ' +
    'these files.\n\n';

  for (const file of Array.from(fileGroups.keys()).sort()) {
    const fileNodes = fileGroups
      .get(file)!
      .sort((a, b) => (a.range?.startLine || 0) - (b.range?.startLine || 0));

    output += `**\`${file}\`** — ${summarizeSymbols(fileNodes)}\n\n`;

    const spans = collectSpans(fileNodes, levels);
    if (spans.length === 0) {
      output += '\n';
      continue;
    }

    output += '```' + fenceLanguage(file) + '\n';
    spans.forEach((span, i) => {
      // A break between non-adjacent spans is marked, so the reader knows lines were
      // skipped rather than assuming the block is contiguous.
      if (i > 0 && span.startLine > spans[i - 1].endLine + 1) {
        output += '\n... (gap) ...\n\n';
      }
      output += numberLines(span.text, span.startLine) + '\n';
    });
    output += '```\n\n';
  }

  return output.trimEnd();
}

/** "Name(kind), Name(kind), +N more" — what this file contributes, at a glance. */
function summarizeSymbols(nodes: MaterializedNode[]): string {
  const MAX = 5;
  const names = nodes.map(n => `${n.name || getDisplayName(n, n.nodeId)}(${n.kind})`);
  const shown = names.slice(0, MAX).join(', ');
  return names.length > MAX ? `${shown}, +${names.length - MAX} more` : shown;
}

/**
 * Turns each node into at most one span, de-duplicated and sorted. Nodes that
 * span-merged upstream share an identical range and must not print twice.
 */
function collectSpans(
  nodes: MaterializedNode[],
  levels: Map<string, RepresentationLevel>
): SourceSpan[] {
  const seen = new Set<string>();
  const spans: SourceSpan[] = [];

  for (const node of nodes) {
    const level = levels.get(node.nodeId) || 'SIGNATURE';
    let span: SourceSpan | null = null;

    if ((level === 'FULL' || level === 'SNIPPET') && node.source) {
      const text =
        level === 'SNIPPET' && node.source.text.length > 800
          ? node.source.text.slice(0, 800)
          : node.source.text;
      span = {
        startLine: node.source.startLine,
        endLine: node.source.startLine + text.split('\n').length - 1,
        text
      };
    } else if (node.signature && node.range) {
      // Declaration line only — keeps the symbol visible without spending budget.
      span = {
        startLine: node.range.startLine,
        endLine: node.range.startLine,
        text: node.signature
      };
    }

    if (!span) continue;
    const key = `${span.startLine}-${span.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push(span);
  }

  return spans.sort((a, b) => a.startLine - b.startLine);
}

/** Prefixes each line with its 1-indexed number and a tab, as the Read tool does. */
function numberLines(text: string, startLine: number): string {
  return text
    .split('\n')
    .map((line, i) => `${startLine + i}\t${line}`)
    .join('\n');
}
