import { ReadableGraph } from '../graph/graph.js';
import { executeRegion } from './operations/region.js';
import { executePath } from './operations/path.js';
import { executeImpact } from './operations/impact.js';
import { GraphQueryPlan } from '../mcp/types.js';
import { ExecutionResult } from './result-types.js';

export class GraphExecutor {
  private graph: ReadableGraph;

  constructor(graph: ReadableGraph) {
    this.graph = graph;
  }

  public execute(
    plan: GraphQueryPlan & { resolvedAnchors: string[] },
    limits: {
      maxDepth: number;
      maxNodes: number;
      maxPaths: number;
      maxEdges: number;
      maxNodesPerFile?: number;
    }
  ): ExecutionResult {
    const operation = plan.operation;
    const anchors = plan.resolvedAnchors;

    const constraints = plan.constraints || {};
    const depth = Math.min(constraints.requestedDepth !== undefined ? constraints.requestedDepth : 3, limits.maxDepth);
    const nodes = Math.min(constraints.requestedNodes !== undefined ? constraints.requestedNodes : 100, limits.maxNodes);
    const paths = Math.min(constraints.requestedPaths !== undefined ? constraints.requestedPaths : 10, limits.maxPaths);

    console.error(`Executing operation "${operation}" with ${anchors.length} resolved anchors (depth limit: ${depth}, node limit: ${nodes}, edge limit: ${limits.maxEdges})`);

    switch (operation) {
      case 'region':
        return executeRegion(this.graph, {
          anchors,
          direction: constraints.direction || 'outgoing',
          edgeKinds: constraints.edgeKinds,
          depth,
          nodeLimit: nodes,
          edgeLimit: limits.maxEdges,
          perFileCap: limits.maxNodesPerFile
        });

      case 'path':
        if (anchors.length < 2) {
          throw new Error('Path operation requires at least two anchors');
        }
        return executePath(this.graph, {
          from: anchors[0],
          to: anchors[1],
          edgeKinds: constraints.edgeKinds,
          maxDepth: depth,
          maxPaths: paths
        });

      case 'impact':
        if (anchors.length < 1) {
          throw new Error('Impact operation requires at least one anchor');
        }
        return executeImpact(this.graph, {
          anchor: anchors[0],
          maxDepth: depth,
          maxNodes: nodes
        });

      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }
}
