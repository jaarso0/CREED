import { ReadableGraph, KGEdge } from '../../graph/graph.js';
import { PathResult, StructuralEdge } from '../result-types.js';

interface PathState {
  currentNodeId: string;
  nodes: string[];
  edges: KGEdge[];
}

export function executePath(
  graph: ReadableGraph,
  options: {
    from: string;
    to: string;
    edgeKinds?: string[];
    maxDepth: number;
    maxPaths: number;
  }
): PathResult {
  const { from, to, edgeKinds, maxDepth, maxPaths } = options;

  const foundPaths: Array<{ nodes: string[]; edges: StructuralEdge[] }> = [];

  // Edge kind filter
  const isAllowedKind = (kind: string) => {
    return !edgeKinds || edgeKinds.length === 0 || edgeKinds.some(k => {
      const queryKind = k.toLowerCase().replace(/s$/, '');
      const actualKind = kind.toLowerCase().replace(/s$/, '');
      return queryKind === actualKind;
    });
  };

  const queue: PathState[] = [{ currentNodeId: from, nodes: [from], edges: [] }];

  // Track visited nodes at specific depths to prevent redundant work
  // but allow multiple paths if they hit the target at the same/minimal depth.
  const minDepthToNode = new Map<string, number>();
  minDepthToNode.set(from, 0);

  while (queue.length > 0 && foundPaths.length < maxPaths) {
    const { currentNodeId, nodes, edges } = queue.shift()!;

    if (currentNodeId === to) {
      foundPaths.push({
        nodes,
        edges: edges.map(e => ({
          sourceId: e.sourceId,
          targetId: e.targetId,
          kind: e.kind,
          properties: e.resolutionMethod ? { resolutionMethod: e.resolutionMethod } : undefined
        }))
      });
      continue;
    }

    if (nodes.length - 1 >= maxDepth) continue;

    const outgoing = graph.getEdgesFrom(currentNodeId);

    for (const edge of outgoing) {
      if (!isAllowedKind(edge.kind)) continue;

      const nextNodeId = edge.targetId;

      // Avoid simple cycles on the current path
      if (nodes.includes(nextNodeId)) continue;

      const nextPathDepth = nodes.length;
      const bestDepth = minDepthToNode.get(nextNodeId);

      // Only traverse if we are at a depth <= any previous traversal depth to this node,
      // which ensures we find shortest paths first.
      if (bestDepth === undefined || nextPathDepth <= bestDepth) {
        minDepthToNode.set(nextNodeId, nextPathDepth);
        queue.push({
          currentNodeId: nextNodeId,
          nodes: [...nodes, nextNodeId],
          edges: [...edges, edge]
        });
      }
    }
  }

  return {
    kind: 'path',
    paths: foundPaths
  };
}
