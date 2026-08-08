import { ReadableGraph, KGNode } from '../graph/graph.js';
import { CandidateDiscovery, DEFINITION_KINDS } from '../retrieval/discovery.js';
import { RetrievalIndexes } from '../retrieval/indexes.js';
import { SymbolIndex } from '../retrieval/symbol-index.js';
import { AnchorSpec } from '../mcp/types.js';
import { ResolvedAnchor, AnchorCandidate, ResolutionResult, MultiAnchorResolutionResult, Disambiguation } from './types.js';

/** Test/scratch symbols are almost never the intended target of a bare query — deprioritize them. */
function isPeripheralFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(tests?|scratch)(\/|$)/.test(p) || /\.(test|spec)\.[a-z]+$/.test(p) || p.startsWith('scratch');
}

export class AnchorResolver {
  private graph: ReadableGraph;
  private indexes: SymbolIndex;
  private discovery: CandidateDiscovery;

  /**
   * `index` lets a caller supply a SQLite-backed lookup instead of building the
   * in-memory one, which otherwise materializes every node into Maps just to
   * resolve an anchor. Defaults to the in-memory index for callers that already
   * hold a full graph.
   */
  constructor(graph: ReadableGraph, index?: SymbolIndex) {
    this.graph = graph;
    this.indexes = index ?? new RetrievalIndexes(graph);
    this.discovery = new CandidateDiscovery(this.indexes);
  }

  /**
   * Resolves a single anchor spec.
   */
  public resolveAnchor(spec: AnchorSpec): ResolutionResult {
    const query = spec.query.trim();
    const kindFilter = spec.kind;
    const resolutionMode = spec.resolution || 'auto';

    console.error(`Resolving anchor: "${query}" (kind: ${kindFilter || 'any'}, mode: ${resolutionMode})`);

    // 1. Stable Node ID Lookup (only if mode is 'exact' or 'auto')
    if (resolutionMode === 'exact' || resolutionMode === 'auto') {
      const node = this.graph.getNode(query);
      if (node && (!kindFilter || node.kind === kindFilter)) {
        console.error(`-> Exact ID match found: ${node.id}`);
        return {
          status: 'resolved',
          anchors: [this.mapNodeToResolved(node)]
        };
      }
    }

    // 2. Case-insensitive Qualified Name Match
    if (resolutionMode === 'exact' || resolutionMode === 'auto') {
      const lowerQuery = query.toLowerCase();
      // Indexed O(1) lookup (byQualifiedName is keyed by lowercased qualified name)
      // instead of an O(n) scan over every node in the graph on every resolve.
      let qnameMatches = this.indexes.getByQualifiedName(lowerQuery);
      if (kindFilter) qnameMatches = qnameMatches.filter(n => n.kind === kindFilter);

      if (qnameMatches.length === 1) {
        console.error(`-> Single Qualified Name match: ${qnameMatches[0].id}`);
        return {
          status: 'resolved',
          anchors: [this.mapNodeToResolved(qnameMatches[0])]
        };
      } else if (qnameMatches.length > 1) {
        console.error(`-> Ambiguous Qualified Name match: ${qnameMatches.length} candidates`);
        return {
          status: 'ambiguous',
          candidates: this.rankNodes(qnameMatches).slice(0, 10).map(n => this.mapNodeToCandidate(n))
        };
      }
    }

    // 3. Case-insensitive Symbol Name Match
    if (resolutionMode === 'exact' || resolutionMode === 'auto') {
      const lowerQuery = query.toLowerCase();
      // Indexed O(1) lookup (bySymbolName is keyed by lowercased name) instead of an
      // O(n) scan over every node — this path runs on essentially every query.
      let nameMatches = this.indexes.getByName(lowerQuery);
      if (kindFilter) nameMatches = nameMatches.filter(n => n.kind === kindFilter);

      // Prefer definitions. If the only exact-name hits are fields/variables, do NOT
      // short-circuit here — fall through to FTS so a definition whose name *contains* the
      // term can compete (e.g. "discovery" should reach `CandidateDiscovery`, not stop at a
      // private field literally named `discovery`).
      const defMatches = nameMatches.filter(n => DEFINITION_KINDS.has(n.kind));
      const preferred = defMatches.length > 0 ? defMatches : [];

      if (preferred.length === 1) {
        console.error(`-> Single Symbol Name match: ${preferred[0].id}`);
        return {
          status: 'resolved',
          anchors: [this.mapNodeToResolved(preferred[0])]
        };
      } else if (preferred.length > 1) {
        console.error(`-> Ambiguous Symbol Name match: ${preferred.length} candidates`);
        return {
          status: 'ambiguous',
          candidates: this.rankNodes(preferred).slice(0, 10).map(n => this.mapNodeToCandidate(n))
        };
      }
      // nameMatches were all non-definition kinds — intentionally fall through to FTS.
    }

    // 4. Token FTS / Discovery Search (only if mode is 'search' or 'auto')
    if (resolutionMode === 'search' || resolutionMode === 'auto') {
      const discovered = this.discovery.discover(query, 20);
      let candidates = discovered.map(d => ({
        ...this.mapNodeToCandidate(d.node),
        score: d.score,
        matchReasons: d.matchReasons
      }));

      if (kindFilter) {
        candidates = candidates.filter(c => {
          const node = this.graph.getNode(c.nodeId);
          return node && node.kind === kindFilter;
        });
      }

      if (candidates.length === 1) {
        console.error(`-> Single FTS match found: ${candidates[0].nodeId} (score: ${candidates[0].score})`);
        const node = this.graph.getNode(candidates[0].nodeId)!;
        return {
          status: 'resolved',
          anchors: [this.mapNodeToResolved(node)]
        };
      } else if (candidates.length > 1) {
        // Dominant-match auto-resolution. A fuzzy query ("MCPServer.handleToolCall",
        // "resolveScope") shouldn't force the caller to re-query with an exact node ID
        // when one candidate clearly wins. Resolve automatically when either:
        //   (a) exactly one candidate's name (or the last dotted segment) or qualified name
        //       equals the query case-insensitively, or
        //   (b) the top-scoring candidate dominates the runner-up by a wide margin.
        // Otherwise fall through to a genuinely ambiguous result (capped for output size).
        const sorted = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const q = query.toLowerCase();
        const tail = q.includes('.') ? q.split('.').pop()! : q;

        const exactMatches = sorted.filter(
          c => c.name.toLowerCase() === tail || c.qualifiedName.toLowerCase() === q
        );
        if (exactMatches.length === 1) {
          console.error(`-> Dominant exact-name match among FTS candidates: ${exactMatches[0].nodeId}`);
          const node = this.graph.getNode(exactMatches[0].nodeId)!;
          return { status: 'resolved', anchors: [this.mapNodeToResolved(node)] };
        }

        const top = sorted[0];
        const second = sorted[1];
        if (
          top.score !== undefined &&
          second.score !== undefined &&
          top.score > 0 &&
          top.score >= second.score * 2
        ) {
          console.error(`-> Dominant top-score FTS match: ${top.nodeId} (${top.score} vs ${second.score})`);
          const node = this.graph.getNode(top.nodeId)!;
          return { status: 'resolved', anchors: [this.mapNodeToResolved(node)] };
        }

        console.error(`-> Ambiguous FTS match: ${candidates.length} candidates`);
        return {
          status: 'ambiguous',
          candidates: sorted.slice(0, 10)
        };
      }
    }

    console.error(`-> Anchor not found for query: "${query}"`);
    return {
      status: 'not_found',
      query
    };
  }

