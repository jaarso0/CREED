/**
 * Benchmark: what one `explore` call costs, AND whether it actually contains the answer.
 *
 *   npx tsx scratch/bench.ts
 *
 * ── Why there are two tables ──────────────────────────────────────────────────
 *
 * An earlier version of this benchmark reported tokens only. That is not a result:
 * a cheap answer that omits the caller you needed is worse than an expensive one that
 * doesn't, and comparing token counts across strategies that return *different amounts
 * of the answer* compares two different tasks. So cost is only reported alongside
 * recall wherever recall can be defined at all.
 *
 * GROUND TRUTH comes from the TypeScript compiler's own symbol resolution — a separate
 * implementation from Creed's graph, so Creed is not being graded by itself. For a given
 * symbol it yields every identifier that semantically resolves to it (following imports
 * and aliases), minus the declaration. That is exactly the set "what breaks if I change
 * this" has to surface.
 *
 * RECALL is then measured identically for every strategy: a reference counts as surfaced
 * if the strategy's output text cites its `file:line`, or contains the opening of that
 * source line. grep output counts — if the agent saw the matching line in the grep
 * results, it saw the call site, whether or not it went on to read the file.
 *
 * Table 2 (concept questions) reports cost WITHOUT recall, and makes no claim of a win,
 * because "how does caching work" has no ground-truth answer set to score against.
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import ts from 'typescript';
import { encode } from 'gpt-tokenizer';
import Database from 'better-sqlite3';
import { SqliteKnowledgeGraph } from '../src/graph/sqlite-graph.js';
import { SqliteSymbolIndex } from '../src/retrieval/sqlite-symbol-index.js';
import { RequestController } from '../src/mcp/controller.js';
import { compileExplore } from '../src/mcp/compile.js';

const tokens = (s: string) => encode(s).length;
const TRIAGE_LIMIT = 5;
/** Lines shorter than this are too generic to match on without false positives. */
const MIN_TESTABLE_LINE = 12;

/**
 * These benchmark scripts live inside the repository they benchmark, so they show up as
 * callers of the very symbols under test and consume slots in the answer. Excluded from
 * both the ground truth and the grep corpus, so neither side is scored on the measuring
 * apparatus.
 */
const EXCLUDED = /^scratch\//;

// ── Ground truth via the TypeScript compiler ─────────────────────────────────

interface Reference {
  file: string;
  line: number;
  text: string;
}

function buildOracle(projectRoot: string) {
  const cfgPath = path.join(projectRoot, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, projectRoot);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter(f => !f.isDeclarationFile);
  const rel = (f: string) => path.relative(projectRoot, f).replace(/[\\]/g, '/');

  /** Every reference to `name` that the compiler resolves to its declaration, minus the declaration. */
  return function referencesTo(name: string): Reference[] {
    let target: ts.Symbol | undefined;
    let declPos: string | undefined;

    for (const sf of sources) {
      const visit = (n: ts.Node): void => {
        const named =
          (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n)) &&
          n.name !== undefined &&
          ts.isIdentifier(n.name) &&
          n.name.text === name;
        if (named) {
          const id = (n as ts.FunctionDeclaration).name as ts.Identifier;
          const sym = checker.getSymbolAtLocation(id);
          if (sym && !target) {
            target = sym;
            declPos = rel(sf.fileName) + ':' + (sf.getLineAndCharacterOfPosition(id.getStart()).line + 1);
          }
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(sf, visit);
    }
    if (!target) throw new Error(`oracle: no declaration found for "${name}"`);

    const refs: Reference[] = [];
    for (const sf of sources) {
      const file = rel(sf.fileName);
      const lines = sf.getFullText().split(/\r?\n/);
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && n.text === name) {
          let sym = checker.getSymbolAtLocation(n);
          if (sym && (sym.flags & ts.SymbolFlags.Alias) !== 0) {
            try { sym = checker.getAliasedSymbol(sym); } catch { /* not an alias */ }
          }
          if (sym === target && !EXCLUDED.test(file)) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
            const pos = file + ':' + line;
            if (pos !== declPos) refs.push({ file, line, text: (lines[line - 1] ?? '').trim() });
          }
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(sf, visit);
    }
    return refs;
  };
}

/**
 * Did this strategy's output actually put the reference in front of the agent?
 * Same rule for every strategy: an explicit `file:line` citation, or the opening of
 * the source line appearing in the text (a prefix, so Creed's `…` truncation of long
 * call-site lines still counts as surfaced).
 */
function surfaced(output: string, ref: Reference): boolean {
  if (output.includes(`${ref.file}:${ref.line}`)) return true;
  const prefix = ref.text.slice(0, Math.min(40, ref.text.length));
  return prefix.length >= MIN_TESTABLE_LINE && output.includes(prefix);
}

