/**
 * Graph model → positioned React Flow nodes. Pure and deterministic: fixed
 * dimensions per node kind, so nothing depends on DOM measurement and the
 * same vault always lands in the same place.
 *
 *   1. Size each machine from a √n grid of its workloads.
 *   2. Shelf-pack machines inside their company (the model already orders
 *      them: proxies first, then by category, VMs after their hypervisor).
 *      Bare appliances line up in a compact strip at the bottom.
 *   3. Arrange companies in a grid: ⌈√n⌉ columns, widened while that keeps
 *      the whole picture closer to a landscape (16:10) screen.
 *   4. Centre the Internet above the grid.
 */

import { Position, getSmoothStepPath } from '@xyflow/react';
import type { GraphEdge, GraphModel, GraphNode } from './build';

export const WORKLOAD = { w: 244, h: 72 };
export const APPLIANCE = { w: 252, h: 60 };
export const HOST = { pad: 14, header: 58, gap: 12, minW: 300 };
export const COMPANY = { pad: 24, header: 68, hostGap: 28, applianceGap: 16, minW: 360, emptyH: 96 };
export const INTERNET = { w: 312, h: 76, gap: 140 };
export const COMPANY_GAP = 112;
const TARGET_ASPECT = 1.6;
export const EDGE_RADIUS = 14;

export interface Rect { x: number; y: number; w: number; h: number }

export type FlowNodeData = { node: GraphNode };

/** Shape-compatible with React Flow's `Node<FlowNodeData>`. */
export interface PositionedNode {
  id: string;
  type: 'internet' | 'company' | 'host' | 'workload';
  position: { x: number; y: number };
  width: number;
  height: number;
  parentId?: string;
  extent?: 'parent';
  data: FlowNodeData;
}

export type Side = 't' | 'r' | 'b' | 'l';

export interface PositionedEdge {
  edge: GraphEdge;
  sourceHandle: `s-${Side}`;
  targetHandle: `t-${Side}`;
}

export interface GraphLayout {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  /** node id → absolute rectangle */
  rects: Map<string, Rect>;
  bounds: Rect;
}

const TYPE: Record<GraphNode['kind'], PositionedNode['type']> = { internet: 'internet', tenant: 'company', host: 'host', service: 'workload', proxy: 'workload' };

