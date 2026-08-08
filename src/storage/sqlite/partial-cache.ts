import * as crypto from 'crypto';
import * as zlib from 'zlib';
import type { Database, Statement } from 'better-sqlite3';
import { openDatabase, databaseExists } from './db.js';
import { PIPELINE_VERSION } from './schema.js';
import { PartialSemanticModel } from '../../semantic-model/types.js';

/** What the pipeline persists per file so a later run can skip parsing it. */
export interface FileRecord {
  path: string;
  language: string;
  contentHash: string;
  mtimeMs: number;
  partial: PartialSemanticModel;
}

/** Read side of the cache, as the pipeline consumes it. */
export interface PartialCache {
  /** The cached partial for this file, if one was stored for this exact content. */
  get(filePath: string, contentHash: string): PartialSemanticModel | undefined;
}

/** Content hash used as the cache key. Not security-sensitive — only change detection. */
export function hashSource(sourceCode: string): string {
  return crypto.createHash('sha1').update(sourceCode, 'utf8').digest('hex');
}

export function encodePartial(partial: PartialSemanticModel): Buffer {
  // Partials are highly repetitive JSON (the same file path and kind strings on
  // every symbol), so gzip keeps the cache from roughly doubling the database.
  return zlib.gzipSync(Buffer.from(JSON.stringify(partial), 'utf8'));
}

export function decodePartial(blob: Buffer): PartialSemanticModel {
  return JSON.parse(zlib.gunzipSync(blob).toString('utf8')) as PartialSemanticModel;
}

/**
 * Serves cached per-file parse output from `.masai/graph.db`.
 *
 * Two guards, both necessary:
 *  - the content hash proves the file's *input* is unchanged;
 *  - `PIPELINE_VERSION` proves the *code* that produced the partial is unchanged.
 * Without the second, an extractor change would keep serving stale partials for every
 * file that happened not to be edited.
 *
 * Set MASAI_NO_CACHE=1 to bypass entirely and force a full re-parse.
 */
export class SqlitePartialCache implements PartialCache {
  private db: Database | null = null;
  private stmt: Statement | null = null;
  private enabled = false;

  public hits = 0;
  public misses = 0;

  constructor(projectRoot: string) {
    if (process.env.MASAI_NO_CACHE === '1') return;
    if (!databaseExists(projectRoot)) return;

    try {
      this.db = openDatabase(projectRoot, { readonly: true });
    } catch {
      // An unreadable or half-written index is a cache miss, never a hard failure —
      // the caller can always fall back to parsing everything.
      return;
    }

    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'pipeline_version'`).get() as
      | { value: string }
      | undefined;
    if (!row || Number.parseInt(row.value, 10) !== PIPELINE_VERSION) {
      this.close();
      return;
    }

    this.stmt = this.db.prepare(
      `SELECT partial FROM files WHERE path = ? AND content_hash = ? AND partial IS NOT NULL`
    );
    this.enabled = true;
  }

  public get(filePath: string, contentHash: string): PartialSemanticModel | undefined {
    if (!this.enabled || !this.stmt) return undefined;

    const row = this.stmt.get(filePath, contentHash) as { partial: Buffer } | undefined;
    if (!row) {
      this.misses++;
      return undefined;
    }

    try {
      const partial = decodePartial(row.partial);
      this.hits++;
      return partial;
    } catch {
      // Corrupt blob — treat as a miss and let the file be re-parsed.
      this.misses++;
      return undefined;
    }
  }

  public close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
    this.stmt = null;
    this.enabled = false;
  }
}
