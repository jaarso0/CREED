import { BaseRetriever } from './base.js';
import { KGNode, KGEdge } from '../../graph/graph.js';

export class ImpactRetriever extends BaseRetriever {
  public retrieve(candidates: KGNode[], taskQuery: string): { nodes: KGNode[]; edges: KGEdge[] } {
    const visitedNodes = new Set<string>();
    const visitedEdges = new Set<string>();
    const resultNodes: KGNode[] = [];
    const resultEdges: KGEdge[] = [];

    let queue = candidates.map(c => c.id);
    for (const id of queue) {
      visitedNodes.add(id);
      const node = this.graph.getNode(id);
      if (node) resultNodes.push(node);
    }

    // Traces backwards (incoming relations) up to depth 3
    const maxDepth = 3;
    const maxNodes = 60;

    for (let depth = 0; depth < maxDepth; depth++) {
      if (queue.length === 0 || resultNodes.length >= maxNodes) break;
      const nextLevel: string[] = [];

      for (const nodeId of queue) {
        // Look up incoming dependencies using reverse index
        const incoming = this.indexes.getIncomingEdges(nodeId);

        for (const edge of incoming) {
          if (resultNodes.length >= maxNodes) break;

          const edgeKey = `${edge.sourceId}->${edge.targetId}:${edge.kind}`;
          if (visitedEdges.has(edgeKey)) continue;
          visitedEdges.add(edgeKey);
          resultEdges.push(edge);

          const callerId = edge.sourceId; // Caller is the source of the reference
          if (!visitedNodes.has(callerId)) {
            visitedNodes.add(callerId);
            const callerNode = this.graph.getNode(callerId);
            if (callerNode) {
              resultNodes.push(callerNode);
              nextLevel.push(callerId);
            }
          }
        }
      }
      queue = nextLevel;
    }

    return { nodes: resultNodes, edges: resultEdges };
  }
}
