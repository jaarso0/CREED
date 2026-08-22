import { SymbolKind } from '../semantic-model/types.js';

export type Operation = 'region' | 'path' | 'impact';

export interface AnchorSpec {
  query: string;
  kind?: SymbolKind;
  resolution?: 'exact' | 'search' | 'auto';
}

export interface GraphQueryPlan {
  operation: Operation;
  anchors: AnchorSpec[];
  constraints?: {
    direction?: 'incoming' | 'outgoing' | 'both';
    edgeKinds?: string[];
    requestedDepth?: number;
    requestedNodes?: number;
    requestedPaths?: number;
    /**
     * Marks this plan as originating from `search_symbols`. On an ambiguous anchor,
     * the controller returns a flat candidate list instead of the "ambiguous" error
     * shape, regardless of requestedDepth — search returning multiple matches isn't
     * an error, it's the expected result of a broad query. Decoupled from
     * requestedDepth so search_symbols can still request a real neighborhood depth
     * for the single-match case without losing its distinct ambiguous-result shape.
     */
    searchMode?: boolean;
    /**
     * Multi-anchor "flow" mode (explore_flow): resolve a bag of terms to several anchors,
     * traverse from all of them at once, and synthesize the connecting paths among them.
     * Terms that don't resolve are dropped instead of failing the whole query.
     */
    tolerateMissingAnchors?: boolean;
    synthesizeFlow?: boolean;
    /**
     * The caller's original, unsplit question. Its presence switches anchor resolution to
     * the whole-query path (`AnchorResolver.resolveFreeForm`), where ranking can see every
     * term at once and admit a *set* of related symbols — rather than resolving each word in
     * isolation and dropping the ones that match several things.
     */
    freeFormQuery?: string;
    /** Ceiling on how many symbols the free-form path may anchor on. */
    maxAnchors?: number;
  };
  materialize?: {
    source?: boolean;
    callsites?: boolean;
    signatures?: boolean;
    docs?: boolean;
  };
  context?: {
    tokenBudget?: number;
  };
}

export interface SearchSymbolsArgs {
  query: string;
  kind?: SymbolKind;
  /** When the query resolves to exactly one symbol, also explore its neighborhood instead of returning bare candidate info. Default true. */
  expand?: boolean;
  /** Neighborhood depth used when `expand` is true and there's a single match. Default 2. */
  depth?: number;
}

export interface ExploreRegionArgs {
  anchor: string;
  direction?: 'incoming' | 'outgoing' | 'both';
  depth?: number;
  edgeKinds?: string[];
}

export interface TracePathArgs {
  from: string;
  to: string;
  edgeKinds?: string[];
  maxDepth?: number;
}

export interface AnalyzeImpactArgs {
  anchor: string;
  maxDepth?: number;
}

export interface ExploreArgs {
  /** A question in plain English, a bag of symbol/file names, or any mix of the two. */
  query: string;
  /** Neighborhood depth around each anchor. Defaults to what the question's intent implies. */
  depth?: number;
  /** Overrides the traversal direction the question's intent implies. */
  direction?: 'incoming' | 'outgoing' | 'both';
  /** Narrows a tangled neighborhood, e.g. `["call"]`. */
  edgeKinds?: string[];
  /** Ceiling on how many symbols to anchor on (default 8). */
  maxAnchors?: number;
}

export interface ExploreFlowArgs {
  /** A bag of symbol/file names or a loose natural-language query. Each whitespace-separated
   *  term is resolved to its best-matching anchor; unresolvable terms are ignored. */
  query: string;
  depth?: number;
  maxAnchors?: number;
}
