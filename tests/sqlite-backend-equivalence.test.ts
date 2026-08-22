import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Pipeline } from '../src/pipeline.js';
import { SqliteSemanticModelStorage } from '../src/storage/sqlite/sqlite-model-storage.js';
import { SqliteKnowledgeGraph } from '../src/graph/sqlite-graph.js';
import { SqliteSymbolIndex } from '../src/retrieval/sqlite-symbol-index.js';
import { RetrievalIndexes } from '../src/retrieval/indexes.js';
import { CandidateDiscovery } from '../src/retrieval/discovery.js';
import { AnchorResolver } from '../src/resolution/anchor-resolver.js';
import { KnowledgeGraph, KGNode, KGEdge } from '../src/graph/graph.js';
import { SemanticModel } from '../src/semantic-model/types.js';

/**
 * The SQLite backend is only safe to substitute if it answers every query exactly
 * as the in-memory one does. These tests run both against the same model and
 * compare — this is the guard for the whole Phase 2 swap.
 *
 * The project's own source is used as the corpus rather than a small fixture: it
 * has real inheritance, dynamic dispatch, tests, and unresolved references, which
 * a three-file fixture would not exercise.
 */

let model: SemanticModel;
let memGraph: KnowledgeGraph;
let sqlGraph: SqliteKnowledgeGraph;
let memIndex: RetrievalIndexes;
let sqlIndex: SqliteSymbolIndex;
let tempRoot: string;

const sortEdges = (edges: KGEdge[]) =>
  [...edges]
    .map(e => `${e.sourceId}|${e.targetId}|${e.kind}|${e.resolutionMethod ?? ''}`)
    .sort();

const sortIds = (nodes: KGNode[]) => nodes.map(n => n.id).sort();

beforeAll(async () => {
  const pipeline = new Pipeline();
  // The whole repo, not just src/: the corpus has to contain real test files or
  // isTestCovered is vacuously false in both backends and the comparison proves
  // nothing. (An earlier version of this test used src/ alone and did exactly that,
  // hiding a genuine divergence in the SQLite test-file predicate.)
  model = await pipeline.buildFull(path.resolve('.'));

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creed-equiv-'));
  await new SqliteSemanticModelStorage().save(model, tempRoot);

  memGraph = pipeline.deriveGraph(model);
  sqlGraph = new SqliteKnowledgeGraph(tempRoot);
  memIndex = new RetrievalIndexes(memGraph);
  sqlIndex = new SqliteSymbolIndex(tempRoot);
}, 120000);

