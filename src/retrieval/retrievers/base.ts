import { SymbolIndex } from '../symbol-index.js';
import { ReadableGraph, KGNode, KGEdge } from '../../graph/graph.js';

export abstract class BaseRetriever {
  protected indexes: SymbolIndex;
  protected graph: ReadableGraph;

  constructor(indexes: SymbolIndex, graph: ReadableGraph) {
    this.indexes = indexes;
    this.graph = graph;
  }

  abstract retrieve(candidates: KGNode[], taskQuery: string): { nodes: KGNode[]; edges: KGEdge[] };
}
