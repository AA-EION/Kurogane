import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GLYPHS } from './glyphs';
import {
  type Coords, type Size, depthKey, footprintCenter, footprintCorners, groundMatrix, polygonPoints, tileToScreen,
} from './iso';
import { type Scene, type SceneConnector, type SceneNode, type SceneZone, connectorsFor } from './layout';

interface Props {
  scene: Scene;
  selected: string | null;
  onSelect: (id: string | null) => void;
  focus: { id: string; nonce: number } | null;
  dimmedTenants: Set<string>;
  inspectorInset?: number;
}

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_K = 0.15;
const MAX_K = 2.5;

// ------------------------------------------------------------------ colours

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const canvasSteel = () => getComputedStyle(document.documentElement).getPropertyValue('--steel').trim() || '#b4b2ac';

// ------------------------------------------------------------------- shapes

function blockFaces(tile: Coords, size: Size, z: number, height: number, inset: number) {
  const t = { x: tile.x + inset, y: tile.y + inset };
  const s = { w: size.w - inset * 2, h: size.h - inset * 2 };
  const top = footprintCorners(t, s, z + height);
  const bot = footprintCorners(t, s, z);
  // corners: 0 back, 1 right, 2 front, 3 left
  return {
    top,
    left: [top[3], top[2], bot[2], bot[3]],
    right: [top[2], top[1], bot[1], bot[2]],
    t,
    s,
  };
}

function Glyph({ name, x, y, size, color, opacity = 1 }: { name: string; x: number; y: number; size: number; color: string; opacity?: number }) {
  return (
    <path
      d={GLYPHS[name] ?? GLYPHS.server}
      transform={`translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})`}
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={opacity}
      pointerEvents="none"
    />
  );
}

interface BlockProps {
  steel: string;
  node: SceneNode;
  selected: boolean;
  hovered: boolean;
  dim: boolean;
  onEnter: (id: string) => void;
  onLeave: () => void;
  onClick: (id: string) => void;
}

/** A host slab, an appliance box, or a container standing on a slab. */
const Block = memo(function Block({ node, selected, hovered, dim, onEnter, onLeave, onClick, steel }: BlockProps) {
  const isItem = node.kind === 'service' || node.kind === 'proxy';
  const inset = isItem ? 0.17 : node.slab ? 0.04 : 0.12;
  const base = node.slab ? steel : isItem ? shade(node.accent, -0.62) : shade(node.accent, -0.7);
  const f = blockFaces(node.tile, node.size, node.z, node.height, inset);
  const lift = hovered && !node.slab ? -3 : 0;
  const topFill = node.slab ? shade(steel, 0.08) : shade(base, 0.25);
  const center = footprintCenter(f.t, f.s, node.z + node.height);
  const stripe = (pts: Coords[], frac: number) => {
    // Accent band along the top edge of a side face.
    const [a, b, c, d] = pts;
    const lerp = (p: Coords, q: Coords) => ({ x: p.x + (q.x - p.x) * frac, y: p.y + (q.y - p.y) * frac });
    return polygonPoints([a, b, lerp(b, c), lerp(a, d)]);
  };
  return (
    <g
      className={`iso-block ${dim ? 'dim' : ''} ${selected ? 'selected' : ''}`}
      transform={`translate(0 ${lift})`}
      onPointerEnter={() => onEnter(node.id)}
      onPointerLeave={onLeave}
      onClick={(e) => {
        e.stopPropagation();
        onClick(node.id);
      }}
      data-node={node.id}
    >
      <polygon points={polygonPoints(f.left)} fill={shade(base, -0.05)} />
      <polygon points={polygonPoints(f.right)} fill={shade(base, -0.32)} />
      {!node.slab && (
        <>
          <polygon points={stripe(f.left, 0.16)} fill={node.accent} opacity={0.85} />
          <polygon points={stripe(f.right, 0.16)} fill={shade(node.accent, -0.25)} opacity={0.85} />
          {node.ownerColor && (
            <>
              <polygon points={stripe([f.left[3], f.left[2], f.left[1], f.left[0]], 0.12)} fill={node.ownerColor} />
              <polygon points={stripe([f.right[3], f.right[2], f.right[1], f.right[0]], 0.12)} fill={shade(node.ownerColor, -0.2)} />
            </>
          )}
        </>
      )}
      <polygon
        points={polygonPoints(f.top)}
        fill={topFill}
        stroke={selected ? node.accent : hovered ? shade(node.accent, 0.2) : 'rgba(255,255,255,0.08)'}
        strokeWidth={selected ? 3 : 1.2}
        filter={selected ? 'url(#kg-glow)' : undefined}
      />
      {node.slab ? (
        <SlabTop node={node} t={f.t} s={f.s} />
      ) : (
        <Glyph name={node.glyph} x={center.x} y={center.y} size={isItem ? 26 : 30} color={node.accent} />
      )}
    </g>
  );
});

