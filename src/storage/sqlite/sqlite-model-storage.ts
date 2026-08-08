import type { Database } from 'better-sqlite3';
import { SemanticModel, Symbol as KGSymbol } from '../../semantic-model/types.js';
import { SemanticModelStorage } from '../semantic-model-storage.js';
import { openDatabase, getDatabasePath, databaseExists } from './db.js';
import { FileRecord, encodePartial } from './partial-cache.js';
import { PIPELINE_VERSION } from './schema.js';
import {
  symbolToRow,
  rowToSymbol,
  scopeToRow,
  rowToScope,
  containmentToRow,
  rowToContainment,
  resolvedReferenceToRow,
  rowToResolvedReference,
  referenceCandidateToRow,
  rowToReferenceCandidate,
  diagnosticToRow,
  rowToDiagnostic,
  SymbolRow,
  ScopeRow,
  ContainmentRow,
  ResolvedReferenceRow,
  ReferenceCandidateRow,
  DiagnosticRow
} from './row-mappers.js';

/**
 * Persists the SemanticModel to a normalized, indexed SQLite database at
 * `.masai/graph.db`, replacing the single pretty-printed JSON document.
 *
 * Implements the same `SemanticModelStorage` contract as the JSON version and
 * returns a structurally identical `SemanticModel` from `load()`, so every
 * existing consumer works unchanged.
 */
export class SqliteSemanticModelStorage implements SemanticModelStorage {
  public getStoragePath(projectRoot: string): string {
    return getDatabasePath(projectRoot);
  }

  public exists(projectRoot: string): boolean {
    return databaseExists(projectRoot);
  }

  /**
   * `fileRecords` carries each source file's content hash and its parse output, which
   * a later build reads back through `SqlitePartialCache` to skip re-parsing unchanged
   * files. Omit it and the index is still complete and correct — just without a warm
   * cache for the next run.
   */
  public async save(
    model: SemanticModel,
    projectRoot: string,
    fileRecords?: FileRecord[]
  ): Promise<void> {
    const db = openDatabase(projectRoot);
    try {
      this.writeModel(db, model, fileRecords);
    } finally {
      db.close();
    }
  }

  public async load(projectRoot: string): Promise<SemanticModel> {
    if (!databaseExists(projectRoot)) {
      throw new Error(`No semantic model database found at ${getDatabasePath(projectRoot)}`);
    }
    const db = openDatabase(projectRoot, { readonly: true });
    try {
      return this.readModel(db);
    } finally {
      db.close();
    }
  }

  // ── write ─────────────────────────────────────────────────────────────────

