import { SymbolIndex } from './symbol-index.js';
import { CandidateResult } from './types.js';
import { KGNode } from '../graph/graph.js';

interface Candidate {
  node: KGNode;
  score: number;
  reasons: string[];
  tokens: Set<string>; // distinct query tokens that matched this node
}

/** Kinds that represent a real definition — what a code-navigation query almost always means. */
export const DEFINITION_KINDS = new Set([
  'class', 'interface', 'struct', 'function', 'method', 'type_alias', 'enum'
]);

/**
 * Pure English filler. These are never the symbol anyone means, in any codebase, so
 * they are dropped outright.
 *
 * Deliberately narrower than it used to be. Words like `config`, `request`, `file` and
 * `handle` were on this list and are *extremely* common real symbol names — filtering
 * them meant the query "config" tokenized to nothing and resolved to nothing at all.
 * They now live in WEAK_TERMS: searched, but discounted when they're the only evidence.
 */
export const HARD_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'via',
  'and', 'or', 'but', 'if', 'then', 'else', 'so', 'than', 'as', 'not',
  'how', 'what', 'when', 'where', 'why', 'which', 'who', 'does', 'do', 'did',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'you', 'they', 'them', 'i',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'work', 'works', 'working', 'way', 'ways', 'thing', 'things', 'about',
  'over', 'under', 'up', 'down', 'off', 'all', 'any', 'each', 'some', 'other', 'same',
  'before', 'after', 'during', 'instead', 'also', 'still', 'just', 'only', 'more', 'most',
  // Verbs that state what the caller wants *done* rather than what they are asking about.
  // "what breaks if I change processPlan" is a question about `processPlan`; treating
  // "breaks" and "change" as symbol candidates only produced phantom unmatched terms.
  'happens', 'happen', 'break', 'breaks', 'breaking', 'broke', 'broken',
  'change', 'changes', 'changed', 'modify', 'modifies', 'edit', 'edits',
  'affect', 'affects', 'affected', 'impact', 'impacts', 'refactor', 'rename',
  'show', 'tell', 'explain', 'describe', 'find', 'look', 'see', 'know', 'need', 'want',
  'happens', 'called', 'calling', 'goes', 'go', 'come', 'comes', 'give', 'gives'
]);

/**
 * Generic programming vocabulary: plausible as a symbol name, but far too common to be
 * evidence on its own. A candidate that matched *only* weak terms is dampened during
 * re-ranking, so `getUserConfig` still beats a random `config` field for the query
 * "user config" — while a bare "config" query still resolves to something.
 */
export const WEAK_TERMS = new Set([
  'add', 'delete', 'update', 'fix', 'remove', 'get', 'set', 'support', 'use', 'make',
  'flow', 'data', 'layer', 'handle', 'request', 'response', 'return', 'value', 'result',
  'config', 'options', 'params', 'args', 'item', 'file', 'files', 'code',
  'class', 'method', 'function', 'type', 'object', 'name', 'id', 'key', 'list', 'map'
]);

/**
 * Suffixes stripped when a search term matches nothing literally. Longest first so the
 * biggest one wins ("orchestration" → "orchestr", not "orchestrat" + a dangling "ion").
 *
 * Deliberately crude — a real stemmer would be overkill, and this only ever runs as a
 * fallback, so an over-eager stem costs a few extra candidates rather than wrong answers.
 * Sorted at module load so entries can be added in any order without silently shadowing
 * a longer suffix.
 */
const STEM_SUFFIXES = [
  'ational', 'ization', 'isation', 'ations', 'ation', 'ition', 'ings', 'ing',
  'ment', 'ness', 'ities', 'ity', 'ance', 'ence', 'able', 'ible', 'ives', 'ive',
  'ers', 'er', 'ors', 'or', 'ies', 'es', 'ed', 'ly', 'al', 'ism', 'ist', 'ize', 'ise',
  'ful', 'less', 'ion', 's'
].sort((a, b) => b.length - a.length);

