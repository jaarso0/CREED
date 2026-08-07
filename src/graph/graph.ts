import {
  SymbolKind,
  ContainmentKind,
  ReferenceKind,
  ResolutionMethod,
  SemanticModel,
  Symbol,
  Containment,
  ResolvedReference
} from '../semantic-model/types.js';

export type KGEdgeKind = ContainmentKind | ReferenceKind;

export interface KGNode {
  id: string;                       // same as Symbol.id
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  properties: Record<string, unknown>;
}

export interface KGEdge {
  sourceId: string;
  targetId: string;
  kind: KGEdgeKind;
  resolutionMethod?: ResolutionMethod;  // only for reference edges
}

/**
 * The read surface every consumer actually uses — executor operations, retrievers,
 * the evidence materializer, the anchor resolver, the MCP controller.
 *
 * Extracted so a SQLite-backed graph (`SqliteKnowledgeGraph`) can be substituted for
 * the in-memory one without touching those call sites: they depend on this interface,
 * not on the Map-based implementation. Write methods (`addNode`, `addEdge`,
 * `markTestCovered`) stay off it — only `buildGraphFromModel` needs them.
 */
export interface ReadableGraph {
  getNode(id: string): KGNode | undefined;
  /**
   * Materializes every node. Unbounded by nature — fine for the visualizer and
   * stats, but avoid it on query paths; that is exactly the pattern the SQLite
   * backend exists to remove.
   */
  getAllNodes(): KGNode[];
  getEdgesFrom(id: string, kind?: KGEdgeKind): KGEdge[];
  getEdgesTo(id: string, kind?: KGEdgeKind): KGEdge[];
  getCallersOf(symbolId: string): KGNode[];
  getCalleesOf(symbolId: string): KGNode[];
  getMembersOf(classId: string): KGNode[];
  getInheritanceChain(classId: string): KGNode[];
  getImportsOf(fileOrSymbolId: string): KGNode[];
  findByName(name: string): KGNode[];
  findByQualifiedName(qname: string): KGNode[];
  /** Returns a bounded in-memory subgraph — safe to materialize regardless of backend. */
  getNeighborhood(symbolId: string, depth: number): KnowledgeGraph;
  getUnresolvedReferences(symbolId: string): { rawName: string; kind: string }[];
  isTestCovered(symbolId: string): boolean;
  stats(): { nodes: number; edges: number; byKind: Record<string, number> };
  getBuiltAt(): string | undefined;
}

export class KnowledgeGraph implements ReadableGraph {
  private nodes = new Map<string, KGNode>();
  private edgesFrom = new Map<string, KGEdge[]>();
  private edgesTo = new Map<string, KGEdge[]>();
  private allEdgesList: KGEdge[] = [];
  private unresolvedByFromSymbol = new Map<string, { rawName: string; kind: string }[]>();

  // The semantic model's createdAt, carried onto the graph so a running server can report
  // which build it is serving. Makes in-memory staleness (stale server vs fresh on-disk
  // index) visible in every tool response instead of requiring a forensic investigation.
  private builtAt: string | undefined;
  public setBuiltAt(iso: string | undefined): void { this.builtAt = iso; }
  public getBuiltAt(): string | undefined { return this.builtAt; }

  public addUnresolvedReference(fromSymbolId: string, rawName: string, kind: string): void {
    const list = this.unresolvedByFromSymbol.get(fromSymbolId) || [];
    list.push({ rawName, kind });
    this.unresolvedByFromSymbol.set(fromSymbolId, list);
  }

  public getUnresolvedReferences(symbolId: string): { rawName: string; kind: string }[] {
    return this.unresolvedByFromSymbol.get(symbolId) || [];
  }

  private testCoveredSymbolIds = new Set<string>();

  public markTestCovered(symbolId: string): void {
    this.testCoveredSymbolIds.add(symbolId);
  }

  /** True if any test file holds a resolved reference to this symbol. */
  public isTestCovered(symbolId: string): boolean {
    return this.testCoveredSymbolIds.has(symbolId);
  }

  public addNode(node: KGNode): void {
    this.nodes.set(node.id, node);
  }

  public addEdge(edge: KGEdge): void {
    this.allEdgesList.push(edge);

    const fromList = this.edgesFrom.get(edge.sourceId) || [];
    fromList.push(edge);
    this.edgesFrom.set(edge.sourceId, fromList);

    const toList = this.edgesTo.get(edge.targetId) || [];
    toList.push(edge);
    this.edgesTo.set(edge.targetId, toList);
  }

  public getNode(id: string): KGNode | undefined {
    return this.nodes.get(id);
  }

  public getAllNodes(): KGNode[] {
    return Array.from(this.nodes.values());
  }

  public getEdgesFrom(id: string, kind?: KGEdgeKind): KGEdge[] {
    const list = this.edgesFrom.get(id) || [];
    if (kind) {
      return list.filter(e => e.kind === kind);
    }
    return list;
  }

  public getEdgesTo(id: string, kind?: KGEdgeKind): KGEdge[] {
    const list = this.edgesTo.get(id) || [];
    if (kind) {
      return list.filter(e => e.kind === kind);
    }
    return list;
  }

  // ════════════════════════════════════════════
  // AGENT QUERIES
  // ════════════════════════════════════════════

  public getCallersOf(symbolId: string): KGNode[] {
    const edges = this.getEdgesTo(symbolId, 'call');
    return edges
      .map(e => this.getNode(e.sourceId))
      .filter((n): n is KGNode => n !== undefined);
  }

  public getCalleesOf(symbolId: string): KGNode[] {
    const edges = this.getEdgesFrom(symbolId, 'call');
    return edges
      .map(e => this.getNode(e.targetId))
      .filter((n): n is KGNode => n !== undefined);
  }