  private writeModel(db: Database, model: SemanticModel, fileRecords?: FileRecord[]): void {
    const insertSymbol = db.prepare(`
      INSERT INTO symbols (
        id, kind, name, name_lower, qualified_name, qualified_name_lower,
        file_path, file_path_lower,
        start_line, start_col, end_line, end_col, exported, visibility, metadata, is_project
      ) VALUES (
        @id, @kind, @name, @name_lower, @qualified_name, @qualified_name_lower,
        @file_path, @file_path_lower,
        @start_line, @start_col, @end_line, @end_col, @exported, @visibility, @metadata, @is_project
      )
      ON CONFLICT(id) DO NOTHING
    `);

    // External-content FTS: 'rebuild' reads straight from `symbols`, so this runs
    // after the insert loop and builds the whole trigram index in one pass.
    const buildFts = db.prepare(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);

    const insertScope = db.prepare(`
      INSERT INTO scopes (
        id, kind, parent_scope_id, owner_symbol_id, file_path,
        start_line, start_col, end_line, end_col, metadata
      ) VALUES (
        @id, @kind, @parent_scope_id, @owner_symbol_id, @file_path,
        @start_line, @start_col, @end_line, @end_col, @metadata
      )
      ON CONFLICT(id) DO NOTHING
    `);

    const insertContainment = db.prepare(`
      INSERT INTO containments (parent_id, child_id, kind)
      VALUES (@parent_id, @child_id, @kind)
    `);

    const insertResolved = db.prepare(`
      INSERT INTO resolved_references (candidate_id, from_symbol_id, to_symbol_id, kind, resolution_method)
      VALUES (@candidate_id, @from_symbol_id, @to_symbol_id, @kind, @resolution_method)
      ON CONFLICT(candidate_id) DO NOTHING
    `);

    const insertUnresolved = db.prepare(`
      INSERT INTO unresolved_references (
        id, from_symbol_id, kind, raw_name, qualifier_chain, import_path,
        ast_node_type, file_path, start_line, start_col, end_line, end_col, metadata
      ) VALUES (
        @id, @from_symbol_id, @kind, @raw_name, @qualifier_chain, @import_path,
        @ast_node_type, @file_path, @start_line, @start_col, @end_line, @end_col, @metadata
      )
      ON CONFLICT(id) DO NOTHING
    `);

    const insertDiagnostic = db.prepare(`
      INSERT INTO diagnostics (
        kind, severity, message, file_path,
        start_line, start_col, end_line, end_col,
        related_symbol_ids, related_candidate_id
      ) VALUES (
        @kind, @severity, @message, @file_path,
        @start_line, @start_col, @end_line, @end_col,
        @related_symbol_ids, @related_candidate_id
      )
    `);

    const insertFile = db.prepare(`
      INSERT INTO files (path, language, content_hash, mtime_ms, indexed_at, partial)
      VALUES (@path, @language, @content_hash, @mtime_ms, @indexed_at, @partial)
      ON CONFLICT(path) DO UPDATE SET
        language     = excluded.language,
        content_hash = excluded.content_hash,
        mtime_ms     = excluded.mtime_ms,
        indexed_at   = excluded.indexed_at,
        partial      = excluded.partial
    `);

    const setMeta = db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    // A full rebuild replaces the whole index. Wrapping the clear + repopulate in
    // one transaction means a concurrent reader (visualizer, MCP) sees either the
    // previous index or the new one, never a half-written graph — and it is the
    // difference between ~100k inserts/sec and a few hundred.
    const write = db.transaction((m: SemanticModel) => {
      db.exec(`
        INSERT INTO symbols_fts(symbols_fts) VALUES('delete-all');
        DELETE FROM symbols;
        DELETE FROM scopes;
        DELETE FROM containments;
        DELETE FROM resolved_references;
        DELETE FROM unresolved_references;
        DELETE FROM diagnostics;
        DELETE FROM files;
      `);

      const projectId = m.project?.id;

      for (const symbol of m.symbols) {
        insertSymbol.run(symbolToRow(symbol, symbol.id === projectId));
      }
      for (const scope of m.scopes) {
        insertScope.run(scopeToRow(scope));
      }
      for (const containment of m.containments) {
        insertContainment.run(containmentToRow(containment));
      }
      for (const ref of m.resolvedReferences) {
        insertResolved.run(resolvedReferenceToRow(ref));
      }
      for (const ref of m.unresolvedReferences) {
        insertUnresolved.run(referenceCandidateToRow(ref));
      }
      for (const diagnostic of m.diagnostics) {
        insertDiagnostic.run(diagnosticToRow(diagnostic));
      }

      buildFts.run();

      const indexedAt = m.createdAt;

      if (fileRecords && fileRecords.length > 0) {
        // The build supplied hashes and parse output — persist them so the next run
        // can reuse the partials for files that have not changed.
        for (const record of fileRecords) {
          insertFile.run({
            path: record.path,
            language: record.language,
            content_hash: record.contentHash,
            mtime_ms: record.mtimeMs,
            indexed_at: indexedAt,
            partial: encodePartial(record.partial)
          });
        }
      } else {
        // No cache data available (e.g. a model loaded from elsewhere and re-saved).
        // Still record the distinct file paths so the table reflects the index, but
        // leave content_hash NULL — a NULL hash can never match, so the next build
        // correctly treats every file as needing a parse.
        const seen = new Set<string>();
        for (const symbol of m.symbols) {
          if (!symbol.filePath || seen.has(symbol.filePath)) continue;
          seen.add(symbol.filePath);
          insertFile.run({
            path: symbol.filePath,
            language: null,
            content_hash: null,
            mtime_ms: null,
            indexed_at: indexedAt,
            partial: null
          });
        }
      }

      // The project root symbol is stored verbatim rather than reconstructed from
      // the symbols table: `SemanticModel.project` and `SemanticModel.symbols[0]`
      // are the same object today, but round-tripping it explicitly means load()
      // stays correct even for a model where that isn't true.
      setMeta.run('project_symbol', JSON.stringify(m.project));
      setMeta.run('project_root', m.projectRoot);
      setMeta.run('created_at', m.createdAt);
      setMeta.run('file_count', String(m.fileCount));
      setMeta.run('symbol_count', String(m.symbolCount));
      // Stamps which parse/extract logic produced the cached partials above, so a
      // later build can reject them wholesale if the pipeline has changed.
      setMeta.run('pipeline_version', String(PIPELINE_VERSION));
    });

    write(model);
  }

