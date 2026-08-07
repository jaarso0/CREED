import * as fs from 'fs/promises';
import * as path from 'path';
import { ReadableGraph, KGNode } from '../graph/graph.js';
import { RegionResult, PathResult, ImpactResult, StructuralNode } from '../executor/result-types.js';
import { MaterializedEvidence, MaterializedNode, MaterializedEdge } from './types.js';
import { GraphQueryPlan } from '../mcp/types.js';

export class EvidenceMaterializer {
  private projectRoot: string;
  private graph: ReadableGraph;
  private fileCache = new Map<string, string[]>(); // filePath -> lines array

  constructor(graph: ReadableGraph, projectRoot: string) {
    this.graph = graph;
    this.projectRoot = projectRoot;
  }

  /**
   * Clears the file cache (useful for incremental updates).
   */
  public clearCache(): void {
    this.fileCache.clear();
  }

  /**
   * Materializes source code spans and callsites for a structural result.
   */
  public async materialize(
    structuralResult: RegionResult | PathResult | ImpactResult,
    plan: GraphQueryPlan
  ): Promise<MaterializedEvidence> {
    const materializeOptions = plan.materialize || {};
    const materializedNodes: MaterializedNode[] = [];
    const materializedEdges: MaterializedEdge[] = [];

    // 1. Collect all nodes that need materialization
    const nodeRoleMap = new Map<string, 'anchor' | 'path' | 'direct_neighbor' | 'transitive_neighbor' | 'impacted'>();
    const nodesToFetch: StructuralNode[] = [];

    if (structuralResult.kind === 'region') {
      const region = structuralResult as RegionResult;
      for (const n of region.nodes) {
        let role: 'anchor' | 'path' | 'direct_neighbor' | 'transitive_neighbor' | 'impacted' = 'direct_neighbor';
        if (region.roots.includes(n.nodeId)) {
          role = 'anchor';
        } else {
          const dist = region.distance[n.nodeId] || 0;
          if (dist > 1) {
            role = 'transitive_neighbor';
          }
        }
        nodeRoleMap.set(n.nodeId, role);
        nodesToFetch.push(n);
      }
    } else if (structuralResult.kind === 'path') {
      const pathRes = structuralResult as PathResult;
      const allPathNodeIds = new Set<string>();
      const anchorNodeIds = new Set<string>();

      if (plan.anchors && plan.anchors.length >= 2) {
        // Resolve anchors if possible
        // We'll mark the first and last node of any path as anchors
      }

      for (const p of pathRes.paths) {
        p.nodes.forEach((id, idx) => {
          allPathNodeIds.add(id);
          if (idx === 0 || idx === p.nodes.length - 1) {
            anchorNodeIds.add(id);
          }
        });
      }

      for (const nodeId of allPathNodeIds) {
        const node = this.graph.getNode(nodeId);
        if (node) {
          const role = anchorNodeIds.has(nodeId) ? 'anchor' : 'path';
          nodeRoleMap.set(nodeId, role);
          nodesToFetch.push({
            nodeId: node.id,
            kind: node.kind,
            name: node.name,
            qualifiedName: node.qualifiedName,
            filePath: node.filePath,
            properties: node.properties
          });
        }
      }
    } else if (structuralResult.kind === 'impact') {
      const impact = structuralResult as ImpactResult;
      const rootNode = this.graph.getNode(impact.root);
      if (rootNode) {
        nodeRoleMap.set(impact.root, 'anchor');
        nodesToFetch.push({
          nodeId: rootNode.id,
          kind: rootNode.kind,
          name: rootNode.name,
          qualifiedName: rootNode.qualifiedName,
          filePath: rootNode.filePath,
          properties: rootNode.properties
        });
      }

      for (const aff of impact.affected) {
        const node = this.graph.getNode(aff.nodeId);
        if (node) {
          nodeRoleMap.set(aff.nodeId, 'impacted');
          nodesToFetch.push({
            nodeId: node.id,
            kind: node.kind,
            name: node.name,
            qualifiedName: node.qualifiedName,
            filePath: node.filePath,
            properties: node.properties
          });
        }
      }
    }

    // 2. Group nodes by file to read each file exactly once
    const nodesByFile = new Map<string, StructuralNode[]>();
    for (const node of nodesToFetch) {
      if (!node.filePath) continue; // skip virtual project nodes
      const fileList = nodesByFile.get(node.filePath) || [];
      fileList.push(node);
      nodesByFile.set(node.filePath, fileList);
    }

    // 3. Batch load files and materialize node contents
    for (const [filePath, nodes] of nodesByFile.entries()) {
      const lines = await this.loadFileLines(filePath);
      if (!lines) {
        // Fallback for missing/unreadable files (return metadata only)
        for (const n of nodes) {
          const range = n.properties.range as any;
          const rangeInfo = (range && range.start && range.end) ? {
            startLine: range.start.line + 1,
            endLine: range.end.line + 1
          } : undefined;

          materializedNodes.push({
            nodeId: n.nodeId,
            name: n.name,
            qualifiedName: n.qualifiedName,
            kind: n.kind,
            file: n.filePath,
            range: rangeInfo,
            structuralRole: nodeRoleMap.get(n.nodeId) || 'direct_neighbor',
            unresolvedRefs: this.graph.getUnresolvedReferences(n.nodeId),
            hasCoveringTests: this.computeTestCoverage(n.kind, n.nodeId)
          });
        }
        continue;
      }

      for (const n of nodes) {
        const range = n.properties.range as any;
        let sourceText: string | undefined;
        let signature: string | undefined;
        let docs: string | undefined;

        if (range && range.start && range.end) {
          const startLine = range.start.line; // 0-indexed
          const endLine = range.end.line;

          if (startLine < lines.length) {
            const sliced = lines.slice(startLine, endLine + 1);
            sourceText = sliced.join('\n');
            signature = sliced[0]?.trim();
          }

          // Extract preceding doc comments if requested
          if (materializeOptions.docs) {
            docs = this.extractPrecedingComments(lines, startLine);
            // Fallback: check metadata
            if (!docs && n.properties.comment) {
              docs = String(n.properties.comment);
            }
          }
        }

        const rangeInfo = (range && range.start && range.end) ? {
          startLine: range.start.line + 1,
          endLine: range.end.line + 1
        } : undefined;

        materializedNodes.push({
          nodeId: n.nodeId,
          name: n.name,
          qualifiedName: n.qualifiedName,
          kind: n.kind,
          file: n.filePath,
          signature: materializeOptions.signatures ? signature : undefined,
          range: rangeInfo,
          source: (materializeOptions.source && sourceText && range) ? {
            startLine: range.start.line + 1,
            endLine: range.end.line + 1,
            text: sourceText
          } : undefined,
          docs: docs || undefined,
          structuralRole: nodeRoleMap.get(n.nodeId) || 'direct_neighbor',
          unresolvedRefs: this.graph.getUnresolvedReferences(n.nodeId),
          hasCoveringTests: this.computeTestCoverage(n.kind, n.nodeId)
        });
      }
    }

    // 4. Materialize edges and search for callsites
    const edgesToProcess = structuralResult.kind === 'path'
      ? (structuralResult as PathResult).paths.flatMap(p => p.edges)
      : (structuralResult as RegionResult | ImpactResult).edges;

    for (const edge of edgesToProcess) {
      let callsiteInfo: { file: string; line: number; snippet: string } | undefined;

      if (materializeOptions.callsites && (edge.kind === 'call' || edge.kind === 'instantiate')) {
        const callerNode = this.graph.getNode(edge.sourceId);
        const calleeNode = this.graph.getNode(edge.targetId);

        if (callerNode && calleeNode && callerNode.filePath) {
          const callerLines = await this.loadFileLines(callerNode.filePath);
          const callerRange = callerNode.properties.range as any;

          if (callerLines && callerRange && callerRange.start && callerRange.end) {
            // Find occurrence of callee name inside caller's scope range
            const nameWord = calleeNode.name;
            const regex = new RegExp(`\\b${nameWord}\\b`);

            let foundLine = -1;
            for (let l = callerRange.start.line; l <= callerRange.end.line; l++) {
              if (l < callerLines.length) {
                const lineContent = callerLines[l];
                if (regex.test(lineContent)) {
                  // Skip if the line is just a definition or parameter declaration/annotation
                  const isFuncDef = new RegExp(`\\b(def|function)\\s+${nameWord}\\b`).test(lineContent);
                  const isClassDef = new RegExp(`\\bclass\\s+${nameWord}\\b`).test(lineContent);
                  const isParamOrType = new RegExp(`\\b${nameWord}\\s*:\\s*(Callable|str|int|float|bool|list|dict|tuple|set|Any|Optional|Union)\\b`, 'i').test(lineContent);

                  if (isFuncDef || isClassDef || isParamOrType) {
                    continue;
                  }

                  foundLine = l;
                  break;
                }
              }
            }

            if (foundLine !== -1) {
              callsiteInfo = {
                file: callerNode.filePath,
                line: foundLine + 1,
                snippet: callerLines[foundLine].trim()
              };
            }
          }
        }
      }

      materializedEdges.push({
        source: edge.sourceId,
        target: edge.targetId,
        kind: edge.kind,
        callsite: callsiteInfo,
        resolutionMethod: (edge as any).properties?.resolutionMethod ?? (edge as any).resolutionMethod
      });
    }

    return {
      nodes: materializedNodes,
      edges: materializedEdges
    };
  }

