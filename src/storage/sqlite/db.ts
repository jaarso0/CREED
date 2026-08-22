import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';

export type { Database } from 'better-sqlite3';

export const DB_FILENAME = 'graph.db';

/** Directory Creed keeps its index in, at the project root. */
export const INDEX_DIR = '.creed';

/**
 * Directory used before the project was renamed. Still recognised when reading so an
 * existing checkout keeps working, but never written to.
 */
export const LEGACY_INDEX_DIR = '.masai';

/** Absolute path to a project's graph database. */
export function getDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, INDEX_DIR, DB_FILENAME);
}

/** Absolute path to a pre-rename index, if the project still has one. */
export function getLegacyDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, LEGACY_INDEX_DIR, DB_FILENAME);
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
      const hadLegacy = fs.existsSync(getLegacyDatabasePath(projectRoot));
      throw new Error(
        `No Creed index found at ${dbPath}. ` +
        (hadLegacy
          ? `A pre-rename index exists at ${LEGACY_INDEX_DIR}/ — re-index to migrate it, then delete that folder. `
          : '') +
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
