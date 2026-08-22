import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { ForceGraphMethods } from 'react-force-graph-2d';
import { forceCollide } from 'd3-force';
import { Waves, Maximize2, Minimize2, Eye, Orbit } from 'lucide-react';

import { GraphNode, GraphLink, SemanticGraph, computeView } from '../utils/graph-model';
import { planLabels } from '../utils/label-layout';
import { AmbientField, ambientOffset, captureField } from '../utils/ambient-motion';
import { symbolColor, relationColor, relationDash } from './symbol-theme';

/*
 * Canvas renderer for the knowledge graph.
 *
 * Three things keep a 1500-symbol workspace readable and cheap:
 *   1. Level of detail — only module-level and high-degree nodes are drawn by
 *      default; everything else rolls up into its file. Zooming in or clicking a
 *      module reveals its children.
 *   2. Label culling — labels appear by degree and zoom, never all at once.
 *   3. The simulation freezes on convergence and the canvas stops repainting;
 *      dragging, shaking or changing the view wakes it.
 */

const COOLDOWN_TICKS = 220;
const MIN_HIGH_DEGREE = 8; // never promote a barely-connected symbol
const MAX_AUTO_EXPAND = 30; // modules revealed at once by zooming

/*
 * Label budget and eligibility by zoom, expressed as a multiple of the zoom level
 * that fits the whole graph. Zoomed out you get module names only; zoomed in,
 * progressively more detail. Collision culling then thins whatever survives.
 */
const LABEL_TIERS = [
  // Zoomed out the field carries no text at all — just the nodes.
  { zoom: 1.8, minDegree: Infinity, modulesOnly: true, budget: 0 },
  // Then names arrive gradually, busiest first, as you push in.
  { zoom: 3, minDegree: 14, modulesOnly: false, budget: 40 },
  { zoom: 5.5, minDegree: 5, modulesOnly: false, budget: 110 },
  { zoom: Infinity, minDegree: 0, modulesOnly: false, budget: 200 },
];

const LABEL_PX = 11; // on-screen font size, constant at every zoom
const LABEL_GAP = 3; // screen px between the node and its label
const MIN_NODE_SCREEN_PX = 2; // a node never renders smaller than this
const NODE_SIZE_SCALE = 1.1; // everything a touch larger, since labels are gone at rest
const IDLE_AMPLITUDE_PX = 3; // hard bound on how far a node wanders from its rest position

export interface FocusRequest {
  id: string;
  nonce: number;
}

interface ForceGraphCanvasProps {
  graph: SemanticGraph;
  searchTerm: string;
  selectedKinds: Set<string>;
  selectedEdgeKinds: Set<string>;
  neighborhoodNodeId: string | null;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  focusRequest: FocusRequest | null;
}

/**
 * Soma radius in graph units. Hubs still read as hubs, but the range is compressed
 * and the whole scale is ~30% smaller than a plain degree mapping would give —
 * small cores with a wide glow read as neurons; big flat discs don't.
 */
