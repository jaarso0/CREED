import * as fs from 'fs/promises';
import * as path from 'path';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createSymbol, createContainment } from '../src/semantic-model/builder.js';
import { buildGraphFromModel, KnowledgeGraph } from '../src/graph/graph.js';
import { SemanticModel } from '../src/semantic-model/types.js';
import { validateGraphQueryPlan } from '../src/mcp/schemas.js';
import {
  compileSearchSymbols,
  compileExploreRegion,
  compileTracePath,
  compileAnalyzeImpact,
  compileExploreFlow,
  compileExplore,
  detectIntent
} from '../src/mcp/compile.js';
import { CandidateDiscovery, stemToken, levenshteinWithin } from '../src/retrieval/discovery.js';
import { RetrievalIndexes } from '../src/retrieval/indexes.js';
import { AnchorResolver } from '../src/resolution/anchor-resolver.js';
import { GraphExecutor } from '../src/executor/graph-executor.js';
import { EvidenceMaterializer } from '../src/evidence/materializer.js';
import { QueryContextOptimizer } from '../src/optimizer/query-context-optimizer.js';
import { RequestController } from '../src/mcp/controller.js';

const TEMP_MCP_TEST_DIR = path.resolve('./temp-mcp-test-project');

describe('MCP Server & Querying Pipeline', () => {
  let model: SemanticModel;
  let graph: KnowledgeGraph;

  beforeAll(async () => {
    // 1. Create a mock project directory with temporary files
    await fs.mkdir(TEMP_MCP_TEST_DIR, { recursive: true });
    await fs.writeFile(
      path.join(TEMP_MCP_TEST_DIR, 'payment.ts'),
      `class PaymentProcessor {
  public charge(amount: number) {
    // Process charging amount
    console.log("Charging " + amount);
    return true;
  }
  public refund(transactionId: string) {
    return "refunded";
  }
}
`
    );
    await fs.writeFile(
      path.join(TEMP_MCP_TEST_DIR, 'checkout.ts'),
      `import { PaymentProcessor } from './payment';
class CheckoutController {
  public runCheckout(req: any) {
    const processor = new PaymentProcessor();
    return processor.charge(req.total);
  }
}
`
    );

    // 2. Build mock symbols
    const projectSym = createSymbol({
      filePath: '',
      chain: ['mcp-test-project'],
      kind: 'project',
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
    });

    const filePayment = createSymbol({
      filePath: 'payment.ts',
      chain: ['payment.ts'],
      kind: 'file',
      range: { start: { line: 0, column: 0 }, end: { line: 8, column: 1 } }
    });

    const fileCheckout = createSymbol({
      filePath: 'checkout.ts',
      chain: ['checkout.ts'],
      kind: 'file',
      range: { start: { line: 0, column: 0 }, end: { line: 7, column: 1 } }
    });

    const paymentClass = createSymbol({
      filePath: 'payment.ts',
      chain: ['PaymentProcessor'],
      kind: 'class',
      range: { start: { line: 0, column: 0 }, end: { line: 8, column: 1 } }
    });

    const chargeMethod = createSymbol({
      filePath: 'payment.ts',
      chain: ['PaymentProcessor', 'charge'],
      kind: 'method',
      range: { start: { line: 1, column: 2 }, end: { line: 5, column: 3 } }
    });

    const refundMethod = createSymbol({
      filePath: 'payment.ts',
      chain: ['PaymentProcessor', 'refund'],
      kind: 'method',
      range: { start: { line: 6, column: 2 }, end: { line: 8, column: 3 } }
    });

    const checkoutClass = createSymbol({
      filePath: 'checkout.ts',
      chain: ['CheckoutController'],
      kind: 'class',
      range: { start: { line: 1, column: 0 }, end: { line: 7, column: 1 } }
    });

    const runCheckoutMethod = createSymbol({
      filePath: 'checkout.ts',
      chain: ['CheckoutController', 'runCheckout'],
      kind: 'method',
      range: { start: { line: 2, column: 2 }, end: { line: 5, column: 3 } }
    });

    // Containment relationships
    const containments = [
      createContainment(projectSym.id, filePayment.id, 'owns'),
      createContainment(projectSym.id, fileCheckout.id, 'owns'),
      createContainment(filePayment.id, paymentClass.id, 'owns'),
      createContainment(paymentClass.id, chargeMethod.id, 'has_member'),
      createContainment(paymentClass.id, refundMethod.id, 'has_member'),
      createContainment(fileCheckout.id, checkoutClass.id, 'owns'),
      createContainment(checkoutClass.id, runCheckoutMethod.id, 'has_member')
    ];

    // Reference edges
    const resolvedReferences = [
      {
        candidateId: 'ref_checkout_import',
        fromSymbolId: fileCheckout.id,
        toSymbolId: paymentClass.id,
        kind: 'import' as const,
        resolutionMethod: 'import' as const
      },
      {
        candidateId: 'ref_checkout_charge',
        fromSymbolId: runCheckoutMethod.id,
        toSymbolId: chargeMethod.id,
        kind: 'call' as const,
        resolutionMethod: 'scope' as const
      }
    ];

    model = {
      project: projectSym,
      symbols: [filePayment, fileCheckout, paymentClass, chargeMethod, refundMethod, checkoutClass, runCheckoutMethod],
      scopes: [],
      containments,
      resolvedReferences,
      unresolvedReferences: [],
      diagnostics: [],
      projectRoot: TEMP_MCP_TEST_DIR,
      createdAt: new Date().toISOString(),
      fileCount: 2,
      symbolCount: 7
    };

    graph = buildGraphFromModel(model);
  });

  afterAll(async () => {
    await fs.rm(TEMP_MCP_TEST_DIR, { recursive: true, force: true });
  });

  // 1. Schema Validation
  test('Schema validation accepts valid and rejects malformed plans', () => {
    const validPlan = {
      operation: 'region',
      anchors: [{ query: 'charge', resolution: 'auto' }],
      constraints: { direction: 'outgoing', requestedDepth: 2 }
    };
    expect(validateGraphQueryPlan(validPlan).valid).toBe(true);

    const invalidPlan = {
      operation: 'unknown_op',
      anchors: []
    };
    const validation = validateGraphQueryPlan(invalidPlan);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  // 2. Compilation
  test('Specialized tools compile correctly to general query plans', () => {
    const explorePlan = compileExploreRegion({ anchor: 'charge', depth: 4, direction: 'incoming' });
    expect(explorePlan.operation).toBe('region');
    expect(explorePlan.anchors[0].query).toBe('charge');
    expect(explorePlan.constraints?.requestedDepth).toBe(4);
    expect(explorePlan.constraints?.direction).toBe('incoming');

    const pathPlan = compileTracePath({ from: 'runCheckout', to: 'charge' });
    expect(pathPlan.operation).toBe('path');
    expect(pathPlan.anchors[0].query).toBe('runCheckout');
    expect(pathPlan.anchors[1].query).toBe('charge');
  });

  // 3. Anchor Resolver
  test('Anchor Resolver cascades and handles resolved/ambiguous/not_found cases', () => {
    const resolver = new AnchorResolver(graph);

    // Exact match by ID
    const r1 = resolver.resolveAnchor({ query: 'payment.ts::PaymentProcessor::charge' });
    expect(r1.status).toBe('resolved');
    if (r1.status === 'resolved') {
      expect(r1.anchors[0].qualifiedName).toBe('PaymentProcessor.charge');
    }

    // Qualified Name match
    const r2 = resolver.resolveAnchor({ query: 'PaymentProcessor.refund' });
    expect(r2.status).toBe('resolved');
    if (r2.status === 'resolved') {
      expect(r2.anchors[0].name).toBe('refund');
    }

    // FTS search fallback
    const r3 = resolver.resolveAnchor({ query: 'PaymentProcessor' });
    expect(r3.status).toBe('resolved'); // maps uniquely to the PaymentProcessor class

    // Ambiguity match
    // If we query for a common name that isn't qualified, it could find multiple
    // Let's add another symbol with name 'charge' in model to test ambiguity if we need,
    // but in this mock graph, name 'charge' is unique, 'runCheckout' is unique.
    // What if we query for "payment"? That matches both "payment.ts" and "PaymentProcessor" in substring.
    const r4 = resolver.resolveAnchor({ query: 'payment' });
    expect(r4.status).toBe('ambiguous');
    if (r4.status === 'ambiguous') {
      expect(r4.candidates.length).toBeGreaterThan(1);
    }

    // Not found
    const r5 = resolver.resolveAnchor({ query: 'NonExistentSymbol' });
    expect(r5.status).toBe('not_found');
  });

  // 4. Graph Execution
  test('Safe Graph Executor traverses region, path, and impact operations', () => {
    const executor = new GraphExecutor(graph);

    // REGION Outgoing from Checkout runCheckout
    const resRegion = executor.execute({
      operation: 'region',
      anchors: [],
      resolvedAnchors: ['checkout.ts::CheckoutController::runCheckout'],
      constraints: { direction: 'outgoing', requestedDepth: 2 }
    }, { maxDepth: 6, maxNodes: 100, maxPaths: 10, maxEdges: 120 });

    expect(resRegion.kind).toBe('region');
    expect(resRegion.nodes.some(n => n.name === 'charge')).toBe(true);

    // PATH from runCheckout to charge
    const resPath = executor.execute({
      operation: 'path',
      anchors: [],
      resolvedAnchors: ['checkout.ts::CheckoutController::runCheckout', 'payment.ts::PaymentProcessor::charge']
    }, { maxDepth: 6, maxNodes: 100, maxPaths: 10, maxEdges: 120 });

    expect(resPath.kind).toBe('path');
    if (resPath.kind === 'path') {
      expect(resPath.paths.length).toBe(1);
      expect(resPath.paths[0].nodes[0]).toBe('checkout.ts::CheckoutController::runCheckout');
      expect(resPath.paths[0].nodes[1]).toBe('payment.ts::PaymentProcessor::charge');
    }

    // IMPACT of modifying charge
    const resImpact = executor.execute({
      operation: 'impact',
      anchors: [],
      resolvedAnchors: ['payment.ts::PaymentProcessor::charge']
    }, { maxDepth: 6, maxNodes: 100, maxPaths: 10, maxEdges: 120 });

    expect(resImpact.kind).toBe('impact');
    if (resImpact.kind === 'impact') {
      // The dependent node should be runCheckout
      expect(resImpact.affected.some(a => a.nodeId === 'checkout.ts::CheckoutController::runCheckout')).toBe(true);
    }
  });

  // 4b. Proactive edge cap: the executor bounds edges BEFORE materialization,
  // keeps anchor-touching edges, and reports how many it dropped.
  test('Region executor proactively caps edges and reports the omitted count', () => {
    const executor = new GraphExecutor(graph);

    const uncapped = executor.execute({
      operation: 'region',
      anchors: [],
      resolvedAnchors: ['payment.ts::PaymentProcessor::charge'],
      constraints: { direction: 'both', requestedDepth: 2 }
    }, { maxDepth: 6, maxNodes: 100, maxPaths: 10, maxEdges: 1000 });

    const capped = executor.execute({
      operation: 'region',
      anchors: [],
      resolvedAnchors: ['payment.ts::PaymentProcessor::charge'],
      constraints: { direction: 'both', requestedDepth: 2 }
    }, { maxDepth: 6, maxNodes: 100, maxPaths: 10, maxEdges: 2 });

    expect(capped.kind).toBe('region');
    if (capped.kind === 'region' && uncapped.kind === 'region') {
      // The cap is enforced...
      expect(capped.edges.length).toBeLessThanOrEqual(2);
      // ...and the drop is reported honestly rather than silently.
      const droppedTotal = (uncapped.edges.length + (uncapped.omittedEdgeCount || 0));
      expect((capped.omittedEdgeCount || 0)).toBe(droppedTotal - capped.edges.length);
      // Kept edges are the relevant ones — every kept edge touches the anchor.
      const anchor = 'payment.ts::PaymentProcessor::charge';
      expect(capped.edges.every(e => e.sourceId === anchor || e.targetId === anchor)).toBe(true);
    }
  });

  // 5. Evidence Materialization
  test('Evidence Materializer fetches code, fallback signatures, comments, and callsite lines', async () => {
    const executor = new GraphExecutor(graph);
    const materializer = new EvidenceMaterializer(graph, TEMP_MCP_TEST_DIR);

    const plan = {
      operation: 'path' as const,
      anchors: [],
      materialize: { source: true, signatures: true, docs: true, callsites: true }
    };

    const resPath = executor.execute({
      operation: 'path',
      anchors: [],
      resolvedAnchors: ['checkout.ts::CheckoutController::runCheckout', 'payment.ts::PaymentProcessor::charge']
    }, { maxDepth: 6, maxNodes: 100, maxPaths: 10, maxEdges: 120 });

    const evidence = await materializer.materialize(resPath, plan);
    expect(evidence.nodes.length).toBe(2);

    const runCheckoutNode = evidence.nodes.find(n => n.name === 'runCheckout')!;
    expect(runCheckoutNode.source).toBeDefined();
    expect(runCheckoutNode.source?.text).toContain('public runCheckout(req: any)');
    expect(runCheckoutNode.signature).toBe('public runCheckout(req: any) {');

    // Callsite snippet verification
    const callEdge = evidence.edges.find(e => e.kind === 'call')!;
    expect(callEdge.callsite).toBeDefined();
    expect(callEdge.callsite?.line).toBe(5); // Line index 4 (0-indexed) is "return processor.charge(req.total);"
    expect(callEdge.callsite?.snippet).toBe('return processor.charge(req.total);');
  });

  // 6. Context Optimization & Span Merging
  test('Query Context Optimizer applies budget constraints and merges contiguous spans', async () => {
    const materializer = new EvidenceMaterializer(graph, TEMP_MCP_TEST_DIR);
    const optimizer = new QueryContextOptimizer(async (f) => (materializer as any).loadFileLines(f));

    const mockEvidence = {
      nodes: [
        {
          nodeId: 'node1',
          name: 'charge',
          kind: 'method',
          file: 'payment.ts',
          signature: 'public charge(amount)',
          source: {
            startLine: 2,
            endLine: 4,
            text: 'line 2\nline 3\nline 4'
          },
          structuralRole: 'anchor' as const
        },
        {
          nodeId: 'node2',
          name: 'refund',
          kind: 'method',
          file: 'payment.ts',
          signature: 'public refund(id)',
          source: {
            startLine: 7,
            endLine: 8,
            text: 'line 7\nline 8'
          },
          structuralRole: 'direct_neighbor' as const
        }
      ],
      edges: []
    };

    // The two spans are at lines 2-4 and 7-8 in payment.ts.
    // Since 7 <= 4 + 5 (7 <= 9), they are within 5 lines of each other and should be merged!
    const result = await optimizer.optimize(
      {
        operation: 'region',
        anchors: [],
        context: { tokenBudget: 5000 }
      },
      {
        kind: 'region',
        roots: ['node1'],
        nodes: [
          { nodeId: 'node1', kind: 'method', name: 'charge', qualifiedName: 'charge', filePath: 'payment.ts', properties: { range: { start: { line: 1, column: 0 }, end: { line: 3, column: 0 } } } },
          { nodeId: 'node2', kind: 'method', name: 'refund', qualifiedName: 'refund', filePath: 'payment.ts', properties: { range: { start: { line: 6, column: 0 }, end: { line: 7, column: 0 } } } }
        ],
        edges: [],
        distance: { node1: 0, node2: 1 }
      },
      mockEvidence
    );

    // Verify optimized text
    expect(result.serializedContext).toContain('**Anchors**');
    expect(result.serializedContext).toContain('charge');
    expect(result.serializedContext).toContain('refund');
  });

  // 7. Request Controller End-to-End
  test('Request Controller integrates all phases and handles ambiguous anchor feedback', async () => {
    const controller = new RequestController(graph, TEMP_MCP_TEST_DIR);

    // Ambiguous anchor query on a traversal tool: auto-picks the best match and proceeds
    // (rather than bailing), prepending a transparency note listing what it chose.
    const resAmbiguous = await controller.processPlan({
      operation: 'region',
      anchors: [{ query: 'payment' }]
    });

    expect(resAmbiguous.status).toBe('success');
    // The transparency note is now a footer, not a banner — it qualifies the result
    // rather than preceding it.
    expect(resAmbiguous.serializedContext).toContain('Auto-resolved "payment"');
    expect(resAmbiguous.serializedContext.startsWith('**Exploration:')).toBe(true);

    // Search mode still returns the raw candidate list for the caller to choose from.
    const resSearch = await controller.processPlan({
      operation: 'region',
      anchors: [{ query: 'payment' }],
      constraints: { searchMode: true, requestedDepth: 0 }
    });

    expect(resSearch.status).toBe('success');
    expect(resSearch.operation).toBe('search');
    expect(resSearch.candidates.length).toBeGreaterThan(1);

    // Successful region query
    const resSuccess = await controller.processPlan({
      operation: 'region',
      anchors: [{ query: 'PaymentProcessor.charge' }],
      constraints: { direction: 'incoming', requestedDepth: 2 },
      materialize: { source: true, callsites: true, signatures: true }
    });

    expect(resSuccess.status).toBe('success');
    expect(resSuccess.serializedContext).toContain('runCheckout');
    expect(resSuccess.tokenUsage.estimated).toBeGreaterThan(0);

    // The point of the format change: source arrives verbatim, line-numbered, in a
    // language-tagged fence under a per-file header — citable without reopening the file.
    const ctx = resSuccess.serializedContext;
    expect(ctx).toContain('**Source Code**');
    expect(ctx).toContain('**`checkout.ts`**');
    expect(ctx).toContain('```typescript');
    // "<lineNumber>\t<code>", matching what the Read tool returns.
    expect(ctx).toMatch(/\n\d+\t/);
  });

  test('explore_flow resolves multiple anchors, tolerates noise, and synthesizes the connecting flow', async () => {
    const controller = new RequestController(graph, TEMP_MCP_TEST_DIR);

    // Bag of terms: two real symbols + a noise word that resolves to nothing.
    const plan = compileExploreFlow({ query: 'runCheckout charge data flow' });
    expect(plan.anchors.length).toBe(2); // "data"/"flow" dropped as stopwords
    expect(plan.constraints?.tolerateMissingAnchors).toBe(true);
    expect(plan.constraints?.synthesizeFlow).toBe(true);

    const res = await controller.processPlan(plan);
    expect(res.status).toBe('success');
    // The synthesized flow section shows the call path connecting the two named symbols,
    // rendered as a numbered vertical chain with the edge verb between steps.
    expect(res.serializedContext).toContain('**Call paths among the queried symbols**');
    expect(res.serializedContext).toContain('1. `CheckoutController.runCheckout`');
    expect(res.serializedContext).toContain('↓ calls');
    expect(res.serializedContext).toContain('2. `PaymentProcessor.charge`');
    // Blast radius section lists what depends on each queried symbol.
    expect(res.serializedContext).toContain('**Blast radius — what depends on these');
    // Header echoes the question *verbatim*, not the surviving anchor terms — reporting
    // "Exploration: runCheckout charge" for a question that also said "data flow" misstates
    // what was asked. What it actually anchored on is listed separately, below it.
    expect(res.serializedContext).toContain('**Exploration: runCheckout charge data flow**');
    expect(res.serializedContext).toContain('Anchored on: ');
    expect(res.serializedContext).toMatch(/Found \d+ symbol\(s\) across \d+ file\(s\)\./);
  });

  test('explore_flow emits a low-confidence handoff when few query terms resolve', async () => {
    const controller = new RequestController(graph, TEMP_MCP_TEST_DIR);
    // Mostly nonsense terms; at most one resolves, so the caller should be warned.
    const res = await controller.processPlan(compileExploreFlow({ query: 'charge zzznope quxbogus flarble' }));
    expect(res.status).toBe('success');
    // The warning is present but demoted to a footer note — it must not be the first
    // thing the caller reads, or a warning on every good result trains them to skip it.
    expect(res.serializedContext).toContain('⚠ Low confidence:');
    expect(res.serializedContext.startsWith('**Exploration:')).toBe(true);
    expect(res.serializedContext.indexOf('⚠ Low confidence:')).toBeGreaterThan(
      res.serializedContext.indexOf('**Source Code**')
    );
  });

  test('a lone ambiguous term still returns its best candidate instead of "not found"', async () => {
    const controller = new RequestController(graph, TEMP_MCP_TEST_DIR);

    // A single broad term that matches several symbols comparably. Dropping ambiguous terms
    // is right only while another anchor survives; as the last one standing it used to
    // produce `not_found` — reporting "no symbols matched" for a query that matched plenty.
    const res = await controller.processPlan(compileExploreFlow({ query: 'checkout' }));

    expect(res.status).toBe('success');
    expect(res.status).not.toBe('not_found');
    expect(res.serializedContext).toContain('**Exploration: checkout**');
    // The pick is surfaced as a best guess, with the alternatives listed, so a wrong
    // guess is visible and correctable rather than silent.
    expect(res.serializedContext).toContain('Auto-resolved');
  });

  test('a genuinely unmatched query still reports not_found', async () => {
    const controller = new RequestController(graph, TEMP_MCP_TEST_DIR);
    // Reinstating the best candidate must not mean "always return something" — when
    // nothing matched at all there is no candidate to reinstate.
    const res = await controller.processPlan(
      compileExploreFlow({ query: 'zzznope quxbogus flarble' })
    );
    expect(res.status).toBe('not_found');
  });

  test('reads impact intent off the question and flips the traversal', () => {
    // With one tool there is no separate `analyze_impact` to carry this, so "what breaks"
    // has to steer the traversal itself — otherwise it returns what the symbol calls, which
    // is the exact opposite of what was asked.
    expect(detectIntent('what breaks if I change charge')).toEqual({
      direction: 'incoming',
      depth: 2
    });
    expect(detectIntent('who calls charge')).toEqual({ direction: 'incoming', depth: 2 });
    expect(detectIntent('how does checkout work')).toEqual({ direction: 'both', depth: 1 });

    const plan = compileExplore({ query: 'what breaks if I change charge' });
    expect(plan.constraints?.direction).toBe('incoming');
    // Explicit arguments still win over the inferred intent.
    expect(compileExplore({ query: 'who calls charge', direction: 'outgoing' }).constraints?.direction)
      .toBe('outgoing');
  });

  test('a prose-only question compiles to a plan and still carries the full query', () => {
    // Every word is filler, so no term survives as an identifier. The plan must still be
    // valid (anchors is required non-empty) and must hand the whole question to the resolver.
    const plan = compileExplore({ query: 'what happens when the work is done' });
    expect(validateGraphQueryPlan(plan).valid).toBe(true);
    expect(plan.constraints?.freeFormQuery).toBe('what happens when the work is done');
  });

  test('one concept anchors on every symbol it spans, not just the best-ranked one', async () => {
    const controller = new RequestController(graph, TEMP_MCP_TEST_DIR);

    // "payment" describes the class, its file, and its methods. Resolving each query word in
    // isolation used to pick exactly one of them — or drop the term as ambiguous — which is
    // how a question about a concept spread over several symbols returned a fraction of it.
    const res = await controller.processPlan(compileExplore({ query: 'payment' }));

    expect(res.status).toBe('success');
    const anchorLine = res.serializedContext.split('\n').find((l: string) =>
      l.startsWith('Anchored on: ')
    );
    expect(anchorLine).toBeDefined();
    expect(anchorLine.split('`').length - 1).toBeGreaterThanOrEqual(4); // >= 2 anchors
    expect(res.serializedContext).toContain('PaymentProcessor');
  });

  test('English morphology reaches the code\'s spelling', async () => {
    const controller = new RequestController(graph, TEMP_MCP_TEST_DIR);
    // "charging" is not a substring of `charge`, so a literal match finds nothing.
    expect(stemToken('charging')).toBe('charg');

    const res = await controller.processPlan(compileExplore({ query: 'how does charging work' }));
    expect(res.status).toBe('success');
    expect(res.serializedContext).toContain('charge');
  });

  test('a misspelled symbol name still resolves', async () => {
    const controller = new RequestController(graph, TEMP_MCP_TEST_DIR);
    // Transposition: no stem or prefix of "chagre" is a substring of "charge".
    const res = await controller.processPlan(compileExplore({ query: 'chagre' }));
    expect(res.status).toBe('success');
    expect(res.serializedContext).toContain('charge');
  });

  test('edit distance bails out instead of scoring hopeless pairs', () => {
    expect(levenshteinWithin('charge', 'chagre', 2)).toBe(2);
    expect(levenshteinWithin('charge', 'charge', 2)).toBe(0);
    expect(levenshteinWithin('charge', 'refund', 2)).toBeNull();
    // Length gap alone exceeds the budget — rejected without building the matrix.
    expect(levenshteinWithin('ab', 'abcdefgh', 2)).toBeNull();
  });

  test('generic vocabulary is searched rather than filtered into nothing', () => {
    // `config` was an unconditional stopword, so the one-word query "config" tokenized to
    // nothing and reported that no symbol matched — in a project whose central class is
    // called exactly that.
    const configClass = createSymbol({
      filePath: 'settings.ts',
      chain: ['Config'],
      kind: 'class',
      range: { start: { line: 0, column: 0 }, end: { line: 4, column: 1 } }
    });
    const tinyGraph = buildGraphFromModel({
      ...model,
      symbols: [configClass],
      containments: [],
      resolvedReferences: []
    });
    const configDiscovery = new CandidateDiscovery(new RetrievalIndexes(tinyGraph));
    expect(configDiscovery.discover('config', 5).map(r => r.node.name)).toContain('Config');

    // A generic word must still not outrank a specific one when both are present: the answer
    // to "payment class" is the payment class, not every class in the project.
    const discovery = new CandidateDiscovery(new RetrievalIndexes(graph));
    expect(discovery.discover('payment class', 5)[0].node.name).toBe('PaymentProcessor');
  });

  test('a term that matched nothing is reported, a whole question that did is not', async () => {
    const controller = new RequestController(graph, TEMP_MCP_TEST_DIR);

    const mostlyNonsense = await controller.processPlan(
      compileExplore({ query: 'charge zzznope quxbogus flarble' })
    );
    expect(mostlyNonsense.serializedContext).toContain('⚠ Low confidence:');

    // Ordinary English around a real symbol is not a coverage problem, and warning about it
    // on every good result is how a caller learns to ignore the warning.
    const ordinary = await controller.processPlan(
      compileExplore({ query: 'how does the checkout run' })
    );
    const footer = ordinary.serializedContext.split('\n---\n').slice(1).join('\n');
    expect(footer).not.toContain('⚠ Low confidence:');
  });
});

