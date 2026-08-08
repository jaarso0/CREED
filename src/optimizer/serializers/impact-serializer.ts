import { MaterializedEvidence } from '../../evidence/types.js';
import { RepresentationLevel } from '../budget-allocator.js';
import { getDisplayName, serializeSourceSection, formatResolutionConfidence, formatUnresolvedRefs, formatTestCoverage, formatConfidenceSummary } from './helper.js';

export function serializeImpact(
  evidence: MaterializedEvidence,
  rootId: string,
  affected: Array<{ nodeId: string; depth: number; via: string }>,
  levels: Map<string, RepresentationLevel>
): string {
  const nodeMap = new Map(evidence.nodes.map(n => [n.nodeId, n]));
  const rootNode = nodeMap.get(rootId);
  // Index edges by "source->kind" so each affected dependent can show how confidently
  // the edge that pulled it in was resolved.
  const resolutionByEdgeKey = new Map<string, string | undefined>();
  evidence.edges.forEach(e => {
    resolutionByEdgeKey.set(`${e.source}:${e.kind}`, e.resolutionMethod);
  });

  let output = '**Changed symbol**\n\n';

  // 1. Root symbol (where change was made)
  if (rootNode) {
    const rootName = getDisplayName(rootNode, rootId);
    const line = rootNode.range ? `:${rootNode.range.startLine}` : '';
    output += `- \`${rootName}\` (${rootNode.kind} — ${rootNode.file}${line})\n`;
    if (rootNode.signature) output += `  \`${rootNode.signature}\`\n`;
    if (rootNode.docs) output += `${rootNode.docs.split('\n').map(l => '  > ' + l).join('\n')}\n`;
    output += formatUnresolvedRefs(rootNode);
    output += formatTestCoverage(rootNode);
  } else {
    output += `- [ID: ${rootId}]\n`;
  }
  output += '\n';

  if (affected.length === 0) {
    output += 'No downstream dependents or affected symbols were found.\n';
    return output.trim();
  }

  // 1b. Confidence rollup — how much of this cone to actually trust before reading every line
  const affectedResolutionMethods = affected.map(a => ({
    resolutionMethod: resolutionByEdgeKey.get(`${a.nodeId}:${a.via}`)
  }));
  output += formatConfidenceSummary(affectedResolutionMethods, 'dependent(s) found');
  output += '\n';

  // 2. Group affected nodes by depth
  const byDepth = new Map<number, Array<{ nodeId: string; via: string }>>();
  affected.forEach(a => {
    const list = byDepth.get(a.depth) || [];
    list.push({ nodeId: a.nodeId, via: a.via });
    byDepth.set(a.depth, list);
  });

  const sortedDepths = Array.from(byDepth.keys()).sort((a, b) => a - b);

  sortedDepths.forEach(depth => {
    const title = depth === 1 ? '**Direct dependents**' : `**Transitive dependents (depth ${depth})**`;
    output += `${title}\n\n`;

    const items = byDepth.get(depth)!;
    items.forEach(item => {
      const node = nodeMap.get(item.nodeId);
      if (node) {
        const displayName = getDisplayName(node, item.nodeId);
        const resolutionMethod = resolutionByEdgeKey.get(`${item.nodeId}:${item.via}`);
        const line = node.range ? `:${node.range.startLine}` : '';
        output += `- \`${displayName}\` (${node.kind} — ${node.file}${line}) [via: ${item.via}]${formatResolutionConfidence(resolutionMethod)}\n`;
        output += formatUnresolvedRefs(node);
        output += formatTestCoverage(node);
      } else {
        output += `- [ID: ${item.nodeId}] [via: ${item.via}]\n`;
      }
    });
    output += '\n';
  });

  // 3. Verbatim source for the dependents (the root's own body isn't what's at risk)
  const spansOutput = serializeSourceSection(evidence.nodes, levels, [rootId]);
  if (spansOutput) {
    output += spansOutput;
  }

  return output.trim();
}
