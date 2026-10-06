import type { Topology } from '../api/types';
import type { Scene } from '../canvas/layout';
import { primaryIp } from '../canvas/layout';
import { bestOf } from './fuzzy';

export type HitKind = 'tenant' | 'host' | 'service' | 'proxy' | 'route' | 'network' | 'credential' | 'ip';

export interface SearchEntry {
  kind: HitKind;
  /** Scene node or zone to focus. */
  target: string;
  title: string;
  subtitle: string;
  fields: string[];
}

export interface SearchHit extends SearchEntry {
  score: number;
  indices: number[];
  field: number;
}

/** Everything the omnibox can find: companies, IPs, ports, domains, services, credential labels. */
export function buildIndex(topo: Topology, scene: Scene): SearchEntry[] {
  const node = (ref: string) => scene.refToNode.get(ref);
  const tenantName = new Map(topo.tenants.map((t) => [t.id, t.name]));
  const hostById = new Map(topo.hosts.map((h) => [h.id, h]));
  const out: SearchEntry[] = [];
  for (const t of topo.tenants)
    out.push({ kind: 'tenant', target: node(t.id)!, title: t.name, subtitle: t.environmentLabel ?? t.environment, fields: [t.name, t.environmentLabel ?? '', t.environment] });
  for (const h of topo.hosts) {
    const ips = h.interfaces.flatMap((n) => [n.internalIp, n.publicIp]).filter(Boolean) as string[];
    out.push({
      kind: 'host',
      target: node(h.id)!,
      title: h.name,
      subtitle: `${tenantName.get(h.tenantId)} · ${[primaryIp(h), h.provider].filter(Boolean).join(' · ')}`,
      fields: [h.name, ...ips, h.fqdn ?? '', h.category, h.provider ?? ''],
    });
    for (const n of h.interfaces)
      for (const ip of [n.internalIp, n.publicIp])
        if (ip) out.push({ kind: 'ip', target: node(h.id)!, title: ip, subtitle: `${h.name} · ${n.name}${n.publicIp === ip ? ' · public' : ''}`, fields: [ip] });
  }
  for (const s of topo.services) {
    const h = hostById.get(s.hostId);
    const ports = s.ports.flatMap((p) => [String(p.containerPort), p.hostPort ? String(p.hostPort) : '']).filter(Boolean);
    out.push({
      kind: 'service',
      target: node(s.id)!,
      title: s.name,
      subtitle: `${h?.name} · ${s.runtime}${s.ports[0] ? ` · ${s.ports.map((p) => (p.hostPort ? `${p.hostPort}→${p.containerPort}` : `${p.containerPort}`)).join(', ')}` : ''}`,
      fields: [s.name, s.image ?? '', ...ports, ports.map((p) => `:${p}`).join(' ')],
    });
  }
  for (const p of topo.proxies) {
    out.push({ kind: 'proxy', target: node(p.id)!, title: p.name, subtitle: `${p.kind} · ${p.routes.length} routes`, fields: [p.name, p.kind] });
    for (const r of p.routes)
      out.push({
        kind: 'route',
        target: node(r.id) ?? node(p.id)!,
        title: r.domain,
        subtitle: `:${r.inboundPort} → ${r.targetIp}:${r.targetPort}`,
        fields: [r.domain, `${r.targetIp}:${r.targetPort}`, String(r.targetPort)],
      });
  }
  for (const n of topo.networks)
    out.push({ kind: 'network', target: node(n.tenantId)!, title: n.cidr, subtitle: `${n.name} · ${tenantName.get(n.tenantId)}${n.vlanId ? ` · VLAN ${n.vlanId}` : ''}`, fields: [n.cidr, n.name] });
  for (const c of topo.credentials)
    out.push({ kind: 'credential', target: node(c.owner.id) ?? '', title: c.label, subtitle: `${c.kind}${c.username ? ` · ${c.username}` : ''}`, fields: [c.label, c.username ?? '', c.kind] });
  return out.filter((e) => e.target);
}

/** Broader entities win ties: "alpha" should surface the company before its hosts. */
const KIND_WEIGHT: Record<HitKind, number> = { tenant: 12, host: 4, service: 4, proxy: 3, route: 3, ip: 5, network: 0, credential: -2 };

export function search(index: SearchEntry[], query: string, limit = 40): SearchHit[] {
  if (!query.trim()) return [];
  const hits: SearchHit[] = [];
  for (const e of index) {
    const m = bestOf(query, e.fields);
    if (m) hits.push({ ...e, ...m, score: m.score + KIND_WEIGHT[e.kind] });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