export function layoutGraph(model: GraphModel): GraphLayout {
  const rel = new Map<string, Rect>();
  const kids = (id: string) => (model.children.get(id) ?? []).map((c) => model.byId.get(c)!);

  // --- 1. machines ----------------------------------------------------------
  for (const host of model.nodes.filter((n) => n.kind === 'host')) {
    const items = kids(host.id);
    if (!items.length) {
      rel.set(host.id, { x: 0, y: 0, ...APPLIANCE });
      continue;
    }
    const cols = Math.ceil(Math.sqrt(items.length));
    const rows = Math.ceil(items.length / cols);
    const inner = cols * WORKLOAD.w + (cols - 1) * HOST.gap;
    const w = Math.max(HOST.minW, inner + HOST.pad * 2);
    const x0 = (w - inner) / 2;
    items.forEach((it, i) => {
      rel.set(it.id, { x: x0 + (i % cols) * (WORKLOAD.w + HOST.gap), y: HOST.header + Math.floor(i / cols) * (WORKLOAD.h + HOST.gap), ...WORKLOAD });
    });
    rel.set(host.id, { x: 0, y: 0, w, h: HOST.header + rows * WORKLOAD.h + (rows - 1) * HOST.gap + HOST.pad });
  }

  // --- 2. shelf-pack machines inside each company -------------------------
  const companies = model.nodes.filter((n) => n.kind === 'tenant');
  for (const company of companies) {
    const hosts = kids(company.id);
    const full = hosts.filter((h) => !h.appliance);
    const gear = hosts.filter((h) => h.appliance);
    const area = full.reduce((s, h) => s + (rel.get(h.id)!.w + COMPANY.hostGap) * (rel.get(h.id)!.h + COMPANY.hostGap), 0);
    const widest = Math.max(0, ...full.map((h) => rel.get(h.id)!.w));
    const maxRow = Math.max(COMPANY.minW - COMPANY.pad * 2, widest, Math.sqrt(area) * 1.3, Math.min(gear.length, 3) * (APPLIANCE.w + COMPANY.applianceGap) - COMPANY.applianceGap);
    let x = 0;
    let y = 0;
    let rowH = 0;
    let maxX = 0;
    const place = (id: string, gap: number) => {
      const r = rel.get(id)!;
      if (x > 0 && x + r.w > maxRow) {
        x = 0;
        y += rowH + gap;
        rowH = 0;
      }
      r.x = COMPANY.pad + x;
      r.y = COMPANY.header + y;
      x += r.w + gap;
      rowH = Math.max(rowH, r.h);
      maxX = Math.max(maxX, x - gap);
    };
    for (const h of full) place(h.id, COMPANY.hostGap);
    if (gear.length && full.length) {
      x = 0;
      y += rowH + COMPANY.hostGap;
      rowH = 0;
    }
    for (const h of gear) place(h.id, COMPANY.applianceGap);
    const innerH = hosts.length ? y + rowH : COMPANY.emptyH;
    rel.set(company.id, { x: 0, y: 0, w: Math.max(COMPANY.minW, maxX + COMPANY.pad * 2), h: COMPANY.header + innerH + COMPANY.pad });
  }

  // --- 3. companies in a grid ----------------------------------------------
  // Start from ⌈√n⌉ columns and widen while that brings the grid closer to a landscape screen.
  const grid = (cols: number) => {
    const colW: number[] = [];
    const rowH: number[] = [];
    companies.forEach((c, i) => {
      const r = rel.get(c.id)!;
      colW[i % cols] = Math.max(colW[i % cols] ?? 0, r.w);
      rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)] ?? 0, r.h);
    });
    const w = colW.reduce((s, v) => s + v, 0) + COMPANY_GAP * Math.max(0, colW.length - 1);
    const h = rowH.reduce((s, v) => s + v, 0) + COMPANY_GAP * Math.max(0, rowH.length - 1) + INTERNET.h + INTERNET.gap;
    return { cols, colW, rowH, miss: Math.abs(Math.log(w / Math.max(1, h) / TARGET_ASPECT)) };
  };
  let best = grid(Math.max(1, Math.ceil(Math.sqrt(companies.length))));
  for (let c = best.cols + 1; c <= companies.length; c++) {
    const g = grid(c);
    if (g.miss >= best.miss) break;
    best = g;
  }
  const { cols, colW, rowH } = best;
  const offsets = (sizes: number[]) => sizes.map((_, i) => sizes.slice(0, i).reduce((s, v) => s + v + COMPANY_GAP, 0));
  const colX = offsets(colW);
  const rowY = offsets(rowH);
  const gridW = Math.max(INTERNET.w, colW.reduce((s, v) => s + v, 0) + COMPANY_GAP * Math.max(0, colW.length - 1));
  const top = INTERNET.h + INTERNET.gap;
  companies.forEach((c, i) => {
    const r = rel.get(c.id)!;
    r.x = colX[i % cols];
    r.y = top + rowY[Math.floor(i / cols)];
  });

  // --- 4. the Internet -----------------------------------------------------
  rel.set('internet', { x: (gridW - INTERNET.w) / 2, y: 0, w: INTERNET.w, h: INTERNET.h });

  // Absolute rectangles (parents precede children in model order).
  const rects = new Map<string, Rect>();
  const nodes: PositionedNode[] = [];
  for (const n of model.nodes) {
    const r = rel.get(n.id)!;
    const p = n.parentId ? rects.get(n.parentId)! : { x: 0, y: 0 };
    rects.set(n.id, { x: p.x + r.x, y: p.y + r.y, w: r.w, h: r.h });
    nodes.push({
      id: n.id,
      type: TYPE[n.kind],
      position: { x: r.x, y: r.y },
      width: r.w,
      height: r.h,
      ...(n.parentId ? { parentId: n.parentId, extent: 'parent' as const } : {}),
      data: { node: n },
    });
  }

  const all = [...rects.values()];
  const bounds = all.reduce(
    (b, r) => {
      const x = Math.min(b.x, r.x);
      const y = Math.min(b.y, r.y);
      return { x, y, w: Math.max(b.x + b.w, r.x + r.w) - x, h: Math.max(b.y + b.h, r.y + r.h) - y };
    },
    { ...all[0] },
  );

  const obstacles = obstaclesOf(model, rects);
  return { nodes, edges: model.edges.map((e) => ({ edge: e, ...handlesFor(e, rects, obstacles) })), rects, bounds };
}

