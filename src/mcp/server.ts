import * as readline from 'readline';
import { ReadableGraph } from '../graph/graph.js';
import { GraphQueryPlan } from './types.js';
import { validateGraphQueryPlan } from './schemas.js';
import {
  compileSearchSymbols,
  compileExploreRegion,
  compileTracePath,
  compileAnalyzeImpact,
  compileExplore
} from './compile.js';
import { RequestController } from './controller.js';
import { SymbolIndex } from '../retrieval/symbol-index.js';

/** The graph and its symbol index, once indexing has finished. */
export interface GraphBundle {
  graph: ReadableGraph;
  index?: SymbolIndex;
}

export class MCPServer {
  private graph: ReadableGraph | undefined;
  private projectRoot: string;
  private controller: RequestController | undefined;
  private index: SymbolIndex | undefined;
  /** Resolves when the first index build lands; rejects if it failed outright. */
  private ready: Promise<void>;
  private readyError: string | null = null;

  /**
   * Takes the graph as a *promise* rather than a value, so `start()` can attach to stdio and
   * complete the MCP handshake while indexing is still running.
   *
   * Blocking the handshake on the build was the original shape, and it put the size of the
   * user's repository inside the client's startup deadline: a large project times out before
   * `initialize` is ever answered, and the client reports a dead server rather than a slow
   * one. `initialize` and `tools/list` are static facts about this server and need no graph;
   * only `tools/call` genuinely has to wait, and it waits here rather than in the client.
   */
  constructor(projectRoot: string, ready: Promise<GraphBundle>) {
    this.projectRoot = projectRoot;
    this.ready = ready.then(
      (bundle) => {
        this.applyBundle(bundle);
      },
      (err: any) => {
        // Held as a message rather than rethrown per call site: an unhandled rejection here
        // would take down a server that is otherwise perfectly able to report the problem.
        this.readyError = err?.message || String(err);
        console.error('Index build failed — tools will report this:', this.readyError);
      }
    );
  }

  private applyBundle(bundle: GraphBundle): void {
    this.graph = bundle.graph;
    if (bundle.index) this.index = bundle.index;
    this.controller = new RequestController(bundle.graph, this.projectRoot, this.index);
  }

  /**
   * Swaps in a freshly rebuilt graph. `index` is optional so the SQLite backend can
   * hand over a refreshed symbol index alongside the graph; omitting it keeps the
   * previous one, which is correct for the in-memory backend where the index is
   * derived from the graph itself.
   */
  public updateGraph(graph: ReadableGraph, index?: SymbolIndex): void {
    this.applyBundle({ graph, index });
    // A successful rebuild clears a failed initial build: the graph on disk is now good,
    // so continuing to report the old error would be wrong.
    this.readyError = null;
  }

