import * as fs from 'fs';
import * as path from 'path';
import { Pipeline } from './pipeline.js';
import { SqliteSemanticModelStorage } from './storage/sqlite/sqlite-model-storage.js';
import { ReadableGraph } from './graph/graph.js';
import { SemanticModel } from './semantic-model/types.js';

const WATCH_IGNORE = new Set([
  'node_modules', 'dist', 'build', '.git', '.masai',
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
      const model = await pipeline.buildFull(targetDir);
      await storage.save(model, targetDir);
      onRebuilt(model, () => pipeline.deriveGraph(model));
      console.error(`Rebuild complete: ${model.fileCount} files, ${model.symbolCount} symbols.`);
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
