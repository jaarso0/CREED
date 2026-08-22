import type { Database, Statement } from 'better-sqlite3';
import { openDatabase } from '../storage/sqlite/db.js';
import { MIN_TRIGRAM_LENGTH } from '../storage/sqlite/schema.js';
import { rowToSymbol, SymbolRow } from '../storage/sqlite/row-mappers.js';
import { KGNode, KGEdge, KGEdgeKind } from '../graph/graph.js';
import { SymbolIndex, SymbolMatch, FilePathMatch } from './symbol-index.js';
import { SymbolKind } from '../semantic-model/types.js';

const SYMBOL_COLS = `
  id, kind, name, name_lower, qualified_name, qualified_name_lower,
  file_path, file_path_lower, start_line, start_col, end_line, end_col,
  exported, visibility, metadata, is_project
`;

/**
 * `SymbolIndex` served from `.creed/graph.db`.
 *
 * Exact lookups use ordinary B-tree indexes. Substring lookups — the ones that
 * previously walked every entry of an in-memory Map on every query token — go
 * through the FTS5 trigram index, which is the single biggest reason this backend
 * exists. Measured on a synthetic 400k-symbol corpus with selective tokens:
 * 190 ms of Map scanning becomes ~2 ms of indexed matching.
 *
 * Endpoints and services stay as small in-memory Maps: they are a tiny, bounded
 * fraction of symbols, derived from JSON metadata that is awkward to index and
 * cheap to hold.
 */
export class SqliteSymbolIndex implements SymbolIndex {
  private db: Database;
  private ownsConnection: boolean;

  private stmts: {
    byName: Statement;
    byQualifiedName: Statement;
    ftsName: Statement;
    ftsQualifiedName: Statement;
    ftsFilePath: Statement;
    likeName: Statement;
    likeQualifiedName: Statement;
    likeFilePath: Statement;
    namePrefix: Statement;
    incomingEdges: Statement;
    endpointCandidates: Statement;
    serviceCandidates: Statement;
  };

  private endpoints: Map<string, KGNode> | null = null;
  private services: Map<string, KGNode> | null = null;

  constructor(projectRootOrDb: string | Database) {
    if (typeof projectRootOrDb === 'string') {
      this.db = openDatabase(projectRootOrDb, { readonly: true });
      this.ownsConnection = true;
    } else {
      this.db = projectRootOrDb;
      this.ownsConnection = false;
    }

    // Trigram MATCH narrows to candidate rows; the `LIKE` then restricts the hit to
    // the specific column (MATCH searches all three) and `<>` excludes exact matches
    // so callers receive each node once, exactly as the Map-based implementation did.
    // The join is on integer rowid — see the note in schema.ts on why that matters.
    const ftsQuery = (col: string) => `
      SELECT ${SYMBOL_COLS.split(',').map(c => 's.' + c.trim()).join(', ')}
        FROM symbols_fts f
        JOIN symbols s ON s.rowid = f.rowid
       WHERE f.symbols_fts MATCH @match
         AND s.${col} LIKE @like
         AND s.${col} <> @token
    `;
    const likeQuery = (col: string) => `
      SELECT ${SYMBOL_COLS} FROM symbols
       WHERE ${col} LIKE @like AND ${col} <> @token
    `;

    this.stmts = {
      byName: this.db.prepare(`SELECT ${SYMBOL_COLS} FROM symbols WHERE name_lower = ?`),
      byQualifiedName: this.db.prepare(
        `SELECT ${SYMBOL_COLS} FROM symbols WHERE qualified_name_lower = ?`
      ),
      ftsName: this.db.prepare(ftsQuery('name_lower')),
      ftsQualifiedName: this.db.prepare(ftsQuery('qualified_name_lower')),
      ftsFilePath: this.db.prepare(`
        SELECT ${SYMBOL_COLS.split(',').map(c => 's.' + c.trim()).join(', ')}
          FROM symbols_fts f
          JOIN symbols s ON s.rowid = f.rowid
         WHERE f.symbols_fts MATCH @match
           AND s.file_path_lower LIKE @like
      `),
      likeName: this.db.prepare(likeQuery('name_lower')),
      likeQualifiedName: this.db.prepare(likeQuery('qualified_name_lower')),
      likeFilePath: this.db.prepare(
        `SELECT ${SYMBOL_COLS} FROM symbols WHERE file_path_lower LIKE @like`
      ),
      // Anchored LIKE, so idx_symbols_name_lower serves this as a range seek rather
      // than a scan — the reason the typo fallback keys off a prefix at all.
      namePrefix: this.db.prepare(
        `SELECT ${SYMBOL_COLS} FROM symbols
          WHERE name_lower LIKE @prefix ESCAPE '\\' LIMIT @limit`
      ),
      incomingEdges: this.db.prepare(`
        SELECT parent_id AS source_id, child_id AS target_id, kind, NULL AS resolution_method
          FROM containments WHERE child_id = @id
        UNION ALL
        SELECT from_symbol_id AS source_id, to_symbol_id AS target_id, kind, resolution_method
          FROM resolved_references WHERE to_symbol_id = @id
      `),
      // Endpoint/service metadata lives inside the JSON blob; these narrow the scan
      // to plausible rows before parsing, and run at most once per index.
      endpointCandidates: this.db.prepare(
        `SELECT ${SYMBOL_COLS} FROM symbols WHERE metadata LIKE '%apiRoute%'`
      ),
      serviceCandidates: this.db.prepare(
        `SELECT ${SYMBOL_COLS} FROM symbols
          WHERE kind = 'class' AND (metadata LIKE '%isService%' OR name LIKE '%Service')`
      )
    };
  }

