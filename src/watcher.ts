import * as fs from 'fs';
import * as path from 'path';
import { Pipeline } from './pipeline.js';
import { SqliteSemanticModelStorage } from './storage/sqlite/sqlite-model-storage.js';
import { SqlitePartialCache } from './storage/sqlite/partial-cache.js';
import { ReadableGraph } from './graph/graph.js';
import { SemanticModel } from './semantic-model/types.js';

const WATCH_IGNORE = new Set([
  'node_modules', 'dist', 'build', '.git', '.creed', '.masai',
  '__pycache__', 'venv', '.venv', 'env', '.env'
]);

function isIgnoredPath(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  return parts.some(p => WATCH_IGNORE.has(p) || p.startsWith('.'));
}

/**
 * Watches the project for file changes and triggers a debounced full rebuild.
 * A full walk is cheap enough for this project's size that incremental
 * patching isn't worth the correctness risk (stale cross-file references) —
 * see src/pipeline.ts's abandoned rebuildFile attempt.
 *
 * `onRebuilt` receives the freshly persisted model plus a `deriveGraph` thunk
 * rather than an already-built graph. A SQLite-backed consumer only needs to
 * re-point its readers at the rewritten database, so materializing an in-memory
 * graph on every rebuild would be pure waste; callers that do want one call the
 * thunk.
 */
export function watchAndRebuild(
  targetDir: string,
  onRebuilt: (model: SemanticModel, deriveGraph: () => ReadableGraph) => void,
  debounceMs = 1000
): fs.FSWatcher {
  const pipeline = new Pipeline();
  const storage = new SqliteSemanticModelStorage();

  let timer: NodeJS.Timeout | null = null;
  let rebuilding = false;
  let pendingRebuild = false;

  const rebuild = async () => {
    if (rebuilding) {
      pendingRebuild = true;
      return;
    }
    rebuilding = true;
    try {
      console.error('Change detected — rebuilding semantic model...');
      // A watcher rebuild is the best case for the partial cache: one file changed,
      // so every other file's parse output is reused and only the edit is re-parsed.
      const cache = new SqlitePartialCache(targetDir);
      let result;
      try {
        result = await pipeline.build(targetDir, { cache });
      } finally {
        // Released before save() opens its own write connection.
        cache.close();
      }

      const { model, fileRecords, stats } = result;
      await storage.save(model, targetDir, fileRecords);
      onRebuilt(model, () => pipeline.deriveGraph(model));
      console.error(
        `Rebuild complete: ${model.fileCount} files, ${model.symbolCount} symbols ` +
        `(${stats.parsed} parsed, ${stats.reused} reused from cache).`
      );
    } catch (err: any) {
      console.error('Rebuild failed:', err.message || err);
    } finally {
      rebuilding = false;
      if (pendingRebuild) {
        pendingRebuild = false;
        scheduleRebuild();
      }
    }
  };

  const scheduleRebuild = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, debounceMs);
  };

  const watcher = fs.watch(targetDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const relative = filename.toString();
    if (isIgnoredPath(relative)) return;
    scheduleRebuild();
  });

  return watcher;
}
