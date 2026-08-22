#!/usr/bin/env node

import * as path from 'path';
import { Pipeline } from './pipeline.js';
import { SqliteSemanticModelStorage } from './storage/sqlite/sqlite-model-storage.js';
import { SqlitePartialCache } from './storage/sqlite/partial-cache.js';

import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

const CLI_VERSION = '1.0.0';
import * as readline from 'readline';
import { startServer } from './serve.js';

// Export everything for programmatic use
// Pipeline
export { Pipeline } from './pipeline.js';
export type { BuildResult, BuildOptions } from './pipeline.js';
export * from './semantic-model/types.js';

// Graph — both backends implement ReadableGraph, so consumers can swap freely
export { KnowledgeGraph, buildGraphFromModel, isTestFile } from './graph/graph.js';
export type { ReadableGraph, KGNode, KGEdge, KGEdgeKind } from './graph/graph.js';
export { SqliteKnowledgeGraph } from './graph/sqlite-graph.js';

// Storage & incremental parse cache
export { SqliteSemanticModelStorage } from './storage/sqlite/sqlite-model-storage.js';
export { SqlitePartialCache, hashSource } from './storage/sqlite/partial-cache.js';
export type { FileRecord, PartialCache } from './storage/sqlite/partial-cache.js';
export { openDatabase, getDatabasePath, databaseExists, INDEX_DIR, DB_FILENAME } from './storage/sqlite/db.js';
export { SCHEMA_VERSION, PIPELINE_VERSION } from './storage/sqlite/schema.js';
export { JsonSemanticModelStorage } from './storage/semantic-model-storage.js';

// Retrieval / symbol lookup
export { RetrievalEngine } from './retrieval/api.js';
export { RetrievalIndexes } from './retrieval/indexes.js';
export { SqliteSymbolIndex } from './retrieval/sqlite-symbol-index.js';
export type { SymbolIndex, SymbolMatch, FilePathMatch } from './retrieval/symbol-index.js';
export * from './retrieval/types.js';

// Servers
export { startServer } from './serve.js';

async function runSetup() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  console.log(`\n==================================================`);
  console.log(` Creed MCP Setup Wizard`);
  console.log(`==================================================\n`);

  const defaultDir = findProjectRoot();
  const inputDir = await question(`Enter the absolute path of the directory to index [${defaultDir}]: `);
  const targetDir = path.resolve(inputDir.trim() || defaultDir);
  rl.close();

  // Detect Claude Desktop config path
  let configPath = '';
  const home = os.homedir();
  if (process.platform === 'win32') {
    configPath = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  } else if (process.platform === 'darwin') {
    configPath = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else {
    configPath = path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }

  console.log(`\nClaude Desktop Config Path: ${configPath}`);

  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    let config: any = {};
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(content);
    } catch (e) {
      // Config doesn't exist or is invalid
    }

    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    // The published package is `creed-kg` — `creed` is an unrelated 2018 async library, so
    // naming it here would have had npx install and run entirely the wrong thing.
    config.mcpServers['creed'] = {
      command: 'npx',
      args: [
        '-y',
        'creed-kg',
        'mcp',
        targetDir
      ]
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`\n✅ Successfully added 'creed' MCP server to Claude Desktop!`);
    console.log(`Project directory registered: ${targetDir}`);
    console.log(`\nTo apply changes, please restart your Claude Desktop client.`);
  } catch (err: any) {
    console.error(`\n❌ Failed to update Claude Desktop configuration:`, err.message || err);
  }
}

/**
 * Files that mark the root of a project. Checked while walking up from the working
 * directory, nearest first — so inside a monorepo package you get that package, not the
 * whole repository, which is almost always the scope you meant to index.
 */
const PROJECT_MARKERS = [
  '.creed', '.masai', '.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'tsconfig.json', 'deno.json'
];

