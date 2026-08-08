# Creed

**Stop paying your AI agent to rediscover your codebase on every single request.**

[![npm](https://img.shields.io/npm/v/creed-kg.svg)](https://www.npmjs.com/package/creed-kg)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

Ask your agent "what breaks if I change this function?" and watch what happens: grep for the
name, read the file, grep for callers, read those files, grep again for *their* callers.
Half a dozen tool calls and thousands of tokens later, it has a partial answer — and it
throws all of it away before your next question.

Creed does that analysis **once**. It parses your code with Tree-sitter, resolves imports,
calls, inheritance and type usage across files, and indexes the whole thing into SQLite.
Then your agent just asks:

> *what breaks if I change `hashSource`?*

and gets the answer in **one call**, with the callers, the exact call sites, and the source
already attached.

```bash
npm install -D creed-kg
```

---

## Try it on your own code, right now

No editor setup, no config file. Install it and ask a question:

```bash
npm install -D creed-kg
npx creed-kg query "how does authentication work"
```

Creed indexes your project on the spot and prints the answer — the symbols involved, what
depends on them, the call sites, and the source. Ask it anything: a function name, a file
name, a half-remembered phrase, or all three mixed together.

```bash
npx creed-kg query "UserService save"
npx creed-kg query "what happens when a payment fails"
npx creed-kg query "src/auth login token refresh"
```

That's the same engine your agent gets — you're just reading it yourself.

---

## Wire it into your editor

Creed speaks standard MCP over stdio, so it works in **Claude Code, Claude Desktop, Cursor,
Antigravity, Kiro, Windsurf, VS Code** — anything that speaks the protocol.

**It's the same block everywhere.** Only the file it goes in changes:

```json
{
  "mcpServers": {
    "creed": {
      "command": "npx",
      "args": ["creed-kg", "mcp", "."]
    }
  }
}
```

| Editor | Where it goes |
| :--- | :--- |
| **Claude Code** | `.mcp.json` in your project root — or just run `claude mcp add creed -- npx creed-kg mcp .` |
| **Claude Desktop** | `claude_desktop_config.json` — run **`npx creed-kg setup`** and it writes the file for you |
| **Cursor** | `.cursor/mcp.json` (this project) or `~/.cursor/mcp.json` (everywhere) |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Kiro** | `.kiro/settings/mcp.json` (workspace) or `~/.kiro/settings/mcp.json` (user) |
| **Antigravity** | Add it from the editor's MCP settings panel — same block |
| **VS Code / Copilot** | `.vscode/mcp.json` — note VS Code names the key `servers`, not `mcpServers` |

Restart the editor and your agent has the six tools below.

`npx creed-kg mcp .` indexes on first connect and then keeps itself current — a file watcher
rebuilds as you edit, re-parsing only what actually changed. There is no re-index command to
remember.

---

## What your agent actually receives

Not a JSON blob it has to decode — formatted markdown with the code already in it:

````
**Exploration: SqlitePartialCache hashSource**

Found 19 symbol(s) across 5 file(s).

**Blast radius — what depends on these (update/verify before editing)**

- `SqlitePartialCache` (class — src/storage/sqlite/partial-cache.ts:49) — 8 caller(s) across src/index.ts, src/watcher.ts
- `hashSource` (function — src/storage/sqlite/partial-cache.ts:24) — 4 caller(s) across src/pipeline.ts

**Relationships**

- `Pipeline.build` --[call]--> `hashSource` [resolved-via: import]
  src/pipeline.ts:60 → `const contentHash = hashSource(file.sourceCode);`

**Source Code**

**`src/storage/sqlite/partial-cache.ts`** — hashSource(function), SqlitePartialCache(class)

```typescript
24	export function hashSource(sourceCode: string): string {
25	  return crypto.createHash('sha1').update(sourceCode, 'utf8').digest('hex');
26	}
```
````

Three things worth noticing:

**The blast radius comes first.** Before touching anything, your agent knows what depends on
it and where those callers live.

**Every relationship carries its call site** — the file, the line, and the actual line of
code. No follow-up reads to find out *where* the call happens.

**The source is line-numbered.** Your agent can cite `partial-cache.ts:24` from what it was
handed, instead of reopening the file to work out where anything sits.

---

## Six tools, one you'll use most

| Tool | Ask it |
| :--- | :--- |
| **`explore_flow`** | **Start here.** Throw a free-form query at it — symbol names, file names, plain English, mixed together. It figures out which terms are real, traverses from all of them, and shows how they connect. |
| `search_symbols` | "Where is `X` defined?" |
| `explore_region` | "What does `X` connect to?" |
| `trace_path` | "How does A reach B?" |
| `analyze_impact` | "What breaks if I change `X`?" |
| `query_graph` | Escape hatch for a raw query plan. |

Most sessions never need more than `explore_flow` — it replaces the
search → copy-an-ID → explore round-trip with a single call.

---

## It tells you when it isn't sure

This is a real static-analysis pipeline, not a language model guessing from file names. And
where it *can't* be certain, it says so instead of presenting a guess as fact:

```
- Pipeline.build --[call]--> hashSource        [resolved-via: import]
- ParserRegistry.getParser                     [⚠ low-confidence: name-only match]
  ⚠ 3 unresolved reference(s) from here: this.parsers.get, this.getLanguageObject
```

Every edge is labelled with **how** it was resolved. `resolved-via: import/scope` means the
resolver followed a real link. `⚠ low-confidence` means it fell back to matching a name and
you should treat it with suspicion.

That distinction is the difference between "nothing depends on this" and "I couldn't tell" —
two answers that look identical in every grep-based workflow, and lead to very different
decisions. It's also how two real resolver bugs got caught during Creed's own development.

---

## Built for codebases that are actually large

The index lives in SQLite, not in memory. Lookups go through real indexes — including an
FTS5 trigram index for substring search — so finding a symbol costs the same whether your
project has ten thousand symbols or two hundred thousand:

| Your codebase | Symbol lookup | Memory used |
| :--- | :--- | :--- |
| 10k symbols | 0.7 ms | ~0 |
| 50k symbols | 1.8 ms | ~0 |
| 200k symbols | **1.7 ms** | **~0** |

*(An in-memory graph answers the same 200k-symbol lookup in 94.6 ms and holds 75.6 MB of
heap to do it.)*

**Re-indexing is close to free.** Every file's parse output is cached and keyed by a content
hash, so a rebuild only touches what changed:

| | Time |
| :--- | :--- |
| First index (110 files) | 3.97s |
| Rebuild, nothing changed | **0.15s** |
| Rebuild, one file edited | **0.16s** |

Which is why staleness never becomes your problem — it's cheap enough to just always be
current.

---

## Languages and frameworks

**TypeScript · TSX · JavaScript · JSX · Python · Java · HTML**, via native Tree-sitter
grammars.

Creed also recognises what your code *means*, not just its shape: adapters detect
**FastAPI, Flask, NestJS and Express** routes, ORM data models, and service classes, and
attach that straight to the graph. So `explore_flow "POST /login"` resolves to the handler.

Cross-file resolution follows imports, class inheritance, instance-method calls through
local variables, and `this.field.method()` chains — through the field's declared type,
interface members, imported types, and even standard-library and dependency types, which
become explicit nodes marking exactly where your code meets its dependencies.

---

## See it, too

```bash
npx creed-kg serve .
```

Opens an interactive 2D graph explorer in your browser — flat, module, service, API and data
views, a details inspector, and execution-flow tracing. Ships prebuilt; nothing to compile.

---

## Every command

| Command | What it does |
| :--- | :--- |
| `npx creed-kg query "<question>"` | Ask about your codebase and print the answer |
| `npx creed-kg mcp .` | Run as an MCP server for your editor |
| `npx creed-kg .` | Index and print a report |
| `npx creed-kg serve .` | Open the visual explorer |
| `npx creed-kg setup` | Write the Claude Desktop config for you |

Add `--path <dir>` to `query` to point it at a project other than the current directory.

The index is a normal SQLite database at `.masai/graph.db` — query it however you like:

```bash
sqlite3 .masai/graph.db "SELECT name, kind, file_path FROM symbols WHERE name_lower = 'userservice';"
```

Or drive the pipeline directly:

```typescript
import { Pipeline, SqliteSemanticModelStorage, SqliteKnowledgeGraph } from 'creed-kg';

const project = './my-project';

// Index it (fileRecords carry the parse cache, so the next build starts warm)
const { model, fileRecords } = await new Pipeline().build(project);
await new SqliteSemanticModelStorage().save(model, project, fileRecords);

// Query it — indexed lookups, bounded memory
const graph = new SqliteKnowledgeGraph(project);
console.log(graph.getCallersOf('src/auth.ts::login').map(n => n.id));
graph.close();
```

---

## Good to know

- **Node 22+** required.
- Add **`.masai/`** to your `.gitignore` — it's a derived cache, rebuildable from source at
  any time.
- `MASAI_NO_CACHE=1` forces a full re-parse if you ever want one.

---

## Contributing

```bash
git clone https://github.com/jaarso0/MASAI-KG.git
npm install
npm test
```

[**Architecture**](architecture.md) · [**Deep dive**](deep_dive_architecture.md) ·
[**Coverage notes**](limitations.md)

MIT licensed.
