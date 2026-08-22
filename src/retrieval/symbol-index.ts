import { KGNode, KGEdge } from '../graph/graph.js';

/**
 * The lookup surface `CandidateDiscovery`, `AnchorResolver` and `ImpactRetriever`
 * need, stated as behaviour rather than as data structures.
 *
 * Previously these consumers reached directly into `RetrievalIndexes`' public Maps
 * and iterated them (`bySymbolName.entries()`), which forced every lookup to be a
 * scan over the whole graph held in heap. Expressing the same operations as methods
 * lets a SQLite-backed implementation answer them through indexes instead, with no
 * change to the callers' logic or scoring.
 */
export interface SymbolIndex {
  /** Exact, case-insensitive name lookup. `name` must already be lowercased. */
  getByName(nameLower: string): KGNode[];

  /** Exact, case-insensitive qualified-name lookup. `qname` must already be lowercased. */
  getByQualifiedName(qnameLower: string): KGNode[];

  /**
   * Nodes whose name equals or contains `token` (lowercased).
   * `exact` distinguishes the two so callers can score them differently —
   * a node is reported at most once per call.
   */
  matchByName(token: string): SymbolMatch[];

  /** As `matchByName`, over qualified names. */
  matchByQualifiedName(token: string): SymbolMatch[];

  /**
   * Nodes whose file path contains `token` (lowercased). `filePath` is returned in
   * its original casing because callers surface it in match-reason strings.
   */
  matchByFilePath(token: string): FilePathMatch[];

  /**
   * Nodes whose lowercased name starts with `prefix`, capped at `limit`.
   *
   * Backs the typo-tolerant fallback in discovery: a misspelled term ("resolvr")
   * matches nothing literally, so we pull the small set of names sharing its first
   * couple of characters and score them by edit distance. A prefix is used rather
   * than a full scan because it is an index seek on both backends, which keeps a
   * fallback that only ever runs on already-failed tokens genuinely cheap.
   */
  namesStartingWith(prefix: string, limit: number): KGNode[];

  /** Endpoint handler for a "METHOD /path" key, if one is registered. */
  getEndpoint(endpointKey: string): KGNode | undefined;

  /** Service class by exact name, if one is registered. */
  getService(name: string): KGNode | undefined;

  /** All incoming edges of any kind — the reverse-dependency lookup impact tracing walks. */
  getIncomingEdges(nodeId: string): KGEdge[];
}

export interface SymbolMatch {
  node: KGNode;
  exact: boolean;
}

export interface FilePathMatch {
  node: KGNode;
  filePath: string;
}
