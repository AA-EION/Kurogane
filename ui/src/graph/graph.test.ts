import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/demo-topology.json';
import type { Topology } from '../api/types';
import { buildIndex, search } from '../search/index';
import { fuzzyMatch } from '../search/fuzzy';
import { buildGraph } from './build';
import { type Rect, layoutGraph, placeLabels } from './layout';
import { litEdges, litNodes } from './trace';

const topo = fixture.topology as Topology;
const NOW = Date.parse('2026-10-06T00:00:00Z');
const model = buildGraph(topo, NOW);
const layout = layoutGraph(model);
const svc = (name: string) => topo.services.find((s) => s.name === name)!;
const nodeFor = (ref: string) => model.byId.get(model.refToNode.get(ref)!)!;

describe('graph model', () => {
  it('has a node for every company, machine, service and proxy', () => {
    expect(model.byId.get('internet')?.kind).toBe('internet');
    for (const t of topo.tenants) expect(model.byId.get(`tenant:${t.id}`)?.kind).toBe('tenant');
    for (const h of topo.hosts) expect(model.byId.get(`host:${h.id}`)?.kind).toBe('host');
    for (const s of topo.services) expect(model.refToNode.get(s.id)).toMatch(/^svc:/);
    for (const p of topo.proxies) expect(model.byId.has(model.refToNode.get(p.id)!)).toBe(true);
  });

  it('resolves every record id and route id', () => {
    const ids = [...topo.tenants, ...topo.hosts, ...topo.services, ...topo.proxies].map((r) => r.id);
    for (const id of ids) expect(model.byId.has(model.refToNode.get(id) ?? ''), id).toBe(true);
    for (const r of topo.proxies.flatMap((p) => p.routes)) {
      const target = model.refToNode.get(r.id);
      expect(target).toBe(model.refToNode.get(r.serviceId ?? r.targetHostId ?? ''));
    }
  });

  it('orders parents before children', () => {
    const seen = new Set<string>();
    for (const n of model.nodes) {
      if (n.parentId) expect(seen.has(n.parentId), n.id).toBe(true);
      seen.add(n.id);
    }
    const pos = new Map(layout.nodes.map((n, i) => [n.id, i]));
    for (const n of layout.nodes) if (n.parentId) expect(pos.get(n.parentId)!).toBeLessThan(pos.get(n.id)!);
  });

  it('flags TLS certificates close to expiry and expired', () => {
    expect(nodeFor(svc('odoo').id).badges.some((b) => b.kind === 'tlsWarn' && b.tone === 'warn')).toBe(true);
    const all = model.nodes.flatMap((n) => n.badges);
    expect(all.some((b) => b.kind === 'tlsWarn')).toBe(true);
  });

  it('marks services owned by another company', () => {
    const odoo = svc('odoo');
    const hostTenant = topo.hosts.find((h) => h.id === odoo.hostId)!.tenantId;
    const owner = topo.tenants.find((t) => t.id !== hostTenant)!;
    const owned = { ...topo, services: topo.services.map((s) => (s.id === odoo.id ? { ...s, ownerTenantId: owner.id } : s)) };
    const m = buildGraph(owned, NOW);
    const node = m.byId.get(m.refToNode.get(odoo.id)!)!;
    expect(node.badges[0]).toMatchObject({ kind: 'owner', label: owner.name });
    expect(node.ownerColor).toBe(owner.color);
    expect(node.tenantId).toBe(hostTenant);
  });

  it('never carries secrets', () => {
    expect(JSON.stringify([...model.nodes, ...model.edges])).not.toContain('Tama-hagane');
  });
});

const within = (c: Rect, p: Rect) => c.x >= p.x && c.y >= p.y && c.x + c.w <= p.x + p.w && c.y + c.h <= p.y + p.h;

