/*
 * Idle animation — the graph breathes in place after the physics has frozen.
 *
 * This is deliberately NOT a simulation. Re-heating d3-force to get idle motion
 * costs a full force pass per frame, and worse, repulsion keeps doing work: the
 * layout slowly bulges outward and never truly settles. Here the physics stops for
 * good and each node keeps the rest position it was given; a closed-form function
 * of time offsets it for display.
 *
 * The offset is strictly LOCAL and strictly BOUNDED. Two sine octaves per axis with
 * a per-node phase produce a smooth wander with no global rotation, no expansion
 * and no cumulative term, so |offset| <= amplitude for all time — a node can never
 * migrate away from where the layout put it. Neighbours are given unrelated phases
 * so nothing moves in lockstep.
 */

export interface RestPoint {
  id: string;
  /** Position the physics settled on; the node never leaves its neighbourhood. */
  rx: number;
  ry: number;
  /** Independent phases per axis, stable across reloads. */
  px: number;
  py: number;
}

export type AmbientField = Map<string, RestPoint>;

const TAU = Math.PI * 2;

/** Periods, in seconds, of the two octaves. Slow enough to read as breathing. */
const SLOW_PERIOD = 9.2;
const FAST_PERIOD = 5.3;
const SLOW_WEIGHT = 0.62;
const FAST_WEIGHT = 0.38; // weights sum to 1, so the offset is bounded by amplitude

/** Deterministic phase per node id, so the motion is identical across reloads. */
function hashPhase(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296) * TAU;
}

/** Snapshots the settled layout. Call once the engine has stopped. */
export function captureField(nodes: { id: string; x?: number; y?: number }[]): AmbientField | null {
  const field: AmbientField = new Map();
  for (const n of nodes) {
    if (n.x === undefined || n.y === undefined) continue;
    field.set(n.id, {
      id: n.id,
      rx: n.x,
      ry: n.y,
      px: hashPhase(n.id, 0),
      py: hashPhase(n.id, 0x9e37),
    });
  }
  return field.size > 0 ? field : null;
}

/*
 * Each axis is bounded by 1, so the offset VECTOR could reach √2 — normalising by
 * that makes `amplitude` mean exactly what it says: the furthest a node can ever
 * be from its resting place, in any direction.
 */
const AXIS_NORM = Math.SQRT1_2;

/**
 * Display position at elapsed time `t` seconds. `amplitude` is in graph units and
 * is a hard bound on the excursion — pass `pixels / zoom` to keep the wander a
 * constant few pixels at any zoom.
 *
 * Pure: same inputs always give the same output.
 */
export function ambientOffset(point: RestPoint, t: number, amplitude: number): { x: number; y: number } {
  const slow = (TAU / SLOW_PERIOD) * t;
  const fast = (TAU / FAST_PERIOD) * t;

  const ox =
    Math.sin(slow + point.px) * SLOW_WEIGHT + Math.sin(fast * 1.13 + point.px * 1.7) * FAST_WEIGHT;
  const oy =
    Math.cos(slow * 0.87 + point.py) * SLOW_WEIGHT + Math.cos(fast + point.py * 1.31) * FAST_WEIGHT;

  const scale = amplitude * AXIS_NORM;
  return { x: point.rx + ox * scale, y: point.ry + oy * scale };
}
