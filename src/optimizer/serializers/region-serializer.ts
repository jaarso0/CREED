import { MaterializedEvidence } from '../../evidence/types.js';
import { RepresentationLevel } from '../budget-allocator.js';
import { getDisplayName, serializeSourceSection, formatResolutionConfidence, formatUnresolvedRefs, formatTestCoverage, formatConfidenceSummary } from './helper.js';

export function serializeRegion(
  evidence: MaterializedEvidence,
  roots: string[],
  levels: Map<string, RepresentationLevel>,
  omittedEdgeCount: number = 0
): string {
  const nodeMap = new Map(evidence.nodes.map(n => [n.nodeId, n]));

  let output = '**Anchors**\n\n';
  roots.forEach(rootId => {
    const node = nodeMap.get(rootId);
    if (node) {
      const displayName = getDisplayName(node, rootId);
      const line = node.range ? `:${node.range.startLine}` : '';
      output += `- \`${displayName}\` (${node.kind} — ${node.file}${line})\n`;
      if (node.signature) output += `  \`${node.signature}\`\n`;
      if (node.docs) output += `${node.docs.split('\n').map(l => '  > ' + l).join('\n')}\n`;
      output += `  [ID: ${node.nodeId}]\n`;
      output += formatUnresolvedRefs(node);
      output += formatTestCoverage(node);
    } else {
      output += `- [Unresolved Anchor ID: ${rootId}]\n`;
    }
  });
  output += '\n';

  // 2. Incoming and Outgoing Edges summary (Deduplicated)
  // Only reference edges (call/import/inherit/etc.) carry a resolutionMethod — structural
  // containment edges (has_member/owns) aren't "resolved" in the same sense, so they're
  // excluded from the confidence rollup to avoid inflating the high-confidence count.
  const referenceEdges = evidence.edges.filter(e => e.resolutionMethod !== undefined);
  output += '**Relationships**\n\n';

  // Edges arrive already proactively capped and relevance-ranked by the executor
  // (see executeRegion's edgeLimit) — so a hub query never materializes thousands of
  // edges just to discard them here. This is a final display cap on top of that.
  const MAX_RELATIONSHIP_LINES = 60;
  const rootSet = new Set(roots);
  const printedEdges = new Set<string>();
  const dedupedEdges: typeof evidence.edges = [];
  evidence.edges.forEach(edge => {
    const edgeKey = `${edge.source}->${edge.target}:${edge.kind}:${edge.callsite?.line || ''}`;
    if (printedEdges.has(edgeKey)) return;
    printedEdges.add(edgeKey);
    dedupedEdges.push(edge);
  });

  dedupedEdges.sort((a, b) => {
    const aTouchesRoot = rootSet.has(a.source) || rootSet.has(a.target) ? 0 : 1;
    const bTouchesRoot = rootSet.has(b.source) || rootSet.has(b.target) ? 0 : 1;
    return aTouchesRoot - bTouchesRoot;
  });

  const shown = dedupedEdges.slice(0, MAX_RELATIONSHIP_LINES);
  shown.forEach(edge => {
    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    const srcName = getDisplayName(src, edge.source);
    const tgtName = getDisplayName(tgt, edge.target);

    output += `- \`${srcName}\` --[${edge.kind}]--> \`${tgtName}\`${formatResolutionConfidence(edge.resolutionMethod)}\n`;
    if (edge.callsite) {
      output += `  ${edge.callsite.file}:${edge.callsite.line} → \`${edge.callsite.snippet}\`\n`;
    }
  });
  const totalOmitted = Math.max(0, dedupedEdges.length - shown.length) + omittedEdgeCount;
  if (totalOmitted > 0) {
    output += `- … ${totalOmitted} more edge(s) not shown (relevance-capped). Narrow with edgeKinds, direction, or a smaller depth.\n`;
  }
  output += '\n';

  const confidence = formatConfidenceSummary(referenceEdges, 'reference edge(s) in this neighborhood');
  if (confidence) output += confidence + '\n';

  // 3. Verbatim, line-numbered source grouped by file
  const spansOutput = serializeSourceSection(evidence.nodes, levels);
  if (spansOutput) {
    output += spansOutput;
  }

  return output.trim();
}