  public getMembersOf(classId: string): KGNode[] {
    const edges = this.getEdgesFrom(classId, 'has_member');
    return edges
      .map(e => this.getNode(e.targetId))
      .filter((n): n is KGNode => n !== undefined);
  }

  public getInheritanceChain(classId: string): KGNode[] {
    const chain: KGNode[] = [];
    let currentId = classId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const edges = this.getEdgesFrom(currentId, 'inherit');
      if (edges.length > 0) {
        const parentNode = this.getNode(edges[0].targetId);
        if (parentNode) {
          chain.push(parentNode);
          currentId = parentNode.id;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    return chain;
  }

  public getImportsOf(fileOrSymbolId: string): KGNode[] {
    const edges = this.getEdgesFrom(fileOrSymbolId, 'import');
    return edges
      .map(e => this.getNode(e.targetId))
      .filter((n): n is KGNode => n !== undefined);
  }

  public findByName(name: string): KGNode[] {
    return this.getAllNodes().filter(n => n.name === name);
  }

  public findByQualifiedName(qname: string): KGNode[] {
    return this.getAllNodes().filter(n => n.qualifiedName === qname);
  }

  // ════════════════════════════════════════════
  // SUBGRAPH NEIGHBORHOOD (FOR LLM AGENTS)
  // ════════════════════════════════════════════

  public getNeighborhood(symbolId: string, depth: number): KnowledgeGraph {
    const subGraph = new KnowledgeGraph();
    const visitedNodes = new Set<string>();
    const visitedEdges = new Set<string>();

    let currentLevel = [symbolId];
    visitedNodes.add(symbolId);

    const startNode = this.getNode(symbolId);
    if (startNode) {
      subGraph.addNode(startNode);
    }

    for (let d = 0; d < depth; d++) {
      if (currentLevel.length === 0) break;
      const nextLevel: string[] = [];

      for (const nodeId of currentLevel) {
        // Collect all edges from and to this node
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
            if (neighborNode) {
              subGraph.addNode(neighborNode);
            }
            nextLevel.push(neighborId);
          }
        }
      }
      currentLevel = nextLevel;
    }

    return subGraph;
  }

  // ════════════════════════════════════════════
  // STATS
  // ════════════════════════════════════════════

  public stats(): { nodes: number; edges: number; byKind: Record<string, number> } {
    const byKind: Record<string, number> = {};
    for (const edge of this.allEdgesList) {
      byKind[edge.kind] = (byKind[edge.kind] || 0) + 1;
    }
    return {
      nodes: this.nodes.size,
      edges: this.allEdgesList.length,
      byKind
    };
  }
}

// ════════════════════════════════════════════
// BUILDER FUNCTION
// ════════════════════════════════════════════

export function buildGraphFromModel(model: SemanticModel): KnowledgeGraph {
  const graph = new KnowledgeGraph();
  graph.setBuiltAt(model.createdAt);

  // 1. Add all symbols as KGNodes
  // Include project symbol
  graph.addNode(mapSymbolToNode(model.project));

  for (const sym of model.symbols) {
    if (sym.id !== model.project.id) {
      graph.addNode(mapSymbolToNode(sym));
    }
  }

  // 2. Add all containments as edges
  for (const containment of model.containments) {
    graph.addEdge({
      sourceId: containment.parentId,
      targetId: containment.childId,
      kind: containment.kind
    });
  }

  // 3. Add all resolved references as edges
  for (const ref of model.resolvedReferences) {
    graph.addEdge({
      sourceId: ref.fromSymbolId,
      targetId: ref.toSymbolId,
      kind: ref.kind,
      resolutionMethod: ref.resolutionMethod
    });
  }

  // 4. Index unresolved references by the symbol that made the reference, so
  // callers can see where the graph's picture near a symbol may be incomplete.
  for (const ref of model.unresolvedReferences) {
    graph.addUnresolvedReference(ref.fromSymbolId, ref.rawName, ref.kind);
  }

  // 5. Mark symbols as test-covered when a resolved reference to them originates
  // from a test file — cheap heuristic, but enough to flag "nothing exercises this."
  const filePathBySymbolId = new Map<string, string>();
  for (const sym of model.symbols) {
    filePathBySymbolId.set(sym.id, sym.filePath);
  }
  for (const ref of model.resolvedReferences) {
    const fromFile = filePathBySymbolId.get(ref.fromSymbolId);
    if (fromFile && isTestFile(fromFile)) {
      graph.markTestCovered(ref.toSymbolId);
    }
  }

  return graph;
}

/**
 * Exported so alternative graph backends classify test files with this exact
 * predicate rather than an approximation of it. An earlier SQLite implementation
 * expressed these rules as SQL `LIKE` patterns and silently diverged — `tests/x.ts`
 * matched there but not here, and `%.test.%` matched mid-path rather than only as a
 * suffix. Sharing the function makes that class of drift impossible.
 */
export function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    /\/tests?\//.test(normalized) ||
    /\.(test|spec)\.[a-z]+$/.test(normalized) ||
    /(^|\/)test_[^/]+\.py$/.test(normalized) ||
    /(^|\/)[^/]+_test\.py$/.test(normalized)
  );
}

function mapSymbolToNode(sym: Symbol): KGNode {
  return {
    id: sym.id,
    kind: sym.kind,
    name: sym.name,
    qualifiedName: sym.qualifiedName,
    filePath: sym.filePath,
    properties: {
      range: sym.range,
      exported: sym.exported,
      visibility: sym.visibility,
      ...sym.metadata
    }
  };
}