/** Host name and IP painted on the slab's front edge, lying on the surface. */
function SlabTop({ node, t, s }: { node: SceneNode; t: Coords; s: Size }) {
  const origin = tileToScreen({ x: t.x + 0.22, y: t.y + s.h - 0.36 }, node.z + node.height);
  return (
    <g transform={groundMatrix(origin)} pointerEvents="none">
      <text x={0} y={0} className="slab-label">
        {node.label}
      </text>
      {node.sublabel && (
        <text x={0} y={19} className="slab-sublabel">
          {node.sublabel}
        </text>
      )}
    </g>
  );
}

function ZoneFloor({ zone, dim, selected, onClick }: { zone: SceneZone; dim: boolean; selected: boolean; onClick: (id: string) => void }) {
  const size = { w: zone.to.x - zone.from.x, h: zone.to.y - zone.from.y };
  const corners = footprintCorners(zone.from, size, 0);
  const labelOrigin = tileToScreen({ x: zone.from.x + 0.6, y: zone.to.y - 0.6 });
  return (
    <g className={`zone ${dim ? 'dim' : ''}`} onClick={(e) => (e.stopPropagation(), onClick(zone.id))} data-node={zone.id}>
      <polygon
        points={polygonPoints(corners)}
        fill={zone.color}
        fillOpacity={selected ? 0.13 : 0.07}
        stroke={zone.color}
        strokeOpacity={selected ? 0.9 : 0.45}
        strokeWidth={selected ? 2.5 : 1.5}
        strokeDasharray={selected ? undefined : '10 7'}
      />
      <g transform={groundMatrix(labelOrigin)} pointerEvents="none">
        <text className="zone-label" fill={zone.color}>
          {zone.label.toUpperCase()}
        </text>
        <text className="zone-sublabel" y={34}>
          {zone.sublabel}
        </text>
      </g>
    </g>
  );
}

function connectorPoints(c: SceneConnector): Coords[] {
  if (c.points) return c.points;
  return (c.tiles ?? []).map((t) => tileToScreen({ x: t.x + 0.5, y: t.y + 0.5 }, c.z));
}

function pathD(pts: Coords[]): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

function Connector({ c, lit, dim }: { c: SceneConnector; lit: boolean; dim: boolean }) {
  const pts = connectorPoints(c);
  if (pts.length < 2) return null;
  const d = pathD(pts);
  const color = c.kind === 'parent' ? 'var(--text-3)' : c.kind === 'ingress' ? 'var(--ingress)' : c.secure ? 'var(--route)' : 'var(--warn)';
  const baseOpacity = dim ? 0.05 : c.kind === 'ingress' ? 0.16 : c.kind === 'parent' ? 0.45 : 0.4;
  return (
    <g className={`connector ${c.kind} ${lit ? 'lit' : ''}`} pointerEvents="none">
      {lit && <path d={d} stroke={color} strokeWidth={9} opacity={0.18} fill="none" strokeLinejoin="round" />}
      <path
        d={d}
        stroke={color}
        strokeWidth={c.kind === 'ingress' ? 2 : 3}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={lit ? 1 : baseOpacity}
        strokeDasharray={c.kind === 'parent' ? '6 6' : c.tunnel || c.kind === 'ingress' ? '2 7' : undefined}
      />
      {lit && <path d={d} className="flow" stroke={color} strokeWidth={3} fill="none" strokeLinejoin="round" />}
    </g>
  );
}

interface PlacedLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
}

/** Midpoint of each lit route's longest segment, nudged so labels never overlap. */
function placeLabels(conns: SceneConnector[]): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const H = 24;
  for (const c of conns) {
    const pts = connectorPoints(c);
    if (!c.label || pts.length < 2) continue;
    const segs = pts.slice(0, -1).map((p, i) => ({ i, len: Math.hypot(pts[i + 1].x - p.x, pts[i + 1].y - p.y) })).sort((a, b) => b.len - a.len);
    const w = c.label.length * 6.6 + 16;
    let best: PlacedLabel | null = null;
    for (const { i } of segs.slice(0, 3)) {
      const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
      for (const dy of [0, -H, H, -2 * H, 2 * H, -3 * H, 3 * H]) {
        const cand = { id: c.id, text: c.label, x: m.x, y: m.y + dy, w };
        const clash = placed.some((p) => Math.abs(p.x - cand.x) < (p.w + cand.w) / 2 + 4 && Math.abs(p.y - cand.y) < H);
        if (!clash) {
          best = cand;
          break;
        }
      }
      if (best) break;
    }
    placed.push(best ?? { id: c.id, text: c.label, x: pts[0].x, y: pts[0].y, w });
  }
  return placed;
}

