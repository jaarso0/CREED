import { ReadableGraph, KGEdge, KGNode } from '../../graph/graph.js';
import { ImpactResult, StructuralEdge } from '../result-types.js';

export function executeImpact(
  graph: ReadableGraph,
  options: {
    anchor: string;
    maxDepth: number;
    maxNodes: number;
  }
): ImpactResult {
  const { anchor, maxDepth, maxNodes } = options;

  const affected: Array<{ nodeId: string; depth: number; via: string }> = [];
  const visited = new Set<string>();
  const visitedEdges = new Set<string>();
  const resultEdges: KGEdge[] = [];

  visited.add(anchor);

  let queue = [anchor];

  // Define reference kinds that represent actual code usages/dependencies
  const referenceKinds = ['call', 'import', 'inherit', 'implement', 'type_use', 'instantiate', 'renders'];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (queue.length === 0 || affected.length >= maxNodes) break;
    const nextLevel: string[] = [];

    for (const nodeId of queue) {
      // Find incoming edges where targetId is the current node
      const incoming = graph.getEdgesTo(nodeId);

      for (const edge of incoming) {
        // Exclude containment edges going upwards (such as owns, declares, has_member)
        if (!referenceKinds.includes(edge.kind)) continue;

        const edgeKey = `${edge.sourceId}->${edge.targetId}:${edge.kind}`;
        if (visitedEdges.has(edgeKey)) continue;
        visitedEdges.add(edgeKey);
        resultEdges.push(edge);

        const dependentId = edge.sourceId; // The source depends on targetId

        if (!visited.has(dependentId)) {
          if (affected.length >= maxNodes) break;

          visited.add(dependentId);
          affected.push({
            nodeId: dependentId,
            depth,
            via: edge.kind
          });
          nextLevel.push(dependentId);
        }
      }
    }
    queue = nextLevel;
  }

  const edges: StructuralEdge[] = resultEdges.map(e => ({
    sourceId: e.sourceId,
    targetId: e.targetId,
    kind: e.kind,
    properties: e.resolutionMethod ? { resolutionMethod: e.resolutionMethod } : undefined
  }));

  return {
    kind: 'impact',
    root: anchor,
    affected,
    edges
  };
}
