import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { Pipeline } from '../src/pipeline.js';
import { SqliteSemanticModelStorage } from '../src/storage/sqlite/sqlite-model-storage.js';
import { SqlitePartialCache, hashSource } from '../src/storage/sqlite/partial-cache.js';
import { getDatabasePath } from '../src/storage/sqlite/db.js';
import { SemanticModel } from '../src/semantic-model/types.js';

/**
 * The partial cache is only safe if a cached build is indistinguishable from a cold
 * one. Everything here is ultimately checking that: the speedup must not change a
 * single byte of the resulting model.
 */

let root: string;
const pipeline = new Pipeline();
const storage = new SqliteSemanticModelStorage();

const FILES: Record<string, string> = {
  'src/models/user.ts': `
export interface User { id: string; name: string; }
export class UserRecord implements User {
  id = '';
  name = '';
  describe(): string { return this.name; }
}
`,
  'src/services/user-service.ts': `
import { User, UserRecord } from '../models/user.js';
export class UserService {
  save(u: User): void { new UserRecord().describe(); }
  getById(id: string): User | undefined { return undefined; }
}
`,
  'src/main.ts': `
import { UserService } from './services/user-service.js';
export function main(): void {
  const svc = new UserService();
  svc.save({ id: '1', name: 'a' });
  svc.getById('1');
}
`
};

function write(rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creed-cache-'));
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
});