interface Obstacle extends Rect { id: string }

/** What an edge or label should not cross: leaves, plus the title bands of machines and companies. */
function obstaclesOf(model: GraphModel, rects: Map<string, Rect>): Obstacle[] {
  return model.nodes.map((n) => {
    const r = rects.get(n.id)!;
    if (n.kind === 'tenant') return { id: n.id, ...r, h: COMPANY.header - 12 };
    if (n.kind === 'host' && !n.appliance) return { id: n.id, ...r, h: HOST.header - 8 };
    return { id: n.id, ...r };
  });
}

const PAIRS: [Side, Side][] = [['b', 't'], ['t', 'b'], ['r', 'l'], ['l', 'r'], ['l', 'l'], ['r', 'r'], ['b', 'b'], ['t', 't']];

/**
 * Pick sides so edges leave and enter on the facing sides, unless that path
 * would cross other nodes and another pair of sides crosses fewer. Ingress
 * always enters proxies from the top.
 */
export function handlesFor(e: GraphEdge, rects: Map<string, Rect>, obstacles: Obstacle[] = []): Omit<PositionedEdge, 'edge'> {
  if (e.kind === 'ingress') return { sourceHandle: 's-b', targetHandle: 't-t' };
  const a = rects.get(e.source)!;
  const b = rects.get(e.target)!;
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const natural: [Side, Side] = gapY > gapX ? (b.y > a.y ? ['b', 't'] : ['t', 'b']) : b.x > a.x ? ['r', 'l'] : ['l', 'r'];
  const box = { x: Math.min(a.x, b.x) - 80, y: Math.min(a.y, b.y) - 80, w: 0, h: 0 };
  box.w = Math.max(a.x + a.w, b.x + b.w) + 80 - box.x;
  box.h = Math.max(a.y + a.h, b.y + b.h) + 80 - box.y;
  const near = obstacles.filter((o) => o.id !== e.source && o.id !== e.target && overlaps(o, box));
  let best: { pair: [Side, Side]; cost: number } | undefined;
  for (const pair of [natural, ...PAIRS.filter(([s, t]) => s !== natural[0] || t !== natural[1])]) {
    const pts = sidePolyline(a, pair[0], b, pair[1]);
    let crossings = 0;
    for (const o of near) if (pts.some((p, i) => i > 0 && segmentHits(pts[i - 1], p, o))) crossings++;
    const length = pts.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - pts[i].x) + Math.abs(p.y - pts[i].y), 0);
    const cost = crossings * 1e6 + length + (pair === natural ? 0 : 60);
    if (!best || cost < best.cost) best = { pair, cost };
  }
  return { sourceHandle: `s-${best!.pair[0]}`, targetHandle: `t-${best!.pair[1]}` };
}

