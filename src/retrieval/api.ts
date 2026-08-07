import { ReadableGraph, KGNode } from '../graph/graph.js';
import { Symbol } from '../semantic-model/types.js';
import { RetrievalIndexes } from './indexes.js';
import { SymbolIndex } from './symbol-index.js';
import { CandidateDiscovery } from './discovery.js';
import { RetrievalPlanner } from './planner.js';
import { ContextBuilder } from './context-builder.js';
import { LocateRetriever } from './retrievers/locate.js';
import { FlowRetriever } from './retrievers/flow.js';
import { ImpactRetriever } from './retrievers/impact.js';
import { ContextPackage, RetrievalStrategy } from './types.js';

export class RetrievalEngine {
  private graph: ReadableGraph;
  private indexes: SymbolIndex;
  private discovery: CandidateDiscovery;
  private planner: RetrievalPlanner;
  private builder: ContextBuilder;
  private projectRoot: string;

  /**
   * Pass `index` (e.g. a `SqliteSymbolIndex`) to look symbols up through the
   * database. Omitting it builds the in-memory index, which requires the whole
   * graph to be resident.
   */
  constructor(graph: ReadableGraph, projectRoot: string, index?: SymbolIndex) {
    this.graph = graph;
    this.projectRoot = projectRoot;
    this.indexes = index ?? new RetrievalIndexes(graph);
    this.discovery = new CandidateDiscovery(this.indexes);
    this.planner = new RetrievalPlanner();
    this.builder = new ContextBuilder(projectRoot);
  }

  /**
   * Retrieves optimized context package for a given user prompt/task.
   */
  public async retrieveContext(taskQuery: string, options?: { strategy?: RetrievalStrategy }): Promise<ContextPackage> {
    // 1. Determine retrieval strategy
    const strategy = options?.strategy || this.planner.plan(taskQuery);

    // 2. Discover graph entry points
    const candidates = this.discovery.discover(taskQuery).map(c => c.node);

    if (candidates.length === 0) {
      return {
        task: taskQuery,
        strategy,
        relevantSymbols: [],
        relevantFiles: [],
        executionFlows: [],
        codeSnippets: [],
        dependencies: []
      };
    }

    // 3. Run selected retriever
    let retrievedGraph: { nodes: KGNode[]; edges: any[] };

    switch (strategy) {
      case 'locate':
        retrievedGraph = new LocateRetriever(this.indexes, this.graph).retrieve(candidates, taskQuery);
        break;
      case 'flow':
        retrievedGraph = new FlowRetriever(this.indexes, this.graph).retrieve(candidates, taskQuery);
        break;
      case 'impact':
        retrievedGraph = new ImpactRetriever(this.indexes, this.graph).retrieve(candidates, taskQuery);
        break;
    }

    // 4. Construct LLM-ready ContextPackage
    return this.builder.build(taskQuery, strategy, retrievedGraph.nodes, retrievedGraph.edges);
  }

  /**
   * Incremental updates to index when pipeline processes a single file change.
   * In-memory index only — with a SQLite-backed index the source of truth is the
   * database, which a pipeline rebuild rewrites wholesale.
   */
  public updateFile(filePath: string, newSymbols: Symbol[], allResolvedReferences: any[], isDeletion: boolean = false): void {
    this.requireInMemoryIndexes('updateFile').updateFile(
      filePath,
      newSymbols,
      allResolvedReferences,
      isDeletion
    );
  }

  /**
   * Expose internal components for advanced customization / inspectability.
   */
  public getIndexes(): RetrievalIndexes {
    return this.requireInMemoryIndexes('getIndexes');
  }

  /** The generic lookup surface, valid for either backend. */
  public getSymbolIndex(): SymbolIndex {
    return this.indexes;
  }

  private requireInMemoryIndexes(method: string): RetrievalIndexes {
    if (!(this.indexes instanceof RetrievalIndexes)) {
      throw new Error(
        `${method}() exposes the in-memory index Maps, but this engine was constructed ` +
        `with an injected SymbolIndex (e.g. SQLite-backed). Use getSymbolIndex() instead.`
      );
    }
    return this.indexes;
  }

  public getDiscovery(): CandidateDiscovery {
    return this.discovery;
  }

  public getPlanner(): RetrievalPlanner {
    return this.planner;
  }
}