function ConnectorLabels({ conns }: { conns: SceneConnector[] }) {
  return (
    <>
      {placeLabels(conns).map((l) => (
        <g key={l.id} transform={`translate(${l.x} ${l.y})`} pointerEvents="none" className="conn-label">
          <rect x={-l.w / 2} y={-11} width={l.w} height={22} rx={6} />
          <text textAnchor="middle" y={4}>
            {l.text}
          </text>
        </g>
      ))}
    </>
  );
}

/**
 * Level of detail: below OVERVIEW_K only machine names float above the scene
 * (counter-scaled so they stay legible); closer in, every workload is
 * labelled and badges/sublabels appear.
 */
const OVERVIEW_K = 0.55;

function NodeLabel({ node, k, show, focused }: { node: SceneNode; k: number; show: boolean; focused: boolean }) {
  if (!show || node.kind === 'internet' || node.kind === 'ip') return null;
  const overview = k < OVERVIEW_K;
  const isHost = node.kind === 'host';
  if (overview && !isHost && !focused) return null;
  if (!overview && node.slab) return null; // painted on the slab instead
  const detailed = focused || k >= 0.8;
  const scale = overview ? Math.min(OVERVIEW_K / k, 2.6) : 1;
  const p = node.slab ? footprintCenter(node.tile, node.size, node.z + node.height) : footprintCenter(node.tile, node.size, node.z + node.height);
  const lift = node.slab ? 18 : 30;
  const badges = detailed && !overview ? node.badges : node.badges.filter((b) => b.tone === 'warn' || b.tone === 'danger');
  return (
    <g transform={`translate(${p.x} ${p.y - lift}) scale(${scale})`} pointerEvents="none" className={`node-label ${node.slab ? 'host' : ''}`}>
      <text textAnchor="middle" className="nl-title" y={-8}>
        {node.label}
      </text>
      {(detailed || overview) && node.sublabel && (
        <text textAnchor="middle" className="nl-sub" y={6}>
          {node.sublabel}
        </text>
      )}
      {badges.length > 0 && <BadgeRow badges={badges} y={-38} />}
    </g>
  );
}

function BadgeRow({ badges, y }: { badges: SceneNode['badges']; y: number }) {
  const widths = badges.map((b) => b.label.length * 6 + (b.glyph === 'lock' ? 26 : 14));
  const total = widths.reduce((a, b) => a + b, 0) + (badges.length - 1) * 4;
  let x = -total / 2;
  return (
    <g transform={`translate(0 ${y})`}>
      {badges.map((b, i) => {
        const w = widths[i];
        const el = (
          <g key={i} transform={`translate(${x} 0)`} className={`badge tone-${b.tone}`}>
            <rect width={w} height={17} rx={8.5} />
            {b.glyph === 'lock' && <Glyph name="lock" x={11} y={8.5} size={11} color="currentColor" />}
            <text x={b.glyph === 'lock' ? 19 : 7} y={12.2}>
              {b.label}
            </text>
          </g>
        );
        x += w + 4;
        return el;
      })}
    </g>
  );
}

function InternetNode({ node, selected, onClick }: { node: SceneNode; selected: boolean; onClick: (id: string) => void }) {
  const p = node.screen!;
  return (
    <g transform={`translate(${p.x} ${p.y})`} className="internet" onClick={(e) => (e.stopPropagation(), onClick(node.id))} data-node={node.id}>
      <ellipse rx={92} ry={40} className="internet-halo" />
      <ellipse rx={62} ry={27} className="internet-core" stroke={selected ? '#ff7a45' : undefined} />
      <Glyph name="globe" x={0} y={-1} size={30} color="#f1f3f5" />
      <text y={-52} textAnchor="middle" className="nl-title">
        {node.label}
      </text>
      <text y={60} textAnchor="middle" className="nl-sub">
        {node.sublabel}
      </text>
    </g>
  );
}

function IpPin({ node, dim }: { node: SceneNode; dim: boolean }) {
  const p = tileToScreen(node.tile, node.z);
  return (
    <g transform={`translate(${p.x} ${p.y})`} className={`ip-pin ${dim ? 'dim' : ''}`} pointerEvents="none">
      <path d="M0 -9 L8 0 L0 9 L-8 0 Z" />
      <text x={13} y={4}>
        {node.label}
      </text>
    </g>
  );
}

