/**
 * Resolution eval harness.
 *
 * Runs a fixed set of natural-language queries against the *already built* graph in
 * `.creed/graph.db` (no reindex) and reports, per query, which anchors resolved and
 * how many symbols came back. Use it to compare resolution behaviour before/after a
 * change to discovery / the anchor resolver.
 *
 *   npx tsx scratch/eval-resolve.ts
 *   npx tsx scratch/eval-resolve.ts "how does anchor resolution work"
 */
import * as path from 'path';
import { SqliteKnowledgeGraph } from '../src/graph/sqlite-graph.js';
import { SqliteSymbolIndex } from '../src/retrieval/sqlite-symbol-index.js';
import { RequestController } from '../src/mcp/controller.js';
import { compileExploreFlow } from '../src/mcp/compile.js';

/**
 * Queries this repository should be able to answer. Phrased the way someone actually asks —
 * English nouns and verbs that are never literally a symbol name, which is the case that
 * used to resolve to nothing.
 */
const QUERIES = [
  // natural-language "how does X work"
  'how does indexing work',
  'how does anchor resolution work',
  'how does the extraction pipeline work',
  'how are references resolved',
  'how does the file watcher work',
  'how does caching work',
  'where is the token budget enforced',
  'how does the visualizer get its data',
  'how does graph expansion work',
  'how is the context optimized before it is returned',
  // plain concept nouns whose morphology differs from the code's
  'ranking',
  'materialization',
  'discovery',
  'storage',
  // generic vocabulary that used to be filtered away entirely
  'config',
  'how does the request handler work',
  'what happens when a file changes',
  // typo / near-miss
  'anchor resolvr',
  'sqlit storage',
  // impact intent — should traverse callers
  'what breaks if I change processPlan',
  // exact symbols (control group — these must always work)
  'AnchorResolver',
  'CandidateDiscovery.discover',
];

/** Queries with no answer in this repo. Returning not_found for these is correct. */
const EXPECTED_MISSES = new Set(['how does crawling work', 'traversal']);

async function run() {
  const projectRoot = path.resolve('.');
  const argQuery = process.argv.slice(2).join(' ').trim();
  const queries = argQuery ? [argQuery] : [...QUERIES, ...EXPECTED_MISSES];

  const graph = new SqliteKnowledgeGraph(projectRoot);
  const index = new SqliteSymbolIndex(projectRoot);
  const controller = new RequestController(graph, projectRoot, index);

  // Resolution logs go to stderr; silence them so the table is readable.
  const realErr = console.error;
  console.error = () => {};

  let failures = 0;
  const rows: string[] = [];

  for (const q of queries) {
    const started = Date.now();
    let line: string;
    try {
      const result: any = await controller.processPlan(compileExploreFlow({ query: q }));
      const ms = Date.now() - started;
      if (result?.status === 'not_found') {
        const expected = EXPECTED_MISSES.has(q);
        if (!expected) failures++;
        line = `${expected ? 'miss' : 'FAIL'}  ${String(ms).padStart(5)}ms  "${q}"  -> not_found`;
      } else if (EXPECTED_MISSES.has(q)) {
        failures++;
        line = `FALSE ${String(ms).padStart(5)}ms  "${q}"  -> matched something it should not have`;
      } else {
        const text: string = result?.serializedContext ?? '';
        const symbols = Number(text.match(/Found (\d+) symbol/)?.[1] ?? 0);
        const anchors = [...text.matchAll(/`([^`]+)` \([a-z_]+ — /g)].map(m => m[1]);
        // Only the footer counts. Matching the whole document meant this repo's own source —
        // which contains the string "Low confidence" in controller.ts — scored itself weak
        // whenever that file happened to be materialized into the answer.
        const footer = text.split('\n---\n').slice(1).join('\n');
        const lowConf = /Low confidence/.test(footer);
        line =
          `${lowConf ? 'WEAK' : 'ok  '}  ${String(ms).padStart(5)}ms  "${q}"  -> ${String(symbols).padStart(3)} symbol(s)` +
          (anchors.length ? `  [${anchors.slice(0, 5).join(', ')}]` : '');
        if (lowConf) failures++;
      }
    } catch (err: any) {
      failures++;
      line = `ERR   "${q}" -> ${err.message || err}`;
    }
    rows.push(line);
  }

  console.error = realErr;
  console.log(rows.join('\n'));
  console.log(`\n${queries.length - failures}/${queries.length} resolved cleanly.`);

  graph.close();
  index.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
