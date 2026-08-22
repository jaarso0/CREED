import type { Database, Statement } from 'better-sqlite3';
import { openDatabase } from '../storage/sqlite/db.js';
import { rowToSymbol, SymbolRow } from '../storage/sqlite/row-mappers.js';
import {
  KnowledgeGraph,
  ReadableGraph,
  KGNode,
  KGEdge,
  KGEdgeKind,
  isTestFile
} from './graph.js';
import { SymbolKind } from '../semantic-model/types.js';

interface EdgeRow {
  source_id: string;
  target_id: string;
  kind: string;
  resolution_method: string | null;
}

/**
 * A `ReadableGraph` served directly from `.creed/graph.db`.
 *
 * The in-memory `KnowledgeGraph` holds every node and edge in four Maps, which is
 * what caps the size of codebase this can index — a 400k-symbol corpus costs
 * hundreds of MB of heap before any query runs. This backend keeps the graph on
 * disk and resolves each lookup through an index, so resident memory is bounded by
 * what a query actually touches rather than by the size of the repo.
 *
 * Edges are the union of two tables — `containments` (structural) and
 * `resolved_references` (call/import/inherit/...) — mirroring how
 * `buildGraphFromModel` composes them, so both backends yield identical edges.
 */
export class SqliteKnowledgeGraph implements ReadableGraph {
  private db: Database;
  private projectRoot: string;
  private builtAt: string | undefined;

  /**
   * Bounded node cache. BFS revisits the same nodes constantly (a hub symbol is a
   * neighbour of everything around it); without this, each visit re-parses a row.
   * Capped so it can't grow into the unbounded Map this class exists to avoid.
   */
  private nodeCache = new Map<string, KGNode | undefined>();
  private static readonly NODE_CACHE_LIMIT = 20000;

  private testCoveredIds: Set<string> | null = null;

