import * as path from 'path';
import { Pipeline } from '../src/pipeline.js';
import { SqliteSemanticModelStorage } from '../src/storage/sqlite/sqlite-model-storage.js';
import { RetrievalEngine } from '../src/retrieval/api.js';

async function run() {
  const query = process.argv.slice(2).join(' ');

  if (!query) {
    console.log('\n❌ Please provide a query to search the Knowledge Graph.');
    console.log('Usage: npx tsx scratch/query.ts "<your-query-here>"');
    console.log('Example: npx tsx scratch/query.ts "How does login work?"\n');
    process.exit(1);
  }

  const projectRoot = path.resolve('.');
  const storage = new SqliteSemanticModelStorage();

  console.log(`\n🔍 Loading Knowledge Graph for: ${projectRoot}`);
  let model;
  try {
    model = await storage.load(projectRoot);
  } catch (err) {
    console.error(`❌ Failed to load semantic model from .masai/ directory. Make sure you run "npm run dev" first.`);
    process.exit(1);
  }

  const pipeline = new Pipeline();
  const graph = pipeline.deriveGraph(model);
  const engine = new RetrievalEngine(graph, projectRoot);

  console.log(`🧠 Running Retrieval Query: "${query}"`);
  console.log(`--------------------------------------------------`);

  const startTime = Date.now();
  const context = await engine.retrieveContext(query);
  const duration = Date.now() - startTime;

  console.log(`\n🎯 Retrieval Strategy: ${context.strategy.toUpperCase()}`);
  console.log(`⚡ Query Duration: ${duration}ms`);
  console.log(`--------------------------------------------------`);

  console.log(`\n📁 Relevant Files (${context.relevantFiles.length}):`);
  context.relevantFiles.forEach(f => console.log(`  - ${f}`));

  console.log(`\n📍 Relevant Symbols (${context.relevantSymbols.length}):`);
  context.relevantSymbols.forEach(s => {
    console.log(`  - [${s.kind}] ${s.qualifiedName} (${s.filePath}:${s.range.start.line + 1})`);
  });

  if (context.executionFlows && context.executionFlows.length > 0 && context.executionFlows[0].length > 0) {
    console.log(`\n🔄 Execution Flow Steps:`);
    context.executionFlows[0].forEach(step => {
      console.log(`  Step ${step.step}: ${step.fromName} --(${step.relationKind})--> ${step.toName}`);
    });
  }

  console.log(`\n✂️ Extracted Code Snippets (${context.codeSnippets.length}):`);
  context.codeSnippets.forEach(snippet => {
    console.log(`\n--- Symbol: ${snippet.symbolName} in ${snippet.filePath} (Lines ${snippet.startLine}-${snippet.endLine}) ---`);
    console.log(snippet.content);
  });
  console.log(`--------------------------------------------------\n`);
}

run().catch(err => {
  console.error('Error executing query script:', err);
});
