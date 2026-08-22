import { SemanticModel, Symbol } from '../types';

/*
 * A renderer-agnostic graph over the semantic model.
 *
 * Node objects are created ONCE per view and reused across every level-of-detail
 * recomputation, because the force engine writes x/y/vx/vy onto them — reusing the
 * instances is what makes expanding a module feel like children emerging from it
 * rather than the whole layout jumping.
 */

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  symbol: Symbol;
  /** Aggregate-level node: a file/module, service, route or data model. */
  isModule: boolean;
  /** Containing file or class — the node this one rolls up into when hidden. */
  parentId?: string;
  /** Reference degree over the whole graph; drives "is this node important". */
  baseDegree: number;
  /** Reference degree within the currently rendered view; drives label culling. */
  degree: number;
  /** Number of descendants that can be revealed by expanding this node. */
  childCount: number;
  // Mutated by the force engine:
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  kind: string;
  /** How many underlying references this rendered link stands for. */
  count: number;
  /** True when either endpoint is a rolled-up stand-in for hidden detail. */
  aggregated: boolean;
}

export interface SemanticGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  nodeById: Map<string, GraphNode>;
  parentOf: Map<string, string>;
  childrenOf: Map<string, string[]>;
  /** 1-hop reference neighbours over the full graph. */
  neighborsOf: Map<string, Set<string>>;
}

const CONTAINS = 'contains';

function makeNode(symbol: Symbol, isModule: boolean, parentId?: string): GraphNode {
  return {
    id: symbol.id,
    label: symbol.name,
    kind: symbol.kind,
    symbol,
    isModule,
    parentId,
    baseDegree: 0,
    degree: 0,
    childCount: 0,
  };
}

function finalize(nodes: GraphNode[], links: GraphLink[]): SemanticGraph {
  const nodeById = new Map<string, GraphNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId && nodeById.has(n.parentId)) {
      parentOf.set(n.id, n.parentId);
      const list = childrenOf.get(n.parentId) ?? [];
      list.push(n.id);
      childrenOf.set(n.parentId, list);
    }
  }

  // Descendant counts (how much detail hides behind a module)
  const countDescendants = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const kids = childrenOf.get(id) ?? [];
    let total = kids.length;
    for (const k of kids) total += countDescendants(k, seen);
    return total;
  };
  for (const n of nodes) n.childCount = countDescendants(n.id);

  const neighborsOf = new Map<string, Set<string>>();
  for (const link of links) {
    const s = link.source as string;
    const t = link.target as string;
    if (!neighborsOf.has(s)) neighborsOf.set(s, new Set());
    if (!neighborsOf.has(t)) neighborsOf.set(t, new Set());
    neighborsOf.get(s)!.add(t);
    neighborsOf.get(t)!.add(s);
    if (link.kind !== CONTAINS) {
      const sn = nodeById.get(s);
      const tn = nodeById.get(t);
      if (sn) sn.baseDegree++;
      if (tn) tn.baseDegree++;
    }
  }

  return { nodes, links, nodeById, parentOf, childrenOf, neighborsOf };
}