  // ── read ──────────────────────────────────────────────────────────────────

  private readModel(db: Database): SemanticModel {
    const meta = this.readMeta(db);

    const symbols = (db.prepare(`SELECT * FROM symbols ORDER BY rowid`).all() as SymbolRow[])
      .map(rowToSymbol);

    const scopes = (db.prepare(`SELECT * FROM scopes ORDER BY rowid`).all() as ScopeRow[])
      .map(rowToScope);

    const containments = (db.prepare(`SELECT * FROM containments ORDER BY rowid`).all() as ContainmentRow[])
      .map(rowToContainment);

    const resolvedReferences = (
      db.prepare(`SELECT * FROM resolved_references ORDER BY rowid`).all() as ResolvedReferenceRow[]
    ).map(rowToResolvedReference);

    const unresolvedReferences = (
      db.prepare(`SELECT * FROM unresolved_references ORDER BY rowid`).all() as ReferenceCandidateRow[]
    ).map(rowToReferenceCandidate);

    const diagnostics = (db.prepare(`SELECT * FROM diagnostics ORDER BY seq`).all() as DiagnosticRow[])
      .map(rowToDiagnostic);

    const project = this.readProjectSymbol(db, meta, symbols);

    return {
      project,
      symbols,
      scopes,
      containments,
      resolvedReferences,
      unresolvedReferences,
      diagnostics,
      projectRoot: meta.project_root ?? '',
      createdAt: meta.created_at ?? '',
      fileCount: Number.parseInt(meta.file_count ?? '0', 10) || 0,
      symbolCount: Number.parseInt(meta.symbol_count ?? '0', 10) || 0
    };
  }

  private readMeta(db: Database): Record<string, string> {
    const rows = db.prepare(`SELECT key, value FROM meta`).all() as { key: string; value: string }[];
    const meta: Record<string, string> = {};
    for (const row of rows) {
      meta[row.key] = row.value;
    }
    return meta;
  }

  private readProjectSymbol(
    db: Database,
    meta: Record<string, string>,
    symbols: KGSymbol[]
  ): KGSymbol {
    if (meta.project_symbol) {
      try {
        return JSON.parse(meta.project_symbol) as KGSymbol;
      } catch {
        // fall through to the table lookup below
      }
    }

    const row = db.prepare(`SELECT * FROM symbols WHERE is_project = 1 LIMIT 1`).get() as
      | SymbolRow
      | undefined;
    if (row) return rowToSymbol(row);

    const fromList = symbols.find(s => s.kind === 'project');
    if (fromList) return fromList;

    throw new Error('Semantic model database has no project root symbol');
  }
}
