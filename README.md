# Creed

**A knowledge graph of your codebase, for AI coding agents.**

[![npm](https://img.shields.io/npm/v/creed-kg.svg)](https://www.npmjs.com/package/creed-kg)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

Creed reads your project once — parsing it with Tree-sitter, resolving imports, calls,
inheritance and type usage across files — and stores the result as a SQLite index. Your
agent then asks a question in plain English and gets **one** answer back: the symbols
involved, what depends on them, the exact call sites, and the source, already attached.

Without it, *"what breaks if I change this function?"* costs half a dozen greps and file
reads, produces a partial answer, and is thrown away before the next question. Measured on
this repo, that loop costs [**2–18× the tokens**](#what-it-costs-in-tokens) of a single
`explore` call.

---

## Install

Requires **Node 22+**. Two commands:

```bash
npm install -D creed-kg
```

```bash
npx creed-kg init
```

Both steps matter, and they do different things:

- **`npm install`** downloads Creed into `node_modules/`. It does not look at your code yet —
  nothing is parsed and no index appears.
- **`npx creed-kg init`** does the actual work: indexes your repo, writes the MCP config for
  whichever editors you have, and adds `.creed/` to your `.gitignore`.

**Restart your editor, and your agent has the tool.**

`init` merges rather than overwrites — existing MCP servers and unrelated settings are left
alone — and re-running it is a no-op. Add `--all` to configure every supported editor, or
`--editor cursor` to pick just one.

<details>
<summary><b>What <code>init</code> just created</b></summary>

| Path | What it is |
| :--- | :--- |
| `.creed/graph.db` | The index itself — every symbol and edge in your project. |
| `.mcp.json` *(or your editor's equivalent)* | Tells your editor how to start Creed. |

`.creed/` is **derived data**, not something you maintain. It's gitignored, safe to delete,
and rebuilt from source on the next run. Nothing else in your project is touched.
</details>

<details>
<summary><b>Prefer to configure your editor by hand?</b></summary>

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

Once connected, Creed keeps itself current — a file watcher rebuilds as you edit, re-parsing
only what changed. There is no re-index command to remember, and no stale-index problem to
notice.

---

## Two ways to use it

**Your agent, through MCP.** After `init`, your agent has one tool — `explore` — and reaches
for it on its own. Nothing for you to do.

**You, from the terminal.** The same engine, no editor involved:

```bash
npx creed-kg query "how does authentication work"
```

Ask it anything — a function name, a file name, a half-remembered phrase, or all three mixed
together:

```bash
npx creed-kg query "UserService save"
npx creed-kg query "what happens when a payment fails"
npx creed-kg query "src/auth login token refresh"
```

Both routes read the same `.creed/graph.db` and return the same answer — one as a tool call,
one as text on your terminal. `query` works whether or not you ever ran `init`; if there's no
index yet, it builds one first.

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

## What it costs in tokens

The claim at the top of this README is that one call replaces a grep-and-read loop. Here it
is measured, on this repository — 121 indexed files, counted with a real BPE tokenizer rather
than a chars/4 estimate, since code tokenizes at roughly 3–3.5 chars per token.

The baseline is deliberately generous. It assumes **one** grep, with a pattern that already
contains the right symbol name — as if the agent guessed perfectly on the first try — and
then reads the files it matched. Real agents grep two or three times with imperfect patterns,
read files that turn out to be irrelevant, and re-grep for callers of whatever they found.
None of that is counted.

| Question | `explore` | grep + read every match | grep + read top 5 |
| :--- | ---: | ---: | ---: |
| what breaks if I change `hashSource` | 5,034 | 11,666 | 11,666 |
| what breaks if I change `processPlan` | 9,217 | 27,335 | 19,134 |
| who calls `allocateBudget` | 4,899 | 5,095 | 5,095 |
| how does anchor resolution work | 8,631 | 32,953 | 24,409 |
| how does the file watcher work | 6,548 | 14,769 | 12,409 |
| how does caching work | 7,685 | 60,772 | 17,050 |
| how does discovery rank candidates | 8,117 | 39,790 | 19,862 |
| how does the extraction pipeline work | 9,350 | 42,071 | 10,729 |
| how is the graph built | 7,534 | 124,187 | 40,057 |
| how are symbols stored | 8,950 | 164,931 | 51,305 |
| **Total** | **75,965** | **523,569** — 6.9× | **211,716** — 2.8× |

Two baselines, because agents differ. A thorough one reads everything the grep matched, and
that is the only column that actually sees what Creed's answer covers. A token-conscious one
reads the five most promising files and accepts that it might miss the caller that mattered.

**The multiplier is not the interesting part — the spread is.**

| | cheapest | dearest | spread |
| :--- | ---: | ---: | ---: |
| `explore` | 4,899 | 9,350 | **1.9×** |
| grep + read | 5,095 | 164,931 | **32.4×** |

Creed ranks results down to a token budget, so what it costs barely moves with how broad your
question is. grep's cost is proportional to how common your word happens to be: `symbol`
matches 1,259 lines across 63 files in this repo, and reading those files is 164,931 tokens —
more than most context windows hold, to answer one question.

**Where it doesn't help.** `who calls allocateBudget` came out at 4,899 against 5,095 — a 4%
saving, which is noise. When a symbol is rare and lives in small files, grep was already cheap
and Creed's fixed overhead eats the difference. The savings come from breadth, not from every
lookup.

Reproduce it yourself — the scenarios and the baseline model are all in the script:

```bash
npx tsx scratch/bench-tokens.ts
```

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

- **`init` adds `.creed/` to your `.gitignore` for you.** If you wired up your editor by hand
  instead, add it yourself — it's a derived cache, rebuildable from source at any time, and
  it does not belong in version control.
- **Nothing to re-run after you edit code.** The file watcher rebuilds only what changed.
- `CREED_NO_CACHE=1` forces a full re-parse if you ever want one.
- Deleting `.creed/` is always safe. The next command rebuilds it.

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
