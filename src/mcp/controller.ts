import { ReadableGraph } from '../graph/graph.js';
import { SymbolIndex } from '../retrieval/symbol-index.js';
import { GraphQueryPlan } from './types.js';
import { AnchorResolver } from '../resolution/anchor-resolver.js';
import { GraphExecutor } from '../executor/graph-executor.js';
import { EvidenceMaterializer } from '../evidence/materializer.js';
import { QueryContextOptimizer } from '../optimizer/query-context-optimizer.js';

export interface RequestPolicy {
  maxResolutionAttempts: number;
  timeoutMs: number;
  graph: {
    maxDepth: number;
    maxNodes: number;
    maxPaths: number;
    maxEdges: number;
    maxNodesPerFile: number;
  };
  context: {
    maxTokens: number;
  };
}

export const DEFAULT_POLICY: RequestPolicy = {
  maxResolutionAttempts: 2,
  timeoutMs: 5000,
  graph: {
    maxDepth: 6,
    maxNodes: 200,
    maxPaths: 20,
    // Proactive ceiling on edges surfaced from a region traversal, enforced in the
    // executor before materialization. Ranked by relevance, so a hub query keeps the
    // edges worth showing and never pays to materialize thousands it would discard.
    maxEdges: 120,
    // Per-file diversity cap: no single file may contribute more than this many transitive
    // (depth >= 2) nodes, so one sprawling file can't monopolize a broad query's budget.
    // Anchors and direct neighbors are exempt, so focused single-symbol exploration is unaffected.
    maxNodesPerFile: 30
  },
  context: {
    maxTokens: 12000
  }
};

export class RequestController {
  private graph: ReadableGraph;
  private projectRoot: string;
  private resolver: AnchorResolver;
  private executor: GraphExecutor;
  private materializer: EvidenceMaterializer;
  private optimizer: QueryContextOptimizer;

  /**
   * `index` threads a SQLite-backed symbol index through to the anchor resolver.
   * Without it the resolver builds an in-memory index, materializing every node
   * into Maps — which would defeat the point of a SQLite-backed graph.
   */
  constructor(graph: ReadableGraph, projectRoot: string, index?: SymbolIndex) {
    this.graph = graph;
    this.projectRoot = projectRoot;
    this.resolver = new AnchorResolver(graph, index);
    this.executor = new GraphExecutor(graph);
    this.materializer = new EvidenceMaterializer(graph, projectRoot);

    // Bind materializer's file line loader to the optimizer
    this.optimizer = new QueryContextOptimizer(
      async (filePath: string) => {
        // Access loadFileLines using internal method or expose it on materializer
        // Since we are in the same module ecosystem, we can cast/use a helper.
        // Let's call the loader on materializer.
        return (this.materializer as any).loadFileLines(filePath);
      }
    );
  }

