import type { Coords } from './iso';

/**
 * Orthogonal connector routing on the tile grid.
 *
 * FossFLOW routes connectors with A* (pathfinding.js, Manhattan heuristic)
 * over the tile grid. We keep that model but forbid diagonals, add a turn
 * penalty (fewer elbows read better in isometric view) and a crowding cost so
 * parallel routes spread out instead of overlapping.
 */
export interface RoutingGrid {
  origin: Coords;
  width: number;
  height: number;
  /** 1 = obstacle */
  blocked: Uint8Array;
  /** Accumulated usage by already-routed connectors. */
  usage: Float32Array;
}

export function createGrid(min: Coords, max: Coords): RoutingGrid {
  const width = max.x - min.x + 1;
  const height = max.y - min.y + 1;
  return { origin: { ...min }, width, height, blocked: new Uint8Array(width * height), usage: new Float32Array(width * height) };
}

const idx = (g: RoutingGrid, x: number, y: number) => (y - g.origin.y) * g.width + (x - g.origin.x);
const inside = (g: RoutingGrid, x: number, y: number) =>
  x >= g.origin.x && y >= g.origin.y && x < g.origin.x + g.width && y < g.origin.y + g.height;

export function block(g: RoutingGrid, t: Coords) {
  if (inside(g, t.x, t.y)) g.blocked[idx(g, t.x, t.y)] = 1;
}

const DIRS: Coords[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

class MinHeap {
  private a: { k: number; v: number }[] = [];
  get size() {
    return this.a.length;
  }
  push(v: number, k: number) {
    const a = this.a;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.v;
  }
}

export interface PathOptions {
  turnPenalty?: number;
  crowdingPenalty?: number;
}

/** A* over (tile, heading) states. Returns tiles from `from` to `to` inclusive, or null. */
export function findPath(g: RoutingGrid, from: Coords, to: Coords, opts: PathOptions = {}): Coords[] | null {
  const turn = opts.turnPenalty ?? 0.6;
  const crowd = opts.crowdingPenalty ?? 0.35;
  if (!inside(g, from.x, from.y) || !inside(g, to.x, to.y)) return null;
  const n = g.width * g.height;
  const S = 5; // 4 headings + "none" at the start
  const cost = new Float32Array(n * S).fill(Infinity);
  const prev = new Int32Array(n * S).fill(-1);
  const heap = new MinHeap();
  const h = (x: number, y: number) => Math.abs(x - to.x) + Math.abs(y - to.y);
  const start = idx(g, from.x, from.y) * S + 4;
  cost[start] = 0;
  heap.push(start, h(from.x, from.y));
  const goal = idx(g, to.x, to.y);
  while (heap.size) {
    const state = heap.pop();
    const cell = Math.floor(state / S);
    const dir = state % S;
    const x = (cell % g.width) + g.origin.x;
    const y = Math.floor(cell / g.width) + g.origin.y;
    if (cell === goal) {
      const out: Coords[] = [];
      for (let s = state; s !== -1; s = prev[s]) {
        const c = Math.floor(s / S);
        out.push({ x: (c % g.width) + g.origin.x, y: Math.floor(c / g.width) + g.origin.y });
      }
      return out.reverse();
    }
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d].x;
      const ny = y + DIRS[d].y;
      if (!inside(g, nx, ny)) continue;
      const ncell = idx(g, nx, ny);
      if (g.blocked[ncell] && ncell !== goal) continue;
      const step = 1 + g.usage[ncell] * crowd + (dir !== 4 && dir !== d ? turn : 0);
      const ns = ncell * S + d;
      const nc = cost[state] + step;
      if (nc < cost[ns]) {
        cost[ns] = nc;
        prev[ns] = state;
        heap.push(ns, nc + h(nx, ny));
      }
    }
  }
  return null;
}

export function markUsage(g: RoutingGrid, path: Coords[]) {
  for (const t of path) if (inside(g, t.x, t.y)) g.usage[idx(g, t.x, t.y)] += 1;
}

/** Drop collinear interior points: [a, b, c] on one line → [a, c]. */
export function simplify(path: Coords[]): Coords[] {
  if (path.length <= 2) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1];
    const b = path[i];
    const c = path[i + 1];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) continue;
    out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}

/** Fallback when the grid is saturated: a plain L-shaped elbow. */
export function elbow(from: Coords, to: Coords): Coords[] {
  return simplify([from, { x: to.x, y: from.y }, to]);
}
