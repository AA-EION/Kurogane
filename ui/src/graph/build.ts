/**
 * Topology → graph model. No manual diagramming: the relational model
 * already encodes the picture.
 *
 *   Company ──contains──► Machine ──runs──► Service / Proxy
 *   Internet ──ingress──► Proxy ──route──► Service (or machine)
 *   VM ──parent──► Hypervisor
 *
 * Output order is deterministic (sorted inputs, no randomness) so the same
 * vault draws the same graph on every machine. Parents always precede their
 * children, as React Flow sub-flows require.
 */

import type { Host, ProxyRoute, ReverseProxy, Service, Topology } from '../api/types';
import {
  ACCENT, type Badge, CATEGORY_ORDER, DEFAULT_TENANT_COLOR, type Glyph, describeProxy, describeService, hostBadges, hostGlyph,
  hostSublabel, ingressText, isTunnel, routeLabel, tenantSublabel,
} from './describe';

export type NodeKind = 'internet' | 'tenant' | 'host' | 'service' | 'proxy';

export interface GraphNode {
  /** `internet`, `tenant:<id>`, `host:<id>`, `svc:<id>` or `proxy:<id>`. */
  id: string;
  kind: NodeKind;
  /** Primary record id (tenant/host/service/proxy id; `internet` for the Internet). */
  refId: string;
  tenantId?: string;
  hostId?: string;
  /** Containing node: company for machines, machine for workloads. */
  parentId?: string;
  label: string;
  sublabel?: string;
  glyph: Glyph;
  accent: string;
  badges: Badge[];
  /** Company colour (companies and their members). */
  color?: string;
  /** Owning company's colour when the service belongs to another company. */
  ownerColor?: string;
  /** Owning company when it differs from the machine's company. */
  ownerTenantId?: string;
  /** Drawn only as context for another company's filtered view. */
  context?: boolean;
  /** Machine with no workloads (switch, AP, NVR…): drawn as a compact leaf. */
  appliance?: boolean;
  /** Direct children: machines in a company, workloads on a machine. */
  count?: number;
  /** Screen-reader description. */
  ariaLabel: string;
}

export type EdgeKind = 'ingress' | 'route' | 'parent';

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  routeIds: string[];
  label?: string;
  secure: boolean;
  tunnel?: boolean;
}

/** What the drawer, sidebar, search and focus-after-save need from the graph. */
export interface GraphIndex {
  byId: Map<string, GraphNode>;
  /** record id (tenant/host/service/proxy/route) → node id. A route resolves to its target. */
  refToNode: Map<string, string>;
  /** route id → edge ids forming its full trace, ingress first. */
  routeTrace: Map<string, string[]>;
}

