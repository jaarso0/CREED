import { MaterializedEvidence, MaterializedNode, MaterializedEdge } from '../../evidence/types.js';
import { RepresentationLevel } from '../budget-allocator.js';
import { getDisplayName, serializeSourceSection, formatResolutionConfidence, formatUnresolvedRefs, formatTestCoverage, formatConfidenceSummary } from './helper.js';

export function serializePath(
  evidence: MaterializedEvidence,
  paths: Array<{ nodes: string[]; edges: any[] }>,
  levels: Map<string, RepresentationLevel>
): string {
  if (paths.length === 0) {
    return 'No call paths found between the specified anchors.';
  }

  const nodeMap = new Map<string, MaterializedNode>(evidence.nodes.map(n => [n.nodeId, n]));
  const edgeMap = new Map<string, MaterializedEdge>();

  for (const e of evidence.edges) {
    edgeMap.set(`${e.source}->${e.target}:${e.kind}`, e);
    edgeMap.set(`${e.source}->${e.target}`, e);
  }

  let output = '';

  paths.forEach((pathObj, pathIdx) => {
    output += paths.length > 1 ? `**Call path ${pathIdx + 1}**\n\n` : '**Call path**\n\n';

    const printedEdges = new Set<string>();
    pathObj.nodes.forEach((nodeId, idx) => {
      const node = nodeMap.get(nodeId);
      const lvl = levels.get(nodeId) || 'SIGNATURE';

      if (!node || lvl === 'OMIT') {
        output += `${idx + 1}. [Omitted: ${nodeId}]\n`;
      } else {
        const displayName = getDisplayName(node, nodeId);
        const line = node.range ? `:${node.range.startLine}` : '';
        output += `${idx + 1}. \`${displayName}\` (${node.kind} — ${node.file}${line})\n`;
        if (node.signature) output += `   \`${node.signature}\`\n`;
        const unresolvedNote = formatUnresolvedRefs(node);
        if (unresolvedNote) output += ' ' + unresolvedNote;
        const testNote = formatTestCoverage(node);
        if (testNote) output += ' ' + testNote;
      }

      // The edge carrying the flow to the next step, with its callsite.
      if (idx < pathObj.nodes.length - 1) {
        const nextNodeId = pathObj.nodes[idx + 1];
        const edge = edgeMap.get(`${nodeId}->${nextNodeId}`) || edgeMap.get(`${nodeId}->${nextNodeId}:call`);

        const edgeKey = `${nodeId}->${nextNodeId}:${edge?.kind || 'relation'}:${edge?.callsite?.line || ''}`;
        if (printedEdges.has(edgeKey)) {
          output += `   ↓\n`;
          return;
        }
        printedEdges.add(edgeKey);

        if (edge) {
          output += `   ↓ ${edge.kind}${formatResolutionConfidence(edge.resolutionMethod)}`;
          if (edge.callsite) {
            output += ` — ${edge.callsite.file}:${edge.callsite.line} → \`${edge.callsite.snippet}\``;
          }
          output += `\n`;
        } else {
          output += `   ↓ relates to\n`;
        }
      }
    });
    output += '\n';
  });

  const pathReferenceEdges = evidence.edges.filter(e => e.resolutionMethod !== undefined);
  const summary = formatConfidenceSummary(pathReferenceEdges, 'reference edge(s) across all path(s)');
  if (summary) output += summary + '\n';

  const spansOutput = serializeSourceSection(evidence.nodes, levels);
  if (spansOutput) {
    output += spansOutput;
  }

  return output.trim();
}
