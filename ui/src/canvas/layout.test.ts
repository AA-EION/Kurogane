import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/demo-topology.json';
import type { Topology } from '../api/types';
import { buildIndex, search } from '../search/index';
import { fuzzyMatch } from '../search/fuzzy';
import { toFossflowModel } from './fossflowExport';
import { connectorsFor, layoutTopology } from './layout';
import { createGrid, block, findPath } from './pathfinder';
import { screenToTile, tileToScreen } from './iso';

const topo = fixture.topology as Topology;
const NOW = Date.parse('2026-10-06T00:00:00Z');

describe('iso projection', () => {
  it('round-trips and matches Isoflow tile size', () => {
    const p = tileToScreen({ x: 3, y: 5 });
    const back = screenToTile(p);
    expect(back.x).toBeCloseTo(3);
    expect(back.y).toBeCloseTo(5);
    expect(tileToScreen({ x: 1, y: 0 }).x).toBeCloseTo(141.5 / 2);
  });
});

describe('pathfinder', () => {
  it('routes orthogonally around obstacles', () => {
    const g = createGrid({ x: 0, y: 0 }, { x: 9, y: 9 });
    for (let y = 0; y < 8; y++) block(g, { x: 5, y });
    const path = findPath(g, { x: 0, y: 0 }, { x: 9, y: 0 })!;
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path.at(-1)).toEqual({ x: 9, y: 0 });
    for (let i = 1; i < path.length; i++) {
      const d = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
      expect(d).toBe(1);
    }
    expect(path.some((t) => t.x === 5 && t.y < 8)).toBe(false);
  });
});

describe('auto layout', () => {
  const scene = layoutTopology(topo, NOW);

  it('places every record and never overlaps items', () => {
    expect(scene.zones).toHaveLength(topo.tenants.length);
    for (const h of topo.hosts) expect(scene.refToNode.get(h.id)).toBeDefined();
    for (const s of topo.services) expect(scene.refToNode.get(s.id)).toBeDefined();
    const taken = new Set<string>();
    for (const n of scene.nodes.filter((n) => n.kind === 'service' || n.kind === 'proxy' || (n.kind === 'host' && !n.slab))) {
      const key = `${n.tile.x},${n.tile.y}`;
      expect(taken.has(key)).toBe(false);
      taken.add(key);
    }
  });

  it('keeps hosts inside their tenant zone and services on their host', () => {
    for (const n of scene.nodes.filter((n) => n.kind === 'host')) {
      const z = scene.zones.find((z) => z.refId === n.tenantId)!;
      expect(n.tile.x).toBeGreaterThanOrEqual(z.from.x);
      expect(n.tile.y).toBeGreaterThanOrEqual(z.from.y);
      expect(n.tile.x + n.size.w).toBeLessThanOrEqual(z.to.x);
      expect(n.tile.y + n.size.h).toBeLessThanOrEqual(z.to.y);
    }
    for (const n of scene.nodes.filter((n) => n.kind === 'service')) {
      const h = scene.byId.get(`host:${n.hostId}`)!;
      expect(n.tile.x).toBeGreaterThan(h.tile.x);
      expect(n.tile.x).toBeLessThan(h.tile.x + h.size.w);
    }
  });

  it('draws a full trace Internet → proxy → service for every route', () => {
    const routes = topo.proxies.flatMap((p) => p.routes);
    for (const r of routes) {
      const trace = scene.routeTrace.get(r.id)!;
      expect(trace[0]).toMatch(/^ingress:/);
      expect(trace.at(-1)).toBe(`route:${r.id}`);
    }
    const gitea = scene.refToNode.get(topo.services.find((s) => s.name === 'gitea')!.id)!;
    const lit = connectorsFor(scene, gitea);
    expect([...lit].some((c) => c.startsWith('ingress:'))).toBe(true);
    expect([...lit].some((c) => c.startsWith('route:'))).toBe(true);
  });

  it('flags TLS certificates close to expiry', () => {
    const shop = scene.byId.get(scene.refToNode.get(topo.services.find((s) => s.name === 'odoo')!.id)!)!;
    expect(shop.badges.some((b) => b.tone === 'warn')).toBe(true);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(layoutTopology(topo, NOW).nodes)).toBe(JSON.stringify(scene.nodes));
  });

  it('exports a FossFLOW model', () => {
    const m = toFossflowModel(topo, scene);
    expect(m.views[0].items.length).toBe(m.items.length);
    const ids = new Set(m.items.map((i) => i.id));
    for (const c of m.views[0].connectors) for (const a of c.anchors) expect(ids.has(a.ref.item!)).toBe(true);
    expect(JSON.stringify(m)).not.toContain('Tama-hagane');
  });
});

describe('omnibox search', () => {
  const scene = layoutTopology(topo, NOW);
  const index = buildIndex(topo, scene);

  it('finds by IP, port, domain and company', () => {
    expect(search(index, '10.10.0.21')[0].title).toBe('10.10.0.21');
    expect(search(index, '8081').some((h) => h.title === 'gitea')).toBe(true);
    expect(search(index, 'git.corp')[0].kind).toBe('route');
    expect(search(index, 'alpha')[0].title).toBe('Client Alpha');
    expect(search(index, 'jlfn').some((h) => h.title === 'jellyfin')).toBe(true);
  });

  it('scores contiguous matches above scattered ones', () => {
    expect(fuzzyMatch('graf', 'grafana')!.score).toBeGreaterThan(fuzzyMatch('graf', 'g-r-a-f')!.score);
    expect(fuzzyMatch('xyz', 'grafana')).toBeNull();
  });
});