function GroundGrid({ scene }: { scene: Scene }) {
  const { min, max } = scene.bounds;
  const lines: string[] = [];
  for (let x = min.x; x <= max.x; x++) {
    const a = tileToScreen({ x, y: min.y });
    const b = tileToScreen({ x, y: max.y });
    lines.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
  }
  for (let y = min.y; y <= max.y; y++) {
    const a = tileToScreen({ x: min.x, y });
    const b = tileToScreen({ x: max.x, y });
    lines.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
  }
  return <path d={lines.join('')} className="ground-grid" />;
}

export function sceneScreenBounds(scene: Scene) {
  const { min, max } = scene.bounds;
  const pts = [tileToScreen(min), tileToScreen({ x: max.x, y: min.y }), tileToScreen(max), tileToScreen({ x: min.x, y: max.y })];
  const inet = scene.byId.get('internet')?.screen;
  if (inet) pts.push({ x: inet.x, y: inet.y - 80 });
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

function nodeAnchor(scene: Scene, id: string): Coords | null {
  const n = scene.byId.get(id);
  if (n) return n.screen ?? footprintCenter(n.tile, n.size, n.z + n.height);
  const z = scene.zones.find((x) => x.id === id);
  if (z) return footprintCenter(z.from, { w: z.to.x - z.from.x, h: z.to.y - z.from.y });
  return null;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ----------------------------------------------------------------- canvas

export function IsoCanvas({ scene, selected, onSelect, focus, dimmedTenants, inspectorInset = 380 }: Props) {
  const [steel, setSteel] = useState(canvasSteel);
  useEffect(() => {
    const update = () => setSteel(canvasSteel());
    window.addEventListener('kurogane:appearance', update);
    return () => window.removeEventListener('kurogane:appearance', update);
  }, []);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 0.5 });
  const [hover, setHover] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const anim = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const animateTo = useCallback((target: View, ms = 480) => {
    if (anim.current) cancelAnimationFrame(anim.current);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setView(target); return; }
    const from = viewRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      setView({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e });
      if (t < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => { if (anim.current) cancelAnimationFrame(anim.current); }, []);

  const fit = useCallback(
    (animate: boolean) => {
      const el = svgRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const b = sceneScreenBounds(scene);
      const k = Math.max(MIN_K, Math.min(1.1, Math.min((width - 80) / (b.x1 - b.x0), (height - 80) / (b.y1 - b.y0))));
      const target = { k, x: width / 2 - ((b.x0 + b.x1) / 2) * k, y: height / 2 - ((b.y0 + b.y1) / 2) * k };
      if (animate) animateTo(target);
      else setView(target);
    },
    [scene, animateTo],
  );

  useLayoutEffect(() => fit(false), [fit]);
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    let previous = element.getBoundingClientRect();
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect();
      if (!previous.width || !previous.height) fit(false);
      else if (next.width !== previous.width || next.height !== previous.height) {
        if (anim.current) cancelAnimationFrame(anim.current);
        setView((value) => ({ ...value, x: value.x + (next.width - previous.width) / 2, y: value.y + (next.height - previous.height) / 2 }));
      }
      previous = next;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);
  useEffect(() => {
    const onFit = () => fit(true);
    window.addEventListener('kurogane:fit', onFit);
    return () => window.removeEventListener('kurogane:fit', onFit);
  }, [fit]);

  useEffect(() => {
    if (!focus) return;
    const el = svgRef.current;
    const p = nodeAnchor(scene, focus.id);
    if (!el || !p) return;
    const { width, height } = el.getBoundingClientRect();
    const isZone = focus.id.startsWith('tenant:');
    const k = isZone ? Math.max(0.55, Math.min(viewRef.current.k, 0.8)) : Math.max(viewRef.current.k, 1.05);
    // Web drawers overlay the scene; native inspectors occupy a separate pane.
    animateTo({ k, x: (width - inspectorInset) / 2 - p.x * k, y: height / 2 - p.y * k });
  }, [focus, scene, animateTo, inspectorInset]);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const el = svgRef.current!;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    setView((v) => {
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))));
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
    });
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const zoomBy = (f: number) => {
    const el = svgRef.current!;
    const { width, height } = el.getBoundingClientRect();
    const v = viewRef.current;
    const k = Math.max(MIN_K, Math.min(MAX_K, v.k * f));
    animateTo({ k, x: width / 2 - ((width / 2 - v.x) * k) / v.k, y: height / 2 - ((height / 2 - v.y) * k) / v.k }, 220);
  };

  const lit = useMemo(() => {
    const s = connectorsFor(scene, selected);
    for (const c of connectorsFor(scene, hover)) s.add(c);
    return s;
  }, [scene, selected, hover]);

  const slabs = useMemo(() => scene.nodes.filter((n) => n.kind === 'host' && n.slab).sort((a, b) => depthKey(a.tile, a.size) - depthKey(b.tile, b.size)), [scene]);
  const blocks = useMemo(
    () => scene.nodes.filter((n) => n.kind === 'service' || n.kind === 'proxy' || (n.kind === 'host' && !n.slab)).sort((a, b) => depthKey(a.tile, a.size, a.z) - depthKey(b.tile, b.size, b.z)),
    [scene],
  );
  const onEnter = useCallback((id: string) => setHover(id), []);
  const onLeave = useCallback(() => setHover(null), []);
  const isDim = (n: { tenantId?: string }) => !!n.tenantId && dimmedTenants.has(n.tenantId);
  const nodeDimById = (id: string) => {
    const n = scene.byId.get(id);
    return n ? isDim(n) : false;
  };

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className="iso-canvas"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          if (anim.current) cancelAnimationFrame(anim.current);
          setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
        }}
        onPointerUp={() => {
          setTimeout(() => (drag.current = null), 0);
        }}
        onClickCapture={(e) => {
          if (drag.current?.moved) e.stopPropagation();
        }}
        onClick={() => onSelect(null)}
      >
        <defs>
          <filter id="kg-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="kg-sky" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ff7a45" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#ff7a45" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <GroundGrid scene={scene} />
          {scene.zones.map((z) => (
            <ZoneFloor key={z.id} zone={z} dim={dimmedTenants.has(z.refId)} selected={selected === z.id} onClick={onSelect} />
          ))}
          {slabs.map((n) => (
            <Block key={n.id} steel={steel} node={n} selected={selected === n.id} hovered={hover === n.id} dim={isDim(n)} onEnter={onEnter} onLeave={onLeave} onClick={onSelect} />
          ))}
          {scene.connectors
            .filter((c) => c.kind !== 'ingress')
            .map((c) => (
              <Connector key={c.id} c={c} lit={lit.has(c.id)} dim={nodeDimById(c.to) && !lit.has(c.id)} />
            ))}
          {blocks.map((n) => (
            <Block key={n.id} steel={steel} node={n} selected={selected === n.id} hovered={hover === n.id} dim={isDim(n)} onEnter={onEnter} onLeave={onLeave} onClick={onSelect} />
          ))}
          {scene.connectors
            .filter((c) => c.kind === 'ingress')
            .map((c) => (
              <Connector key={c.id} c={c} lit={lit.has(c.id)} dim={nodeDimById(c.to) && !lit.has(c.id)} />
            ))}
          {scene.nodes
            .filter((n) => n.kind === 'ip')
            .map((n) => (
              <IpPin key={n.id} node={n} dim={isDim(n)} />
            ))}
          {[...slabs, ...blocks].map((n) => (
            <NodeLabel key={n.id} node={n} k={view.k} show={!isDim(n)} focused={selected === n.id || hover === n.id} />
          ))}
          {scene.nodes
            .filter((n) => n.kind === 'internet')
            .map((n) => (
              <g key={n.id}>
                <ellipse cx={n.screen!.x} cy={n.screen!.y} rx={240} ry={110} fill="url(#kg-sky)" pointerEvents="none" />
                <InternetNode node={n} selected={selected === n.id} onClick={onSelect} />
              </g>
            ))}
          <ConnectorLabels conns={scene.connectors.filter((c) => lit.has(c.id) && c.kind === 'route')} />
        </g>
      </svg>
      <div className="zoom-controls">
        <button title="Zoom in" onClick={() => zoomBy(1.3)}>
          <svg viewBox="0 0 24 24"><path d={GLYPHS.plus} /></svg>
        </button>
        <button title="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
          <svg viewBox="0 0 24 24"><path d={GLYPHS.minus} /></svg>
        </button>
        <button title="Fit to view" onClick={() => fit(true)}>
          <svg viewBox="0 0 24 24"><path d={GLYPHS.fit} /></svg>
        </button>
        <span className="zoom-readout">{Math.round(view.k * 100)}%</span>
      </div>
      <div className="legend">
        <span><i className="sw" style={{ background: 'var(--route)' }} />HTTPS route</span>
        <span><i className="sw dashed" />Tunnel / ingress</span>
        <span><i className="sw" style={{ background: '#868e96' }} />VM → hypervisor</span>
      </div>
    </div>
  );
}