  public close(): void {
    if (!this.ownsConnection) return;
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  /** Drops derived caches after the underlying index was rewritten. */
  public refresh(): void {
    this.endpoints = null;
    this.services = null;
  }

  // ── mapping ───────────────────────────────────────────────────────────────

  private toNode(row: SymbolRow): KGNode {
    const symbol = rowToSymbol(row);
    return {
      id: symbol.id,
      kind: symbol.kind as SymbolKind,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      filePath: symbol.filePath,
      properties: {
        range: symbol.range,
        exported: symbol.exported,
        visibility: symbol.visibility,
        ...symbol.metadata
      }
    };
  }

  /**
   * FTS5 MATCH syntax: the token is quoted so punctuation common in identifiers and
   * paths (`.`, `/`, `_`, `-`) is treated as literal text rather than as query
   * operators. Embedded double quotes are doubled per FTS5's escaping rule.
   */
  private matchExpr(token: string): string {
    return `"${token.replace(/"/g, '""')}"`;
  }

  // ── exact lookups ─────────────────────────────────────────────────────────

  public getByName(nameLower: string): KGNode[] {
    return (this.stmts.byName.all(nameLower) as SymbolRow[]).map(r => this.toNode(r));
  }

  public getByQualifiedName(qnameLower: string): KGNode[] {
    return (this.stmts.byQualifiedName.all(qnameLower) as SymbolRow[]).map(r => this.toNode(r));
  }

  // ── substring lookups ─────────────────────────────────────────────────────

  /**
   * Tokens shorter than a trigram cannot be served by the FTS index, so they fall
   * back to a base-table LIKE scan. Discovery only admits tokens of length >= 2, so
   * this affects 2-character tokens alone — rare, and correctness is identical
   * either way.
   */
  private substringRows(
    token: string,
    ftsStmt: Statement,
    likeStmt: Statement
  ): SymbolRow[] {
    const like = `%${token}%`;
    if (token.length < MIN_TRIGRAM_LENGTH) {
      return likeStmt.all({ like, token }) as SymbolRow[];
    }
    return ftsStmt.all({ match: this.matchExpr(token), like, token }) as SymbolRow[];
  }

  public matchByName(token: string): SymbolMatch[] {
    const exact = this.getByName(token).map(node => ({ node, exact: true }));
    const partial = this.substringRows(token, this.stmts.ftsName, this.stmts.likeName)
      .map(r => ({ node: this.toNode(r), exact: false }));
    return [...exact, ...partial];
  }

  public matchByQualifiedName(token: string): SymbolMatch[] {
    const exact = this.getByQualifiedName(token).map(node => ({ node, exact: true }));
    const partial = this.substringRows(
      token,
      this.stmts.ftsQualifiedName,
      this.stmts.likeQualifiedName
    ).map(r => ({ node: this.toNode(r), exact: false }));
    return [...exact, ...partial];
  }

  public matchByFilePath(token: string): FilePathMatch[] {
    const like = `%${token}%`;
    const rows =
      token.length < MIN_TRIGRAM_LENGTH
        ? (this.stmts.likeFilePath.all({ like }) as SymbolRow[])
        : (this.stmts.ftsFilePath.all({ match: this.matchExpr(token), like }) as SymbolRow[]);

    return rows.map(r => {
      const node = this.toNode(r);
      return { node, filePath: node.filePath };
    });
  }

  public namesStartingWith(prefix: string, limit: number): KGNode[] {
    // `prefix` comes from a tokenized query term, so it can contain LIKE wildcards
    // (`_` is legal in identifiers and matches any character); escape them.
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    const rows = this.stmts.namePrefix.all({
      prefix: `${escaped}%`,
      limit
    }) as SymbolRow[];
    return rows.map(r => this.toNode(r));
  }

  // ── endpoints & services ──────────────────────────────────────────────────

  public getEndpoint(endpointKey: string): KGNode | undefined {
    if (this.endpoints === null) {
      this.endpoints = new Map();
      for (const row of this.stmts.endpointCandidates.all() as SymbolRow[]) {
        const node = this.toNode(row);
        const route = node.properties?.apiRoute as { path?: string; method?: string } | undefined;
        if (route?.method && route?.path) {
          this.endpoints.set(`${route.method.toUpperCase()} ${route.path}`, node);
        }
      }
    }
    return this.endpoints.get(endpointKey);
  }

  public getService(name: string): KGNode | undefined {
    if (this.services === null) {
      this.services = new Map();
      for (const row of this.stmts.serviceCandidates.all() as SymbolRow[]) {
        const node = this.toNode(row);
        if (node.properties?.isService === true || node.name.endsWith('Service')) {
          this.services.set(node.name, node);
        }
      }
    }
    return this.services.get(name);
  }

  // ── edges ─────────────────────────────────────────────────────────────────

  public getIncomingEdges(nodeId: string): KGEdge[] {
    const rows = this.stmts.incomingEdges.all({ id: nodeId }) as {
      source_id: string;
      target_id: string;
      kind: string;
      resolution_method: string | null;
    }[];

    return rows.map(row => {
      const edge: KGEdge = {
        sourceId: row.source_id,
        targetId: row.target_id,
        kind: row.kind as KGEdgeKind
      };
      if (row.resolution_method !== null) {
        edge.resolutionMethod = row.resolution_method as KGEdge['resolutionMethod'];
      }
      return edge;
    });
  }
}