afterEach(() => {
  delete process.env.CREED_NO_CACHE;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Build using whatever cache is on disk, then persist so the next build can use it. */
async function buildWithCache() {
  const cache = new SqlitePartialCache(root);
  let result;
  try {
    result = await pipeline.build(root, { cache });
  } finally {
    cache.close();
  }
  await storage.save(result.model, root, result.fileRecords);
  return result;
}

/** Everything about a model except the wall-clock stamp, which always differs. */
function comparable(model: SemanticModel) {
  const { createdAt, ...rest } = model;
  return JSON.parse(JSON.stringify(rest));
}

describe('partial cache', () => {
  test('a cold build populates the cache; the next build reuses all of it', async () => {
    const first = await buildWithCache();
    expect(first.stats.parsed).toBe(3);
    expect(first.stats.reused).toBe(0);

    const second = await buildWithCache();
    expect(second.stats.parsed).toBe(0);
    expect(second.stats.reused).toBe(3);
  });

  test('a cached build produces a byte-identical model', async () => {
    const cold = await buildWithCache();
    const cached = await buildWithCache();
    expect(comparable(cached.model)).toEqual(comparable(cold.model));
  });

  test('editing one file re-parses only that file', async () => {
    await buildWithCache();

    write('src/main.ts', FILES['src/main.ts'] + `\nexport function extra(): void {}\n`);
    const after = await buildWithCache();

    expect(after.stats.parsed).toBe(1);
    expect(after.stats.reused).toBe(2);
    expect(after.model.symbols.some(s => s.name === 'extra')).toBe(true);
  });

  test('an edited file yields the same model as a full cold rebuild', async () => {
    await buildWithCache();
    write('src/main.ts', FILES['src/main.ts'] + `\nexport function extra(): void {}\n`);
    const incremental = await buildWithCache();

    // Same sources, no cache at all.
    process.env.CREED_NO_CACHE = '1';
    const cold = await buildWithCache();
    delete process.env.CREED_NO_CACHE;

    expect(cold.stats.parsed).toBe(3);
    expect(comparable(incremental.model)).toEqual(comparable(cold.model));
  });

  test('cross-file references still resolve after an incremental build', async () => {
    await buildWithCache();

    // Rename the method in the model file only. The *callers* are cached, so this is
    // exactly the case where a naive incremental resolver would leave a stale edge.
    write('src/models/user.ts', FILES['src/models/user.ts'].replace('describe', 'summarize'));
    const after = await buildWithCache();

    expect(after.stats.parsed).toBe(1);
    expect(after.stats.reused).toBe(2);

    // The renamed definition exists; the old name does not.
    expect(after.model.symbols.some(s => s.name === 'summarize')).toBe(true);
    expect(after.model.symbols.some(s => s.name === 'describe')).toBe(false);

    // And no resolved reference points at a symbol that no longer exists — the check
    // that would fail if resolution had been cached along with parsing.
    const ids = new Set(after.model.symbols.map(s => s.id));
    const dangling = after.model.resolvedReferences.filter(r => !ids.has(r.toSymbolId));
    expect(dangling).toEqual([]);
  });

  test('adding and deleting files is picked up', async () => {
    await buildWithCache();

    write('src/extra.ts', `export function brandNew(): number { return 1; }\n`);
    const added = await buildWithCache();
    expect(added.stats.parsed).toBe(1);
    expect(added.stats.reused).toBe(3);
    expect(added.model.symbols.some(s => s.name === 'brandNew')).toBe(true);

    fs.rmSync(path.join(root, 'src/extra.ts'));
    const removed = await buildWithCache();
    expect(removed.model.symbols.some(s => s.name === 'brandNew')).toBe(false);
    expect(removed.model.fileCount).toBe(3);
  });

  test('a stale pipeline version invalidates the whole cache', async () => {
    await buildWithCache();

    const db = new Database(getDatabasePath(root));
    db.prepare(`UPDATE meta SET value = '999' WHERE key = 'pipeline_version'`).run();
    db.close();

    const after = await buildWithCache();
    expect(after.stats.reused).toBe(0);
    expect(after.stats.parsed).toBe(3);
  });

  test('CREED_NO_CACHE=1 bypasses the cache', async () => {
    await buildWithCache();
    process.env.CREED_NO_CACHE = '1';
    const after = await buildWithCache();
    expect(after.stats.reused).toBe(0);
    expect(after.stats.parsed).toBe(3);
  });

  test('a corrupt cached blob falls back to parsing instead of failing', async () => {
    await buildWithCache();

    const db = new Database(getDatabasePath(root));
    db.prepare(`UPDATE files SET partial = ? WHERE path = 'src/main.ts'`)
      .run(Buffer.from('not gzip at all'));
    db.close();

    const after = await buildWithCache();
    expect(after.stats.parsed).toBe(1);
    expect(after.stats.reused).toBe(2);
    expect(after.model.symbols.some(s => s.name === 'main')).toBe(true);
  });

  test('no cache present is a clean miss, not an error', async () => {
    const cache = new SqlitePartialCache(root); // nothing indexed yet
    expect(cache.get('src/main.ts', 'deadbeef')).toBeUndefined();
    cache.close();

    const built = await pipeline.build(root);
    expect(built.stats.parsed).toBe(3);
  });

  test('content hash, not mtime, decides reuse', async () => {
    await buildWithCache();

    // Rewrite identical content: mtime changes, hash does not.
    const target = path.join(root, 'src/main.ts');
    fs.writeFileSync(target, FILES['src/main.ts'], 'utf-8');
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(target, future, future);

    const after = await buildWithCache();
    expect(after.stats.parsed).toBe(0);
    expect(after.stats.reused).toBe(3);
  });

  test('file rows carry the hash of their current contents', async () => {
    await buildWithCache();
    const db = new Database(getDatabasePath(root), { readonly: true });
    try {
      const rows = db.prepare(`SELECT path, content_hash, language, partial FROM files`).all() as
        { path: string; content_hash: string; language: string; partial: Buffer }[];
      expect(rows.length).toBe(3);
      for (const row of rows) {
        const source = fs.readFileSync(path.join(root, row.path), 'utf-8');
        expect(row.content_hash, `hash for ${row.path}`).toBe(hashSource(source));
        expect(row.language).toBe('typescript');
        expect(row.partial.length).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }
  });
});