  /**
   * Processes a GraphQueryPlan end-to-end.
   * If there is ambiguity or search failures, returns resolution result immediately.
   */
  public async processPlan(plan: GraphQueryPlan): Promise<any> {
    const startTime = Date.now();

    // 1. Anchor Resolution Phase
    // search_symbols wants the raw candidate list on ambiguity; traversal tools
    // (explore/trace/impact) auto-pick the best match and proceed, so a loose or
    // natural-language query resolves in a single call instead of forcing a
    // search-then-copy-nodeId round-trip.
    const isSearch = plan.operation === 'region' && plan.constraints?.searchMode === true;
    const tolerateMissing = plan.constraints?.tolerateMissingAnchors === true;
    const resolution = this.resolver.resolveAll(plan.anchors, { autoPick: !isSearch, tolerateMissing });

    if (resolution.status === 'not_found') {
      return {
        status: 'not_found',
        message: `Could not resolve anchor query: ${resolution.missingQueries.join(', ')}`,
        missingQueries: resolution.missingQueries
      };
    }

    if (resolution.status === 'ambiguous') {
      if (isSearch) {
        const candidates = resolution.ambiguousAnchors.flatMap(a => a.candidates);
        return {
          status: 'success',
          operation: 'search',
          candidates
        };
      }

      // Only reached when autoPick had candidates but none mapped to a live graph node.
      return {
        status: 'ambiguous',
        message: 'One or more anchor queries resolved to multiple candidates. Please refine your query.',
        ambiguousAnchors: resolution.ambiguousAnchors
      };
    }

    const disambiguations = resolution.disambiguations;

    // 2. Traversal Phase (Safe Graph Executor)
    // Dedup by node id — a multi-term query can resolve two terms to the same symbol
    // (e.g. "startServer" and "serve.ts"), which would otherwise list it twice as an anchor.
    const resolvedAnchors = [...new Set(resolution.anchors.map(a => a.nodeId))];
    const planWithResolved = { ...plan, resolvedAnchors };

    const structuralResult = this.executor.execute(planWithResolved, {
      maxDepth: DEFAULT_POLICY.graph.maxDepth,
      maxNodes: DEFAULT_POLICY.graph.maxNodes,
      maxPaths: DEFAULT_POLICY.graph.maxPaths,
      maxEdges: DEFAULT_POLICY.graph.maxEdges,
      maxNodesPerFile: DEFAULT_POLICY.graph.maxNodesPerFile
    });

    // 3. Evidence Materialization Phase (Batch File Reader & Slicer)
    // Clear materializer cache per-request for fresh file content
    this.materializer.clearCache();
    const evidence = await this.materializer.materialize(structuralResult, plan);

    // 4. Context Optimization & Serialization Phase
    const contextPackage = await this.optimizer.optimize(plan, structuralResult, evidence);

    // Flow synthesis (explore_flow): given several resolved anchors, surface the call/render
    // paths *connecting* them — "how do these symbols relate" — as a header, the way
    // codegraph shows "call path among the symbols you queried". Uses the same path executor.
    let flowText = '';
    if (plan.constraints?.synthesizeFlow) {
      const anchorIds = resolution.anchors.map(a => a.nodeId);
      // Blast radius first (prepended, so it ends up just above the source section).
      const blastRadius = this.synthesizeBlastRadius(anchorIds);
      if (blastRadius) {
        contextPackage.serializedContext = blastRadius + '\n\n' + contextPackage.serializedContext;
      }
      // Then the flow, prepended last so it sits at the very top — the "how do these connect".
      if (resolution.anchors.length > 1) {
        flowText = this.synthesizeFlow(anchorIds);
        if (flowText) {
          contextPackage.serializedContext = flowText + '\n\n' + contextPackage.serializedContext;
        }
      }
    }

    // Prepend a transparency note when a loose query was auto-resolved, so the caller
    // knows which symbol it landed on and how to redirect if it guessed wrong.
    if (disambiguations && disambiguations.length > 0) {
      const noteLines = disambiguations.map(d => {
        const alts = d.alternatives.length > 0
          ? ` — also matched: ${d.alternatives.map(a => a.qualifiedName || a.nodeId).join(', ')}. Pass an exact ID to pick another.`
          : '';
        return `- "${d.query}" → ${d.chosen.qualifiedName} [${d.chosen.nodeId}]${alts}`;
      });
      contextPackage.serializedContext =
        `Note: auto-resolved ambiguous anchor(s) to the best match:\n${noteLines.join('\n')}\n\n` +
        contextPackage.serializedContext;
    }

    // Low-confidence handoff, prepended LAST so it's the first thing the caller sees: if a
    // free-form query anchored on few of its terms, or the anchors it did resolve don't
    // connect, warn that the view may be incomplete — mirroring codegraph's confidence note.
    if (plan.constraints?.synthesizeFlow) {
      const requested = plan.anchors.length;
      const resolved = resolution.anchors.length;
      const weakCoverage = requested >= 2 && resolved / requested < 0.5;
      const noConnections = resolved >= 2 && flowText === '';
      const tooThin = requested >= 2 && resolved <= 1;
      if (weakCoverage || noConnections || tooThin) {
        const reasons: string[] = [];
        if (tooThin || weakCoverage) reasons.push(`only ${resolved} of ${requested} query terms resolved to symbols`);
        if (noConnections) reasons.push(`no call/render paths connect the resolved symbols`);
        contextPackage.serializedContext =
          `⚠ Low confidence: ${reasons.join('; ')}. This view may be incomplete — ` +
          `try naming specific symbols by exact name (or use search_symbols to find them first).\n\n` +
          contextPackage.serializedContext;
      }
    }

    const durationMs = Date.now() - startTime;
    console.error(`Request execution completed in ${durationMs}ms`);

    return {
      status: 'success',
      ...contextPackage
    };
  }