// ════════════════════════════════════════════
// FLAT GRAPH — every symbol, with containment structure for roll-up
// ════════════════════════════════════════════
export function buildGraph(model: SemanticModel): SemanticGraph {
  const symbols = model.symbols.filter((s) => s.kind !== 'project');
  const symbolIds = new Set(symbols.map((s) => s.id));

  const fileIdByPath = new Map<string, string>();
  for (const s of symbols) {
    if (s.kind === 'file') fileIdByPath.set(s.filePath, s.id);
  }

  /*
   * The model only records containment for project→file and class→member, so a
   * top-level function has no declared parent. Fall back to the file it lives in,
   * otherwise it has nothing to roll up into and its references would vanish from
   * the module-level view instead of aggregating.
   */
  const parentOf = new Map<string, string>();
  for (const c of model.containments) {
    if (c.parentId !== model.project.id && symbolIds.has(c.parentId) && symbolIds.has(c.childId)) {
      parentOf.set(c.childId, c.parentId);
    }
  }
  for (const s of symbols) {
    if (s.kind === 'file' || parentOf.has(s.id)) continue;
    const fileId = fileIdByPath.get(s.filePath);
    if (fileId && fileId !== s.id) parentOf.set(s.id, fileId);
  }

  const nodes = symbols.map((s) => makeNode(s, s.kind === 'file', parentOf.get(s.id)));

  const links: GraphLink[] = [];
  const seen = new Set<string>();

  for (const ref of model.resolvedReferences) {
    if (!symbolIds.has(ref.fromSymbolId) || !symbolIds.has(ref.toSymbolId)) continue;
    if (ref.fromSymbolId === ref.toSymbolId) continue;
    const key = `${ref.fromSymbolId}->${ref.toSymbolId}:${ref.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: ref.fromSymbolId, target: ref.toSymbolId, kind: ref.kind, count: 1, aggregated: false });
  }

  for (const [childId, pId] of parentOf) {
    links.push({ source: pId, target: childId, kind: CONTAINS, count: 1, aggregated: false });
  }

  return finalize(nodes, links);
}

// ════════════════════════════════════════════
// MODULE GRAPH — files and the dependencies between them
// ════════════════════════════════════════════
export function buildModuleGraph(model: SemanticModel): SemanticGraph {
  const files = model.symbols.filter((s) => s.kind === 'file');
  const byPath = new Map<string, Symbol>();
  for (const f of files) byPath.set(f.filePath, f);

  const symbolFile = new Map<string, string>();
  for (const s of model.symbols) symbolFile.set(s.id, s.filePath);

  const nodes = files.map((f) => makeNode(f, true));
  const links: GraphLink[] = [];
  const agg = new Map<string, GraphLink>();

  for (const ref of model.resolvedReferences) {
    const fromPath = symbolFile.get(ref.fromSymbolId);
    const toPath = symbolFile.get(ref.toSymbolId);
    if (!fromPath || !toPath || fromPath === toPath) continue;
    const from = byPath.get(fromPath);
    const to = byPath.get(toPath);
    if (!from || !to) continue;

    const key = `${from.id}->${to.id}`;
    const existing = agg.get(key);
    if (existing) {
      existing.count++;
    } else {
      const link: GraphLink = { source: from.id, target: to.id, kind: ref.kind, count: 1, aggregated: true };
      agg.set(key, link);
      links.push(link);
    }
  }

  return finalize(nodes, links);
}

// ════════════════════════════════════════════
// SERVICE GRAPH — service classes and the calls between them
// ════════════════════════════════════════════
export function buildServiceGraph(model: SemanticModel): SemanticGraph {
  const services = model.symbols.filter(
    (s) => s.kind === 'class' && (s.metadata?.isService === true || s.name.endsWith('Service')),
  );
  const serviceIds = new Set(services.map((s) => s.id));

  // Map every symbol inside a service (at any depth) back to that service
  const childToService = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();
  for (const c of model.containments) {
    const list = childrenByParent.get(c.parentId) ?? [];
    list.push(c.childId);
    childrenByParent.set(c.parentId, list);
  }
  const claim = (id: string, serviceId: string) => {
    childToService.set(id, serviceId);
    for (const child of childrenByParent.get(id) ?? []) claim(child, serviceId);
  };
  for (const id of serviceIds) claim(id, id);

  const nodes = services.map((s) => makeNode(s, true));
  const links: GraphLink[] = [];
  const agg = new Map<string, GraphLink>();

  for (const ref of model.resolvedReferences) {
    const from = childToService.get(ref.fromSymbolId);
    const to = childToService.get(ref.toSymbolId);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    const existing = agg.get(key);
    if (existing) {
      existing.count++;
    } else {
      const link: GraphLink = { source: from, target: to, kind: ref.kind, count: 1, aggregated: true };
      agg.set(key, link);
      links.push(link);
    }
  }

  return finalize(nodes, links);
}

// ════════════════════════════════════════════
// API GRAPH — virtual route nodes linked to their handlers
// ════════════════════════════════════════════
export function buildApiGraph(model: SemanticModel): SemanticGraph {
  const handlers = model.symbols.filter((s) => s.metadata?.apiRoute);
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const added = new Set<string>();

  for (const handler of handlers) {
    const route = handler.metadata.apiRoute;
    const routeId = `api:${route.method}:${route.path}`;

    if (!added.has(routeId)) {
      added.add(routeId);
      const virtual: Symbol = {
        ...handler,
        id: routeId,
        kind: 'api_route' as any,
        name: `${route.method} ${route.path}`,
        qualifiedName: `${route.method} ${route.path}`,
        metadata: { apiRoute: route, handlerSymbolId: handler.id },
      };
      nodes.push(makeNode(virtual, true));
    }
    if (!added.has(handler.id)) {
      added.add(handler.id);
      nodes.push(makeNode(handler, true));
    }
    links.push({ source: routeId, target: handler.id, kind: 'call', count: 1, aggregated: false });
  }

  return finalize(nodes, links);
}

// ════════════════════════════════════════════
// DATA GRAPH — services/functions linked to the data models they touch
// ════════════════════════════════════════════
export function buildDataGraph(model: SemanticModel): SemanticGraph {
  const dataModels = new Map<string, Symbol>();
  for (const s of model.symbols) {
    if (s.metadata?.dataModel) dataModels.set(s.id, s);
  }

  const symbolById = new Map<string, Symbol>();
  for (const s of model.symbols) symbolById.set(s.id, s);

  const services = model.symbols.filter(
    (s) => s.kind === 'class' && (s.metadata?.isService === true || s.name.endsWith('Service')),
  );
  const serviceOfChild = new Map<string, Symbol>();
  for (const service of services) {
    for (const c of model.containments) {
      if (c.parentId === service.id) serviceOfChild.set(c.childId, service);
    }
  }

  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const added = new Set<string>();
  const seenLinks = new Set<string>();

  for (const ref of model.resolvedReferences) {
    const target = dataModels.get(ref.toSymbolId);
    if (!target) continue;
    const from = symbolById.get(ref.fromSymbolId);
    if (!from) continue;

    const accessor = serviceOfChild.get(from.id) ?? from;
    const key = `${accessor.id}->${target.id}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);

    if (!added.has(accessor.id)) {
      added.add(accessor.id);
      nodes.push(makeNode(accessor, true));
    }
    if (!added.has(target.id)) {
      added.add(target.id);
      nodes.push(makeNode({ ...target, kind: 'data_model' as any }, true));
    }
    links.push({ source: accessor.id, target: target.id, kind: 'call', count: 1, aggregated: false });
  }

  return finalize(nodes, links);
}