export interface GraphModel extends GraphIndex {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** parent node id → child node ids, in layout order. */
  children: Map<string, string[]>;
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

interface HostItem {
  id: string;
  name: string;
  service?: Service;
  proxy?: ReverseProxy;
}

export const tenantNodeId = (id: string) => `tenant:${id}`;
export const hostNodeId = (id: string) => `host:${id}`;
const itemNodeId = (it: HostItem) => (it.service ? `svc:${it.id}` : `proxy:${it.id}`);

export function buildGraph(topo: Topology, now = Date.now()): GraphModel {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const refToNode = new Map<string, string>();
  const routeTrace = new Map<string, string[]>();
  const children = new Map<string, string[]>();

  const tenantById = new Map(topo.tenants.map((t) => [t.id, t]));
  const hostsByTenant = new Map<string, Host[]>();
  for (const h of topo.hosts) push(hostsByTenant, h.tenantId, h);
  const servicesByHost = new Map<string, Service[]>();
  for (const s of topo.services) push(servicesByHost, s.hostId, s);
  const proxyByService = new Map<string, ReverseProxy>();
  const standaloneProxiesByHost = new Map<string, ReverseProxy[]>();
  for (const p of topo.proxies) {
    if (p.serviceId) proxyByService.set(p.serviceId, p);
    else push(standaloneProxiesByHost, p.hostId, p);
  }
  const proxyHosts = new Set(topo.proxies.map((p) => p.hostId));
  const routesByService = new Map<string, ProxyRoute[]>();
  for (const p of topo.proxies) for (const r of p.routes) if (r.serviceId) push(routesByService, r.serviceId, r);

  // Proxies first on every machine, then services by name.
  const itemsOf = (h: Host): HostItem[] => {
    const svcs = [...(servicesByHost.get(h.id) ?? [])].sort(
      (a, b) => (proxyByService.has(a.id) ? 0 : 1) - (proxyByService.has(b.id) ? 0 : 1) || a.name.localeCompare(b.name),
    );
    return [
      ...[...(standaloneProxiesByHost.get(h.id) ?? [])].sort(byName).map((p) => ({ id: p.id, name: p.name, proxy: p })),
      ...svcs.map((s) => ({ id: s.id, name: s.name, service: s, proxy: proxyByService.get(s.id) })),
    ];
  };

  // Proxy machines first, then by category; VMs right after their hypervisor.
  const orderHosts = (hosts: Host[]): Host[] => {
    const rank = (h: Host) => (proxyHosts.has(h.id) ? -1 : CATEGORY_ORDER[h.category] ?? 99);
    const sorted = [...hosts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const order = new Map(sorted.map((h, i) => [h.id, i]));
    const key = (h: Host) => (h.parentHostId && order.has(h.parentHostId) ? order.get(h.parentHostId)! + 0.5 + order.get(h.id)! / 1e4 : order.get(h.id)!);
    return sorted.sort((a, b) => key(a) - key(b));
  };

  const routeCount = topo.proxies.reduce((s, p) => s + p.routes.length, 0);
  nodes.push({
    id: 'internet',
    kind: 'internet',
    refId: 'internet',
    label: 'Public Internet',
    sublabel: `${routeCount} published route${routeCount === 1 ? '' : 's'}`,
    glyph: 'globe',
    accent: ACCENT.internet,
    badges: [],
    ariaLabel: `Public Internet, ${routeCount} published routes`,
  });

  for (const tenant of [...topo.tenants].sort((a, b) => byName(a, b) || a.id.localeCompare(b.id))) {
    const tid = tenantNodeId(tenant.id);
    const color = tenant.color ?? DEFAULT_TENANT_COLOR;
    const hosts = orderHosts(hostsByTenant.get(tenant.id) ?? []);
    const sublabel = tenantSublabel(tenant, hosts.length);
    nodes.push({
      id: tid, kind: 'tenant', refId: tenant.id, tenantId: tenant.id, label: tenant.name, sublabel,
      glyph: 'shield', accent: color, color, badges: [], count: hosts.length, ariaLabel: `Company ${tenant.name}, ${sublabel}`,
    });
    refToNode.set(tenant.id, tid);

    for (const host of hosts) {
      const hid = hostNodeId(host.id);
      const items = itemsOf(host);
      const sub = hostSublabel(host);
      push(children, tid, hid);
      nodes.push({
        id: hid,
        kind: 'host',
        refId: host.id,
        tenantId: tenant.id,
        hostId: host.id,
        parentId: tid,
        label: host.name,
        sublabel: sub,
        glyph: hostGlyph(host),
        accent: items.length ? ACCENT.host : ACCENT.appliance,
        color,
        badges: hostBadges(host),
        appliance: items.length === 0,
        count: items.length,
        ariaLabel: `Machine ${host.name}${sub ? `, ${sub}` : ''}, ${tenant.name}`,
      });
      refToNode.set(host.id, hid);

      for (const it of items) {
        const id = itemNodeId(it);
        const owner = it.service?.ownerTenantId && it.service.ownerTenantId !== tenant.id ? tenantById.get(it.service.ownerTenantId) : undefined;
        const d = it.proxy
          ? describeProxy(it.proxy, host, it.name)
          : describeService(it.service!, host, routesByService.get(it.id) ?? [], owner, now);
        const kind = it.proxy ? 'proxy' : 'service';
        push(children, hid, id);
        nodes.push({
          id, kind, refId: it.id, tenantId: tenant.id, hostId: host.id, parentId: hid, color, ...d, ...(owner ? { ownerTenantId: owner.id } : {}),
          ariaLabel: `${kind === 'proxy' ? 'Proxy' : 'Service'} ${d.label}${d.sublabel ? `, ${d.sublabel}` : ''}, on ${host.name}${owner ? `, owned by ${owner.name}` : ''}`,
        });
        refToNode.set(it.id, id);
        if (it.proxy) refToNode.set(it.proxy.id, id);
      }
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const svcById = new Map(topo.services.map((s) => [s.id, s]));
  const hostById = new Map(topo.hosts.map((h) => [h.id, h]));
  const proxies = [...topo.proxies].sort((a, b) => byName(a, b) || a.id.localeCompare(b.id));

  // Internet → proxy, through the machine's public IP or the Cloudflare edge.
  for (const px of proxies) {
    const pid = refToNode.get(px.id);
    const host = hostById.get(px.hostId);
    if (!pid || !host) continue;
    const id = `ingress:${px.id}`;
    edges.push({ id, kind: 'ingress', source: 'internet', target: pid, routeIds: px.routes.map((r) => r.id), label: ingressText(px, host), secure: true, tunnel: isTunnel(px) });
    for (const r of px.routes) routeTrace.set(r.id, [id]);
  }

  // Proxy → target service (or machine). Routes whose target is missing are skipped.
  for (const px of proxies) {
    const from = refToNode.get(px.id);
    if (!from) continue;
    for (const r of px.routes) {
      const targetRef = r.serviceId ?? r.targetHostId;
      const to = targetRef ? refToNode.get(targetRef) : undefined;
      if (!to || to === from) continue;
      const id = `route:${r.id}`;
      edges.push({
        id, kind: 'route', source: from, target: to, routeIds: [r.id],
        label: routeLabel(r, r.serviceId ? svcById.get(r.serviceId) : undefined),
        secure: r.inboundProtocol === 'https', tunnel: isTunnel(px),
      });
      routeTrace.set(r.id, [...(routeTrace.get(r.id) ?? []), id]);
      refToNode.set(r.id, to);
    }
  }

  // VM → hypervisor.
  for (const h of [...topo.hosts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!h.parentHostId || !byId.has(hostNodeId(h.parentHostId))) continue;
    edges.push({ id: `parent:${h.id}`, kind: 'parent', source: hostNodeId(h.id), target: hostNodeId(h.parentHostId), routeIds: [], secure: false });
  }

  return { nodes, edges, byId, refToNode, routeTrace, children };
}
