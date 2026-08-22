/*
 * Decides which node labels get drawn.
 *
 * Two independent mechanisms, in order:
 *   1. Zoom tiers — zoomed out, only modules are eligible; zooming in progressively
 *      admits lower-degree symbols. Keeps the graph from ever attempting 1500 labels.
 *   2. Greedy collision culling — candidates are sorted by importance and placed one
 *      at a time; a label whose box overlaps one already placed is dropped. The most
 *      important label in a crowded region wins, and the rest stay silent.
 *
 * Pure and renderer-free so it can be tested without a canvas: text measurement is
 * injected, and all geometry is returned rather than drawn.
 */

export interface LabelTier {
  /** Applies while zoom / fitZoom is below this. */
  zoom: number;
  minDegree: number;
  modulesOnly: boolean;
  budget: number;
}

export interface LabelNode {
  id: string;
  label: string;
  x?: number;
  y?: number;
  radius: number;
  isModule: boolean;
  degree: number;
}

export interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LabelPlacement {
  id: string;
  text: string;
  x: number;
  y: number;
  bold: boolean;
  box: LabelBox;
}

export interface LabelLayoutOptions {
  tiers: LabelTier[];
  /** Current canvas zoom. */
  globalScale: number;
  /** Zoom at which the whole graph fits; tiers are multiples of this. */
  fitZoom: number | null;
  focusId: string | null;
  focusNeighbors: Set<string> | null;
  selectedId: string | null;
  /**
   * Visible region in graph coordinates. Off-screen nodes are dropped before the
   * budget is spent — otherwise an important node far outside the viewport takes a
   * slot from one the user can actually see.
   */
  viewport?: LabelBox | null;
  /**
   * Labels placed on the previous frame. They get a small importance bonus so a
   * drifting layout doesn't make labels flicker on and off as ties in a crowded
   * region flip back and forth.
   */
  sticky?: Set<string> | null;
  /** Font height and node gap, in graph units. */
  fontSize: number;
  gap: number;
  padX: number;
  padY: number;
  /** Text width in graph units. */
  measure: (text: string, bold: boolean) => number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

export function pickTier(tiers: LabelTier[], globalScale: number, fitZoom: number | null): LabelTier {
  // Without a known fit zoom, assume we're fully zoomed out — the quiet end
  const ratio = fitZoom ? globalScale / fitZoom : 1;
  return tiers.find((t) => ratio < t.zoom) ?? tiers[tiers.length - 1];
}

export function planLabels(nodes: LabelNode[], opts: LabelLayoutOptions): LabelPlacement[] {
  if (nodes.length === 0) return [];
  const tier = pickTier(opts.tiers, opts.globalScale, opts.fitZoom);

  const importance = (n: LabelNode): number => {
    if (n.id === opts.focusId) return 1e9;
    if (opts.focusNeighbors?.has(n.id)) return 1e8 + n.degree;
    if (n.id === opts.selectedId) return 1e7;
    const stick = opts.sticky?.has(n.id) ? 500 : 0;
    return (n.isModule ? 1e4 : 0) + n.degree + stick;
  };

  const eligible = (n: LabelNode): boolean => {
    if (n.x === undefined || n.y === undefined) return false;
    const vp = opts.viewport;
    if (vp && (n.x < vp.x0 || n.x > vp.x1 || n.y < vp.y0 || n.y > vp.y1)) return false;
    if (opts.focusId) {
      // In focus mode, only the lit neighbourhood is worth naming
      return n.id === opts.focusId || !!opts.focusNeighbors?.has(n.id);
    }
    if (n.id === opts.selectedId) return true;
    if (n.isModule) return true;
    return !tier.modulesOnly && n.degree >= tier.minDegree;
  };

  const candidates = nodes.filter(eligible).sort((a, b) => importance(b) - importance(a));

  const placements: LabelPlacement[] = [];
  const placed: LabelBox[] = [];

  for (const node of candidates) {
    if (placements.length >= tier.budget) break;

    const bold = node.id === opts.focusId || node.isModule;
    const width = opts.measure(node.label, bold);
    const x = node.x! + node.radius + opts.gap;
    const y = node.y!;
    const box: LabelBox = {
      x0: x - opts.padX,
      y0: y - opts.fontSize / 2 - opts.padY,
      x1: x + width + opts.padX,
      y1: y + opts.fontSize / 2 + opts.padY,
    };

    if (placed.some((other) => overlaps(box, other))) continue;

    placed.push(box);
    placements.push({ id: node.id, text: node.label, x, y, bold, box });
  }

  return placements;
}
