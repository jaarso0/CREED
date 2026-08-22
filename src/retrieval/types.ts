import { KGNode, KGEdge, KGEdgeKind } from '../graph/graph.js';
import { Range } from '../semantic-model/types.js';

export type RetrievalStrategy = 'locate' | 'flow' | 'impact';

export interface CodeSnippet {
  filePath: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ExecutionFlowStep {
  step: number;
  fromSymbolId: string;
  toSymbolId: string;
  fromName: string;
  toName: string;
  relationKind: string;
  filePath: string;
}

export interface ContextPackage {
  task: string;
  strategy: RetrievalStrategy;
  relevantSymbols: {
    id: string;
    kind: string;
    name: string;
    qualifiedName: string;
    filePath: string;
    range: Range;
  }[];
  relevantFiles: string[];
  executionFlows: ExecutionFlowStep[][];
  codeSnippets: CodeSnippet[];
  dependencies: {
    sourceId: string;
    targetId: string;
    kind: string;
  }[];
}

export interface CandidateResult {
  node: KGNode;
  score: number;
  matchReasons: string[];
  /**
   * The distinct query terms this candidate matched. Lets a caller label *why* a symbol
   * became an anchor ("resolved 'crawling' → crawl_site") when several were admitted from
   * one whole-query discovery pass, instead of guessing from the match reasons.
   */
  tokens: string[];
}

export interface ExpansionConfig {
  maxDepth: number;
  relationTypes: KGEdgeKind[];
  includeContainment?: boolean;
  maxNodes?: number;
}
