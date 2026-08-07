import { describe, test, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import Database from 'better-sqlite3';
import { Pipeline } from '../src/pipeline.js';
import { SqliteSemanticModelStorage } from '../src/storage/sqlite/sqlite-model-storage.js';
import { getDatabasePath, databaseExists } from '../src/storage/sqlite/db.js';
import { SCHEMA_VERSION } from '../src/storage/sqlite/schema.js';
import { SemanticModel } from '../src/semantic-model/types.js';

/**
 * Round-trip fidelity is the whole contract of the JSON→SQLite migration: every
 * downstream consumer keeps working only if load(save(m)) is structurally equal
 * to m. These tests are the gate for that.
 */

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'masai-sqlite-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function buildFixtureModel(fixture: string): Promise<SemanticModel> {
  const pipeline = new Pipeline();
  return pipeline.buildFull(path.resolve(`tests/fixtures/${fixture}`));
}

describe('SqliteSemanticModelStorage', () => {
  test('round-trips a real model without losing anything', async () => {
    const model = await buildFixtureModel('typescript-project');
    const root = makeTempRoot();
    const storage = new SqliteSemanticModelStorage();

    await storage.save(model, root);
    const loaded = await storage.load(root);

    // The strongest possible assertion: the reloaded model is deep-equal to the
    // original. JSON.parse(JSON.stringify(model)) is the reference because that
    // is exactly what the old JSON storage returned — undefined-valued optional
    // keys were dropped, so SQLite must drop them too.
    expect(loaded).toEqual(JSON.parse(JSON.stringify(model)));
  });

  test('round-trips every language fixture', async () => {
    for (const fixture of ['python-project', 'typescript-project', 'html-project']) {
      const model = await buildFixtureModel(fixture);
      const root = makeTempRoot();
      const storage = new SqliteSemanticModelStorage();

      await storage.save(model, root);
      const loaded = await storage.load(root);

      expect(loaded, `fixture ${fixture}`).toEqual(JSON.parse(JSON.stringify(model)));
    }
  });

  test('preserves array ordering, which resolution and ranking depend on', async () => {
    const model = await buildFixtureModel('python-project');
    const root = makeTempRoot();
    const storage = new SqliteSemanticModelStorage();

    await storage.save(model, root);
    const loaded = await storage.load(root);

    expect(loaded.symbols.map(s => s.id)).toEqual(model.symbols.map(s => s.id));
    expect(loaded.containments.map(c => `${c.parentId}->${c.childId}`)).toEqual(
      model.containments.map(c => `${c.parentId}->${c.childId}`)
    );
    expect(loaded.resolvedReferences.map(r => r.candidateId)).toEqual(
      model.resolvedReferences.map(r => r.candidateId)
    );
    expect(loaded.diagnostics.map(d => d.message)).toEqual(model.diagnostics.map(d => d.message));
  });

  test('preserves the project root symbol', async () => {
    const model = await buildFixtureModel('python-project');
    const root = makeTempRoot();
    const storage = new SqliteSemanticModelStorage();

    await storage.save(model, root);
    const loaded = await storage.load(root);

    expect(loaded.project).toEqual(model.project);
    expect(loaded.project.kind).toBe('project');
    // The project symbol is also a member of symbols[]; both views must agree.
    expect(loaded.symbols.some(s => s.id === loaded.project.id)).toBe(true);
  });

  test('preserves optional fields exactly (absent stays absent)', async () => {
    const model = await buildFixtureModel('typescript-project');
    const root = makeTempRoot();
    const storage = new SqliteSemanticModelStorage();

    await storage.save(model, root);
    const loaded = await storage.load(root);

    // importPath is optional on ReferenceCandidate — present only for imports.
    const withImportPath = loaded.unresolvedReferences.filter(r => r.importPath !== undefined);
    const originalWithImportPath = model.unresolvedReferences.filter(r => r.importPath !== undefined);
    expect(withImportPath.length).toBe(originalWithImportPath.length);

    // A candidate with no importPath must not gain an explicit undefined key.
    const withoutImportPath = loaded.unresolvedReferences.find(r => r.importPath === undefined);
    if (withoutImportPath) {
      expect(Object.hasOwn(withoutImportPath, 'importPath')).toBe(false);
    }

    // parentScopeId is `string | null` — null is meaningful and must survive.
    const globalScope = loaded.scopes.find(s => s.parentScopeId === null);
    if (model.scopes.some(s => s.parentScopeId === null)) {
      expect(globalScope).toBeDefined();
    }
  });

  test('a second save replaces the previous index rather than appending', async () => {
    const model = await buildFixtureModel('python-project');
    const root = makeTempRoot();
    const storage = new SqliteSemanticModelStorage();

    await storage.save(model, root);
    await storage.save(model, root);
    const loaded = await storage.load(root);

    expect(loaded.symbols.length).toBe(model.symbols.length);
    expect(loaded.containments.length).toBe(model.containments.length);
    expect(loaded.resolvedReferences.length).toBe(model.resolvedReferences.length);
    expect(loaded.diagnostics.length).toBe(model.diagnostics.length);
  });

  test('the derived graph is identical whether built pre- or post-round-trip', async () => {
    const model = await buildFixtureModel('typescript-project');
    const root = makeTempRoot();
    const storage = new SqliteSemanticModelStorage();
    const pipeline = new Pipeline();

    await storage.save(model, root);
    const loaded = await storage.load(root);

    const before = pipeline.deriveGraph(model);
    const after = pipeline.deriveGraph(loaded);

    expect(after.stats()).toEqual(before.stats());
    expect(after.getAllNodes().map(n => n.id).sort()).toEqual(
      before.getAllNodes().map(n => n.id).sort()
    );
    expect(after.getMembersOf('src/services/user.ts::UserService').map(m => m.name).sort()).toEqual(
      before.getMembersOf('src/services/user.ts::UserService').map(m => m.name).sort()
    );
  });

  test('writes an indexed, queryable database', async () => {
    const model = await buildFixtureModel('typescript-project');
    const root = makeTempRoot();
    const storage = new SqliteSemanticModelStorage();
    await storage.save(model, root);

    expect(databaseExists(root)).toBe(true);
    expect(storage.getStoragePath(root)).toBe(getDatabasePath(root));

    const db = new Database(getDatabasePath(root), { readonly: true });
    try {
      const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
      expect(version?.value).toBe(String(SCHEMA_VERSION));

      // Row counts must agree with the model — proves nothing was silently dropped.
      const symbolCount = db.prepare(`SELECT COUNT(*) AS n FROM symbols`).get() as { n: number };
      expect(symbolCount.n).toBe(model.symbols.length);

      // The point of the migration: an indexed lookup instead of scanning a Map.
      const hits = db
        .prepare(`SELECT id, name FROM symbols WHERE name_lower = ?`)
        .all('userservice') as { id: string; name: string }[];
      expect(hits.some(h => h.id === 'src/services/user.ts::UserService')).toBe(true);

      // Confirm the query planner actually uses the index we created for it.
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT id FROM symbols WHERE name_lower = ?`)
        .all('userservice') as { detail: string }[];
      expect(plan.some(p => p.detail.includes('idx_symbols_name_lower'))).toBe(true);

      // Distinct source files are recorded for Phase 3 incremental indexing.
      const fileCount = db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number };
      expect(fileCount.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test('load fails clearly when a project has not been indexed', async () => {
    const root = makeTempRoot();
    const storage = new SqliteSemanticModelStorage();
    await expect(storage.load(root)).rejects.toThrow(/No semantic model database found/);
  });

  test('a database written by an older schema is rebuilt, not read as garbage', async () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, '.masai'), { recursive: true });

    // Simulate a stale index from a previous schema version.
    const stale = new Database(getDatabasePath(root));
    stale.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
    stale.exec(`CREATE TABLE symbols (id TEXT PRIMARY KEY, junk TEXT);`);
    stale.prepare(`INSERT INTO meta VALUES ('schema_version', '-1')`).run();
    stale.prepare(`INSERT INTO symbols VALUES ('leftover', 'x')`).run();
    stale.close();

    const model = await buildFixtureModel('python-project');
    const storage = new SqliteSemanticModelStorage();
    await storage.save(model, root);
    const loaded = await storage.load(root);

    expect(loaded.symbols.some(s => s.id === 'leftover')).toBe(false);
    expect(loaded).toEqual(JSON.parse(JSON.stringify(model)));
  });
});