/** The stem of a term, or null when there's nothing safe to strip. */
export function stemToken(token: string): string | null {
  for (const suffix of STEM_SUFFIXES) {
    // Keep at least 4 characters, or "class" → "clas" and "series" → "ser" start matching
    // everything. A 4-char stem is still selective enough to be useful.
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return null;
}

/**
 * Progressively shorter prefixes to try when neither the literal term nor its stem
 * matched anything. English and code often diverge past the root — "resolution" vs
 * `resolve`, "traversal" vs `traverse`, "authentication" vs `authorize` — and no suffix
 * table bridges those. A prefix does: "resol" reaches `AnchorResolver`.
 *
 * Bounded to three attempts and never shorter than 5 characters (4 for short tokens),
 * because below that a prefix stops being selective and starts matching everything.
 */
export function prefixLadder(token: string): string[] {
  if (token.length < 6) return [];
  const floor = 5;
  const lengths = [token.length - 2, token.length - 3, floor]
    .filter(n => n >= floor && n < token.length);
  return [...new Set(lengths)].map(n => token.slice(0, n));
}

/**
 * Edit distance between `a` and `b`, or `null` once it provably exceeds `max`.
 * Row-at-a-time with an early bail, so a rejected pair costs a few comparisons
 * rather than a full matrix.
 */
export function levenshteinWithin(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null;
  if (a === b) return 0;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return null;
    [prev, curr] = [curr, prev];
  }

  const distance = prev[b.length];
  return distance <= max ? distance : null;
}

/** How many names the typo fallback is willing to pull for one failed token. */
const FUZZY_SCAN_LIMIT = 600;

export class CandidateDiscovery {
  private indexes: SymbolIndex;

  // Recognizes test/scratch/fixture code in any common shape: a dir segment (tests/, scratch/,
  // __tests__/, fixtures/), a suffix (foo.test.ts, foo.spec.js), a hyphen/underscore variant
  // (scratch-test.js, test-utils.ts, foo_test.py), or anything under a "scratch" path.
  private isPeripheral(filePath: string): boolean {
    const p = filePath.replace(/\\/g, '/').toLowerCase();
    if (/(^|\/)(tests?|__tests__|specs?|fixtures?|mocks?|examples?)(\/)/.test(p)) return true;
    if (p.includes('scratch')) return true;
    const base = p.split('/').pop() || p;
    return /[.\-_](test|spec)[.\-_]/.test(base) || /^(test|spec)[.\-_]/.test(base) || /[.\-_](test|spec)\.[a-z0-9]+$/.test(base);
  }

  constructor(indexes: SymbolIndex) {
    this.indexes = indexes;
  }