/** Does an axis-aligned segment pass through the rectangle (ignoring a 2px rim)? */
function segmentHits(p: { x: number; y: number }, q: { x: number; y: number }, r: Rect): boolean {
  const x0 = Math.min(p.x, q.x);
  const x1 = Math.max(p.x, q.x);
  const y0 = Math.min(p.y, q.y);
  const y1 = Math.max(p.y, q.y);
  return x1 > r.x + 2 && x0 < r.x + r.w - 2 && y1 > r.y + 2 && y0 < r.y + r.h - 2;
}

const POSITION: Record<Side, Position> = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left };

export function handlePoint(r: Rect, side: Side) {
  switch (side) {
    case 't': return { x: r.x + r.w / 2, y: r.y };
    case 'b': return { x: r.x + r.w / 2, y: r.y + r.h };
    case 'l': return { x: r.x, y: r.y + r.h / 2 };
    case 'r': return { x: r.x + r.w, y: r.y + r.h / 2 };
  }
}

function sidePolyline(a: Rect, as: Side, b: Rect, bs: Side): { x: number; y: number }[] {
  const s = handlePoint(a, as);
  const t = handlePoint(b, bs);
  const [d] = getSmoothStepPath({ sourceX: s.x, sourceY: s.y, targetX: t.x, targetY: t.y, sourcePosition: POSITION[as], targetPosition: POSITION[bs], borderRadius: 0 });
  const nums = (d.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

/** The smoothstep path React Flow will draw for this edge, as a polyline. */
export function edgePolyline(pe: PositionedEdge, rects: Map<string, Rect>): { x: number; y: number }[] {
  return sidePolyline(rects.get(pe.edge.source)!, pe.sourceHandle.slice(2) as Side, rects.get(pe.edge.target)!, pe.targetHandle.slice(2) as Side);
}

export const LABEL_H = 24;
export const labelWidth = (text: string) => Math.ceil(text.length * 6.7 + 22);

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Centre point for each edge label: the first spot along the path that covers
 * no workload, appliance, machine or company title, or other label.
 */
export function placeLabels(layout: GraphLayout, model: GraphModel, edgeIds: Iterable<string>): Map<string, { x: number; y: number }> {
  const obstacles = obstaclesOf(model, layout.rects);
  const wanted = new Set(edgeIds);
  const out = new Map<string, { x: number; y: number }>();
  const placed: Rect[] = [];
  for (const pe of layout.edges) {
    if (!wanted.has(pe.edge.id) || !pe.edge.label) continue;
    const pts = edgePolyline(pe, layout.rects);
    const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const total = lens.reduce((s, v) => s + v, 0);
    const at = (f: number) => {
      let d = f * total;
      for (let i = 0; i < lens.length; i++) {
        if (d <= lens[i] || i === lens.length - 1) {
          const k = lens[i] ? Math.min(1, d / lens[i]) : 0;
          return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
        }
        d -= lens[i];
      }
      return pts[0];
    };
    const w = labelWidth(pe.edge.label);
    const box = (p: { x: number; y: number }) => ({ x: p.x - w / 2, y: p.y - LABEL_H / 2, w, h: LABEL_H });
    let best: { x: number; y: number } | undefined;
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88]) {
      const p = at(f);
      const b = box(p);
      if (!obstacles.some((o) => overlaps(o, b)) && !placed.some((o) => overlaps(o, b))) {
        best = p;
        break;
      }
    }
    if (!best) {
      // Nudge vertically off the midpoint: first clear of everything, then clear of other labels.
      const m = at(0.5);
      const steps = [1, -1, 2, -2, 3, -3, 4, -4].map((k) => k * (LABEL_H + 4));
      const near = [0, ...steps].map((dy) => ({ x: m.x, y: m.y + dy }));
      best =
        near.find((p) => !obstacles.some((o) => overlaps(o, box(p))) && !placed.some((o) => overlaps(o, box(p)))) ??
        near.find((p) => !placed.some((o) => overlaps(o, box(p)))) ??
        m;
    }
    placed.push(box(best));
    out.set(pe.edge.id, best);
  }
  return out;
}
