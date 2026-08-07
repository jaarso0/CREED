import { ReadableGraph, KGNode, KGEdge, KGEdgeKind } from '../graph/graph.js';
import { ExpansionConfig } from './types.js';

export class GraphExpander {
  private graph: ReadableGraph;

  constructor(graph: ReadableGraph) {
    this.graph = graph;
  }

  public expand(startNodeIds: string[], config: ExpansionConfig): { nodes: KGNode[]; edges: KGEdge[] } {
    const visitedNodes = new Set<string>();
    const visitedEdges = new Set<string>();
    const resultNodes: KGNode[] = [];
    const resultEdges: KGEdge[] = [];

    let queue = [...startNodeIds];
    for (const id of queue) {
      visitedNodes.add(id);
      const node = this.graph.getNode(id);
      if (node) resultNodes.push(node);
    }

    const maxNodes = config.maxNodes || 100;

    for (let depth = 0; depth < config.maxDepth; depth++) {
      if (queue.length === 0 || resultNodes.length >= maxNodes) break;
      const nextLevel: string[] = [];

      for (const nodeId of queue) {
        const outgoing = this.graph.getEdgesFrom(nodeId);
        const incoming = this.graph.getEdgesTo(nodeId);
        const allEdges = [...outgoing, ...incoming];

        for (const edge of allEdges) {
          if (resultNodes.length >= maxNodes) break;

          const kindMatch = config.relationTypes.includes(edge.kind);
          const isContainment = edge.kind === 'owns' || edge.kind === 'declares' || edge.kind === 'has_member';
          const isContainmentAllowed = config.includeContainment && isContainment;

          if (!kindMatch && !isContainmentAllowed) continue;

          const edgeKey = `${edge.sourceId}->${edge.targetId}:${edge.kind}`;
          if (visitedEdges.has(edgeKey)) continue;
          visitedEdges.add(edgeKey);
          resultEdges.push(edge);

          const neighborId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
          if (!visitedNodes.has(neighborId)) {
            visitedNodes.add(neighborId);
            const neighborNode = this.graph.getNode(neighborId);
            if (neighborNode) {
              resultNodes.push(neighborNode);
              nextLevel.push(neighborId);
            }
          }
        }
      }
      queue = nextLevel;
    }

    return { nodes: resultNodes, edges: resultEdges };
  }
}