describe('layout', () => {
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('keeps every child inside its parent', () => {
    for (const n of model.nodes) if (n.parentId) expect(within(layout.rects.get(n.id)!, layout.rects.get(n.parentId)!), n.id).toBe(true);
  });

  it('never overlaps siblings', () => {
    const groups = new Map<string, string[]>();
    for (const n of model.nodes) groups.set(n.parentId ?? '', [...(groups.get(n.parentId ?? '') ?? []), n.id]);
    for (const ids of groups.values())
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) expect(overlap(layout.rects.get(ids[i])!, layout.rects.get(ids[j])!), `${ids[i]} × ${ids[j]}`).toBe(false);
  });

  it('places the Internet above every company', () => {
    const inet = layout.rects.get('internet')!;
    for (const n of model.nodes.filter((n) => n.kind === 'tenant')) expect(layout.rects.get(n.id)!.y).toBeGreaterThan(inet.y + inet.h);
  });

  it('enters proxies from the top for ingress', () => {
    for (const e of layout.edges.filter((e) => e.edge.kind === 'ingress')) expect(e.targetHandle).toBe('t-t');
  });

  it('is deterministic', () => {
    const again = layoutGraph(buildGraph(topo, NOW));
    expect(JSON.stringify(again.nodes)).toBe(JSON.stringify(layout.nodes));
    expect(JSON.stringify(again.edges)).toBe(JSON.stringify(layout.edges));
  });

  it('places labels for lit edges without stacking them', () => {
    const ids = model.edges.filter((e) => e.kind === 'route').map((e) => e.id);
    const spots = placeLabels(layout, model, ids);
    expect(spots.size).toBe(ids.length);
  });

  it('renders a company with no machines as an empty group', () => {
    const t = { ...topo.tenants[0], id: 'empty-co', name: 'Empty Co' };
    const m = buildGraph({ ...topo, tenants: [...topo.tenants, t] }, NOW);
    const l = layoutGraph(m);
    const r = l.rects.get('tenant:empty-co')!;
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
    expect(m.byId.get('tenant:empty-co')!.sublabel).toContain('0 machines');
  });
});

describe('scale', () => {
  it('lays out 200 machines and 1,000 services without overlaps', () => {
    const tenants = Array.from({ length: 8 }, (_, t) => ({ ...topo.tenants[0], id: `t${t}`, name: `Company ${t}` }));
    const hosts = Array.from({ length: 200 }, (_, h) => ({ ...topo.hosts[0], id: `h${h}`, tenantId: `t${h % 8}`, parentHostId: null, name: `host-${h}` }));
    const services = Array.from({ length: 1000 }, (_, i) => ({ ...topo.services[0], id: `s${i}`, hostId: `h${i % 200}`, name: `svc-${i}`, ownerTenantId: null }));
    const big: Topology = { ...topo, tenants, hosts, services, proxies: [], networks: [], credentials: [] };
    const started = performance.now();
    const m = buildGraph(big, NOW);
    const l = layoutGraph(m);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(l.nodes).toHaveLength(1 + 8 + 200 + 1000);
    for (const n of m.nodes) if (n.parentId) expect(within(l.rects.get(n.id)!, l.rects.get(n.parentId)!)).toBe(true);
  });
});

describe('tracing', () => {
  it('builds Internet → ingress → proxy → route for every route', () => {
    for (const p of topo.proxies)
      for (const r of p.routes) {
        const trace = model.routeTrace.get(r.id)!;
        expect(trace[0]).toBe(`ingress:${p.id}`);
        expect(trace.at(-1)).toBe(`route:${r.id}`);
        const ingress = model.edges.find((e) => e.id === trace[0])!;
        expect(ingress.source).toBe('internet');
        expect(ingress.target).toBe(model.refToNode.get(p.id));
      }
  });

  it('lights only gitea’s chain, without fanning out through a shared ingress', () => {
    const gitea = model.refToNode.get(svc('gitea').id)!;
    const lit = litEdges(model, gitea);
    const routes = topo.proxies.flatMap((p) => p.routes.map((r) => ({ r, p }))).filter(({ r }) => r.serviceId === svc('gitea').id);
    expect(routes.length).toBeGreaterThan(0);
    const expected = new Set(routes.flatMap(({ r }) => model.routeTrace.get(r.id)!));
    expect(lit).toEqual(expected);
    // The proxy behind gitea publishes other routes too; none of them light up.
    const proxy = routes[0].p;
    expect(proxy.routes.length).toBeGreaterThan(1);
    for (const r of proxy.routes) if (r.serviceId !== svc('gitea').id) expect(lit.has(`route:${r.id}`)).toBe(false);
    const nodes = litNodes(model, gitea, lit);
    expect(nodes.has('internet')).toBe(true);
    expect(nodes.has(model.refToNode.get(proxy.id)!)).toBe(true);
  });

  it('lights all ingress edges from the Internet', () => {
    const lit = litEdges(model, 'internet');
    expect(lit).toEqual(new Set(model.edges.filter((e) => e.kind === 'ingress').map((e) => e.id)));
  });

  it('lights the edges of a machine’s workloads and a company’s members', () => {
    const proxyHost = topo.proxies[0].hostId;
    const lit = litEdges(model, `host:${proxyHost}`);
    expect([...lit].some((id) => id.startsWith('route:'))).toBe(true);
    const tenant = topo.hosts.find((h) => h.id === proxyHost)!.tenantId;
    for (const id of lit) expect(litEdges(model, `tenant:${tenant}`).has(id)).toBe(true);
  });
});

describe('omnibox search', () => {
  const index = buildIndex(topo, model);

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
