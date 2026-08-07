import * as readline from 'readline';
import { ReadableGraph } from '../graph/graph.js';
import { GraphQueryPlan } from './types.js';
import { validateGraphQueryPlan } from './schemas.js';
import {
  compileSearchSymbols,
  compileExploreRegion,
  compileTracePath,
  compileAnalyzeImpact,
  compileExploreFlow
} from './compile.js';
import { RequestController } from './controller.js';
import { SymbolIndex } from '../retrieval/symbol-index.js';

export class MCPServer {
  private graph: ReadableGraph;
  private projectRoot: string;
  private controller: RequestController;
  private index: SymbolIndex | undefined;

  constructor(graph: ReadableGraph, projectRoot: string, index?: SymbolIndex) {
    this.graph = graph;
    this.projectRoot = projectRoot;
    this.index = index;
    this.controller = new RequestController(graph, projectRoot, index);
  }

  /**
   * Swaps in a freshly rebuilt graph. `index` is optional so the SQLite backend can
   * hand over a refreshed symbol index alongside the graph; omitting it keeps the
   * previous one, which is correct for the in-memory backend where the index is
   * derived from the graph itself.
   */
  public updateGraph(graph: ReadableGraph, index?: SymbolIndex): void {
    this.graph = graph;
    if (index) this.index = index;
    this.controller = new RequestController(graph, this.projectRoot, this.index);
  }

  public start(): void {
    console.error('MASAI-KG MCP Server starting on stdio...');

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
      console.error('MASAI-KG MCP Server stdio channel closed');
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
            name: 'masai-kg-mcp',
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
      let plan: GraphQueryPlan;

      switch (toolName) {
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

        case 'explore_flow':
          if (typeof args.query !== 'string') {
            this.sendToolError(id, 'Missing or invalid parameter: query');
            return;
          }
          plan = compileExploreFlow(args);
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
      const result = await this.controller.processPlan(plan);

      // Stamp the in-memory graph's build time onto every response, so a stale server
      // (serving a graph built before the latest reindex) is obvious at a glance rather
      // than requiring a forensic comparison against the on-disk model.
      if (result && typeof result === 'object') {
        result.graphBuiltAt = this.graph.getBuiltAt() ?? 'unknown';
      }

      // Return the result formatted as MCP text content
      this.sendResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      });

    } catch (err: any) {
      console.error(`Error executing tool ${toolName}:`, err);
      this.sendToolError(id, err.message || String(err));
    }
  }

  private getToolsList() {
    return [
      {
        name: 'search_symbols',
        description: 'Resolve and search for symbols in the codebase graph by name or kind. When the query resolves to exactly one symbol, also returns its neighborhood (source, callsites, relationships) in the same call — set expand:false to get bare candidate info only, like a plain lookup.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Name, qualified name, or substring of symbol to search for' },
            kind: { type: 'string', description: 'Optional filtering kind (e.g. class, function, method)' },
            expand: { type: 'boolean', description: 'Explore the neighborhood when there is a single unambiguous match (default: true)' },
            depth: { type: 'number', description: 'Neighborhood depth used when expand is true and there is a single match (default: 2)' }
          },
          required: ['query']
        }
      },
      {
        name: 'explore_region',
        description: 'Explore the structural neighborhood (BFS) of a code anchor. The anchor accepts a plain symbol name, qualified name, substring, or loose/natural-language query — no exact node ID needed; the best match is auto-picked and noted, so you rarely need search_symbols first. Output self-caps to a token budget, so a broad depth/direction on a well-connected symbol degrades gracefully rather than failing.',
        inputSchema: {
          type: 'object',
          properties: {
            anchor: { type: 'string', description: 'Symbol name, qualified name, substring, or loose query. Exact node IDs also work and skip auto-pick.' },
            direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'], description: 'Traversal direction (default: outgoing)' },
            depth: { type: 'number', description: 'Maximum search depth (default: 3)' },
            edgeKinds: { type: 'array', items: { type: 'string' }, description: 'Optional edge-kind filter (e.g. ["call"]) to narrow a tangled neighborhood' }
          },
          required: ['anchor']
        }
      },
      {
        name: 'trace_path',
        description: 'Find call/dependency paths between two symbols. Both endpoints accept a plain name, qualified name, or loose query — the best match for each is auto-picked, no exact IDs required.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source symbol — name, qualified name, or loose query' },
            to: { type: 'string', description: 'Target symbol — name, qualified name, or loose query' },
            edgeKinds: { type: 'array', items: { type: 'string' }, description: 'Edge kinds to filter by' },
            maxDepth: { type: 'number', description: 'Maximum traversal depth' }
          },
          required: ['from', 'to']
        }
      },
      {
        name: 'analyze_impact',
        description: 'Identify the bounded dependency cone affected by modifying a symbol ("what breaks if I change this"). The anchor accepts a plain name, qualified name, or loose query — the best match is auto-picked, no exact ID required.',
        inputSchema: {
          type: 'object',
          properties: {
            anchor: { type: 'string', description: 'Symbol to analyze impact from — name, qualified name, or loose query' },
            maxDepth: { type: 'number', description: 'Maximum depth of impact tracing' }
          },
          required: ['anchor']
        }
      },
      {
        name: 'explore_flow',
        description: 'PRIMARY entry point — start here for almost any "how does X work" / "where is Y" / "how do these relate" question. Takes ONE free-form query string mixing symbol names, file names, and plain English however you like (e.g. "parseProject walker.ts how does the file walk work"). It fuzzily resolves the meaningful terms (ignoring prose filler), traverses from all of them at once, synthesizes the call/render paths connecting them, and returns their source ranked to a budget — replacing a search_symbols→explore_region loop with a single call. Use the narrower tools (explore_region/trace_path/analyze_impact) only when you already have an exact symbol and want a specific directed view.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Bag of symbol/file names or a loose natural-language query; each term is resolved independently and unresolvable ones are ignored' },
            depth: { type: 'number', description: 'Neighborhood depth around each anchor (default: 1)' },
            maxAnchors: { type: 'number', description: 'Maximum number of terms to resolve as anchors (default: 8)' }
          },
          required: ['query']
        }
      },
      {
        name: 'query_graph',
        description: 'Execute a generalized typed GraphQueryPlan directly.',
        inputSchema: {
          type: 'object',
          properties: {
            plan: {
              type: 'object',
              description: 'The GraphQueryPlan structure containing operation, anchors, constraints, and materialize options.'
            }
          },
          required: ['plan']
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
