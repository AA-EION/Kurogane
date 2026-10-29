import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/multi-company.json';
import type { Topology } from '../api/types';
import { buildGraph } from './build';
import { focusCompany } from './filter';
import { type Rect, layoutGraph } from './layout';

const topo = fixture.topology as Topology;
const model = buildGraph(topo, Date.parse('2026-10-29T00:00:00Z'));
const tenant = (name: string) => topo.tenants.find((t) => t.name === name)!;
const ref = (name: string) => model.refToNode.get(topo.services.find((s) => s.name === name)!.id)!;
const host = (name: string) => `host:${topo.hosts.find((h) => h.name === name)!.id}`;
const northwind = tenant('Northwind Logistics');
const view = focusCompany(model, northwind.id);

describe('company filter', () => {
  it('keeps the company with everything on its machines', () => {
    for (const h of topo.hosts.filter((h) => h.tenantId === northwind.id)) expect(view.byId.has(`host:${h.id}`)).toBe(true);
    for (const s of topo.services.filter((s) => topo.hosts.find((h) => h.id === s.hostId)!.tenantId === northwind.id)) expect(view.byId.has(model.refToNode.get(s.id)!)).toBe(true);
    // Atlas's licence server runs on Northwind's machine, so it stays — but Atlas itself does not appear.
    expect(view.byId.get(ref('license-server'))?.context).toBeFalsy();
    expect(view.byId.has(`tenant:${tenant('Atlas Engineering').id}`)).toBe(false);
  });

  it('shows another company only where this company depends on it', () => {
    const bluefin = `tenant:${tenant('Bluefin Dental').id}`;
    // tracking-api (Northwind's) runs on bluefin-app and is published by Bluefin's proxy on bluefin-edge.
    expect(view.byId.get(ref('tracking-api'))?.context).toBeFalsy();
    expect(view.byId.get(host('bluefin-app'))?.context).toBe(true);
    expect(view.byId.get(host('bluefin-edge'))?.context).toBe(true);
    expect(view.byId.get(bluefin)?.sublabel).toBe('Context · 2 of 4 machines');
    expect(view.children.get(host('bluefin-app'))).toEqual([ref('tracking-api')]);
    expect(view.byId.has(ref('pms'))).toBe(false);
    expect(view.byId.has(host('bluefin-fw'))).toBe(false);
    for (const name of ['Kestrel Legal', 'Orchard Bakery']) expect(view.byId.has(`tenant:${tenant(name).id}`)).toBe(false);
  });

  it('keeps the trace from the Internet to its hosted service', () => {
    const route = topo.proxies.flatMap((p) => p.routes).find((r) => r.serviceId === topo.services.find((s) => s.name === 'tracking-api')!.id)!;
    const trace = view.routeTrace.get(route.id)!;
    expect(trace).toHaveLength(2);
    for (const id of trace) expect(view.edges.some((e) => e.id === id)).toBe(true);
    for (const e of view.edges) expect(view.byId.has(e.source) && view.byId.has(e.target)).toBe(true);
  });

  it('lays out the slice with every child inside its parent', () => {
    const layout = layoutGraph(view);
    const inside = (c: Rect, p: Rect) => c.x >= p.x && c.y >= p.y && c.x + c.w <= p.x + p.w && c.y + c.h <= p.y + p.h;
    for (const n of view.nodes) if (n.parentId) expect(inside(layout.rects.get(n.id)!, layout.rects.get(n.parentId)!)).toBe(true);
    expect(layout.nodes.length).toBe(view.nodes.length);
  });

  it('returns the full graph for an unknown company', () => {
    expect(focusCompany(model, 'missing')).toBe(model);
  });
});
