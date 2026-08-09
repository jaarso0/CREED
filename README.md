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

## Wire it into your editor — one command

```bash
npx creed-kg init
```

That indexes the repo, detects which editors you use, writes the MCP config for each, and
adds `.creed/` to your `.gitignore`. **Restart your editor and your agent has the tools.**

It merges — existing MCP servers and unrelated settings are left alone — and re-running is
a no-op. Use `--all` to configure every supported editor, or `--editor cursor` to pick one.

<details>
<summary>Prefer to do it by hand?</summary>

It's the same block everywhere, with **no project path to fill in** — Creed walks up from
wherever your editor launches it to find the project root, so this works in every repo:

```json
{
  "mcpServers": {
    "creed": {
      "command": "npx",
      "args": ["-y", "creed-kg", "mcp"]
    }
  }
}
```

| Editor | Where it goes |
| :--- | :--- |
| **Claude Code** | `.mcp.json` — or `claude mcp add creed -- npx creed-kg mcp` |
| **Cursor** | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |
| **Kiro** | `.kiro/settings/mcp.json` |
| **Gemini CLI** | `.gemini/settings.json` |
| **VS Code / Copilot** | `.vscode/mcp.json` — names the key `servers`, not `mcpServers` |
| **Claude Desktop** | run `npx creed-kg setup` |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Codex CLI** | `~/.codex/config.toml` — TOML, `[mcp_servers.creed]` |
| **Antigravity** | the editor's MCP settings panel |

Because the block carries no path, you can put it in a **global** config once and it works
in every project you open.
</details>

Once connected, the server indexes on first connect and keeps itself current — a file
watcher rebuilds as you edit, re-parsing only what changed. There is no re-index command to
remember.

---

## What your agent actually receives

Not a JSON blob it has to decode — formatted markdown with the code already in it:

````
**Exploration: what breaks if I change hashSource**

Anchored on: `hashSource` (function — src/storage/sqlite/partial-cache.ts:24)

Found 9 symbol(s) across 5 file(s).

**Blast radius — what depends on these (update/verify before editing)**

- `hashSource` (function — src/storage/sqlite/partial-cache.ts:24) — 4 caller(s) across src/pipeline.ts, tests/partial-cache.test.ts

**Relationships**

- `Pipeline.build` --[call]--> `hashSource` [resolved-via: import]
  src/pipeline.ts:60 → `const contentHash = hashSource(file.sourceCode);`
- `watchAndRebuild` --[call]--> `Pipeline.build` [resolved-via: scope]
  src/watcher.ts:56 → `result = await pipeline.build(targetDir, { cache });`

**Source Code**

**`src/storage/sqlite/partial-cache.ts`** — hashSource(function)

```typescript
24	export function hashSource(sourceCode: string): string {
25	  return crypto.createHash('sha1').update(sourceCode, 'utf8').digest('hex');
26	}
```
````

Four things worth noticing:

**It says what it anchored on.** The question was English; the header names the symbol it
actually resolved to. When a question anchors somewhere you didn't intend, you can see it —
rather than reading a confident answer about the wrong function.

**The blast radius comes first.** Before touching anything, your agent knows what depends on
it and where those callers live.

**Every relationship carries its call site** — the file, the line, and the actual line of
code. No follow-up reads to find out *where* the call happens.

**The source is line-numbered.** Your agent can cite `partial-cache.ts:24` from what it was
handed, instead of reopening the file to work out where anything sits.

---

## One tool

`explore`. Throw a question at it — symbol names, file names, plain English, or all three
mixed together — and it answers.

| Ask it | And it |
| :--- | :--- |
| "how does crawling work" | anchors on every symbol the concept spans and returns all of them |
| "where is `X` defined" | anchors on the definition and its neighbourhood |
| "what does `X` connect to" | traverses outward from `X` |
| "how does A reach B" | synthesizes the call path connecting them |
| "what breaks if I change `X`" | flips to incoming edges and traces the dependency cone |

There's nothing to choose between and no anchor to look up first. A multi-tool surface makes
you decide, *before* you know the answer, whether your question is a search, a neighbourhood,
a path or an impact query — and then hand it a symbol name you'd have to go find. That round
trip is where questions phrased in English tend to die.

Here the whole question is resolved at once, which matters most when the word you used isn't
the word in the code:

- **A concept spanning several symbols anchors on all of them.** "crawling", against a
  codebase with `crawl_site`, `crawl_competitors` and `get_crawled_pages`, returns all
  three — rather than picking one arbitrarily or giving up because the term was ambiguous.
- **English word endings reach the code's spelling** — "resolution" finds `AnchorResolver`,
  "traversal" finds `traverse`.
- **Typos still resolve** — "anchor resolvr" lands on `AnchorResolver`.
- **Generic words are searched, not discarded.** A project whose central class is `Config` is
  findable by asking for "config".
- **Words that co-occur reinforce each other**, so "voice agent context" ranks the file where
  all three land above anything matching only one.

Terms that match nothing are simply ignored — and when they add up to a real share of what
you asked, the answer says so rather than quietly returning less.

`depth`, `direction`, `edgeKinds` and `maxAnchors` are there when you want to steer it, and
are inferred from the question when you don't.

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

The same applies to the question itself. If most of what you asked matched no symbol, or you
named two symbols and nothing connects them, the answer says so in a footer — under the
content, not above it, so a warning on every good result never trains you to skip it.

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
attach that straight to the graph. So `explore "POST /login"` resolves to the handler.

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
| `npx creed-kg init` | Index the repo and connect it to your editors |
| `npx creed-kg query "<question>"` | Ask about your codebase and print the answer |
| `npx creed-kg mcp` | Run as an MCP server for your editor |
| `npx creed-kg` | Index and print a report |
| `npx creed-kg serve` | Open the visual explorer |
| `npx creed-kg setup` | Write the Claude Desktop config for you |

Every command finds the project root on its own; `--path <dir>` overrides it.

The index is a normal SQLite database at `.creed/graph.db` — query it however you like:

```bash
sqlite3 .creed/graph.db "SELECT name, kind, file_path FROM symbols WHERE name_lower = 'userservice';"
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
- Add **`.creed/`** to your `.gitignore` — it's a derived cache, rebuildable from source at
  any time.
- `CREED_NO_CACHE=1` forces a full re-parse if you ever want one.

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