/**
 * Works out which project to operate on when no path was given.
 *
 * MCP clients spawn the server themselves, and the working directory they pick is theirs to
 * choose — so trusting `process.cwd()` blindly meant every config had to hard-code an
 * absolute path, per project, by hand. Walking up to a project marker removes that: the
 * same path-less config block works in every repository, and can be installed once globally.
 *
 * Falls back to the starting directory when nothing is found, which is the old behaviour.
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  const start = path.resolve(startDir);
  const { root } = path.parse(start);
  const home = os.homedir();

  let dir = start;
  while (true) {
    // The home directory and the filesystem root are never inferred as project roots. Plenty
    // of people have a stray package.json or a dotfiles .git in $HOME, and walking up into it
    // would quietly point Creed at every file they own. Only honoured when the user named
    // that directory themselves.
    const atBoundary = dir === home || dir === root;

    if (!atBoundary || dir === start) {
      // A package.json inside node_modules is a dependency's, never the user's project.
      const insideDeps = dir.split(path.sep).includes('node_modules');
      if (!insideDeps && PROJECT_MARKERS.some(m => fsSync.existsSync(path.join(dir, m)))) {
        return dir;
      }
    }

    if (atBoundary) return start;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function printUsage(): void {
  console.log(`
Creed — a knowledge graph of your codebase, for AI coding agents.

Usage: creed-kg <command> [options]

Commands:
  init                   Index this repo and connect it to your editors — start here
  query "<question>"     Ask about your codebase and print the answer
  mcp [dir]              Run as an MCP server (for Claude Code, Cursor, Kiro, ...)
  serve [dir]            Open the interactive graph explorer in a browser
  setup                  Write the Claude Desktop MCP config for you
  [dir]                  Index a directory and print a report (default)

[dir] is optional everywhere. Omitted, Creed walks up from the working directory to
the nearest project root (.git, package.json, pyproject.toml, ...) — so the same
config works in every repo without hard-coding a path.

Options:
  --path, -p <dir>       Project directory (for \`init\` and \`query\`)
  --all                  init: configure every supported editor, not just detected ones
  --editor, -e <id>      init: configure a specific editor
                         (claude-code, cursor, vscode, kiro, gemini)
  --no-index             init: write configs only, skip building the index
  --help, -h             Show this message

Examples:
  creed-kg init
  creed-kg query "how does authentication work"
  creed-kg query "UserService save" --path ./backend
  creed-kg init --all
  creed-kg mcp
`);
}

// CLI Execution Support
async function runCLI() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log(CLI_VERSION);
    return;
  }

  if (command === 'setup' || command === 'configure') {
    await runSetup();
    return;
  }

  if (command === 'init') {
    const rest = args.slice(1);
    let targetDir = findProjectRoot();
    const pathFlag = rest.findIndex(a => a === '--path' || a === '-p');
    if (pathFlag !== -1) {
      targetDir = path.resolve(rest[pathFlag + 1] || '.');
      rest.splice(pathFlag, 2);
    }

    const editors: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--editor' || rest[i] === '-e') {
        if (rest[i + 1]) editors.push(rest[i + 1]);
        i++;
      }
    }

    try {
      const { runInit } = await import('./init.js');
      await runInit({
        projectRoot: targetDir,
        all: rest.includes('--all'),
        editors,
        skipIndex: rest.includes('--no-index')
      });
    } catch (err: any) {
      console.error(`\n❌ init failed:`, err.message || err);
      process.exit(1);
    }
    return;
  }

  if (command === 'query' || command === 'ask') {
    // One-shot version of the `explore_flow` MCP tool, so the graph is usable straight after
    // install without wiring up an editor first. Indexes (reusing the cache, so it's near
    // instant on a warm project), runs the query, prints the same markdown an agent receives.
    const rest = args.slice(1);
    let targetDir = findProjectRoot();
    const pathFlag = rest.findIndex(a => a === '--path' || a === '-p');
    if (pathFlag !== -1) {
      targetDir = path.resolve(rest[pathFlag + 1] || '.');
      rest.splice(pathFlag, 2);
    }
    const queryText = rest.join(' ').trim();

    if (!queryText) {
      console.error('Usage: creed-kg query "<what you want to know>" [--path <dir>]');
      console.error('Example: creed-kg query "how does authentication work"');
      process.exit(1);
    }

    try {
      const pipeline = new Pipeline();
      const cache = new SqlitePartialCache(targetDir);
      let build;
      try {
        build = await pipeline.build(targetDir, { cache });
      } finally {
        cache.close();
      }
      await new SqliteSemanticModelStorage().save(build.model, targetDir, build.fileRecords);

      const { SqliteKnowledgeGraph } = await import('./graph/sqlite-graph.js');
      const { SqliteSymbolIndex } = await import('./retrieval/sqlite-symbol-index.js');
      const { RequestController } = await import('./mcp/controller.js');
      const { compileExploreFlow } = await import('./mcp/compile.js');

      const graph = new SqliteKnowledgeGraph(targetDir);
      const index = new SqliteSymbolIndex(targetDir);
      try {
        const controller = new RequestController(graph, targetDir, index);
        const result = await controller.processPlan(compileExploreFlow({ query: queryText }));

        if (typeof result?.serializedContext === 'string') {
          console.log(result.serializedContext);
        } else if (result?.status === 'not_found') {
          console.log(`No symbols matched "${queryText}".`);
          console.log('Try naming a specific function, class, or file.');
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } finally {
        graph.close();
        index.close();
      }
    } catch (err: any) {
      console.error(`\n❌ Query failed:`, err.message || err);
      process.exit(1);
    }
    return;
  }

  if (command === 'serve' || command === 'visualize') {
    const targetDir = args[1] ? path.resolve(args[1]) : findProjectRoot();
    try {
      await startServer(targetDir);
    } catch (err: any) {
      console.error(`\n❌ Error starting server:`, err.message || err);
      process.exit(1);
    }
    return;
  }

  if (command === 'mcp') {
    const targetDir = args[1] ? path.resolve(args[1]) : findProjectRoot();
    try {
      const storage = new SqliteSemanticModelStorage();
      const pipeline = new Pipeline();
      // The graph is always rebuilt on startup — a previously cached *model* was never
      // trusted, because a restarted server could inherit a stale index that another
      // (older-code) instance had clobbered onto disk.
      //
      // The partial cache does not weaken that guarantee: every file is still read and
      // hashed on every startup, and merge/registry/resolution still run over the full
      // set. Only parse+extract is skipped, and only for files whose content hash and
      // pipeline version both match. So the served graph still reflects the current
      // source exactly — it just gets there without re-parsing what has not changed.
      console.error(`Building semantic model for ${targetDir} on startup...`);
      const cache = new SqlitePartialCache(targetDir);
      let build;
      try {
        build = await pipeline.build(targetDir, { cache });
      } finally {
        // Closed before save() opens its write connection.
        cache.close();
      }
      const { model, fileRecords, stats } = build;
      await storage.save(model, targetDir, fileRecords);
      console.error(
        `Model ready: ${model.fileCount} files, ${model.symbolCount} symbols ` +
        `(${stats.parsed} parsed, ${stats.reused} reused from cache).`
      );

      // Serve the graph out of SQLite rather than the in-memory model. The model
      // object built above is released once this scope exits; from here on, node and
      // edge lookups are indexed reads against .creed/graph.db, so resident memory
      // tracks what queries touch instead of the size of the repository.
      const { SqliteKnowledgeGraph } = await import('./graph/sqlite-graph.js');
      const { SqliteSymbolIndex } = await import('./retrieval/sqlite-symbol-index.js');
      const graph = new SqliteKnowledgeGraph(targetDir);
      const index = new SqliteSymbolIndex(targetDir);

      const { MCPServer } = await import('./mcp/server.js');
      const mcpServer = new MCPServer(graph, targetDir, index);
      mcpServer.start();

      const { watchAndRebuild } = await import('./watcher.js');
      const watcher = watchAndRebuild(targetDir, () => {
        // The rebuild has already written the new index to the same database file.
        // Re-point the existing readers at it instead of constructing a new graph.
        graph.refresh();
        index.refresh();
        mcpServer.updateGraph(graph, index);
      });
      process.on('exit', () => {
        watcher.close();
        graph.close();
        index.close();
      });
    } catch (err: any) {
      console.error(`\n❌ Error starting MCP server:`, err.message || err);
      process.exit(1);
    }
    return;
  }

  // Anything left is the default "index this directory" mode, where args[0] is a path.
  // Guard it: a mistyped or unsupported subcommand used to be resolved as a directory name,
  // so `creed-kg quer "..."` reported `ENOENT: no such file or directory .../quer` — which
  // points at the wrong problem entirely. If it doesn't exist on disk, treat it as a command.
  if (args[0] && !fsSync.existsSync(path.resolve(args[0]))) {
    console.error(`Unknown command or missing directory: "${args[0]}"\n`);
    printUsage();
    process.exit(1);
  }

  const targetDir = args[0] ? path.resolve(args[0]) : findProjectRoot();

  console.log(`\n==================================================`);
  console.log(` Creed — Knowledge Graph Builder`);
  console.log(`==================================================`);
  console.log(`Target Directory : ${targetDir}`);
  console.log(`Starting analysis...\n`);

  const startTime = Date.now();
  const pipeline = new Pipeline();

  try {
    const cache = new SqlitePartialCache(targetDir);
    let build;
    try {
      build = await pipeline.build(targetDir, { cache });
    } finally {
      cache.close();
    }
    const { model, fileRecords, stats: buildStats } = build;
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✓ Analysis completed successfully in ${duration}s!`);
    console.log(`--------------------------------------------------`);
    console.log(`Files Processed  : ${model.fileCount} (${buildStats.parsed} parsed, ${buildStats.reused} cached)`);
    console.log(`Total Symbols    : ${model.symbolCount}`);
    console.log(`Resolved Refs    : ${model.resolvedReferences.length}`);
    console.log(`Diagnostics/Warns: ${model.diagnostics.length}`);

    // Persist model, including per-file hashes and parse output for the next run
    const storage = new SqliteSemanticModelStorage();
    await storage.save(model, targetDir, fileRecords);
    console.log(`\nSaved semantic model to:`);
    console.log(`  ${storage.getStoragePath(targetDir)}`);

    // Derive graph stats
    const graph = pipeline.deriveGraph(model);
    const stats = graph.stats();
    console.log(`\nDerived Knowledge Graph stats:`);
    console.log(`  Total Nodes: ${stats.nodes}`);
    console.log(`  Total Edges: ${stats.edges}`);
    console.log(`  Edges by Kind:`);
    for (const [kind, count] of Object.entries(stats.byKind)) {
      console.log(`    - ${kind}: ${count}`);
    }
    console.log(`==================================================\n`);
  } catch (err: any) {
    console.error(`\n❌ Error during analysis:`, err.message || err);
    process.exit(1);
  }
}

// Run CLI if this file is executed directly
const currentFilePath = path.resolve(process.argv[1] || '');
const isExecutedDirectly =
  currentFilePath.endsWith('index.ts') ||
  currentFilePath.endsWith('index.js') ||
  currentFilePath.endsWith('index.mjs');

if (isExecutedDirectly) {
  runCLI();
}
