#!/usr/bin/env node

import * as path from 'path';
import { Pipeline } from './pipeline.js';
import { SqliteSemanticModelStorage } from './storage/sqlite/sqlite-model-storage.js';
import { SqlitePartialCache } from './storage/sqlite/partial-cache.js';

import * as os from 'os';
import * as fs from 'fs/promises';
import * as readline from 'readline';
import { startServer } from './serve.js';

// Export everything for programmatic use
export { Pipeline } from './pipeline.js';
export { JsonSemanticModelStorage } from './storage/semantic-model-storage.js';
export { SqliteSemanticModelStorage } from './storage/sqlite/sqlite-model-storage.js';
export { openDatabase, getDatabasePath, databaseExists } from './storage/sqlite/db.js';
export * from './semantic-model/types.js';
export { KnowledgeGraph } from './graph/graph.js';
export { startServer } from './serve.js';
export { RetrievalEngine } from './retrieval/api.js';
export * from './retrieval/types.js';

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

  const defaultDir = process.cwd();
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

    config.mcpServers['creed'] = {
      command: 'npx',
      args: [
        '-y',
        'creed',
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

// CLI Execution Support
async function runCLI() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'setup' || command === 'configure') {
    await runSetup();
    return;
  }

  if (command === 'serve' || command === 'visualize') {
    const targetDir = args[1] ? path.resolve(args[1]) : process.cwd();
    try {
      await startServer(targetDir);
    } catch (err: any) {
      console.error(`\n❌ Error starting server:`, err.message || err);
      process.exit(1);
    }
    return;
  }

  if (command === 'mcp') {
    const targetDir = args[1] ? path.resolve(args[1]) : process.cwd();
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
      // edge lookups are indexed reads against .masai/graph.db, so resident memory
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

  const targetDir = args[0] ? path.resolve(args[0]) : process.cwd();

  console.log(`\n==================================================`);
  console.log(` MASAI Knowledge Graph Builder v1.0.0`);
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