  public discover(taskQuery: string, limit: number = 10): CandidateResult[] {
    const { strong: tokens, weak } = this.tokenize(taskQuery);
    const candidates = new Map<string, Candidate>();

    if (tokens.length === 0) return [];

    const wantsTests = /\b(tests?|specs?|fixtures?|mocks?)\b/i.test(taskQuery);

    // Heuristic 1: Match HTTP methods and routes (e.g. "POST /login" or "GET /users")
    const routeMatch = taskQuery.match(/(GET|POST|PUT|DELETE|PATCH)\s+([^\s]+)/i);
    if (routeMatch) {
      const method = routeMatch[1].toUpperCase();
      const path = routeMatch[2];
      const endpointKey = `${method} ${path}`;
      const node = this.indexes.getEndpoint(endpointKey);
      if (node) {
        this.addOrScore(candidates, node, 15, `Exact Endpoint Match: ${endpointKey}`);
      }
    }

    // Heuristic 2: per-token match cascade. Each stage only runs when the cheaper one
    // above it found nothing, so the common case costs exactly what it used to and the
    // expensive fallbacks are reserved for terms that would otherwise resolve to nothing.
    for (const token of tokens) {
      const tokLower = token.toLowerCase();
      let hits = this.scoreToken(candidates, tokLower, tokLower, '', 1, { rawTerm: token });

      // Nothing matched literally. People ask in English — "how does orchestration work" —
      // while the code says `orchestrator`, and "orchestration" is not a substring of
      // "orchestrator", so the whole query returned nothing. Retry on the stem.
      //
      // Scored at full weight on purpose. Discounting it seems safer but isn't: the
      // re-ranking below adds *additive* bonuses (co-location, brevity), so scaling the
      // base scores down lets those constants compress the gap between the top two
      // candidates — which pushes the result under resolveAll's dominance ratio and gets
      // the whole term dropped as "ambiguous". And there is nothing to lose a tie-break
      // against anyway: this only runs when the literal token matched nothing.
      if (hits === 0) {
        const stem = stemToken(tokLower);
        if (stem && stem !== tokLower) {
          hits += this.scoreToken(candidates, stem, tokLower, ' (stem)');
        }
      }

      // Still nothing: walk down the prefix ladder. Scored lower because a short prefix is
      // much less selective than a whole term.
      if (hits === 0) {
        for (const prefix of prefixLadder(tokLower)) {
          hits += this.scoreToken(candidates, prefix, tokLower, ' (prefix)', 0.5);
          if (hits > 0) break;
        }
      }

      // Last resort: assume a typo.
      if (hits === 0) {
        hits += this.scoreFuzzy(candidates, tokLower);
      }
    }

    // Generic terms alongside specific ones ("request" in "request handler"): worth scoring,
    // because a node matching both is the answer, but at a fraction of the weight and without
    // the file-path channel — `matchByFilePath('file')` matches half a repository and would
    // cost more than every specific term combined.
    for (const token of weak) {
      this.scoreToken(candidates, token, token, ' (generic)', 0.35, { skipFilePath: true });
    }

    // ── Re-ranking (codegraph-style) ──────────────────────────────────────────
    // Co-location: how many distinct query tokens landed anywhere in each file. A file where
    // several of the query's terms co-occur is very likely the focus of the query.
    const fileTokenUnion = new Map<string, Set<string>>();
    for (const c of candidates.values()) {
      const set = fileTokenUnion.get(c.node.filePath) || new Set<string>();
      c.tokens.forEach(t => set.add(t));
      fileTokenUnion.set(c.node.filePath, set);
    }

    const scored = Array.from(candidates.values()).map(c => {
      let score = c.score;

      // Multi-term co-occurrence: a node matching several distinct query terms is far more
      // relevant than one matching a single term.
      if (c.tokens.size >= 2) score *= (1 + (c.tokens.size - 1) * 0.5);

      // Generic dampening: everything this node matched was generic vocabulary, with no
      // specific term corroborating it. Skipped when the query was *only* generic terms
      // ("config"), where there is nothing else to go on and scaling every candidate by the
      // same constant would change nothing but the numbers.
      const allWeak = c.tokens.size > 0 && [...c.tokens].every(t => WEAK_TERMS.has(t));
      if (allWeak && weak.length > 0) score *= 0.4;

      // Co-location boost: node's file is where multiple query terms landed.
      const coFile = fileTokenUnion.get(c.node.filePath)?.size ?? 0;
      if (coFile >= 2) score += (coFile - 1) * 8;

      // Kind preference: when navigating code you almost always mean the definition, not a
      // field that happens to share the name. Without this, a private field literally named
      // `discovery` outranks the `CandidateDiscovery` class for the query "discovery".
      if (DEFINITION_KINDS.has(c.node.kind)) score *= 1.4;
      else if (c.node.kind === 'variable') score *= 0.5;

      // Brevity bonus: core components have concise names; test/helper classes are verbose.
      if (c.node.kind !== 'file' && c.node.name.length <= 12) score += 2;

      // Test / peripheral demotion — unless the query explicitly asks for tests/fixtures.
      if (!wantsTests && this.isPeripheral(c.node.filePath)) score *= 0.3;

      return { node: c.node, score, matchReasons: c.reasons, tokens: [...c.tokens] };
    }).sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  /**
   * Scores every match for one search term. `searchTerm` is what gets looked up (possibly a
   * stem or prefix); `originToken` is the query word it came from, and is what co-occurrence
   * counts — so a term and its own stem don't count as two independent matches. `note` is
   * appended to the match reasons so the output shows *why* something matched, and `weight`
   * scales the points for the less-certain stages. Returns how many matches it found, so the
   * caller can tell a term that landed from one that didn't.
   */
  private scoreToken(
    candidates: Map<string, Candidate>,
    searchTerm: string,
    originToken: string,
    note: string,
    weight: number = 1,
    opts: { skipFilePath?: boolean; rawTerm?: string } = {}
  ): number {
    let hits = 0;
    const pts = (n: number) => n * weight;

    // The service map is keyed by the symbol's declared name, so this lookup — alone among
    // the channels here — needs the term in its original casing.
    const serviceTerm = opts.rawTerm ?? searchTerm;
    const serviceNode = this.indexes.getService(serviceTerm);
    if (serviceNode) {
      this.addOrScore(candidates, serviceNode, pts(10), `Exact Service Name Match: ${serviceTerm}${note}`, originToken);
      hits++;
    }

    for (const { node: n, exact } of this.indexes.matchByName(searchTerm)) {
      if (exact) {
        this.addOrScore(candidates, n, pts(8), `Exact Symbol Name Match: ${n.name}${note}`, originToken);
      } else {
        // Prefix position is meaningfully stronger evidence than a substring buried mid-name:
        // for "context", `ContextBuilder` is a better answer than `resetContextCacheInternal`.
        const atPrefix = n.name.toLowerCase().startsWith(searchTerm);
        this.addOrScore(
          candidates, n, pts(atPrefix ? 6 : 4),
          `${atPrefix ? 'Prefix' : 'Substring'} Symbol Name Match: ${n.name}${note}`,
          originToken
        );
      }
      hits++;
    }

    for (const { node: n, exact } of this.indexes.matchByQualifiedName(searchTerm)) {
      if (exact) this.addOrScore(candidates, n, pts(6), `Exact Qualified Name Match: ${n.qualifiedName}${note}`, originToken);
      else this.addOrScore(candidates, n, pts(3), `Substring Qualified Name Match: ${n.qualifiedName}${note}`, originToken);
      hits++;
    }

    if (!opts.skipFilePath) {
      for (const { node: n, filePath } of this.indexes.matchByFilePath(searchTerm)) {
        const mult = (n.kind === 'class' || n.kind === 'function') ? 5 : 2;
        this.addOrScore(candidates, n, pts(mult), `File Path Match: ${filePath}${note}`, originToken);
        hits++;
      }
    }

    return hits;
  }

  /**
   * Typo tolerance. Pulls the names sharing this token's first two characters and keeps those
   * within a small edit distance of it.
   *
   * Distance is measured against the *same-length prefix* of each name, not the whole name:
   * a user who types "resolvr" means `resolveAnchor`, and comparing "resolvr" to the full
   * "resolveanchor" is distance 6 — useless. Against its first seven characters ("resolve")
   * it is distance 1, which is exactly the signal we want.
   */
  private scoreFuzzy(candidates: Map<string, Candidate>, token: string): number {
    if (token.length < 4) return 0;

    const maxDistance = token.length <= 5 ? 1 : 2;
    const pool = this.indexes.namesStartingWith(token.slice(0, 2), FUZZY_SCAN_LIMIT);

    // Rank by distance so a near-perfect match isn't buried under a crowd of distance-2 ones.
    const matches: Array<{ node: KGNode; distance: number }> = [];
    for (const node of pool) {
      const name = node.name.toLowerCase();
      const head = name.slice(0, token.length);
      const distance =
        levenshteinWithin(token, head, maxDistance) ?? levenshteinWithin(token, name, maxDistance);
      if (distance !== null) matches.push({ node, distance });
    }

    matches.sort((a, b) => a.distance - b.distance);
    for (const { node, distance } of matches.slice(0, 12)) {
      this.addOrScore(
        candidates, node, distance === 0 ? 6 : 4 - distance,
        `Fuzzy Name Match: ${node.name} (edit distance ${distance})`,
        token
      );
    }
    return matches.length;
  }

  /**
   * Splits a query into `strong` terms (which drive the match cascade) and `weak` ones
   * (generic code vocabulary, scored as corroborating evidence only).
   *
   * Filler is dropped — but only while something survives. "config" is one word, and it is
   * generic vocabulary; filtering it left zero tokens and the query resolved to nothing at
   * all, which is strictly worse than searching for a generic term. So when nothing specific
   * remains, the generic terms are promoted to strong, and failing even that, the filler is.
   */
  private tokenize(query: string): { strong: string[]; weak: string[] } {
    const raw = query
      .replace(/[^a-zA-Z0-9_/]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);

    const strong: string[] = [];
    const weak: string[] = [];
    for (const t of raw) {
      const lower = t.toLowerCase();
      if (HARD_STOPWORDS.has(lower)) continue;
      if (WEAK_TERMS.has(lower)) weak.push(lower);
      else strong.push(t);
    }

    if (strong.length > 0) return { strong, weak };
    if (weak.length > 0) return { strong: weak, weak: [] };
    return { strong: raw, weak: [] };
  }

  private addOrScore(map: Map<string, Candidate>, node: KGNode, points: number, reason: string, token?: string): void {
    const existing = map.get(node.id);
    if (existing) {
      existing.score += points;
      existing.reasons.push(reason);
      if (token) existing.tokens.add(token);
    } else {
      map.set(node.id, {
        node,
        score: points,
        reasons: [reason],
        tokens: token ? new Set([token]) : new Set()
      });
    }
  }
}