  public start(): void {
    console.error('creed-kg MCP server starting on stdio...');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async (line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        await this.handleMessage(message);
      } catch (err: any) {
        this.sendError(null, -32700, `Parse error: ${err.message || err}`);
      }
    });

    rl.on('close', () => {
      console.error('creed-kg MCP server stdio channel closed');
    });
  }

  private async handleMessage(message: any): Promise<void> {
    if (!message || typeof message !== 'object') {
      this.sendError(null, -32600, 'Invalid Request');
      return;
    }

    const { jsonrpc, id, method, params } = message;

    if (jsonrpc !== '2.0') {
      this.sendError(id, -32600, 'Invalid Request: jsonrpc version must be "2.0"');
      return;
    }

    // Handle Notifications (no ID)
    if (id === undefined) {
      if (method === 'notifications/initialized') {
        console.error('Client initialized MCP handshake.');
      }
      return;
    }

    // Handle Requests
    switch (method) {
      case 'initialize':
        this.sendResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'creed-kg',
            version: '1.0.0'
          }
        });
        break;

      case 'tools/list':
        this.sendResult(id, {
          tools: this.getToolsList()
        });
        break;

      case 'tools/call':
        if (!params || typeof params.name !== 'string') {
          this.sendError(id, -32602, 'Invalid params: name is required');
          break;
        }
        await this.handleToolCall(id, params.name, params.arguments || {});
        break;

      default:
        this.sendError(id, -32601, `Method not found: ${method}`);
        break;
    }
  }

  private async handleToolCall(id: any, toolName: string, args: any): Promise<void> {
    try {
      // The handshake deliberately does not wait for indexing; this is the one place that
      // must. Held here rather than in the client, which would call it a startup failure.
      await this.ready;

      // Captured once: the watcher can swap in a rebuilt graph at any await point, and a
      // request should finish against the graph it started on rather than a half-swapped pair.
      const controller = this.controller;
      const graph = this.graph;
      if (!controller || !graph) {
        this.sendToolError(
          id,
          this.readyError
            ? `Index build failed: ${this.readyError}`
            : 'Index is not ready yet.'
        );
        return;
      }

      let plan: GraphQueryPlan;

      switch (toolName) {
        case 'explore':
          if (typeof args.query !== 'string' || args.query.trim() === '') {
            this.sendToolError(id, 'Missing or invalid parameter: query');
            return;
          }
          plan = compileExplore(args);
          break;

        // ── Legacy tool names ────────────────────────────────────────────────
        // No longer advertised in tools/list — `explore` covers all of them, and the
        // multi-tool surface was itself a source of failed queries: callers had to know
        // which tool a question belonged to, and `explore_flow` in particular required an
        // anchor that already resolved, forcing a search-then-explore round trip. Still
        // routed so pinned configs and scripts written against them keep working.
        case 'explore_flow':
          if (typeof args.query !== 'string') {
            this.sendToolError(id, 'Missing or invalid parameter: query');
            return;
          }
          plan = compileExplore(args);
          break;

        case 'search_symbols':
          if (typeof args.query !== 'string') {
            this.sendToolError(id, 'Missing or invalid parameter: query');
            return;
          }
          plan = compileSearchSymbols(args);
          break;

        case 'explore_region':
          if (typeof args.anchor !== 'string') {
            this.sendToolError(id, 'Missing or invalid parameter: anchor');
            return;
          }
          plan = compileExploreRegion(args);
          break;

        case 'trace_path':
          if (typeof args.from !== 'string' || typeof args.to !== 'string') {
            this.sendToolError(id, 'Missing or invalid parameter: from or to');
            return;
          }
          plan = compileTracePath(args);
          break;

        case 'analyze_impact':
          if (typeof args.anchor !== 'string') {
            this.sendToolError(id, 'Missing or invalid parameter: anchor');
            return;
          }
          plan = compileAnalyzeImpact(args);
          break;

        case 'query_graph':
          if (!args.plan) {
            this.sendToolError(id, 'Missing parameter: plan');
            return;
          }
          plan = args.plan;
          break;

        default:
          this.sendError(id, -32601, `Tool not found: ${toolName}`);
          return;
      }

      // Validate plan schema
      const validation = validateGraphQueryPlan(plan);
      if (!validation.valid) {
        this.sendToolError(id, `Invalid query plan: ${validation.errors.join('; ')}`);
        return;
      }

      console.error(`Executing tool ${toolName} with compiled plan:`, JSON.stringify(plan));

      // Execute the query plan through the request controller
      const result = await controller.processPlan(plan);

      // Stamp the in-memory graph's build time onto every response, so a stale server
      // (serving a graph built before the latest reindex) is obvious at a glance rather
      // than requiring a forensic comparison against the on-disk model.
      if (result && typeof result === 'object') {
        result.graphBuiltAt = graph.getBuiltAt() ?? 'unknown';
      }

      this.sendResult(id, {
        content: [{ type: 'text', text: this.renderResult(result) }]
      });

    } catch (err: any) {
      console.error(`Error executing tool ${toolName}:`, err);
      this.sendToolError(id, err.message || String(err));
    }
  }

  /**
   * Renders a controller result as the text the caller actually reads.
   *
   * Successful results carry `serializedContext`, already-formatted markdown — it is
   * emitted directly rather than embedded in JSON. Wrapping it meant the reader received
   * escaped `\n` sequences instead of formatted text, and paid ~4% overhead for the
   * escaping. The other statuses (not_found, ambiguous, search candidates) have no prose
   * form, so they are rendered as compact markdown lists.
   */
  private renderResult(result: any): string {
    if (!result || typeof result !== 'object') return String(result);

    if (typeof result.serializedContext === 'string') {
      return result.serializedContext;
    }

    if (result.status === 'success' && Array.isArray(result.candidates)) {
      if (result.candidates.length === 0) return 'No matching symbols found.';
      const lines = result.candidates.map(
        (c: any) => `- \`${c.qualifiedName || c.name}\` — ${c.file}\n  [ID: ${c.nodeId}]`
      );
      return `**Matching symbols (${result.candidates.length})**\n\n${lines.join('\n')}`;
    }

    if (result.status === 'ambiguous' && Array.isArray(result.ambiguousAnchors)) {
      const blocks = result.ambiguousAnchors.map((a: any) => {
        const items = a.candidates
          .map((c: any) => `  - \`${c.qualifiedName || c.name}\` — ${c.file}\n    [ID: ${c.nodeId}]`)
          .join('\n');
        return `- "${a.query}" matched ${a.candidates.length} symbols:\n${items}`;
      });
      return `**Ambiguous query** — pass an exact ID to pick one.\n\n${blocks.join('\n')}`;
    }

    if (result.status === 'not_found') {
      return `**Not found** — ${result.message || 'no symbols matched the query.'}`;
    }

    // Unknown shape: JSON is still better than dropping information.
    return JSON.stringify(result, null, 2);
  }

  /**
   * One tool. Everything the five specialized tools did is reachable through it, and the
   * split between them was actively harmful: it made the caller decide, before knowing the
   * answer, whether a question was a search, a neighborhood, a path or an impact query — and
   * every one of them except `explore_flow` needed an anchor that already resolved, so a
   * question phrased in English ("how does crawling work") had to be turned into symbol names
   * by a separate search call first. That round trip is where most failed queries died.
   */
  private getToolsList() {
    return [
      {
        name: 'explore',
        description:
          'Answer any question about this codebase from its knowledge graph. Takes ONE free-form query — plain English ("how does crawling work", "what breaks if I change the resolver"), symbol/file names ("AnchorResolver compile.ts"), or any mix. It resolves the question as a whole to the set of symbols it is about (a concept spread across several functions anchors on all of them), traverses their neighborhoods, synthesizes the call paths connecting them, summarizes the blast radius, and returns their verbatim line-numbered source ranked to a token budget. This is the first thing to reach for instead of grep or reading files: one call usually answers the whole question. Questions about callers or breakage automatically trace incoming dependencies; everything else traverses both directions.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'The question, in whatever form is natural — prose, a bag of symbol/file names, or both. Terms that match nothing are ignored and reported.'
            },
            depth: {
              type: 'number',
              description: 'Neighborhood depth around each anchor. Defaults to what the question implies (1, or 2 for impact questions).'
            },
            direction: {
              type: 'string',
              enum: ['incoming', 'outgoing', 'both'],
              description: 'Override the traversal direction. incoming = callers/dependents, outgoing = callees/dependencies.'
            },
            edgeKinds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional edge-kind filter (e.g. ["call"]) to narrow a tangled neighborhood.'
            },
            maxAnchors: {
              type: 'number',
              description: 'Ceiling on how many symbols to anchor on (default: 8).'
            }
          },
          required: ['query']
        }
      }
    ];
  }

  private sendResult(id: any, result: any): void {
    const response = {
      jsonrpc: '2.0',
      id,
      result
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  private sendError(id: any, code: number, message: string): void {
    const response = {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message
      }
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  private sendToolError(id: any, errorMessage: string): void {
    this.sendResult(id, {
      content: [
        {
          type: 'text',
          text: `Error: ${errorMessage}`
        }
      ],
      isError: true
    });
  }
}

function formatResultToMarkdown(result: any, plan: any): string {
  if (result.status === 'not_found') {
    return `### ❌ Anchor Not Found\n\nCould not resolve the anchor query: **"${result.missingQueries.join('", "')}"**.\n\nPlease verify the spelling or try a broader search query.`;
  }

  if (result.status === 'ambiguous') {
    let md = `### ⚠️ Ambiguous Anchor Query\n\nThe query **"${result.ambiguousAnchors[0].query}"** resolved to multiple candidates. Please refine your query using a more specific name (e.g., \`Class.method\`) or one of the unique IDs below:\n\n`;

    result.ambiguousAnchors[0].candidates.forEach((cand: any, idx: number) => {
      const matchType = cand.matchReasons?.[0] || 'Name match';
      md += `${idx + 1}. **${cand.name}** (${cand.nodeId.split('::').pop()?.includes('.') ? 'method' : 'class'})\n`;
      md += `   - **ID**: \`${cand.nodeId}\`\n`;
      md += `   - **File**: \`${cand.file}\`\n`;
      md += `   - **Match Reason**: ${matchType}\n\n`;
    });
    return md.trim();
  }

  if (result.status === 'success') {
    if (result.operation === 'search') {
      let md = `### 🔍 Search Results for "${plan.anchors[0].query}"\n\n`;
      if (!result.candidates || result.candidates.length === 0) {
        return md + `No matching symbols found.`;
      }

      result.candidates.forEach((node: any, idx: number) => {
        md += `${idx + 1}. **${node.name}** (${node.nodeId.split('::').pop()?.includes('.') ? 'method' : 'class'})\n`;
        md += `   - **ID**: \`${node.nodeId}\`\n`;
        md += `   - **File**: \`${node.file}\`\n`;
        md += '\n';
      });
      return md.trim();
    }

    return result.serializedContext;
  }

  return JSON.stringify(result, null, 2);
}
