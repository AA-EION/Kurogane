import type { CredentialMeta, Host, ProxyRoute, ReverseProxy, Service, Tenant, Topology } from './api/types';
import { primaryIp, publicIp } from './canvas/layout';

/** Indexed view over a topology for the drawer and the operations HUD. */
export interface Lookup {
  topo: Topology;
  tenant: Map<string, Tenant>;
  host: Map<string, Host>;
  service: Map<string, Service>;
  proxy: Map<string, ReverseProxy>;
  proxyByService: Map<string, ReverseProxy>;
  routesToService: Map<string, { route: ProxyRoute; proxy: ReverseProxy }[]>;
  credsByOwner: Map<string, CredentialMeta[]>;
}

export function buildLookup(topo: Topology): Lookup {
  const routesToService = new Map<string, { route: ProxyRoute; proxy: ReverseProxy }[]>();
  for (const p of topo.proxies)
    for (const r of p.routes) if (r.serviceId) routesToService.set(r.serviceId, [...(routesToService.get(r.serviceId) ?? []), { route: r, proxy: p }]);
  const credsByOwner = new Map<string, CredentialMeta[]>();
  for (const c of topo.credentials) credsByOwner.set(c.owner.id, [...(credsByOwner.get(c.owner.id) ?? []), c]);
  return {
    topo,
    tenant: new Map(topo.tenants.map((t) => [t.id, t])),
    host: new Map(topo.hosts.map((h) => [h.id, h])),
    service: new Map(topo.services.map((s) => [s.id, s])),
    proxy: new Map(topo.proxies.map((p) => [p.id, p])),
    proxyByService: new Map(topo.proxies.filter((p) => p.serviceId).map((p) => [p.serviceId!, p])),
    routesToService,
    credsByOwner,
  };
}

export interface Endpoint {
  url: string;
  kind: 'public' | 'internal';
  note: string;
}

/** Container ports that are never browsable web UIs. */
const NON_HTTP_PORTS = new Set([21, 22, 23, 25, 53, 110, 143, 389, 445, 554, 636, 1433, 1521, 3306, 3389, 5432, 5672, 6379, 9042, 11211, 27017]);

const defaultPort = (scheme: string, port: number) => (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);

export function routeUrl(r: ProxyRoute): string {
  const scheme = r.inboundProtocol === 'https' ? 'https' : 'http';
  const port = defaultPort(scheme, r.inboundPort) ? '' : `:${r.inboundPort}`;
  return `${scheme}://${r.domain}${port}${r.pathPrefix === '/' ? '/' : r.pathPrefix}`;
}

/** Resolve every way to reach a service: public domains first, then IP:port. */
export function serviceEndpoints(s: Service, l: Lookup): Endpoint[] {
  const out: Endpoint[] = [];
  for (const { route, proxy } of l.routesToService.get(s.id) ?? [])
    if (route.enabled) out.push({ url: routeUrl(route), kind: 'public', note: `via ${proxy.name}` });
  const host = l.host.get(s.hostId);
  const ip = host ? primaryIp(host) : undefined;
  const scheme = s.scheme === 'https' ? 'https' : s.scheme === 'http' ? 'http' : null;
  if (ip && scheme)
    for (const p of s.ports)
      if (p.hostPort && p.protocol === 'tcp' && !NON_HTTP_PORTS.has(p.containerPort)) out.push({ url: `${scheme}://${ip}${defaultPort(scheme, p.hostPort) ? '' : `:${p.hostPort}`}/`, kind: 'internal', note: `host port ${p.hostPort} → container ${p.containerPort}` });
  return out;
}

export interface TraceStep {
  label: string;
  detail: string;
  kind: 'internet' | 'ip' | 'proxy' | 'host' | 'service';
}

/** Public Internet → public IP → reverse proxy:443 → host private IP:port → container port. */
export function traceFor(route: ProxyRoute, proxy: ReverseProxy, l: Lookup): TraceStep[] {
  const proxyHost = l.host.get(proxy.hostId);
  const target = route.serviceId ? l.service.get(route.serviceId) : undefined;
  const cport = target?.ports.find((p) => p.hostPort === route.targetPort)?.containerPort;
  const tunnel = proxy.kind === 'cloudflare_tunnel';
  const steps: TraceStep[] = [
    { label: 'Internet', detail: route.domain, kind: 'internet' },
    tunnel
      ? { label: 'Cloudflare edge', detail: 'outbound tunnel', kind: 'ip' }
      : { label: (proxyHost && publicIp(proxyHost)) ?? 'public IP', detail: proxyHost?.name ?? '', kind: 'ip' },
    { label: `${proxy.name}`, detail: `${route.inboundProtocol.toUpperCase()} :${route.inboundPort}`, kind: 'proxy' },
    { label: `${route.targetIp}:${route.targetPort}`, detail: l.host.get(route.targetHostId ?? '')?.name ?? 'target host', kind: 'host' },
  ];
  if (target) steps.push({ label: target.name, detail: cport ? `container :${cport}` : target.runtime, kind: 'service' });
  return steps;
}

export function daysUntil(iso: string, now = Date.now()): number {
  return Math.floor((Date.parse(iso) - now) / 86_400_000);
}

export const CRED_KIND_LABEL: Record<string, string> = {
  ssh_password: 'SSH password', ssh_key: 'SSH key', rdp: 'RDP', winrm: 'WinRM', web_gui: 'Web GUI', admin_login: 'Admin login',
  db_user: 'DB user', api_token: 'API token', smb: 'SMB', snmp: 'SNMP', other: 'Other',
};

export const CATEGORY_LABEL: Record<string, string> = {
  vps: 'VPS', local_server: 'Local server', vm: 'Virtual machine', switch: 'Switch', access_point: 'Access point', router: 'Router',
  firewall: 'Firewall', nvr: 'NVR', nas: 'NAS', edge_device: 'Edge device', workstation: 'Workstation',
};