afterAll(() => {
  sqlGraph?.close();
  sqlIndex?.close();
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('SqliteKnowledgeGraph matches KnowledgeGraph', () => {
  test('corpus is substantial enough for the comparison to mean something', () => {
    expect(model.symbols.length).toBeGreaterThan(300);
    expect(model.resolvedReferences.length).toBeGreaterThan(500);
  });

  test('stats agree exactly', () => {
    expect(sqlGraph.stats()).toEqual(memGraph.stats());
  });

  test('getAllNodes returns the same node set', () => {
    expect(sortIds(sqlGraph.getAllNodes())).toEqual(sortIds(memGraph.getAllNodes()));
  });

  test('getNode returns identical objects for every node', () => {
    for (const node of memGraph.getAllNodes()) {
      expect(sqlGraph.getNode(node.id), `node ${node.id}`).toEqual(node);
    }
  });

  test('getNode returns undefined for unknown ids in both', () => {
    expect(sqlGraph.getNode('does/not/exist.ts::Nope')).toBeUndefined();
    expect(memGraph.getNode('does/not/exist.ts::Nope')).toBeUndefined();
  });

  test('edges agree for every node, in both directions', () => {
    for (const node of memGraph.getAllNodes()) {
      expect(sortEdges(sqlGraph.getEdgesFrom(node.id)), `from ${node.id}`).toEqual(
        sortEdges(memGraph.getEdgesFrom(node.id))
      );
      expect(sortEdges(sqlGraph.getEdgesTo(node.id)), `to ${node.id}`).toEqual(
        sortEdges(memGraph.getEdgesTo(node.id))
      );
    }
  });

  test('kind-filtered edge queries agree', () => {
    const kinds = ['call', 'import', 'has_member', 'owns', 'inherit', 'type_use'] as const;
    for (const node of memGraph.getAllNodes()) {
      for (const kind of kinds) {
        expect(sortEdges(sqlGraph.getEdgesFrom(node.id, kind))).toEqual(
          sortEdges(memGraph.getEdgesFrom(node.id, kind))
        );
        expect(sortEdges(sqlGraph.getEdgesTo(node.id, kind))).toEqual(
          sortEdges(memGraph.getEdgesTo(node.id, kind))
        );
      }
    }
  });

  test('derived queries agree for every node', () => {
    for (const node of memGraph.getAllNodes()) {
      expect(sortIds(sqlGraph.getCallersOf(node.id)), `callers ${node.id}`).toEqual(
        sortIds(memGraph.getCallersOf(node.id))
      );
      expect(sortIds(sqlGraph.getCalleesOf(node.id))).toEqual(sortIds(memGraph.getCalleesOf(node.id)));
      expect(sortIds(sqlGraph.getMembersOf(node.id))).toEqual(sortIds(memGraph.getMembersOf(node.id)));
      expect(sortIds(sqlGraph.getImportsOf(node.id))).toEqual(sortIds(memGraph.getImportsOf(node.id)));
      expect(sortIds(sqlGraph.getInheritanceChain(node.id))).toEqual(
        sortIds(memGraph.getInheritanceChain(node.id))
      );
    }
  });

  test('unresolved references agree', () => {
    for (const node of memGraph.getAllNodes()) {
      const a = [...sqlGraph.getUnresolvedReferences(node.id)]
        .map(r => `${r.rawName}|${r.kind}`).sort();
      const b = [...memGraph.getUnresolvedReferences(node.id)]
        .map(r => `${r.rawName}|${r.kind}`).sort();
      expect(a, `unresolved for ${node.id}`).toEqual(b);
    }
  });

  test('test-coverage marking agrees', () => {
    const disagreements = memGraph
      .getAllNodes()
      .filter(n => sqlGraph.isTestCovered(n.id) !== memGraph.isTestCovered(n.id))
      .map(n => n.id);
    expect(disagreements).toEqual([]);
    // Guard against the trivial pass where nothing is marked covered in either.
    expect(memGraph.getAllNodes().some(n => memGraph.isTestCovered(n.id))).toBe(true);
  });

  test('neighborhood traversal agrees at several depths', () => {
    const anchors = memGraph
      .getAllNodes()
      .filter(n => n.kind === 'class' || n.kind === 'function' || n.kind === 'method')
      .slice(0, 25);
    expect(anchors.length).toBeGreaterThan(10);

    for (const anchor of anchors) {
      for (const depth of [1, 2, 3]) {
        const a = sqlGraph.getNeighborhood(anchor.id, depth);
        const b = memGraph.getNeighborhood(anchor.id, depth);
        expect(sortIds(a.getAllNodes()), `${anchor.id} @${depth}`).toEqual(sortIds(b.getAllNodes()));
        expect(a.stats().edges, `${anchor.id} @${depth} edges`).toBe(b.stats().edges);
      }
    }
  });

  test('findByName / findByQualifiedName agree', () => {
    for (const node of memGraph.getAllNodes().slice(0, 200)) {
      expect(sortIds(sqlGraph.findByName(node.name))).toEqual(sortIds(memGraph.findByName(node.name)));
      expect(sortIds(sqlGraph.findByQualifiedName(node.qualifiedName))).toEqual(
        sortIds(memGraph.findByQualifiedName(node.qualifiedName))
      );
    }
  });
});

describe('SqliteSymbolIndex matches RetrievalIndexes', () => {
  const TOKENS = [
    'storage', 'graph', 'discovery', 'resolve', 'index', 'sqlite', 'retrieval',
    'node', 'edge', 'pipeline', 'extract', 'zzznotfound', 'ab', 'q'
  ];

  test('exact name and qualified-name lookups agree', () => {
    for (const node of memGraph.getAllNodes()) {
      const n = node.name.toLowerCase();
      const q = node.qualifiedName.toLowerCase();
      expect(sortIds(sqlIndex.getByName(n)), `name ${n}`).toEqual(sortIds(memIndex.getByName(n)));
      expect(sortIds(sqlIndex.getByQualifiedName(q)), `qname ${q}`).toEqual(
        sortIds(memIndex.getByQualifiedName(q))
      );
    }
  });

  test('substring name matching agrees, including the exact/partial split', () => {
    for (const token of TOKENS) {
      const fmt = (ms: { node: KGNode; exact: boolean }[]) =>
        ms.map(m => `${m.node.id}|${m.exact}`).sort();
      expect(fmt(sqlIndex.matchByName(token)), `token "${token}"`).toEqual(
        fmt(memIndex.matchByName(token))
      );
      expect(fmt(sqlIndex.matchByQualifiedName(token)), `qname token "${token}"`).toEqual(
        fmt(memIndex.matchByQualifiedName(token))
      );
    }
  });

  test('short tokens below the trigram minimum still agree (LIKE fallback)', () => {
    for (const token of ['ab', 'q', 'io']) {
      const fmt = (ms: { node: KGNode; exact: boolean }[]) =>
        ms.map(m => `${m.node.id}|${m.exact}`).sort();
      expect(fmt(sqlIndex.matchByName(token)), `short token "${token}"`).toEqual(
        fmt(memIndex.matchByName(token))
      );
    }
  });

  test('file-path matching agrees', () => {
    for (const token of TOKENS) {
      const fmt = (ms: { node: KGNode; filePath: string }[]) =>
        ms.map(m => `${m.node.id}|${m.filePath}`).sort();
      expect(fmt(sqlIndex.matchByFilePath(token)), `path token "${token}"`).toEqual(
        fmt(memIndex.matchByFilePath(token))
      );
    }
  });

  test('name-prefix seeks agree, including the LIKE metacharacters identifiers contain', () => {
    // `_` is legal in identifiers and is also a LIKE wildcard, so an unescaped prefix would
    // silently match more on the SQLite side than the in-memory startsWith ever would.
    for (const prefix of ['re', 'sq', 'gr', 'zz', 'a_', 'x%', 'in']) {
      const ids = (nodes: KGNode[]) => nodes.map(n => n.id).sort();
      expect(ids(sqlIndex.namesStartingWith(prefix, 1000)), `prefix "${prefix}"`).toEqual(
        ids(memIndex.namesStartingWith(prefix, 1000))
      );
    }
  });

  test('name-prefix seeks honour the limit', () => {
    expect(sqlIndex.namesStartingWith('', 5).length).toBeLessThanOrEqual(5);
    expect(memIndex.namesStartingWith('', 5).length).toBeLessThanOrEqual(5);
  });

  test('incoming edges agree for every node', () => {
    for (const node of memGraph.getAllNodes()) {
      expect(sortEdges(sqlIndex.getIncomingEdges(node.id)), `incoming ${node.id}`).toEqual(
        sortEdges(memIndex.getIncomingEdges(node.id))
      );
    }
  });

  test('service lookups agree', () => {
    for (const name of memIndex.byService.keys()) {
      expect(sqlIndex.getService(name)?.id, `service ${name}`).toBe(memIndex.getService(name)?.id);
    }
    expect(sqlIndex.getService('NoSuchServiceXyz')).toBeUndefined();
  });

  test('tokens with FTS-significant punctuation do not break the query', () => {
    // Unquoted, these would be parsed as FTS5 operators rather than literal text.
    for (const token of ['graph.ts', 'src/retrieval', 'a"b', 'foo-bar', 'x_y']) {
      expect(() => sqlIndex.matchByName(token)).not.toThrow();
      const fmt = (ms: { node: KGNode; exact: boolean }[]) =>
        ms.map(m => `${m.node.id}|${m.exact}`).sort();
      expect(fmt(sqlIndex.matchByName(token)), `token "${token}"`).toEqual(
        fmt(memIndex.matchByName(token))
      );
    }
  });
});

describe('end-to-end ranking is unchanged', () => {
  const QUERIES = [
    'how does storage work',
    'discovery',
    'sqlite graph backend',
    'resolve anchor',
    'GET /api/model',
    'CandidateDiscovery',
    'retrieval indexes build',
    'pipeline buildFull'
  ];

  test('CandidateDiscovery returns identical ranked output for both indexes', () => {
    const memDiscovery = new CandidateDiscovery(memIndex);
    const sqlDiscovery = new CandidateDiscovery(sqlIndex);

    for (const query of QUERIES) {
      const a = memDiscovery.discover(query, 10);
      const b = sqlDiscovery.discover(query, 10);

      // Scores must match exactly — the scoring math was deliberately untouched,
      // so any drift means the two indexes disagree on what matched.
      expect(
        b.map(r => `${r.node.id}:${r.score.toFixed(6)}`),
        `query "${query}"`
      ).toEqual(a.map(r => `${r.node.id}:${r.score.toFixed(6)}`));
    }
  });

  test('AnchorResolver resolves identically through both backends', () => {
    const memResolver = new AnchorResolver(memGraph, memIndex);
    const sqlResolver = new AnchorResolver(sqlGraph, sqlIndex);

    for (const query of [...QUERIES, 'SqliteKnowledgeGraph', 'getEdgesFrom', 'nonexistentzz']) {
      const a = memResolver.resolveAnchor({ query });
      const b = sqlResolver.resolveAnchor({ query });
      expect(b.status, `query "${query}"`).toBe(a.status);
      if (a.status === 'resolved' && b.status === 'resolved') {
        expect(b.anchors.map(x => x.nodeId)).toEqual(a.anchors.map(x => x.nodeId));
      }
      if (a.status === 'ambiguous' && b.status === 'ambiguous') {
        expect(b.candidates.map(x => x.nodeId)).toEqual(a.candidates.map(x => x.nodeId));
      }
    }
  });
});
