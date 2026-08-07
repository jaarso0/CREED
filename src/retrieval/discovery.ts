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

export class CandidateDiscovery {
  private indexes: SymbolIndex;
  // Common English + generic programming words that are noise as query terms — filtered out
  // so "how does the auth service class work" anchors on "auth"/"service", not "class"/"work".
  private stopWords = new Set([
    'add', 'delete', 'update', 'fix', 'remove', 'get', 'set', 'support', 'for', 'in', 'and',
    'the', 'is', 'to', 'how', 'does', 'where', 'a', 'an', 'of', 'on', 'with', 'from', 'into',
    'via', 'flow', 'data', 'layer', 'handle', 'request', 'response', 'return', 'value', 'result',
    'config', 'options', 'params', 'args', 'item', 'work', 'file', 'use', 'make', 'this', 'that',
    'which', 'what', 'when', 'why', 'who', 'class', 'method', 'function', 'code', 'way'
  ]);
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
    const tokens = this.tokenize(taskQuery);
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

    // Heuristic 2: Search by token matches in names, qualified names, and paths.
    // These were four full scans over in-memory Maps per token; they are now index
    // lookups (FTS5 trigram for the substring cases). The point values, reason
    // strings and ordering are unchanged — only how the matches are found differs.
    for (const token of tokens) {
      const tokLower = token.toLowerCase();

      const serviceNode = this.indexes.getService(token);
      if (serviceNode) {
        this.addOrScore(candidates, serviceNode, 10, `Exact Service Name Match: ${token}`, tokLower);
      }

      for (const { node: n, exact } of this.indexes.matchByName(tokLower)) {
        if (exact) this.addOrScore(candidates, n, 8, `Exact Symbol Name Match: ${n.name}`, tokLower);
        else this.addOrScore(candidates, n, 4, `Substring Symbol Name Match: ${n.name}`, tokLower);
      }

      for (const { node: n, exact } of this.indexes.matchByQualifiedName(tokLower)) {
        if (exact) this.addOrScore(candidates, n, 6, `Exact Qualified Name Match: ${n.qualifiedName}`, tokLower);
        else this.addOrScore(candidates, n, 3, `Substring Qualified Name Match: ${n.qualifiedName}`, tokLower);
      }

      for (const { node: n, filePath } of this.indexes.matchByFilePath(tokLower)) {
        const mult = (n.kind === 'class' || n.kind === 'function') ? 5 : 2;
        this.addOrScore(candidates, n, mult, `File Path Match: ${filePath}`, tokLower);
      }
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
      // relevant than one matching a single term (and single common-word matches get dampened).
      if (c.tokens.size >= 2) score *= (1 + (c.tokens.size - 1) * 0.5);

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

      return { node: c.node, score, matchReasons: c.reasons };
    }).sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  private tokenize(query: string): string[] {
    return query
      .replace(/[^a-zA-Z0-9_/]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !this.stopWords.has(t.toLowerCase()));
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
