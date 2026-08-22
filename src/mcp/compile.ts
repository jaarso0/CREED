import {
  GraphQueryPlan,
  SearchSymbolsArgs,
  ExploreRegionArgs,
  TracePathArgs,
  AnalyzeImpactArgs,
  ExploreArgs,
  ExploreFlowArgs
} from './types.js';
import { HARD_STOPWORDS, WEAK_TERMS } from '../retrieval/discovery.js';

// Prose that is never the symbol you mean. Shared with CandidateDiscovery rather than kept
// as a second list here: the two drifted, and the drift was visible in the output — a word
// this file admitted as an anchor but discovery discarded as filler ("breaks", "happens")
// resolved to nothing and was then reported to the caller as a term that matched nothing.
const FLOW_STOPWORDS = new Set([
  ...HARD_STOPWORDS,
  ...WEAK_TERMS,
  'across', 'through', 'between', 'out'
]);

// A token is worth resolving as an anchor if it *looks like* a code identifier — camelCase /
// PascalCase, a dotted filename (walker.ts), a path, or snake_case — OR it's a plain lowercase
// word that isn't obvious English filler (so real lowercase symbols like `walk`, `charge`,
// `refund` still pass, while `how`, `does`, `file`, `work` are dropped).
function looksLikeAnchor(token: string): boolean {
  if (token.length <= 1) return false;
  const hasIdentifierShape = /[A-Z]/.test(token) || /[._/]/.test(token) || token.includes('_');
  if (hasIdentifierShape) return true;               // buildGraph, walker.ts, src/parse, snake_case
  if (!/^[a-z]+$/.test(token)) return false;         // odd tokens: skip
  return !FLOW_STOPWORDS.has(token);                 // plain lowercase word, not filler
}

/** Identifier-shaped terms worth resolving exactly, before ranking gets a say. */
function identifierTerms(query: string, max: number): string[] {
  return query
    .split(/\s+/)
    .map(t => t.trim().replace(/[?!,;:()"']+$/g, '').replace(/^["'(]+/g, ''))
    .filter(looksLikeAnchor)
    .slice(0, max);
}

/**
 * What shape of answer the question is asking for.
 *
 * "what breaks if I change X" and "how does X work" want opposite traversals — the first
 * wants X's callers, the second wants what X calls — and getting it wrong means returning
 * a correct neighborhood of the wrong side. With one tool there is no separate
 * `analyze_impact` to carry that intent, so it is read off the question instead.
 */
const IMPACT_PATTERN =
  /\b(break|breaks|breaking|impact|affects?|affected|callers?|who calls|call(s|ed)? (it|this)|depend(s|ent|ents|encies)?|refactor|rename|safe to (change|delete|remove)|before (i )?(change|delete|remove))\b/i;

export function detectIntent(query: string): {
  direction: 'incoming' | 'outgoing' | 'both';
  depth: number;
} {
  if (IMPACT_PATTERN.test(query)) {
    // Callers, and callers of callers — the dependency cone `analyze_impact` used to return.
    return { direction: 'incoming', depth: 2 };
  }
  return { direction: 'both', depth: 1 };
}

/**
 * The single entry point. Compiles any question — plain English, a bag of symbol names, or
 * both — into one plan: resolve a set of anchors from the whole query, traverse around them,
 * synthesize the paths connecting them, and return their source.
 */
export function compileExplore(args: ExploreArgs): GraphQueryPlan {
  const query = args.query.trim();
  const maxAnchors = args.maxAnchors ?? 8;
  const intent = detectIntent(query);
  const terms = identifierTerms(query, maxAnchors);

  return {
    operation: 'region',
    // Anchors must be non-empty. When the question is entirely prose ("what happens when a
    // file changes"), the whole query stands in as the single spec; `resolveFreeForm` sees
    // it has whitespace, skips exact resolution for it, and lets ranking do the work.
    anchors: terms.length > 0
      ? terms.map(t => ({ query: t, resolution: 'auto' as const }))
      : [{ query, resolution: 'search' as const }],
    constraints: {
      direction: args.direction ?? intent.direction,
      requestedDepth: args.depth ?? intent.depth,
      edgeKinds: args.edgeKinds,
      freeFormQuery: query,
      maxAnchors,
      tolerateMissingAnchors: true,
      synthesizeFlow: true
    },
    materialize: {
      source: true,
      callsites: true,
      signatures: true,
      docs: true
    }
  };
}

/** @deprecated Kept so existing callers keep working; `compileExplore` supersedes it. */
export function compileExploreFlow(args: ExploreFlowArgs): GraphQueryPlan {
  return compileExplore({ query: args.query, depth: args.depth, maxAnchors: args.maxAnchors });
}

export function compileSearchSymbols(args: SearchSymbolsArgs): GraphQueryPlan {
  const expand = args.expand !== false;
  return {
    operation: 'region',
    anchors: [
      {
        query: args.query,
        kind: args.kind,
        resolution: 'auto'
      }
    ],
    constraints: {
      direction: 'both',
      // 0 when not expanding (bare candidate/anchor info only); otherwise a real
      // neighborhood depth so a single unambiguous match doubles as an explore_region
      // call — searchMode keeps ambiguous multi-match results returning the flat
      // candidate list either way (see GraphQueryPlan.constraints.searchMode).
      // Depth kept at 1 (not 2) and node count well below explore_region's default:
      // depth 2/both on a heavily-referenced symbol (a common utility class, say) can
      // fan out into hundreds of edges — observed producing a 75K+ character response
      // that exceeded the caller's token limit entirely. This is meant to be a cheap
      // "what is this and who touches it directly" convenience, not a full traversal;
      // callers who want more should follow up with explore_region.
      requestedDepth: expand ? (args.depth ?? 1) : 0,
      requestedNodes: expand ? 40 : undefined,
      searchMode: true
    },
    materialize: {
      source: expand,
      callsites: expand,
      signatures: true,
      docs: true
    }
  };
}

export function compileExploreRegion(args: ExploreRegionArgs): GraphQueryPlan {
  return {
    operation: 'region',
    anchors: [
      {
        query: args.anchor,
        resolution: 'auto'
      }
    ],
    constraints: {
      direction: args.direction || 'outgoing',
      requestedDepth: args.depth !== undefined ? args.depth : 3,
      edgeKinds: args.edgeKinds
    },
    materialize: {
      source: true,
      callsites: true,
      signatures: true,
      docs: true
    }
  };
}

export function compileTracePath(args: TracePathArgs): GraphQueryPlan {
  return {
    operation: 'path',
    anchors: [
      {
        query: args.from,
        resolution: 'auto'
      },
      {
        query: args.to,
        resolution: 'auto'
      }
    ],
    constraints: {
      edgeKinds: args.edgeKinds,
      requestedDepth: args.maxDepth !== undefined ? args.maxDepth : 6
    },
    materialize: {
      source: true,
      callsites: true,
      signatures: true,
      docs: true
    }
  };
}

export function compileAnalyzeImpact(args: AnalyzeImpactArgs): GraphQueryPlan {
  return {
    operation: 'impact',
    anchors: [
      {
        query: args.anchor,
        resolution: 'auto'
      }
    ],
    constraints: {
      requestedDepth: args.maxDepth !== undefined ? args.maxDepth : 3
    },
    materialize: {
      source: true,
      callsites: true,
      signatures: true,
      docs: true
    }
  };
}
