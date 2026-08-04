# CREED - code intelligence

**A knowledge graph of your codebase, exposed as an MCP server — so your AI coding agent stops re-deriving structure from grep and Read on every request.**

Agents working on a codebase they don't already understand spend a huge share of their context budget on discovery: grepping for a symbol, reading the file it's in, grepping again for its callers, reading those files too. MASAI-KG does that analysis once — parsing with Tree-sitter, resolving imports/calls/inheritance across files, and indexing the result — and then answers structural questions directly: *where is this defined, what calls it, what breaks if I change it, how does A reach B.* One tool call instead of a grep-and-read loop.

It's a real static-analysis pipeline, not an LLM guessing from file names — and it tells you when it's *not* sure, rather than presenting a best-effort guess as fact (see [Resolution Confidence](#resolution-confidence--trust-signals) below).

## Why this over grep + Read?

- **Fewer round trips.** `explore_region` returns the anchor's signature, docs, inlined source for high-priority neighbors, every relationship with exact callsites, and a "read next" index — in one call.
- **It resolves across files.** Imports, class inheritance, and (as of this build) instance-method calls through local variables are followed automatically — you get the actual callee, not just a name match.
- **It tells you what it doesn't know.** Every edge is tagged with how confidently it was resolved (`resolved-via: scope/import` vs `⚠ low-confidence: name-only match`), and nodes flag their own unresolved references. A confidently-empty result and a "we couldn't tell" result look different — which matters, because [that distinction found two real resolver bugs during this project's own development](deep_dive_architecture.md#resolver-correctness-history-relevant-to-trusting-analyze_impacttrace_path).
- **It stays current.** A file watcher debounces changes and rebuilds automatically — no manual re-index step in the loop.

## Core Features

- **Multi-Language**: TypeScript, TSX, JavaScript, JSX, Python, Java, and HTML — via native Tree-sitter grammars.
- **Cross-File Reference Resolution**: two-phase resolution (imports first, then lexical scope/instance-type/fallback) links calls, instantiations, inheritance, and type usage to their actual declarations — not just name matches.
- **Framework-Aware**: pluggable adapters detect FastAPI/Flask/NestJS/Express API routes, ORM data models, and service classes, and attach that context directly to the graph.
- **Agent-Ready MCP Server**: five tools (`search_symbols`, `explore_region`, `trace_path`, `analyze_impact`, `query_graph`) exposed over JSON-RPC/stdio for any MCP-compatible client (Claude Code, Cursor, etc.).
- **Confidence-Tagged Output**: every returned edge is labeled with its resolution method, and nodes surface their own unresolved references — see below.
- **Live-Updating**: an `fs.watch`-based debounced rebuild keeps a running `mcp` server's graph in sync with the codebase without manual re-indexing.
- **Interactive Visualizer**: a React Flow-based 2D graph explorer with flat/module/service/API/data views and execution-flow tracing.

## Known Limitations

Being upfront about where static analysis can't (yet) follow the code:

- **`this.field.method()` chains** aren't specially resolved — `this` is treated as a literal identifier, so these calls fall back to low-confidence or unresolved.
- **Dynamic dispatch via registries** (e.g. Python `HANDLERS[key](...)` where `key` is a runtime string) can't be resolved by static analysis at all — `trace_path`/`analyze_impact` will report no path even when a real dependency exists.

Both are documented in detail, with the reasoning and a proposed heuristic fix for the second, in [deep_dive_architecture.md](deep_dive_architecture.md).

---

## Quick Start: MCP Server

This is the primary way to use MASAI-KG — as a tool provider for your AI coding agent.

**1. Build it:**
```bash
npm install
npm run build
```

**2. Register it** in your MCP client's config (e.g. `.mcp.json` for Claude Code):
```json
{
  "mcpServers": {
    "masai-kg": {
      "command": "node",
      "args": ["<path-to-masai-kg>/dist/index.js", "mcp", "<path-to-your-target-project>"]
    }
  }
}
```

On first connect it builds a full semantic model (or loads a cached `.masai/semantic-model.json` if one already exists) and starts watching the target project for changes.

### The Five Tools

| Tool | Use it to ask... |
| :--- | :--- |
| `search_symbols` | "Where is `X` defined?" — resolve a name/kind to concrete node(s) |
| `explore_region` | "What does `X` connect to?" — BFS neighborhood, both directions |
| `trace_path` | "How does A reach B?" — shortest dependency/call path between two anchors |
| `analyze_impact` | "What breaks if I change `X`?" — bounded upstream dependency cone |
| `query_graph` | Escape hatch — run a raw `GraphQueryPlan` directly |

### Resolution Confidence & Trust Signals

Output isn't just "here's an edge" — it tells you how sure it is:

```
- LocateRetriever.retrieve --[call]--> GraphExpander.expand [resolved-via: scope]
  Callsite: src/retrieval/retrievers/locate.ts:11 -> "return expander.expand(candidateIds, {"

- ParserRegistry.getParser [⚠ low-confidence: name-only match]
  ⚠ 3 unresolved reference(s) from here: this.parsers.get, this.getLanguageObject, this.parsers.set
```
`resolved-via: import/scope/qualified_name` means the resolver is confident. `⚠ low-confidence: name-only match` means it fell back to a best-effort name guess — treat those edges with real skepticism. The `unresolvedRefs` line tells you what the graph knows it *couldn't* figure out near a symbol, so an empty result reads differently depending on whether it's clean or full of unresolved warnings.

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

Persists the model to `<path-to-target-project>/.masai/semantic-model.json`.

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
import { JsonSemanticModelStorage } from './src/storage/semantic-model-storage.ts';

async function main() {
  const projectPath = './my-target-project';
  const pipeline = new Pipeline();

  const model = await pipeline.buildFull(projectPath);
  console.log(`Files parsed: ${model.fileCount}`);
  console.log(`Total symbols extracted: ${model.symbolCount}`);
  console.log(`Resolved references: ${model.resolvedReferences.length}`);

  const storage = new JsonSemanticModelStorage();
  await storage.save(model, projectPath);

  const graph = pipeline.deriveGraph(model);

  const callers = graph.getCallersOf('src/auth.ts::login');
  console.log('Callers of login():', callers.map(node => node.id));

  const localGraph = graph.getNeighborhood('src/auth.ts::login', 2);
  console.log(`Neighborhood size: ${localGraph.stats().nodes} nodes`);
}

main();
```

---

## Codebase Architecture

- **[src/index.ts](src/index.ts)**: CLI entry point (`mcp`, `serve`, or default analysis mode) and library exports.
- **[src/pipeline.ts](src/pipeline.ts)**: Orchestrates parse → extract → merge → index → resolve → graph.
- **[src/stage1-parse/](src/stage1-parse/)**: Walks the workspace and builds Tree-sitter ASTs.
- **[src/stage2-extract/](src/stage2-extract/)**: S-expression queries → normalized symbols/scopes/references. Framework adapters (`src/frameworks/`) run here too.
- **[src/stage3-registry/](src/stage3-registry/)**: Indexed symbol/scope lookup tables.
- **[src/stage4-resolve/](src/stage4-resolve/)**: Two-phase reference resolution (imports, then lexical scope + instance-type + fallback).
- **[src/stage5-graph/](src/stage5-graph/)**: The queryable `KnowledgeGraph` API.
- **[src/retrieval/](src/retrieval/)**: Bulk context-packaging layer for feeding an LLM prompt directly (distinct from the MCP tools, which are for fine-grained agent queries).
- **[src/mcp/](src/mcp/), [src/resolution/](src/resolution/), [src/executor/](src/executor/), [src/evidence/](src/evidence/), [src/optimizer/](src/optimizer/)**: The MCP server stack — anchor resolution, graph algorithms, source materialization, token-budget allocation, and text serialization.
- **[src/watcher.ts](src/watcher.ts)**: Debounced auto-rebuild for a running `mcp` server.
- **[src/semantic-model/](src/semantic-model/)**: Core schema, builders, and merge logic.
- **[src/storage/](src/storage/)**: Persists/loads the semantic model JSON.

For a deep dive into every stage's algorithms, data structures, and known resolver limitations, see **[deep_dive_architecture.md](deep_dive_architecture.md)**.

---

## Running Tests

```bash
npm test          # run once
npm run test:watch # watch mode
```
