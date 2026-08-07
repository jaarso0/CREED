import { ReadableGraph, KGNode, KGEdge } from '../../graph/graph.js';
import { RegionResult, StructuralNode, StructuralEdge } from '../result-types.js';

export function executeRegion(
  graph: ReadableGraph,
  options: {
    anchors: string[];
    direction: 'incoming' | 'outgoing' | 'both';
    edgeKinds?: string[];
    depth: number;
    nodeLimit: number;
    edgeLimit: number;
    /** Max nodes from any single file admitted at depth >= 2, so one huge file can't
     *  monopolize the budget on broad queries. 0/undefined = unlimited. Anchors and
     *  direct (depth-1) neighbors are always kept, preserving focused exploration. */
    perFileCap?: number;
  }
): RegionResult {
  const { anchors, direction, edgeKinds, depth, nodeLimit, edgeLimit } = options;
  const perFileCap = options.perFileCap && options.perFileCap > 0 ? options.perFileCap : Infinity;

  const distance: Record<string, number> = {};
  const visitedNodes = new Set<string>();
  const visitedEdges = new Set<string>();
  const fileNodeCounts = new Map<string, number>();

  const resultNodesMap = new Map<string, KGNode>();
  const resultEdges: KGEdge[] = [];

  // Initialize anchors
  const queue: Array<{ id: string; d: number }> = [];
  for (const anchorId of anchors) {
    const node = graph.getNode(anchorId);
    if (node) {
      visitedNodes.add(anchorId);
      distance[anchorId] = 0;
      resultNodesMap.set(anchorId, node);
      queue.push({ id: anchorId, d: 0 });
    }
  }

  // BFS Traversal
  while (queue.length > 0) {
    const { id, d } = queue.shift()!;

    if (d >= depth) continue;

    // Retrieve relevant edges based on direction
    const outgoing = (direction === 'outgoing' || direction === 'both') ? graph.getEdgesFrom(id) : [];
    const incoming = (direction === 'incoming' || direction === 'both') ? graph.getEdgesTo(id) : [];
    const allEdges = [...outgoing, ...incoming];

    for (const edge of allEdges) {
      // Check edge kind matches filter (case-insensitive & plural-insensitive)
      const isAllowedKind = !edgeKinds || edgeKinds.length === 0 || edgeKinds.some(k => {
        const queryKind = k.toLowerCase().replace(/s$/, '');
        const actualKind = edge.kind.toLowerCase().replace(/s$/, '');
        return queryKind === actualKind;
      });

      if (!isAllowedKind) continue;

      const edgeKey = `${edge.sourceId}->${edge.targetId}:${edge.kind}`;
      if (visitedEdges.has(edgeKey)) continue;
      visitedEdges.add(edgeKey);

      const neighborId = edge.sourceId === id ? edge.targetId : edge.sourceId;
      const neighborNode = graph.getNode(neighborId);

      if (!neighborNode) continue;

      const isNeighborVisited = visitedNodes.has(neighborId);

      if (!isNeighborVisited) {
        // Enforce hard node ceiling
        if (resultNodesMap.size >= nodeLimit) continue;

        // Per-file diversity cap: only bites on transitive nodes (depth >= 2) so anchors and
        // their direct neighbors are never dropped — a single sprawling file can't crowd out
        // the rest of a broad query's results.
        const nd = d + 1;
        const fileCount = fileNodeCounts.get(neighborNode.filePath) || 0;
        if (nd >= 2 && fileCount >= perFileCap) continue;

        visitedNodes.add(neighborId);
        distance[neighborId] = nd;
        fileNodeCounts.set(neighborNode.filePath, fileCount + 1);
        resultNodesMap.set(neighborId, neighborNode);
        queue.push({ id: neighborId, d: nd });
      }

      // Record the edge (provenance)
      resultEdges.push(edge);
    }
  }

  // Proactively cap edges BEFORE they reach materialization (which does a per-edge
  // callsite file-read for call/instantiate edges). A hub at depth:2/both can produce
  // thousands of edges among its neighbors; without this, we'd pay to materialize all
  // of them only for the serializer to show ~60. Rank by relevance so the ones we keep
  // are the ones worth showing: edges touching an anchor first, then edges nearer the
  // anchor (smaller max endpoint distance), then containment/kind as a mild tiebreak.
  const anchorSet = new Set(anchors);
  const edgePriority = (e: KGEdge): number => {
    if (anchorSet.has(e.sourceId) || anchorSet.has(e.targetId)) return 0;
    const ds = distance[e.sourceId] ?? Infinity;
    const dt = distance[e.targetId] ?? Infinity;
    return Math.max(ds, dt); // both endpoints close => higher priority (lower number)
  };
  const rankedEdges = [...resultEdges].sort((a, b) => edgePriority(a) - edgePriority(b));
  const keptEdges = rankedEdges.slice(0, edgeLimit);
  const omittedEdgeCount = resultEdges.length - keptEdges.length;

  // Map to structural types
  const nodes: StructuralNode[] = Array.from(resultNodesMap.values()).map(n => ({
    nodeId: n.id,
    kind: n.kind,
    name: n.name,
    qualifiedName: n.qualifiedName,
    filePath: n.filePath,
    properties: n.properties
  }));

  const edges: StructuralEdge[] = keptEdges.map(e => ({
    sourceId: e.sourceId,
    targetId: e.targetId,
    kind: e.kind,
    properties: e.resolutionMethod ? { resolutionMethod: e.resolutionMethod } : undefined
  }));

  return {
    kind: 'region',
    roots: anchors,
    nodes,
    edges,
    distance,
    omittedEdgeCount
  };
}
