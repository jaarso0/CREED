import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';

export type { Database } from 'better-sqlite3';

export const DB_FILENAME = 'graph.db';

/** Absolute path to a project's graph database. */
export function getDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, '.masai', DB_FILENAME);
}

/** True if a project has already been indexed into SQLite. */
export function databaseExists(projectRoot: string): boolean {
  return fs.existsSync(getDatabasePath(projectRoot));
}

export interface OpenOptions {
  /** Open without creating the file. Throws if it doesn't exist. */
  readonly?: boolean;
}

/**
 * Opens (creating if needed) the project's graph database with the schema applied.
 *
 * Callers own the returned handle and should `close()` it — better-sqlite3 holds
 * a real file descriptor, and on Windows an open handle blocks the WAL sidecar
 * files from being cleaned up.
 */
export function openDatabase(projectRoot: string, options: OpenOptions = {}): Database.Database {
  const dbPath = getDatabasePath(projectRoot);

  if (options.readonly) {
    // Check first and fail with something actionable. better-sqlite3's own message here is
    // "Cannot open database because the directory does not exist", which says nothing about
    // needing to index the project — and this is the very first thing a new consumer hits.
    if (!fs.existsSync(dbPath)) {
      throw new Error(
        `No Creed index found at ${dbPath}. ` +
        `Index the project first — run \`npx creed-kg ${projectRoot}\`, or build and save a ` +
        `model with Pipeline.build() + SqliteSemanticModelStorage.save().`
      );
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return db;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  migrate(db);
  return db;
}