function radiusOf(node: GraphNode): number {
  const base = node.isModule ? 3 : 2.1;
  // Nudged up now that nothing else is carrying the field at rest
  return (base + Math.min(Math.sqrt(node.degree) * 0.95, 6)) * NODE_SIZE_SCALE;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Pulls a hue toward light slate so it reads as a line on a near-black canvas. */
function lighten(hex: string, amount: number, alpha: number): string {
  const [r, g, b] = rgb(hex);
  const [tr, tg, tb] = [203, 213, 225]; // #cbd5e1
  const mix = (c: number, t: number) => Math.round(c + (t - c) * amount);
  return `rgba(${mix(r, tr)}, ${mix(g, tg)}, ${mix(b, tb)}, ${alpha})`;
}

/*
 * Soft glow behind each node. Building a radial gradient per node per frame is the
 * obvious way and the expensive one — a few hundred gradient objects every frame.
 * Instead each colour's falloff is rendered once into a small offscreen canvas and
 * blitted, so the glow costs one drawImage per node.
 */
const GLOW_TEXTURE_PX = 64;
const glowCache = new Map<string, HTMLCanvasElement>();

function glowSprite(color: string): HTMLCanvasElement | null {
  const cached = glowCache.get(color);
  if (cached) return cached;
  if (typeof document === 'undefined') return null;

  const size = GLOW_TEXTURE_PX * 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const [r, g, b] = rgb(color);
  const gradient = ctx.createRadialGradient(
    GLOW_TEXTURE_PX,
    GLOW_TEXTURE_PX,
    0,
    GLOW_TEXTURE_PX,
    GLOW_TEXTURE_PX,
    GLOW_TEXTURE_PX,
  );
  // Tight bright centre, long soft tail — a synaptic bloom rather than a halo ring
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.85)`);
  gradient.addColorStop(0.18, `rgba(${r}, ${g}, ${b}, 0.38)`);
  gradient.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, 0.12)`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  glowCache.set(color, canvas);
  return canvas;
}

function endpointId(end: string | GraphNode): string {
  return typeof end === 'string' ? end : end.id;
}