// ════════════════════════════════════════════
// FLOW TRACE — breadth-first walk of calls from a starting symbol
// ════════════════════════════════════════════
export function traceFlow(model: SemanticModel, startSymbolId: string, depth = 4): SemanticGraph {
  const symbolById = new Map<string, Symbol>();
  for (const s of model.symbols) symbolById.set(s.id, s);

  const childrenByParent = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();
  for (const c of model.containments) {
    const list = childrenByParent.get(c.parentId) ?? [];
    list.push(c.childId);
    childrenByParent.set(c.parentId, list);
    parentByChild.set(c.childId, c.parentId);
  }

  let actualStartId = startSymbolId;
  let virtualRoute: Symbol | null = null;
  if (startSymbolId.startsWith('api:')) {
    const match = model.symbols.find((s) => {
      const route = s.metadata?.apiRoute;
      return route && `api:${route.method}:${route.path}` === startSymbolId;
    });
    if (match) {
      actualStartId = match.id;
      const route = match.metadata.apiRoute;
      virtualRoute = {
        ...match,
        id: startSymbolId,
        kind: 'api_route' as any,
        name: `${route.method} ${route.path}`,
        qualifiedName: `${route.method} ${route.path}`,
        metadata: { apiRoute: route, handlerSymbolId: match.id },
      };
    }
  }

  const descendants = (id: string, acc: string[] = [], seen = new Set<string>()): string[] => {
    if (seen.has(id)) return acc;
    seen.add(id);
    for (const child of childrenByParent.get(id) ?? []) {
      acc.push(child);
      descendants(child, acc, seen);
    }
    return acc;
  };

  // Calls out of a service method are attributed to the service itself
  const rollUp = (id: string): string => {
    const parentId = parentByChild.get(id);
    const sym = symbolById.get(id);
    if (!sym || sym.kind !== 'method' || !parentId) return id;
    const parent = symbolById.get(parentId);
    const isService =
      parent?.kind === 'class' && (parent.metadata?.isService === true || parent.name.endsWith('Service'));
    return isService ? parent!.id : id;
  };

  const refsFrom = new Map<string, string[]>();
  for (const ref of model.resolvedReferences) {
    const list = refsFrom.get(ref.fromSymbolId) ?? [];
    list.push(ref.toSymbolId);
    refsFrom.set(ref.fromSymbolId, list);
  }

  const visited = new Set<string>([actualStartId]);
  const edgeKeys = new Set<string>();
  const edges: [string, string][] = [];
  let frontier = new Set<string>([actualStartId]);

  if (virtualRoute) {
    visited.add(virtualRoute.id);
    edges.push([virtualRoute.id, actualStartId]);
    edgeKeys.add(`${virtualRoute.id}->${actualStartId}`);
  }

  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const sourceId of [id, ...descendants(id)]) {
        for (const targetId of refsFrom.get(sourceId) ?? []) {
          if (!symbolById.has(targetId)) continue;
          const from = rollUp(sourceId) === sourceId ? id : rollUp(sourceId);
          const to = rollUp(targetId);
          if (from === to) continue;
          const key = `${from}->${to}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push([from, to]);
          }
          if (!visited.has(to)) {
            visited.add(to);
            next.add(to);
          }
        }
      }
    }
    frontier = next;
  }

  const nodes: GraphNode[] = [];
  if (virtualRoute) nodes.push(makeNode(virtualRoute, true));
  for (const id of visited) {
    if (virtualRoute && id === virtualRoute.id) continue;
    const sym = symbolById.get(id);
    if (!sym) continue;
    nodes.push(makeNode(sym.metadata?.dataModel ? { ...sym, kind: 'data_model' as any } : sym, true));
  }

  const present = new Set(nodes.map((n) => n.id));
  const links: GraphLink[] = edges
    .filter(([from, to]) => present.has(from) && present.has(to))
    .map(([from, to]) => ({ source: from, target: to, kind: 'call', count: 1, aggregated: false }));

  return finalize(nodes, links);
}

// ════════════════════════════════════════════
// LEVEL OF DETAIL — what actually gets drawn
// ════════════════════════════════════════════

export interface ViewOptions {
  searchTerm: string;
  selectedKinds: Set<string>;
  selectedEdgeKinds: Set<string>;
  /** Modules the user opened, or that opened automatically on zoom. */
  expandedIds: Set<string>;
  /** Skip the roll-up entirely and draw every node. */
  showAll: boolean;
  /** Isolate a node and its 1-hop neighbourhood. */
  neighborhoodNodeId: string | null;
  /** Symbols at or above this reference degree are always drawn. */
  highDegreeThreshold: number;
  /** Always keep these visible (e.g. the selected node). */
  pinnedIds?: string[];
}

export interface RenderView {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Nodes hidden by the roll-up, for reporting in the UI. */
  hiddenCount: number;
}

/**
 * Reduces the full graph to what should be on screen: applies search/kind filters,
 * then rolls every hidden node up into its nearest visible ancestor so the links
 * it participated in still show as module-level dependencies.
 */
export function computeView(graph: SemanticGraph, opts: ViewOptions): RenderView {
  const term = opts.searchTerm.trim().toLowerCase();

  const matchesFilter = (node: GraphNode): boolean => {
    if (!opts.selectedKinds.has(node.kind)) return false;
    if (!term) return true;
    return (
      node.symbol.name.toLowerCase().includes(term) ||
      node.symbol.qualifiedName.toLowerCase().includes(term)
    );
  };

  // A module survives the filter if it matches itself or holds something that does
  const matched = new Set<string>();
  for (const node of graph.nodes) {
    if (matchesFilter(node)) matched.add(node.id);
  }
  const surviving = new Set(matched);
  for (const id of matched) {
    let parentId = graph.parentOf.get(id);
    while (parentId && !surviving.has(parentId)) {
      surviving.add(parentId);
      parentId = graph.parentOf.get(parentId);
    }
  }

  // Neighbourhood isolation trumps everything else
  let scope: Set<string> | null = null;
  if (opts.neighborhoodNodeId) {
    scope = new Set<string>([opts.neighborhoodNodeId]);
    for (const id of graph.neighborsOf.get(opts.neighborhoodNodeId) ?? []) scope.add(id);
  }

  const pinned = new Set(opts.pinnedIds ?? []);

  const visible = new Set<string>();
  for (const node of graph.nodes) {
    if (scope && !scope.has(node.id) && !pinned.has(node.id)) continue;
    if (!scope && !surviving.has(node.id) && !pinned.has(node.id)) continue;

    const detailWorthy =
      opts.showAll ||
      scope !== null ||
      node.isModule ||
      node.baseDegree >= opts.highDegreeThreshold ||
      (node.parentId !== undefined && opts.expandedIds.has(node.parentId)) ||
      pinned.has(node.id);

    if (detailWorthy) visible.add(node.id);
  }

  // Nearest visible ancestor — the node a hidden symbol's links roll up into
  const repCache = new Map<string, string | null>();
  const representative = (id: string): string | null => {
    const cached = repCache.get(id);
    if (cached !== undefined) return cached;

    const chain: string[] = [];
    let cur: string | undefined = id;
    let result: string | null = null;
    while (cur) {
      if (visible.has(cur)) {
        result = cur;
        break;
      }
      chain.push(cur);
      cur = graph.parentOf.get(cur);
    }
    for (const step of chain) repCache.set(step, result);
    repCache.set(id, result);
    return result;
  };

  const aggregated = new Map<string, GraphLink>();
  for (const link of graph.links) {
    const rawSource = typeof link.source === 'string' ? link.source : link.source.id;
    const rawTarget = typeof link.target === 'string' ? link.target : link.target.id;

    if (link.kind !== CONTAINS && !opts.selectedEdgeKinds.has(link.kind)) continue;

    const from = representative(rawSource);
    const to = representative(rawTarget);
    if (!from || !to || from === to) continue;

    // A containment link is only meaningful while both ends are actually drawn
    if (link.kind === CONTAINS && (from !== rawSource || to !== rawTarget)) continue;

    const key = `${from}->${to}:${link.kind}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += link.count;
    } else {
      aggregated.set(key, {
        source: from,
        target: to,
        kind: link.kind,
        count: link.count,
        aggregated: link.aggregated || from !== rawSource || to !== rawTarget,
      });
    }
  }

  const links = Array.from(aggregated.values());

  const nodes: GraphNode[] = [];
  for (const node of graph.nodes) {
    if (!visible.has(node.id)) continue;
    node.degree = 0;
    nodes.push(node);
  }
  for (const link of links) {
    if (link.kind === CONTAINS) continue;
    const s = graph.nodeById.get(link.source as string);
    const t = graph.nodeById.get(link.target as string);
    if (s) s.degree += link.count;
    if (t) t.degree += link.count;
  }

  return { nodes, links, hiddenCount: graph.nodes.length - nodes.length };
}