  private static readonly TESTABLE_KINDS = new Set(['function', 'method', 'class', 'interface']);

  /** Only meaningful for callable/type kinds — undefined otherwise so serializers can skip it cleanly. */
  private computeTestCoverage(kind: string, nodeId: string): boolean | undefined {
    if (!EvidenceMaterializer.TESTABLE_KINDS.has(kind)) return undefined;
    return this.graph.isTestCovered(nodeId);
  }

  private async loadFileLines(filePath: string): Promise<string[] | null> {
    const normPath = filePath.replace(/\\/g, '/');
    if (this.fileCache.has(normPath)) {
      return this.fileCache.get(normPath)!;
    }

    try {
      const absolutePath = path.isAbsolute(normPath)
        ? normPath
        : path.join(this.projectRoot, normPath);
      const content = await fs.readFile(absolutePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      this.fileCache.set(normPath, lines);
      return lines;
    } catch (err) {
      console.error(`Failed to read file for materialization: ${normPath}`, err);
      return null;
    }
  }

  /**
   * Scans upwards from startLine - 1 to extract block comments (# or // or /*).
   */
  private extractPrecedingComments(lines: string[], startLine: number): string | null {
    const commentLines: string[] = [];
    let idx = startLine - 1;
    let inBlockComment = false;

    while (idx >= 0 && commentLines.length < 6) {
      const line = lines[idx].trim();

      // Stop on empty line if we have comments already
      if (!line) {
        if (commentLines.length > 0) break;
        idx--;
        continue;
      }

      // Check block comments ending
      if (line.endsWith('*/')) {
        inBlockComment = true;
        commentLines.unshift(line);
        idx--;
        continue;
      }

      if (inBlockComment) {
        commentLines.unshift(line);
        if (line.startsWith('/*')) {
          inBlockComment = false;
        }
        idx--;
        continue;
      }

      if (line.startsWith('//') || line.startsWith('#')) {
        commentLines.unshift(line);
        idx--;
      } else {
        // Stop scanning if we hit code
        break;
      }
    }

    return commentLines.length > 0 ? commentLines.join('\n') : null;
  }
}