  /**
   * Finds directed call/render/instantiate paths connecting the queried anchors and renders
   * them as a compact "Flow" header. For each ordered pair it runs the path executor (both
   * directions) and keeps the shortest connection found, so the caller sees how the symbols
   * they named actually wire together — not just their individual neighborhoods.
   */
  private synthesizeFlow(anchorIds: string[]): string {
    const flowEdgeKinds = ['call', 'instantiate', 'renders'];
    const uniqueIds = [...new Set(anchorIds)];
    const paths: Array<{ nodes: string[]; edges: any[] }> = [];

    for (const from of uniqueIds) {
      for (const to of uniqueIds) {
        if (from === to) continue;
        const result = this.executor.execute(
          { operation: 'path', anchors: [], resolvedAnchors: [from, to], constraints: { edgeKinds: flowEdgeKinds } },
          { maxDepth: 4, maxNodes: DEFAULT_POLICY.graph.maxNodes, maxPaths: 1, maxEdges: DEFAULT_POLICY.graph.maxEdges }
        );
        if (result.kind === 'path' && result.paths.length > 0 && result.paths[0].nodes.length > 1) {
          paths.push(result.paths[0]);
        }
      }
    }

    // Keep only maximal paths — drop any that is a contiguous sub-sequence of a longer one.
    const isSubsequence = (short: string[], long: string[]): boolean => {
      if (short.length >= long.length) return false;
      for (let i = 0; i + short.length <= long.length; i++) {
        if (short.every((id, k) => id === long[i + k])) return true;
      }
      return false;
    };
    const maximal = paths.filter(p => !paths.some(q => isSubsequence(p.nodes, q.nodes)));

    // Render each maximal path as a numbered vertical chain with the edge verb between steps.
    const rendered = new Set<string>();
    const blocks: string[] = [];
    for (const p of maximal) {
      const key = p.nodes.join('>');
      if (rendered.has(key)) continue;
      rendered.add(key);

      let block = '';
      p.nodes.forEach((id, i) => {
        block += `  ${i + 1}. ${this.formatNodeRef(id)}\n`;
        if (i < p.nodes.length - 1) {
          const edge = p.edges[i];
          block += `       ↓ ${this.edgeVerb(edge?.kind)}\n`;
        }
      });
      blocks.push(block.trimEnd());
    }

    if (blocks.length === 0) return '';
    return `=== FLOW (call path among the queried symbols) ===\n${blocks.join('\n\n')}`;
  }

  /**
   * "Blast radius" — for each queried symbol, how many things reference it (and from which
   * files), plus whether any test exercises it. This is the "what breaks if I touch this"
   * summary codegraph surfaces up front, computed from the graph's incoming reference edges.
   */
  private synthesizeBlastRadius(anchorIds: string[]): string {
    const refKinds = new Set(['call', 'instantiate', 'renders', 'import', 'inherit', 'implement', 'type_use']);
    const testableKinds = new Set(['function', 'method', 'class', 'interface']);
    const lines: string[] = [];

    for (const id of [...new Set(anchorIds)]) {
      const node = this.graph.getNode(id);
      if (!node) continue;

      const incoming = this.graph.getEdgesTo(id).filter(e => refKinds.has(e.kind));
      const callerFiles = [...new Set(
        incoming.map(e => this.graph.getNode(e.sourceId)?.filePath).filter((f): f is string => !!f)
      )];

      const callerPart = incoming.length > 0
        ? `${incoming.length} caller(s) across ${callerFiles.slice(0, 3).join(', ')}${callerFiles.length > 3 ? ` (+${callerFiles.length - 3} more)` : ''}`
        : 'no callers found';
      const testNote = (testableKinds.has(node.kind) && !this.graph.isTestCovered(id))
        ? '; ⚠️ no covering tests found'
        : '';

      lines.push(`- ${this.formatNodeRef(id)} — ${callerPart}${testNote}`);
    }

    if (lines.length === 0) return '';
    return `=== BLAST RADIUS (what depends on the queried symbols) ===\n${lines.join('\n')}`;
  }

  /** "QualifiedName (path:line)" for a node id, matching the compact reference style. */
  private formatNodeRef(id: string): string {
    const n = this.graph.getNode(id);
    if (!n) return id;
    const range = n.properties?.range as { start?: { line: number } } | undefined;
    const line = range?.start ? range.start.line + 1 : undefined;
    const name = n.qualifiedName || n.name;
    return line !== undefined ? `${name} (${n.filePath}:${line})` : `${name} (${n.filePath})`;
  }

  private edgeVerb(kind?: string): string {
    switch (kind) {
      case 'call': return 'calls';
      case 'renders': return 'renders';
      case 'instantiate': return 'instantiates';
      case 'inherit': return 'extends';
      case 'implement': return 'implements';
      case 'import': return 'imports';
      default: return kind || 'relates to';
    }
  }
}
