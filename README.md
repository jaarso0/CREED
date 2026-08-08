# CREED - code intelligence

**A knowledge graph of your codebase, exposed as an MCP server — so your AI coding agent stops re-deriving structure from grep and Read on every request.**

Agents working on a codebase they don't already understand spend a huge share of their context budget on discovery: grepping for a symbol, reading the file it's in, grepping again for its callers, reading those files too. Creed does that analysis once — parsing with Tree-sitter, resolving imports/calls/inheritance across files, and indexing the result into SQLite — and then answers structural questions directly: *where is this defined, what calls it, what breaks if I change it, how does A reach B.* One tool call instead of a grep-and-read loop.

It's a real static-analysis pipeline, not an LLM guessing from file names — and it tells you when it's *not* sure, rather than presenting a best-effort guess as fact (see [Resolution Confidence](#resolution-confidence--trust-signals) below).

## Why this over grep + Read?

- **Fewer round trips.** `explore_flow` returns the anchor's signature, docs, blast radius, every relationship with exact callsites, and the verbatim line-numbered source — in one call.
- **It resolves across files.** Imports, class inheritance, and (as of this build) instance-method calls through local variables are followed automatically — you get the actual callee, not just a name match.
- **It tells you what it doesn't know.** Every edge is tagged with how confidently it was resolved (`resolved-via: scope/import` vs `⚠ low-confidence: name-only match`), and nodes flag their own unresolved references. A confidently-empty result and a "we couldn't tell" result look different — which matters, because [that distinction found two real resolver bugs during this project's own development](deep_dive_architecture.md#resolver-correctness-history-relevant-to-trusting-analyze_impacttrace_path).
- **It stays current.** A file watcher debounces changes and rebuilds automatically — no manual re-index step in the loop.

## Core Features

- **Multi-Language**: TypeScript, TSX, JavaScript, JSX, Python, Java, and HTML — via native Tree-sitter grammars.
- **Cross-File Reference Resolution**: two-phase resolution (imports first, then lexical scope/instance-type/fallback) links calls, instantiations, inheritance, and type usage to their actual declarations — not just name matches.
- **Framework-Aware**: pluggable adapters detect FastAPI/Flask/NestJS/Express API routes, ORM data models, and service classes, and attach that context directly to the graph.
- **Agent-Ready MCP Server**: six tools (`explore_flow`, `search_symbols`, `explore_region`, `trace_path`, `analyze_impact`, `query_graph`) exposed over JSON-RPC/stdio for any MCP-compatible client (Claude Code, Cursor, etc.).
- **Confidence-Tagged Output**: every returned edge is labeled with its resolution method, and nodes surface their own unresolved references — see below.
- **SQLite-Backed Index**: the graph lives in `.masai/graph.db`, served through real indexes (including an FTS5 trigram index for substring symbol search) rather than held entirely in memory — so resident memory tracks what a query touches, not the size of the repo.
- **Incremental Re-Indexing**: each file's parse output is cached and keyed by a content hash, so a rebuild only re-parses what changed.
- **Live-Updating**: an `fs.watch`-based debounced rebuild keeps a running `mcp` server's graph in sync with the codebase without manual re-indexing.
- **Interactive Visualizer**: a React Flow-based 2D graph explorer with flat/module/service/API/data views and execution-flow tracing.

## What it resolves

`this.field.method()` chains resolve through the enclosing class, the field's declared type,
interface members, imported types, and stdlib/dependency types — the last become explicit
`external::` nodes, so a call into `Map` or `better-sqlite3` shows up as a real edge marking
where your code meets its dependencies, instead of vanishing.

Coverage is tracked in [limitations.md](limitations.md).

---

## Quick Start: MCP Server

This is the primary way to use Creed — as a tool provider for your AI coding agent.

**1. Build it:**
```bash
npm install
npm run build
```

**2. Register it** in your MCP client's config (e.g. `.mcp.json` for Claude Code):
```json
{
  "mcpServers": {
    "creed": {
      "command": "node",
      "args": ["<path-to-creed>/dist/index.js", "mcp", "<path-to-your-target-project>"]
    }
  }
}
```

For Claude Desktop, `node dist/index.js setup` writes this entry for you after prompting
for the directory to index.

On first connect it builds a full semantic model, writes it to `.masai/graph.db`, and starts watching the target project for changes.

### The Six Tools

| Tool | Use it to ask... |
| :--- | :--- |
| `explore_flow` | **Start here.** One free-form query mixing symbol names, file names and plain English — resolves the meaningful terms, traverses from all of them, and returns how they connect |
| `search_symbols` | "Where is `X` defined?" — resolve a name/kind to concrete node(s) |
| `explore_region` | "What does `X` connect to?" — BFS neighborhood, both directions |
| `trace_path` | "How does A reach B?" — shortest dependency/call path between two anchors |
| `analyze_impact` | "What breaks if I change `X`?" — bounded upstream dependency cone |
| `query_graph` | Escape hatch — run a raw `GraphQueryPlan` directly |

### What the tools return

Markdown, not JSON: a blast-radius summary, the anchors with their signatures and doc
comments, every relationship with its exact callsite, then the verbatim **line-numbered**
source grouped by file — so a caller can cite `file.ts:42` from what it was handed
instead of reopening the file to find out where anything lives.

````
**Exploration: SqlitePartialCache hashSource**

Found 19 symbol(s) across 5 file(s).

**Blast radius — what depends on these (update/verify before editing)**

- `SqlitePartialCache` (class — src/storage/sqlite/partial-cache.ts:49) — 8 caller(s) across src/index.ts, src/watcher.ts
- `hashSource` (function — src/storage/sqlite/partial-cache.ts:24) — 4 caller(s) across src/pipeline.ts

**Relationships**

- `Pipeline.build` --[call]--> `hashSource` [resolved-via: import]
  src/pipeline.ts:60 → `const contentHash = hashSource(file.sourceCode);`
- `ParserRegistry.getParser` [⚠ low-confidence: name-only match]
  ⚠ 3 unresolved reference(s) from here: this.parsers.get, this.getLanguageObject

**Source Code**

> The code below is the verbatim, current on-disk source of these symbols, line-numbered.
> Treat it as a Read you have already performed — no need to reopen these files.

**`src/storage/sqlite/partial-cache.ts`** — hashSource(function), SqlitePartialCache(class)

```typescript
24	export function hashSource(sourceCode: string): string {
25	  return crypto.createHash('sha1').update(sourceCode, 'utf8').digest('hex');
26	}
```
````

Output self-caps to a token budget (8,000 by default, hard-stopped at 40k characters), so
a broad query on a well-connected symbol degrades gracefully instead of failing. Anything
dropped is reported in a footer note rather than silently omitted.

### Resolution Confidence & Trust Signals

Output isn't just "here's an edge" — it tells you how sure it is.
`resolved-via: import/scope/qualified_name` means the resolver is confident.
`⚠ low-confidence: name-only match` means it fell back to a best-effort name guess — treat
those edges with real skepticism. The unresolved-references line tells you what the graph
knows it *couldn't* figure out near a symbol, so an empty result reads differently
depending on whether it's clean or full of unresolved warnings.

---

## Quick Start: CLI Analysis Pipeline

Build a semantic model and print a diagnostic report without starting the MCP server.

```bash
# Development (JIT via tsx)
npm run dev -- <path-to-target-project>

# Production
npm run build
node dist/index.js <path-to-target-project>
```

Persists the model to `<path-to-target-project>/.masai/graph.db` — a normalized, indexed
SQLite database. You can query it directly:

```bash
sqlite3 .masai/graph.db "SELECT name, kind, file_path FROM symbols WHERE name_lower = 'userservice';"
```

Each file's parse output is cached in the database and keyed by a content hash, so
re-indexing only re-parses what changed. Set `MASAI_NO_CACHE=1` to force a full re-parse.

### Index performance

Measured on this repo (110 files, 791 symbols):

| Build | Time |
| :--- | :--- |
| cold, no cache | 3.97s |
| rebuild, nothing changed | 0.15s |
| rebuild, one file changed | 0.16s (1 parsed, 109 reused) |

And on synthetic corpora, comparing the SQLite backend against holding the whole graph in
memory. "Specific lookup" is a query naming a particular symbol:

| Corpus | Lookup (in-memory) | Lookup (sqlite) | Memory (in-memory) | Memory (sqlite) |
| :--- | :--- | :--- | :--- | :--- |
| 10k symbols | 2.9ms | **0.7ms** | 5.6 MB | ~0 |
| 50k symbols | 19.1ms | **1.8ms** | 21.7 MB | ~0 |
| 200k symbols | 94.6ms | **1.7ms** | 75.6 MB | ~0 |

Specific lookups stay flat as the corpus grows, while the in-memory path grows linearly.

---

## Quick Start: Interactive Visualizer

A web-based 2D node-link graph explorer with a details inspector, flat/module/service/API/data view modes, and execution-flow tracing.

```bash
# Build the frontend once
cd visualizer && npm install && npm run build && cd ..

# Serve it
npm run serve -- <path-to-target-project>
```
Opens `http://localhost:3000` (or the next available port) automatically.

For frontend development with hot reload, run `npm run serve -- <path>` in one terminal and `cd visualizer && npm run dev` in another — the Vite dev server at `:5173` proxies API requests to the backend.

---

## Programmatic API Usage

```typescript
import { Pipeline } from './src/pipeline.ts';
import { SqliteSemanticModelStorage } from './src/storage/sqlite/sqlite-model-storage.ts';
import { SqlitePartialCache } from './src/storage/sqlite/partial-cache.ts';
import { SqliteKnowledgeGraph } from './src/graph/sqlite-graph.ts';

async function main() {
  const projectPath = './my-target-project';
  const pipeline = new Pipeline();

  // Reuse cached parse output for files whose contents haven't changed.
  const cache = new SqlitePartialCache(projectPath);
  const { model, fileRecords, stats } = await pipeline.build(projectPath, { cache });
  cache.close();

  console.log(`Files: ${model.fileCount} (${stats.parsed} parsed, ${stats.reused} cached)`);
  console.log(`Symbols: ${model.symbolCount}, refs: ${model.resolvedReferences.length}`);

  // Persist, passing fileRecords so the next build starts warm.
  await new SqliteSemanticModelStorage().save(model, projectPath, fileRecords);

  // Query from disk — bounded memory, indexed lookups.
  const graph = new SqliteKnowledgeGraph(projectPath);
  try {
    const callers = graph.getCallersOf('src/auth.ts::login');
    console.log('Callers of login():', callers.map(node => node.id));

    const localGraph = graph.getNeighborhood('src/auth.ts::login', 2);
    console.log(`Neighborhood size: ${localGraph.stats().nodes} nodes`);
  } finally {
    graph.close();
  }
}

main();
```

`pipeline.buildFull(projectPath)` remains as a one-liner that returns just the model, with
no cache. For an in-memory graph instead, use `pipeline.deriveGraph(model)` — both
implement `ReadableGraph`, so downstream code doesn't change.

---

## Codebase Architecture

- **[src/index.ts](src/index.ts)**: CLI entry point (`mcp`, `serve`, or default analysis mode) and library exports.
- **[src/pipeline.ts](src/pipeline.ts)**: Orchestrates parse → extract → merge → index → resolve → graph.
- **[src/parse/](src/parse/)**: Walks the workspace and builds Tree-sitter ASTs. `walkProject` (discover + read) is split from `parseSourceFile` so unchanged files can skip parsing.
- **[src/extract/](src/extract/)**: S-expression queries → normalized symbols/scopes/references. Framework adapters (`src/frameworks/`) run here too.
- **[src/registry/](src/registry/)**: Indexed symbol/scope lookup tables.
- **[src/resolve/](src/resolve/)**: Two-phase reference resolution (imports, then lexical scope + instance-type + fallback).
- **[src/graph/](src/graph/)**: The queryable graph. Consumers depend on the `ReadableGraph` interface, implemented by both the in-memory `KnowledgeGraph` and the SQLite-backed `SqliteKnowledgeGraph`.
- **[src/retrieval/](src/retrieval/)**: Symbol lookup and candidate discovery behind the `SymbolIndex` interface — in-memory (`RetrievalIndexes`) or SQLite/FTS5 (`SqliteSymbolIndex`).
- **[src/mcp/](src/mcp/), [src/resolution/](src/resolution/), [src/executor/](src/executor/), [src/evidence/](src/evidence/), [src/optimizer/](src/optimizer/)**: The MCP server stack — anchor resolution, graph algorithms, source materialization, token-budget allocation, and markdown serialization.
- **[src/watcher.ts](src/watcher.ts)**: Debounced auto-rebuild for a running `mcp` server.
- **[src/semantic-model/](src/semantic-model/)**: Core schema, builders, and merge logic.
- **[src/storage/sqlite/](src/storage/sqlite/)**: Schema/migrations, row mapping, model persistence, and the per-file parse cache.

For a deep dive into every stage's algorithms and data structures, see **[deep_dive_architecture.md](deep_dive_architecture.md)**. Coverage gaps are tracked in **[limitations.md](limitations.md)**.

---

## Running Tests

```bash
npm test          # run once
npm run test:watch # watch mode
```
