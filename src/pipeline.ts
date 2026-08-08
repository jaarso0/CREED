import * as path from 'path';
import { walkProject, parseSourceFile } from './parse/walker.js';
import { extractorRegistry } from './extract/extractor-registry.js';
import { createSymbol } from './semantic-model/builder.js';
import { mergePartials } from './semantic-model/merge.js';
import { SymbolRegistry } from './registry/registry.js';
import { resolveAll } from './resolve/resolver.js';
import { buildGraphFromModel, KnowledgeGraph } from './graph/graph.js';
import { SemanticModel, PartialSemanticModel } from './semantic-model/types.js';
import { PartialCache, FileRecord, hashSource } from './storage/sqlite/partial-cache.js';

export interface BuildResult {
  model: SemanticModel;
  /** Per-file hashes and parse output, for persisting so the next build can reuse them. */
  fileRecords: FileRecord[];
  /** How much work the cache saved: files parsed from scratch vs served from cache. */
  stats: { parsed: number; reused: number };
}

export interface BuildOptions {
  /** Supply to skip parsing files whose contents are unchanged since the last build. */
  cache?: PartialCache;
}

export class Pipeline {
  /**
   * Builds the model, optionally reusing cached parse output for unchanged files.
   *
   * **Parsing is incremental; resolution is not, deliberately.** Only per-file
   * parse+extract is cached. Merge, registry and resolution always run over the
   * complete set of partials, because a change in one file can invalidate references
   * that were resolved in *other* files via `global_fallback`/`qualified_name` — the
   * same reasoning that killed the earlier `rebuildFile` attempt (see below). Parsing
   * is the expensive stage, so this captures the win without reopening that
   * correctness question.
   */
  public async build(projectRoot: string, options: BuildOptions = {}): Promise<BuildResult> {
    const resolvedRoot = path.resolve(projectRoot);
    const projectName = path.basename(resolvedRoot) || 'root-project';

    // 1. Create project root symbol
    const project = createSymbol({
      filePath: '',
      chain: [projectName],
      kind: 'project',
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
    });

    // 2. Stage 1: Discover and read every source file. Reading is unavoidable, so
    // hashing here is nearly free and tells us which files can skip stage 2.
    const sourceFiles = await walkProject(resolvedRoot);

    // 3. Stage 2: Extract, reusing cached partials where the content hash matches.
    const partials: PartialSemanticModel[] = [];
    const fileRecords: FileRecord[] = [];
    let parsed = 0;
    let reused = 0;

    for (const file of sourceFiles) {
      const contentHash = hashSource(file.sourceCode);
      let partial = options.cache?.get(file.filePath, contentHash);

      if (partial) {
        reused++;
      } else {
        try {
          const parsedFile = parseSourceFile(file);
          const extractor = extractorRegistry.getExtractor(parsedFile.language);
          partial = extractor.extract(parsedFile);
          parsed++;
        } catch (err) {
          // Matches the previous parseProject behaviour: a file that fails to parse
          // is skipped with a warning rather than failing the whole build.
          console.error(`Failed to parse file ${file.absolutePath}:`, err);
          continue;
        }
      }

      partials.push(partial);
      fileRecords.push({
        path: file.filePath,
        language: file.language,
        contentHash,
        mtimeMs: file.mtimeMs,
        partial
      });
    }

    // 4. Merge Partials (includes Project CONTAINS File edges)
    const merged = mergePartials(partials, project);

    // 5. Stage 3: Registry (includes ScopeIndex)
    const registry = new SymbolRegistry();
    registry.build(merged);

    // 6. Stage 4: Resolve — always global, over every partial
    const { resolved, unresolved, diagnostics } = resolveAll(
      merged.references,
      registry,
      merged.containments
    );

    // 7. Assemble final SemanticModel
    const model: SemanticModel = {
      project,
      symbols: merged.symbols,
      scopes: merged.scopes,
      containments: merged.containments,
      resolvedReferences: resolved,
      unresolvedReferences: unresolved,
      diagnostics: [...merged.diagnostics, ...diagnostics],
      projectRoot: resolvedRoot.replace(/\\/g, '/'),
      createdAt: new Date().toISOString(),
      fileCount: partials.length,
      symbolCount: merged.symbols.length
    };

    return { model, fileRecords, stats: { parsed, reused } };
  }

  public async buildFull(projectRoot: string): Promise<SemanticModel> {
    const { model } = await this.build(projectRoot);
    return model;
  }

  /**
   * NOT incremental, despite the name/signature. A prior attempt built a `MergeableModel`
   * patch here via `updatePartial` (see merge.ts) but discarded it and fell back to a full
   * rebuild anyway. True incremental resolution is unsound in general: a change in one file
   * can invalidate cross-file references that were resolved via `global_fallback`/
   * `qualified_name` in unrelated files, so a partial patch risks leaving stale, silently-
   * wrong edges in the graph. `updatePartial` correctly implements the patch mechanics if
   * this is ever revisited — see deep_dive_architecture.md for the full reasoning. Kept as a
   * thin alias for API compatibility with existing callers.
   */
  public async rebuildFile(
    projectRoot: string,
    _filePath: string,
    _currentModel: SemanticModel
  ): Promise<SemanticModel> {
    return this.buildFull(projectRoot);
  }

  public deriveGraph(model: SemanticModel): KnowledgeGraph {
    return buildGraphFromModel(model);
  }
}