/**
 * Weaker but arguably more useful question than "is this exact line here": did the output
 * name the file at all, so the agent knows to go look at it?
 *
 * Both numbers are reported because they answer different things. Twelve call sites inside
 * one test file is twelve misses at site level but one file to open — and an answer that
 * says "tests/mcp.test.ts depends on this" has told you what breaks, even if it did not
 * reproduce every line. An answer that never mentions the file has not.
 */
function fileNamed(output: string, ref: Reference): boolean {
  return output.includes(ref.file);
}

// ── Corpus & the grep→read baseline ──────────────────────────────────────────

function indexedFiles(projectRoot: string): string[] {
  const db = new Database(path.join(projectRoot, '.creed', 'graph.db'), { readonly: true });
  const rows = db
    .prepare(`SELECT DISTINCT file_path FROM symbols WHERE file_path <> '' ORDER BY file_path`)
    .all() as { file_path: string }[];
  db.close();
  return rows.map(r => r.file_path).filter(f => !EXCLUDED.test(f));
}

interface Baseline {
  grepText: string;
  allText: string;
  triagedText: string;
  matchedFiles: number;
  matchLines: number;
}

async function baseline(projectRoot: string, files: string[], pattern: RegExp): Promise<Baseline> {
  const grepLines: string[] = [];
  const hits = new Map<string, number>();
  const contents = new Map<string, string>();

  for (const rel of files) {
    let src: string;
    try {
      src = await fs.readFile(path.join(projectRoot, rel), 'utf-8');
    } catch {
      continue;
    }
    const lines = src.split(/\r?\n/);
    let matchedHere = false;
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        grepLines.push(`${rel}:${i + 1}:${lines[i]}`);
        hits.set(rel, (hits.get(rel) ?? 0) + 1);
        matchedHere = true;
      }
    }
    if (matchedHere) contents.set(rel, src);
  }

  const grepText = grepLines.join('\n');
  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);

  const join = (fileList: string[]) =>
    grepText + '\n' + fileList.map(f => contents.get(f) ?? '').join('\n');

  return {
    grepText,
    allText: join(ranked),
    triagedText: join(ranked.slice(0, TRIAGE_LIMIT)),
    matchedFiles: hits.size,
    matchLines: grepLines.length
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────────

/** Questions with an objectively checkable answer set. */
const SCORED = [
  { question: 'what breaks if I change hashSource', symbol: 'hashSource' },
  { question: 'what breaks if I change processPlan', symbol: 'processPlan' },
  { question: 'who calls allocateBudget', symbol: 'allocateBudget' },
  { question: 'what breaks if I change estimateTokens', symbol: 'estimateTokens' },
  { question: 'what depends on stemToken', symbol: 'stemToken' },
  { question: 'who calls discover', symbol: 'discover' }
];

/** Questions with no ground truth. Cost only — no claim of correctness either way. */
const UNSCORED = [
  { question: 'how does caching work', pattern: /cache/i, label: 'cache' },
  { question: 'how does the extraction pipeline work', pattern: /extract/i, label: 'extract' },
  { question: 'how is the graph built', pattern: /graph/i, label: 'graph' },
  { question: 'how are symbols stored', pattern: /symbol/i, label: 'symbol' }
];

async function run() {
  const projectRoot = path.resolve('.');
  const files = indexedFiles(projectRoot);
  const referencesTo = buildOracle(projectRoot);

  const graph = new SqliteKnowledgeGraph(projectRoot);
  const index = new SqliteSymbolIndex(projectRoot);
  const controller = new RequestController(graph, projectRoot, index);
  const realErr = console.error;
  console.error = () => {};

  const pad = (s: string | number, n: number) => String(s).padStart(n);
  const padR = (s: string, n: number) => s.padEnd(n);
  const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);

  // ── Table 1: cost AND recall ───────────────────────────────────────────────
  console.log(`Corpus: ${files.length} indexed files. Tokenizer: gpt-tokenizer (cl100k).`);
  console.log(`Ground truth: TypeScript compiler symbol resolution (independent of Creed's graph).\n`);
  console.log(`TABLE 1 — questions with a checkable answer set`);
  console.log(`  site  = the exact reference line is in the output`);
  console.log(`  file  = the file containing it is named, so the agent knows where to look\n`);
  console.log(
    padR('question', 34) + pad('refs', 5) +
    pad('creed', 7) + pad('site', 6) + pad('file', 6) +
    pad('g+r(all)', 10) + pad('site', 6) +
    pad(`g+r(top${TRIAGE_LIMIT})`, 11) + pad('site', 6) + pad('file', 6)
  );
  console.log('─'.repeat(98));

  const missedSite: string[] = [];
  const missedFile: string[] = [];
  let tCreed = 0, tAll = 0, tTri = 0;
  let sCreed = 0, sAll = 0, sTri = 0, fCreed = 0, fTri = 0, rTotal = 0;

  for (const s of SCORED) {
    const refs = referencesTo(s.symbol).filter(r => r.text.length >= MIN_TESTABLE_LINE);
    const result: any = await controller.processPlan(compileExplore({ query: s.question }));
    const creedText: string = result?.serializedContext ?? '';
    const b = await baseline(projectRoot, files, new RegExp(s.symbol));

    const siteC = refs.filter(r => surfaced(creedText, r)).length;
    const siteA = refs.filter(r => surfaced(b.allText, r)).length;
    const siteT = refs.filter(r => surfaced(b.triagedText, r)).length;
    const fileC = refs.filter(r => fileNamed(creedText, r)).length;
    const fileT = refs.filter(r => fileNamed(b.triagedText, r)).length;

    for (const r of refs) {
      if (!surfaced(creedText, r)) missedSite.push(`${s.symbol.padEnd(16)} ${r.file}:${r.line}`);
      if (!fileNamed(creedText, r)) missedFile.push(`${s.symbol.padEnd(16)} ${r.file}:${r.line}`);
    }

    const cCreed = tokens(creedText);
    const cAll = tokens(b.allText);
    const cTri = tokens(b.triagedText);
    tCreed += cCreed; tAll += cAll; tTri += cTri;
    sCreed += siteC; sAll += siteA; sTri += siteT;
    fCreed += fileC; fTri += fileT; rTotal += refs.length;

    console.log(
      padR(s.question.slice(0, 33), 34) + pad(refs.length, 5) +
      pad(cCreed, 7) + pad(pct(siteC, refs.length), 6) + pad(pct(fileC, refs.length), 6) +
      pad(cAll, 10) + pad(pct(siteA, refs.length), 6) +
      pad(cTri, 11) + pad(pct(siteT, refs.length), 6) + pad(pct(fileT, refs.length), 6)
    );
  }

  console.log('─'.repeat(98));
  console.log(
    padR('TOTAL', 34) + pad(rTotal, 5) +
    pad(tCreed, 7) + pad(pct(sCreed, rTotal), 6) + pad(pct(fCreed, rTotal), 6) +
    pad(tAll, 10) + pad(pct(sAll, rTotal), 6) +
    pad(tTri, 11) + pad(pct(sTri, rTotal), 6) + pad(pct(fTri, rTotal), 6)
  );

  console.log(`\nCost per reference actually surfaced — cost alone is not a result:`);
  const perRef = (c: number, r: number) => (r === 0 ? '—' : Math.round(c / r).toLocaleString());
  console.log(`  creed           site ${perRef(tCreed, sCreed).padStart(7)} tok/ref   file ${perRef(tCreed, fCreed).padStart(7)} tok/ref`);
  console.log(`  grep+read(all)  site ${perRef(tAll, sAll).padStart(7)} tok/ref`);
  console.log(`  grep+read(top${TRIAGE_LIMIT}) site ${perRef(tTri, sTri).padStart(7)} tok/ref   file ${perRef(tTri, fTri).padStart(7)} tok/ref`);

  if (missedFile.length > 0) {
    console.log(`\n⚠ References whose FILE Creed never named (${missedFile.length}/${rTotal}) — genuine misses:`);
    for (const m of missedFile) console.log(`    ${m}`);
  } else {
    console.log(`\nCreed named the containing file for all ${rTotal} references.`);
  }
  console.log(`\n  (site-level misses: ${missedSite.length}/${rTotal} — mostly extra call sites inside a file Creed did name)`);

  // ── Table 2: cost only, no correctness claim ───────────────────────────────
  console.log(`\n\nTABLE 2 — concept questions. Cost only: there is no ground-truth answer`);
  console.log(`set for "how does caching work", so NO correctness claim is made here.\n`);
  console.log(padR('question', 38) + pad('creed', 8) + pad('g+r(all)', 11) + pad(`g+r(top${TRIAGE_LIMIT})`, 12) + '   grep matched');
  console.log('─'.repeat(92));

  for (const s of UNSCORED) {
    const result: any = await controller.processPlan(compileExplore({ query: s.question }));
    const b = await baseline(projectRoot, files, s.pattern);
    console.log(
      padR(s.question.slice(0, 37), 38) +
      pad(tokens(result?.serializedContext ?? ''), 8) +
      pad(tokens(b.allText), 11) + pad(tokens(b.triagedText), 12) +
      `   ${b.matchLines} lines / ${b.matchedFiles} files`
    );
  }

  console.error = realErr;
  graph.close();
  index.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