  /**
   * Resolves multiple anchor specs.
   *
   * With `autoPick` (used by traversal tools — explore/trace/impact), an ambiguous query
   * does NOT bail: the best-ranked candidate is chosen and the query proceeds, recording a
   * Disambiguation so the caller can surface "picked X; also matched Y, Z". This eliminates
   * the search_symbols → copy-nodeId → explore round-trip and lets loose / natural-language
   * queries resolve directly. Without `autoPick` (used by search_symbols), ambiguity is
   * returned as a candidate list for the caller to choose from.
   */
  public resolveAll(
    specs: AnchorSpec[],
    opts: { autoPick?: boolean; tolerateMissing?: boolean } = {}
  ): MultiAnchorResolutionResult {
    const resolvedAnchors: ResolvedAnchor[] = [];
    const ambiguousAnchors: Array<{ query: string; candidates: AnchorCandidate[] }> = [];
    const missingQueries: string[] = [];
    const disambiguations: Disambiguation[] = [];
    // Terms dropped for being ambiguous, kept so they can be reinstated if it turns out
    // nothing else resolved — dropping is only sound while some other anchor survives.
    const droppedAmbiguous: Array<{ query: string; candidates: AnchorCandidate[] }> = [];

    for (const spec of specs) {
      const result = this.resolveAnchor(spec);
      if (result.status === 'resolved') {
        resolvedAnchors.push(...result.anchors);
      } else if (result.status === 'ambiguous') {
        if (opts.autoPick && result.candidates.length > 0) {
          const top = result.candidates[0];
          const second = result.candidates[1];

          // In bag-of-terms mode, a *fuzzy* match with no dominant winner is misresolution
          // waiting to happen — a broad term like "retrieval" or "context" matches several
          // unrelated symbols equally well, and pinning it to an arbitrary one is worse than
          // not anchoring on it at all. Drop it; the low-confidence note reports the shortfall.
          // (Exact-name ambiguity has no score and IS worth picking — all candidates are real
          // exact matches, so the ranked best is a reasonable choice.)
          // Threshold calibrated against real queries: "discovery" gives CandidateDiscovery
          // (16.8) over the runner-up (11.8) = 1.42x — a clear winner worth taking; "context"
          // gives three classes tied at 16.8 = 1.0x — genuinely ambiguous, worth dropping.
          const DOMINANCE_RATIO = 1.25;
          const isFuzzy = top.score !== undefined;
          const dominant =
            !isFuzzy || second?.score === undefined || top.score! >= second.score! * DOMINANCE_RATIO;
          if (opts.tolerateMissing && isFuzzy && !dominant) {
            console.error(`-> Dropping ambiguous fuzzy term "${spec.query}" (${result.candidates.length} comparable candidates)`);
            missingQueries.push(spec.query);
            droppedAmbiguous.push({ query: spec.query, candidates: result.candidates });
            continue;
          }

          const node = this.graph.getNode(top.nodeId);
          if (node) {
            const chosen = this.mapNodeToResolved(node);
            resolvedAnchors.push(chosen);
            disambiguations.push({
              query: spec.query,
              chosen,
              alternatives: result.candidates.slice(1, 4)
            });
            console.error(`-> Auto-picked "${spec.query}" -> ${chosen.nodeId} (${result.candidates.length} candidates)`);
            continue;
          }
        }
        ambiguousAnchors.push({
          query: spec.query,
          candidates: result.candidates
        });
      } else if (result.status === 'not_found') {
        missingQueries.push(result.query);
      }
    }

    // Multi-anchor flow mode: a bag of terms will include noise ("data", "flow") that
    // resolves to nothing. Drop those and proceed with whatever anchors resolved, as long
    // as at least one did.
    if (opts.tolerateMissing) {
      // Nothing survived, but some terms were dropped for being ambiguous — meaning we DID
      // find plausible symbols and then threw them away. Reinstate the best of them.
      //
      // Dropping an ambiguous term is only defensible while another anchor still carries the
      // query; as the last one standing it turns a real result into "no symbols matched",
      // which is simply false. A user asking "how does orchestration work" against a project
      // containing OrchestratorAgent should get it, flagged as a best guess, rather than
      // nothing. The alternatives ride along in the disambiguation so the choice is visible
      // and correctable.
      if (resolvedAnchors.length === 0 && droppedAmbiguous.length > 0) {
        const best = droppedAmbiguous
          .filter(d => d.candidates.length > 0)
          .sort((a, b) => (b.candidates[0].score ?? 0) - (a.candidates[0].score ?? 0))[0];

        const node = best ? this.graph.getNode(best.candidates[0].nodeId) : undefined;
        if (best && node) {
          const chosen = this.mapNodeToResolved(node);
          resolvedAnchors.push(chosen);
          disambiguations.push({
            query: best.query,
            chosen,
            alternatives: best.candidates.slice(1, 4)
          });
          const stillMissing = missingQueries.indexOf(best.query);
          if (stillMissing !== -1) missingQueries.splice(stillMissing, 1);
          console.error(
            `-> No anchors survived; reinstating best candidate for "${best.query}" -> ${chosen.nodeId}`
          );
        }
      }

      if (resolvedAnchors.length === 0) {
        return { status: 'not_found', missingQueries };
      }
      return {
        status: 'resolved',
        anchors: resolvedAnchors,
        disambiguations: disambiguations.length > 0 ? disambiguations : undefined
      };
    }

    if (missingQueries.length > 0) {
      return {
        status: 'not_found',
        missingQueries
      };
    }

    if (ambiguousAnchors.length > 0) {
      return {
        status: 'ambiguous',
        ambiguousAnchors
      };
    }

    return {
      status: 'resolved',
      anchors: resolvedAnchors,
      disambiguations: disambiguations.length > 0 ? disambiguations : undefined
    };
  }

  private mapNodeToResolved(node: KGNode): ResolvedAnchor {
    return {
      nodeId: node.id,
      name: node.name,
      qualifiedName: node.qualifiedName,
      file: node.filePath
    };
  }

  private mapNodeToCandidate(node: KGNode): AnchorCandidate {
    return {
      nodeId: node.id,
      name: node.name,
      qualifiedName: node.qualifiedName,
      file: node.filePath
    };
  }

  /**
   * Orders candidate nodes best-first for auto-pick / capped ambiguous lists.
   * Heuristic: prefer non-test/scratch files, then exported symbols, then the shorter
   * (more direct) qualified name.
   */
  private rankNodes(nodes: KGNode[]): KGNode[] {
    return [...nodes].sort((a, b) => {
      const aPeripheral = isPeripheralFile(a.filePath) ? 1 : 0;
      const bPeripheral = isPeripheralFile(b.filePath) ? 1 : 0;
      if (aPeripheral !== bPeripheral) return aPeripheral - bPeripheral;

      const aExported = a.properties?.exported ? 0 : 1;
      const bExported = b.properties?.exported ? 0 : 1;
      if (aExported !== bExported) return aExported - bExported;

      return a.qualifiedName.length - b.qualifiedName.length;
    });
  }
}