export function ForceGraphCanvas({
  graph,
  searchTerm,
  selectedKinds,
  selectedEdgeKinds,
  neighborhoodNodeId,
  selectedNodeId,
  onSelectNode,
  focusRequest,
}: ForceGraphCanvasProps) {
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink>>();
  const containerRef = useRef<HTMLDivElement>(null);

  const [size, setSize] = useState({ width: 800, height: 600 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedExpanded, setPinnedExpanded] = useState<Set<string>>(new Set());
  const [autoExpanded, setAutoExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [settled, setSettled] = useState(false);
  const [ambient, setAmbient] = useState(true);

  const fitZoomRef = useRef<number | null>(null);
  const zoomRef = useRef(1);

  // Rest positions the idle animation oscillates around
  const fieldRef = useRef<AmbientField | null>(null);

  // ── Container sizing ────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const { clientWidth, clientHeight } = el;
      if (clientWidth > 0 && clientHeight > 0) {
        setSize((prev) =>
          prev.width === clientWidth && prev.height === clientHeight
            ? prev
            : { width: clientWidth, height: clientHeight },
        );
      }
    };

    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // ── What to draw ────────────────────────────────────────────────────
  const expandedIds = useMemo(() => {
    const merged = new Set(pinnedExpanded);
    for (const id of autoExpanded) merged.add(id);
    return merged;
  }, [pinnedExpanded, autoExpanded]);

  /*
   * How connected a symbol must be to earn a place alongside the modules. Derived
   * from this graph's own degree distribution rather than fixed, so a small repo
   * isn't emptied out and a huge one doesn't flood the default view.
   */
  const highDegreeThreshold = useMemo(() => {
    const degrees = graph.nodes
      .filter((n) => !n.isModule)
      .map((n) => n.baseDegree)
      .sort((a, b) => b - a);
    if (degrees.length === 0) return MIN_HIGH_DEGREE;
    const budget = Math.max(40, Math.min(120, Math.round(graph.nodes.length * 0.06)));
    const cut = degrees[Math.min(budget, degrees.length - 1)];
    return Math.max(MIN_HIGH_DEGREE, cut);
  }, [graph]);

  const view = useMemo(
    () =>
      computeView(graph, {
        searchTerm,
        selectedKinds,
        selectedEdgeKinds,
        expandedIds,
        showAll,
        neighborhoodNodeId,
        highDegreeThreshold,
        pinnedIds: selectedNodeId ? [selectedNodeId] : [],
      }),
    [
      graph,
      searchTerm,
      selectedKinds,
      selectedEdgeKinds,
      expandedIds,
      showAll,
      neighborhoodNodeId,
      selectedNodeId,
      highDegreeThreshold,
    ],
  );

  /*
   * Handing the engine a new graphData object restarts the layout, so only do it
   * when the drawn set genuinely changed. Selecting a node that was already on
   * screen must not re-shuffle the graph.
   */
  const stableRef = useRef<{ signature: string; data: { nodes: GraphNode[]; links: GraphLink[] } } | null>(null);
  const graphData = useMemo(() => {
    const signature = `${view.nodes.map((n) => n.id).join('|')}##${view.links
      .map((l) => `${endpointId(l.source)}>${endpointId(l.target)}:${l.kind}`)
      .join('|')}`;

    if (stableRef.current?.signature === signature) return stableRef.current.data;

    // New nodes start at their parent so an expansion reads as children emerging
    // from the module, instead of flying in from the origin.
    for (const node of view.nodes) {
      if (node.x !== undefined || !node.parentId) continue;
      const parent = graph.nodeById.get(node.parentId);
      if (parent?.x !== undefined && parent.y !== undefined) {
        node.x = parent.x + (Math.random() - 0.5) * 30;
        node.y = parent.y + (Math.random() - 0.5) * 30;
      }
    }

    const data = { nodes: view.nodes, links: view.links };
    stableRef.current = { signature, data };
    return data;
  }, [view, graph]);

  const dataRef = useRef(graphData);
  dataRef.current = graphData;

  // A new drawn set means the physics runs again — drop the drift snapshot until
  // it settles, otherwise we'd float nodes around stale rest positions.
  useEffect(() => {
    setSettled(false);
    fieldRef.current = null;
  }, [graphData]);

  /*
   * Ambient drift loop. The simulation stays frozen; this only rewrites display
   * positions from a closed-form function of elapsed time. Writing to node.x/y
   * (rather than offsetting inside the node painter) means links, arrowheads,
   * labels and hit-testing all follow for free.
   */
  useEffect(() => {
    if (!ambient) return;
    let raf = 0;
    const start = performance.now();

    const step = () => {
      raf = requestAnimationFrame(step);
      const field = fieldRef.current;
      if (!field) return; // still settling, or a drag is in progress

      const t = (performance.now() - start) / 1000;
      // Amplitude in screen pixels, converted to graph units, so the wander stays a
      // few pixels whether you're zoomed out over the whole graph or in on one file
      const amplitude = IDLE_AMPLITUDE_PX / (zoomRef.current || 1);
      for (const node of dataRef.current.nodes) {
        const point = field.get(node.id);
        if (!point || node.fx !== undefined) continue; // skip pinned/dragged nodes
        const next = ambientOffset(point, t, amplitude);
        node.x = next.x;
        node.y = next.y;
      }
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ambient]);

  // ── Focus: the hovered/selected node and its 1-hop neighbourhood ────
  const focusId = hoveredId ?? selectedNodeId;
  const focusNeighbors = useMemo(() => {
    if (!focusId) return null;
    const ids = new Set<string>();
    for (const link of graphData.links) {
      const s = endpointId(link.source);
      const t = endpointId(link.target);
      if (s === focusId) ids.add(t);
      else if (t === focusId) ids.add(s);
    }
    return ids;
  }, [focusId, graphData]);

  const isLit = useCallback(
    (id: string) => !focusId || id === focusId || !!focusNeighbors?.has(id),
    [focusId, focusNeighbors],
  );

  // ── Forces ──────────────────────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    fg.d3Force('collide', forceCollide<GraphNode>((n) => radiusOf(n) + 3).strength(0.85) as any);

    const charge = fg.d3Force('charge') as any;
    charge?.strength(-140).distanceMax(700);

    const link = fg.d3Force('link') as any;
    link
      // Bigger hubs need more room, so spacing accounts for the endpoint radii
      ?.distance((l: GraphLink) => {
        const span =
          (typeof l.source === 'object' ? radiusOf(l.source) : 0) +
          (typeof l.target === 'object' ? radiusOf(l.target) : 0);
        return (l.kind === 'contains' ? 26 : 70) + span;
      })
      .strength((l: GraphLink) => (l.kind === 'contains' ? 1.1 : 0.35));
  }, [graphData]);

  // ── Base edge opacity, eased down only in genuinely dense views ─────
  const baseLinkAlpha = useMemo(() => {
    const n = graphData.links.length;
    if (n > 2500) return 0.14;
    if (n > 1200) return 0.18;
    if (n > 400) return 0.22;
    return 0.3;
  }, [graphData]);

  // ── Painting ────────────────────────────────────────────────────────
  const paintNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (node.x === undefined || node.y === undefined) return;

      const lit = isLit(node.id);
      const isFocus = node.id === focusId;
      const isSelected = node.id === selectedNodeId;
      const color = symbolColor(node.kind);
      // Radii are graph units, so clamp to a floor in screen pixels — otherwise
      // zooming out shrinks the field into invisible specks.
      const r = Math.max(radiusOf(node) * (isFocus ? 1.35 : 1), MIN_NODE_SCREEN_PX / globalScale);

      // Soft bloom behind the soma, blended additively so overlapping fields pool
      // light the way a stained neuron field does
      const sprite = glowSprite(color);
      if (sprite) {
        const reach = r * (isFocus || isSelected ? 5.5 : 4);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = lit ? (isFocus || isSelected ? 0.95 : 0.6) : 0.08;
        ctx.drawImage(sprite, node.x - reach, node.y - reach, reach * 2, reach * 2);
      }

      // Bright core on top, drawn normally so it stays a crisp cell body
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = lit ? 1 : 0.18;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = lighten(color, isFocus || isSelected ? 0.5 : 0.22, 1);
      ctx.fill();

      // Nucleus highlight — a small near-white centre gives the core depth
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * 0.42, 0, 2 * Math.PI);
      ctx.fillStyle = lighten(color, 0.8, lit ? 0.9 : 0.3);
      ctx.fill();

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 1.6 / globalScale, 0, 2 * Math.PI);
        ctx.lineWidth = 1.5 / globalScale;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }

      // Collapsed module still holding detail — a ring marks "there's more inside"
      const collapsed = node.childCount > 0 && !expandedIds.has(node.id) && !showAll;
      if (collapsed) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 2.4 / globalScale, 0, 2 * Math.PI);
        ctx.lineWidth = 0.8 / globalScale;
        ctx.strokeStyle = withAlpha(color, lit ? 0.5 : 0.15);
        ctx.setLineDash([1.5 / globalScale, 1.5 / globalScale]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.globalAlpha = 1;
    },
    [isLit, focusId, selectedNodeId, expandedIds, showAll],
  );

  /*
   * Labels are drawn in one pass after the nodes, not per node, because culling
   * them needs a global decision: sort by importance, then place greedily and skip
   * anything whose box overlaps a label already on the canvas.
   */
  const stickyLabelsRef = useRef<Set<string>>(new Set());
  const textWidthRef = useRef<Map<string, number>>(new Map());

  const paintLabels = useCallback(
    (ctx: CanvasRenderingContext2D, globalScale: number) => {
      const nodes = dataRef.current.nodes;
      if (nodes.length === 0) return;

      const fontSize = LABEL_PX / globalScale;
      const fontFor = (bold: boolean) =>
        `${bold ? 700 : 500} ${fontSize}px ui-monospace, SFMono-Regular, monospace`;

      // Only nodes on screen may spend the label budget
      const fg = fgRef.current;
      let viewport = null;
      if (fg) {
        const margin = 40 / globalScale;
        const tl = fg.screen2GraphCoords(0, 0);
        const br = fg.screen2GraphCoords(size.width, size.height);
        viewport = { x0: tl.x - margin, y0: tl.y - margin, x1: br.x + margin, y1: br.y + margin };
      }

      const placements = planLabels(
        nodes.map((n) => ({
          id: n.id,
          label: n.label,
          x: n.x,
          y: n.y,
          radius: Math.max(
            radiusOf(n) * (n.id === focusId ? 1.4 : 1),
            MIN_NODE_SCREEN_PX / globalScale,
          ),
          isModule: n.isModule,
          degree: n.degree,
        })),
        {
          tiers: LABEL_TIERS,
          globalScale,
          fitZoom: fitZoomRef.current,
          focusId,
          focusNeighbors,
          selectedId: selectedNodeId,
          viewport,
          sticky: stickyLabelsRef.current,
          fontSize,
          gap: LABEL_GAP / globalScale,
          padX: 3 / globalScale,
          padY: 1.5 / globalScale,
          // Measuring text is the expensive part of a per-frame label pass, and
          // widths only change with the font size — so cache them.
          measure: (text, bold) => {
            const key = `${bold ? 'b' : 'r'}|${fontSize.toFixed(3)}|${text}`;
            const cached = textWidthRef.current.get(key);
            if (cached !== undefined) return cached;
            ctx.font = fontFor(bold);
            const width = ctx.measureText(text).width;
            if (textWidthRef.current.size > 4000) textWidthRef.current.clear();
            textWidthRef.current.set(key, width);
            return width;
          },
        },
      );

      stickyLabelsRef.current = new Set(placements.map((p) => p.id));

      // Text must never blend additively or the plates stop being opaque
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      for (const p of placements) {
        ctx.font = fontFor(p.bold);
        // Subtle plate behind the text so it survives a dense node/edge field
        ctx.fillStyle = 'rgba(7, 10, 19, 0.72)';
        ctx.fillRect(p.box.x0, p.box.y0, p.box.x1 - p.box.x0, p.box.y1 - p.box.y0);
        ctx.lineWidth = 2.5 / globalScale;
        ctx.strokeStyle = 'rgba(7, 10, 19, 0.85)';
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.id === focusId ? '#ffffff' : p.bold ? '#e2e8f0' : '#cbd5e1';
        ctx.fillText(p.text, p.x, p.y);
      }
    },
    [focusId, focusNeighbors, selectedNodeId, size.width, size.height],
  );

  const paintPointerArea = useCallback(
    (node: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
      if (node.x === undefined || node.y === undefined) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radiusOf(node) + 4, 0, 2 * Math.PI);
      ctx.fill();
    },
    [],
  );

  const isHotLink = useCallback(
    (link: GraphLink) =>
      focusId ? endpointId(link.source) === focusId || endpointId(link.target) === focusId : false,
    [focusId],
  );

  const linkColor = useCallback(
    (link: GraphLink) => {
      const base = relationColor(link.kind);
      // Hot links keep their true hue at full strength; everything else is pulled
      // toward light slate so it reads as structure rather than colour noise.
      // These are drawn additively, so overlapping bundles pool into brighter
      // tracts on their own — the dendrite look, at no extra draw cost.
      if (isHotLink(link)) return withAlpha(base, 0.95);
      if (focusId) return lighten(base, 0.55, baseLinkAlpha * 0.3);
      return lighten(base, 0.5, link.kind === 'contains' ? baseLinkAlpha * 0.55 : baseLinkAlpha);
    },
    [focusId, isHotLink, baseLinkAlpha],
  );

  // Widths are screen pixels: force-graph divides by the zoom scale internally
  const linkWidth = useCallback(
    (link: GraphLink) => {
      if (isHotLink(link)) return 2.6;
      if (link.kind === 'contains') return 0.9;
      return link.aggregated ? Math.min(1.1 + Math.log2(1 + link.count) * 0.45, 3) : 1.2;
    },
    [isHotLink],
  );

  /*
   * The link + arrow layer is drawn additively. force-graph paints links, then
   * arrows, then nodes between these two hooks, and its internal save/restore
   * inherits whatever blend mode is set here — so one assignment turns the whole
   * edge layer into accumulating light. Node and label painters reset it.
   */
  const beginFrame = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.globalCompositeOperation = 'lighter';
  }, []);

  // Arrow length IS in graph units, so divide by zoom to hold it steady on screen
  const arrowLength = useCallback(
    (link: GraphLink) => {
      if (link.kind === 'contains') return 0;
      const scale = zoomRef.current || 1;
      return (isHotLink(link) ? 7 : 4.5) / scale;
    },
    [isHotLink],
  );

  // ── Interaction ─────────────────────────────────────────────────────
  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      onSelectNode(node.id);
      if (node.childCount > 0 && !showAll) {
        setPinnedExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        });
      }
    },
    [onSelectNode, showAll],
  );

  // Zooming past the detail threshold reveals the modules actually in view
  const handleZoomEnd = useCallback(
    (transform: { k: number }) => {
      zoomRef.current = transform.k;
      const fg = fgRef.current;
      const fitZoom = fitZoomRef.current;
      if (!fg || !fitZoom || showAll) return;

      if (transform.k < fitZoom * 3) {
        setAutoExpanded((prev) => (prev.size === 0 ? prev : new Set()));
        return;
      }

      const topLeft = fg.screen2GraphCoords(0, 0);
      const bottomRight = fg.screen2GraphCoords(size.width, size.height);
      const inView: string[] = [];
      for (const node of graphData.nodes) {
        if (node.childCount === 0 || node.x === undefined || node.y === undefined) continue;
        if (
          node.x >= topLeft.x &&
          node.x <= bottomRight.x &&
          node.y >= topLeft.y &&
          node.y <= bottomRight.y
        ) {
          inView.push(node.id);
        }
        if (inView.length >= MAX_AUTO_EXPAND) break;
      }

      setAutoExpanded((prev) => {
        if (prev.size === inView.length && inView.every((id) => prev.has(id))) return prev;
        return new Set(inView);
      });
    },
    [graphData, showAll, size.width, size.height],
  );

  /*
   * The zoom level at which the whole graph fits, computed from its bounding box
   * rather than sampled after an animated zoomToFit. Every label threshold is a
   * multiple of this, so it has to be a number we can trust.
   */
  const computeFitZoom = useCallback((): number | null => {
    const fg = fgRef.current;
    if (!fg) return null;
    const bbox = fg.getGraphBbox();
    if (!bbox) return null;
    const w = Math.max(1, bbox.x[1] - bbox.x[0]);
    const h = Math.max(1, bbox.y[1] - bbox.y[0]);
    return Math.min(size.width / (w + 120), size.height / (h + 120));
  }, [size.width, size.height]);

  // A new view means a new extent — re-fit and re-derive the thresholds
  useEffect(() => {
    fitZoomRef.current = null;
  }, [graph]);

  const handleEngineStop = useCallback(() => {
    setSettled(true);
    if (fitZoomRef.current === null) {
      fitZoomRef.current = computeFitZoom();
      fgRef.current?.zoomToFit(600, 60);
    }
    // Freeze point becomes the rest layout the ambient drift orbits around
    fieldRef.current = captureField(dataRef.current.nodes);
  }, [computeFitZoom]);

  /*
   * Centre on a node requested from the sidebars. A rolled-up node has to be
   * revealed first and then given a tick or two to acquire coordinates, so this
   * polls briefly rather than depending on the drawn graph — otherwise every later
   * expansion would re-trigger the centering for a stale request.
   */
  const graphRef = useRef(graph);
  graphRef.current = graph;

  useEffect(() => {
    if (!focusRequest) return;
    const node = graphRef.current.nodeById.get(focusRequest.id);
    if (!node) return;

    if (node.parentId) {
      setPinnedExpanded((prev) => (prev.has(node.parentId!) ? prev : new Set(prev).add(node.parentId!)));
    }

    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tryCenter = () => {
      const fg = fgRef.current;
      if (fg && node.x !== undefined && node.y !== undefined) {
        fg.centerAt(node.x, node.y, 700);
        fg.zoom(Math.max(fg.zoom(), (fitZoomRef.current ?? 1) * 3.5), 700);
        return;
      }
      if (++attempts < 8) timer = setTimeout(tryCenter, 120);
    };
    timer = setTimeout(tryCenter, 80);
    return () => clearTimeout(timer);
  }, [focusRequest]);

  const reheat = useCallback(() => {
    fgRef.current?.d3ReheatSimulation();
    setSettled(false);
  }, []);

  const collapseAll = useCallback(() => {
    setPinnedExpanded(new Set());
    setAutoExpanded(new Set());
    setShowAll(false);
    fgRef.current?.zoomToFit(600, 60);
  }, []);

  return (
    <div ref={containerRef} className="force-canvas">
      <div className="physics-toolbar">
        <div className="graph-stat-pill" title="Nodes and relations currently drawn">
          <Eye size={12} />
          <span>
            {graphData.nodes.length} nodes · {graphData.links.length} links
            {view.hiddenCount > 0 ? ` · ${view.hiddenCount} rolled up` : ''}
          </span>
        </div>
        <button
          className={`physics-btn ${showAll ? 'active' : ''}`}
          onClick={() => setShowAll((v) => !v)}
          title={showAll ? 'Roll detail back up into modules' : 'Draw every symbol (slow on large graphs)'}
        >
          {showAll ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          <span>{showAll ? 'Full detail' : 'Modules'}</span>
        </button>
        <button
          className={`physics-btn ${ambient ? 'active' : ''}`}
          onClick={() => setAmbient((v) => !v)}
          title={
            ambient
              ? 'Hold every node perfectly still'
              : 'Let each node breathe around its resting place'
          }
        >
          <Orbit size={12} />
          <span>{ambient ? 'Alive' : 'Still'}</span>
        </button>
        <button className="physics-btn" onClick={collapseAll} title="Collapse everything and refit">
          <Minimize2 size={12} />
          <span>Reset</span>
        </button>
        <button className="physics-btn" onClick={reheat} title="Shake the layout loose">
          <Waves size={12} />
          <span>{settled ? 'Shake' : 'Settling…'}</span>
        </button>
      </div>

      <ForceGraph2D<GraphNode, GraphLink>
        ref={fgRef as any}
        graphData={graphData}
        width={size.width}
        height={size.height}
        backgroundColor="rgba(0,0,0,0)"
        nodeId="id"
        // Tells force-graph our true radius (r = √val × relSize) so arrowheads stop
        // at the circle edge instead of the default size's
        nodeRelSize={1}
        nodeVal={(node) => radiusOf(node) ** 2}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={paintPointerArea}
        nodeLabel={(node) => `${node.symbol.kind} · ${node.symbol.qualifiedName}`}
        onRenderFramePre={beginFrame}
        onRenderFramePost={paintLabels}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkLineDash={(link) => relationDash(link.kind)}
        linkDirectionalArrowLength={arrowLength}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={linkColor}
        onNodeClick={handleNodeClick}
        onNodeHover={(node) => setHoveredId(node ? node.id : null)}
        // Dragging re-heats the engine; suspend the drift until it settles again
        onNodeDrag={() => {
          fieldRef.current = null;
          setSettled(false);
        }}
        onBackgroundClick={() => onSelectNode(null)}
        onZoom={(t) => {
          zoomRef.current = t.k;
        }}
        onZoomEnd={handleZoomEnd}
        onEngineStop={handleEngineStop}
        // Freeze on convergence — the canvas stops repainting once this elapses
        cooldownTicks={COOLDOWN_TICKS}
        warmupTicks={40}
        d3AlphaDecay={0.028}
        d3VelocityDecay={0.35}
        // Drift needs a frame every tick; without it the canvas idles at zero cost
        autoPauseRedraw={!ambient}
        minZoom={0.05}
        maxZoom={12}
        enableNodeDrag
      />
    </div>
  );
}