  private stmts!: {
    nodeById: Statement;
    allNodes: Statement;
    edgesFrom: Statement;
    edgesFromKind: Statement;
    edgesTo: Statement;
    edgesToKind: Statement;
    byName: Statement;
    byQualifiedName: Statement;
    unresolvedFrom: Statement;
    nodeCount: Statement;
    edgeCounts: Statement;
    testCovered: Statement;
  };

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.db = openDatabase(projectRoot, { readonly: true });
    this.prepare();
    this.builtAt = this.readBuiltAt();
  }

  private prepare(): void {
    const SYMBOL_COLS = `
      id, kind, name, name_lower, qualified_name, qualified_name_lower,
      file_path, file_path_lower, start_line, start_col, end_line, end_col,
      exported, visibility, metadata, is_project
    `;

    // Containments and resolved references are unioned so callers see the single
    // edge list `buildGraphFromModel` would have produced in memory.
    const EDGES_FROM = `
      SELECT parent_id AS source_id, child_id AS target_id, kind, NULL AS resolution_method
        FROM containments WHERE parent_id = @id
      UNION ALL
      SELECT from_symbol_id AS source_id, to_symbol_id AS target_id, kind, resolution_method
        FROM resolved_references WHERE from_symbol_id = @id
    `;
    const EDGES_TO = `
      SELECT parent_id AS source_id, child_id AS target_id, kind, NULL AS resolution_method
        FROM containments WHERE child_id = @id
      UNION ALL
      SELECT from_symbol_id AS source_id, to_symbol_id AS target_id, kind, resolution_method
        FROM resolved_references WHERE to_symbol_id = @id
    `;

    this.stmts = {
      nodeById: this.db.prepare(`SELECT ${SYMBOL_COLS} FROM symbols WHERE id = ?`),
      allNodes: this.db.prepare(`SELECT ${SYMBOL_COLS} FROM symbols ORDER BY rowid`),
      edgesFrom: this.db.prepare(EDGES_FROM),
      edgesTo: this.db.prepare(EDGES_TO),
      // Kind is filtered in SQL rather than in JS so a narrow traversal
      // (e.g. edgeKinds: ['call']) reads only the rows it needs.
      edgesFromKind: this.db.prepare(`
        SELECT parent_id AS source_id, child_id AS target_id, kind, NULL AS resolution_method
          FROM containments WHERE parent_id = @id AND kind = @kind
        UNION ALL
        SELECT from_symbol_id AS source_id, to_symbol_id AS target_id, kind, resolution_method
          FROM resolved_references WHERE from_symbol_id = @id AND kind = @kind
      `),
      edgesToKind: this.db.prepare(`
        SELECT parent_id AS source_id, child_id AS target_id, kind, NULL AS resolution_method
          FROM containments WHERE child_id = @id AND kind = @kind
        UNION ALL
        SELECT from_symbol_id AS source_id, to_symbol_id AS target_id, kind, resolution_method
          FROM resolved_references WHERE to_symbol_id = @id AND kind = @kind
      `),
      byName: this.db.prepare(`SELECT ${SYMBOL_COLS} FROM symbols WHERE name = ?`),
      byQualifiedName: this.db.prepare(`SELECT ${SYMBOL_COLS} FROM symbols WHERE qualified_name = ?`),
      unresolvedFrom: this.db.prepare(
        `SELECT raw_name, kind FROM unresolved_references WHERE from_symbol_id = ?`
      ),
      nodeCount: this.db.prepare(`SELECT COUNT(*) AS n FROM symbols`),
      edgeCounts: this.db.prepare(`
        SELECT kind, COUNT(*) AS n FROM containments GROUP BY kind
        UNION ALL
        SELECT kind, COUNT(*) AS n FROM resolved_references GROUP BY kind
      `),
      // A symbol is test-covered when some resolved reference to it originates in a
      // test file. The SQL returns (target, source-file) pairs and `isTestFile` — the
      // very function the in-memory backend uses — decides. Encoding those rules as
      // LIKE patterns instead looked equivalent and was not.
      testCovered: this.db.prepare(`
        SELECT DISTINCT r.to_symbol_id AS id, s.file_path AS from_file
          FROM resolved_references r
          JOIN symbols s ON s.id = r.from_symbol_id
      `)
    };
  }

  private readBuiltAt(): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'created_at'`).get() as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /**
   * Re-reads the index after a rebuild wrote to the same file. Cheaper and less
   * error-prone than rebuilding a graph object, which is what the in-memory
   * backend forces the watcher to do.
   */
  public refresh(): void {
    this.close();
    this.db = openDatabase(this.projectRoot, { readonly: true });
    this.prepare();
    this.nodeCache.clear();
    this.testCoveredIds = null;
    this.builtAt = this.readBuiltAt();
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  public getBuiltAt(): string | undefined {
    return this.builtAt;
  }

  // ── nodes ─────────────────────────────────────────────────────────────────

  private toNode(row: SymbolRow): KGNode {
    const symbol = rowToSymbol(row);
    // Identical shape to mapSymbolToNode in graph.ts — metadata is spread last so
    // a symbol carrying its own `range`/`exported` key can't silently shadow the
    // structural values, matching the in-memory backend exactly.
    return {
      id: symbol.id,
      kind: symbol.kind as SymbolKind,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      filePath: symbol.filePath,
      properties: {
        range: symbol.range,
        exported: symbol.exported,
        visibility: symbol.visibility,
        ...symbol.metadata
      }
    };
  }

  private cacheNode(id: string, node: KGNode | undefined): KGNode | undefined {
    if (this.nodeCache.size >= SqliteKnowledgeGraph.NODE_CACHE_LIMIT) {
      // Simple generational eviction: clearing wholesale is cheaper than tracking
      // per-entry recency, and the working set of a single query fits comfortably.
      this.nodeCache.clear();
    }
    this.nodeCache.set(id, node);
    return node;
  }

  public getNode(id: string): KGNode | undefined {
    if (this.nodeCache.has(id)) return this.nodeCache.get(id);
    const row = this.stmts.nodeById.get(id) as SymbolRow | undefined;
    return this.cacheNode(id, row ? this.toNode(row) : undefined);
  }

  public getAllNodes(): KGNode[] {
    return (this.stmts.allNodes.all() as SymbolRow[]).map(r => this.toNode(r));
  }

  private nodesFor(ids: string[]): KGNode[] {
    const out: KGNode[] = [];
    for (const id of ids) {
      const node = this.getNode(id);
      if (node) out.push(node);
    }
    return out;
  }

  // ── edges ─────────────────────────────────────────────────────────────────

  private toEdge(row: EdgeRow): KGEdge {
    const edge: KGEdge = {
      sourceId: row.source_id,
      targetId: row.target_id,
      kind: row.kind as KGEdgeKind
    };
    if (row.resolution_method !== null) {
      edge.resolutionMethod = row.resolution_method as KGEdge['resolutionMethod'];
    }
    return edge;
  }

  public getEdgesFrom(id: string, kind?: KGEdgeKind): KGEdge[] {
    const rows = kind
      ? (this.stmts.edgesFromKind.all({ id, kind }) as EdgeRow[])
      : (this.stmts.edgesFrom.all({ id }) as EdgeRow[]);
    return rows.map(r => this.toEdge(r));
  }

  public getEdgesTo(id: string, kind?: KGEdgeKind): KGEdge[] {
    const rows = kind
      ? (this.stmts.edgesToKind.all({ id, kind }) as EdgeRow[])
      : (this.stmts.edgesTo.all({ id }) as EdgeRow[]);
    return rows.map(r => this.toEdge(r));
  }

  // ── derived queries ───────────────────────────────────────────────────────

  public getCallersOf(symbolId: string): KGNode[] {
    return this.nodesFor(this.getEdgesTo(symbolId, 'call').map(e => e.sourceId));
  }

  public getCalleesOf(symbolId: string): KGNode[] {
    return this.nodesFor(this.getEdgesFrom(symbolId, 'call').map(e => e.targetId));
  }

  public getMembersOf(classId: string): KGNode[] {
    return this.nodesFor(this.getEdgesFrom(classId, 'has_member').map(e => e.targetId));
  }

  public getImportsOf(fileOrSymbolId: string): KGNode[] {
    return this.nodesFor(this.getEdgesFrom(fileOrSymbolId, 'import').map(e => e.targetId));
  }

  public getInheritanceChain(classId: string): KGNode[] {
    const chain: KGNode[] = [];
    let currentId = classId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const edges = this.getEdgesFrom(currentId, 'inherit');
      if (edges.length === 0) break;
      const parent = this.getNode(edges[0].targetId);
      if (!parent) break;
      chain.push(parent);
      currentId = parent.id;
    }
    return chain;
  }

  public findByName(name: string): KGNode[] {
    return (this.stmts.byName.all(name) as SymbolRow[]).map(r => this.toNode(r));
  }

  public findByQualifiedName(qname: string): KGNode[] {
    return (this.stmts.byQualifiedName.all(qname) as SymbolRow[]).map(r => this.toNode(r));
  }

  public getUnresolvedReferences(symbolId: string): { rawName: string; kind: string }[] {
    const rows = this.stmts.unresolvedFrom.all(symbolId) as { raw_name: string; kind: string }[];
    return rows.map(r => ({ rawName: r.raw_name, kind: r.kind }));
  }

  public isTestCovered(symbolId: string): boolean {
    if (this.testCoveredIds === null) {
      const rows = this.stmts.testCovered.all() as { id: string; from_file: string }[];
      this.testCoveredIds = new Set(
        rows.filter(r => isTestFile(r.from_file)).map(r => r.id)
      );
    }
    return this.testCoveredIds.has(symbolId);
  }

  // ── traversal ─────────────────────────────────────────────────────────────

  /**
   * Same BFS as the in-memory backend, but each level's edges come from an indexed
   * query instead of a Map. The result is a bounded in-memory `KnowledgeGraph`, so
   * downstream consumers are unaffected by which backend produced it.
   */
  public getNeighborhood(symbolId: string, depth: number): KnowledgeGraph {
    const subGraph = new KnowledgeGraph();
    const visitedNodes = new Set<string>();
    const visitedEdges = new Set<string>();

    let currentLevel = [symbolId];
    visitedNodes.add(symbolId);

    const startNode = this.getNode(symbolId);
    if (startNode) subGraph.addNode(startNode);

    for (let d = 0; d < depth; d++) {
      if (currentLevel.length === 0) break;
      const nextLevel: string[] = [];

      for (const nodeId of currentLevel) {
        const edges = [...this.getEdgesFrom(nodeId), ...this.getEdgesTo(nodeId)];

        for (const edge of edges) {
          const edgeKey = `${edge.sourceId}->${edge.targetId}:${edge.kind}`;
          if (visitedEdges.has(edgeKey)) continue;
          visitedEdges.add(edgeKey);

          subGraph.addEdge(edge);

          const neighborId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
          if (!visitedNodes.has(neighborId)) {
            visitedNodes.add(neighborId);
            const neighborNode = this.getNode(neighborId);
            if (neighborNode) subGraph.addNode(neighborNode);
            nextLevel.push(neighborId);
          }
        }
      }
      currentLevel = nextLevel;
    }

    return subGraph;
  }

  // ── stats ─────────────────────────────────────────────────────────────────

  /** Aggregated in SQL; the in-memory backend walks its full edge array to do this. */
  public stats(): { nodes: number; edges: number; byKind: Record<string, number> } {
    const nodes = (this.stmts.nodeCount.get() as { n: number }).n;
    const rows = this.stmts.edgeCounts.all() as { kind: string; n: number }[];

    const byKind: Record<string, number> = {};
    let edges = 0;
    for (const row of rows) {
      byKind[row.kind] = (byKind[row.kind] || 0) + row.n;
      edges += row.n;
    }
    return { nodes, edges, byKind };
  }
}
