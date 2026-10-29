/**
 * Domain → presentation: which pictogram, accent, badges and labels each
 * record gets on the topology view. Pure functions, no positions.
 */

import type { Host, ProxyRoute, ReverseProxy, Service, Tenant } from '../api/types';
import { primaryIp, publicIp } from '../model';

export type Glyph =
  | 'cloud' | 'server' | 'vps' | 'vm' | 'switch' | 'ap' | 'router' | 'firewall' | 'nvr' | 'nas' | 'edge'
  | 'workstation' | 'container' | 'proxy' | 'tunnel' | 'share' | 'gear' | 'windows' | 'db' | 'globe' | 'shield';

export type BadgeKind = 'runtime' | 'os' | 'port' | 'tls' | 'tlsWarn' | 'routes' | 'ip' | 'kind' | 'owner';

export interface Badge {
  kind: BadgeKind;
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
  glyph?: string;
}

/** Badges that must stay visible at every zoom level. */
export const isAlert = (b: Badge) => b.tone === 'warn' || b.tone === 'danger';

export const CATEGORY_ORDER: Record<string, number> = {
  firewall: 0, router: 1, vps: 2, local_server: 3, vm: 4, nas: 5, edge_device: 6, switch: 7, access_point: 8, nvr: 9, workstation: 10,
};

const CATEGORY_GLYPH: Record<string, Glyph> = {
  vps: 'vps', local_server: 'server', vm: 'vm', switch: 'switch', access_point: 'ap', router: 'router',
  firewall: 'firewall', nvr: 'nvr', nas: 'nas', edge_device: 'edge', workstation: 'workstation',
};

export const ACCENT = {
  proxy: '#ff7a45',
  container: '#6ea8fe',
  db: '#b197fc',
  share: '#38d9a9',
  native: '#ffd43b',
  windows: '#74c0fc',
  host: '#adb5bd',
  appliance: '#ced4da',
  internet: '#e9ecef',
};

export const DEFAULT_TENANT_COLOR = '#868e96';

const PROXY_LABEL: Record<string, string> = {
  traefik: 'Traefik', nginx: 'nginx', npm: 'NPM', caddy: 'Caddy', haproxy: 'HAProxy', cloudflare_tunnel: 'CF Tunnel', other: 'Proxy',
};

const RUNTIME_LABEL: Record<string, string> = {
  docker: 'Docker', podman: 'Podman', systemd: 'systemd', smb: 'SMB', kubernetes: 'k8s', windows_service: 'Windows', lxc: 'LXC', other: 'native',
};

const OS_LABEL: Record<string, string> = {
  linux: 'Linux', windows: 'Windows', macos: 'macOS', bsd: 'BSD', routeros: 'RouterOS', embedded: 'Firmware', other: 'Other',
};

export type TlsState = 'ok' | 'warn' | 'expired' | 'managed' | 'none';

export function tlsState(r: ProxyRoute, now: number): TlsState {
  if (r.inboundProtocol !== 'https') return 'none';
  if (!r.tlsExpiresAt) return 'managed';
  const days = (Date.parse(r.tlsExpiresAt) - now) / 86_400_000;
  if (days < 0) return 'expired';
  if (days < 14) return 'warn';
  return 'ok';
}

export const isTunnel = (p: ReverseProxy) => p.kind === 'cloudflare_tunnel';

export function tenantSublabel(t: Tenant, hostCount: number): string {
  return `${t.environmentLabel || t.environment} · ${hostCount} ${hostCount === 1 ? 'machine' : 'machines'}`;
}

export function hostGlyph(h: Host): Glyph {
  return CATEGORY_GLYPH[h.category] ?? 'server';
}

export function hostBadges(h: Host): Badge[] {
  const badges: Badge[] = [];
  const pub = publicIp(h);
  if (pub) badges.push({ kind: 'ip', label: pub, tone: 'info' });
  if (h.osFamily) badges.push({ kind: 'os', label: OS_LABEL[h.osFamily] ?? h.osFamily, tone: 'neutral', glyph: h.osFamily });
  return badges;
}

export function hostSublabel(h: Host): string | undefined {
  return primaryIp(h) ?? h.fqdn ?? undefined;
}

export function serviceGlyph(s: Service): { glyph: Glyph; accent: string } {
  const hay = `${s.name} ${s.image ?? ''}`.toLowerCase();
  if (/postgres|mariadb|mysql|redis|mongo|clickhouse|influx/.test(hay)) return { glyph: 'db', accent: ACCENT.db };
  switch (s.runtime) {
    case 'smb':
      return { glyph: 'share', accent: ACCENT.share };
    case 'systemd':
    case 'other':
      return { glyph: 'gear', accent: ACCENT.native };
    case 'windows_service':
      return { glyph: 'windows', accent: ACCENT.windows };
    default:
      return { glyph: 'container', accent: ACCENT.container };
  }
}

export interface Described {
  label: string;
  sublabel?: string;
  glyph: Glyph;
  accent: string;
  badges: Badge[];
  ownerColor?: string;
}

/** A reverse proxy, either standalone or running as one of the host's services. */
export function describeProxy(px: ReverseProxy, host: Host, name = px.name): Described {
  const tunnel = isTunnel(px);
  const pub = publicIp(host);
  const badges: Badge[] = [{ kind: 'kind', label: PROXY_LABEL[px.kind] ?? px.kind, tone: 'neutral' }];
  if (px.routes.length) badges.push({ kind: 'routes', label: `${px.routes.length} route${px.routes.length > 1 ? 's' : ''}`, tone: 'info' });
  if (px.routes.some((r) => r.inboundProtocol === 'https')) badges.push({ kind: 'tls', label: tunnel ? 'edge TLS' : ':443', tone: 'ok', glyph: 'lock' });
  return {
    label: name,
    sublabel: tunnel ? 'outbound tunnel' : pub ? `${pub}:443` : undefined,
    glyph: tunnel ? 'tunnel' : 'proxy',
    accent: ACCENT.proxy,
    badges,
  };
}

/** A workload: owner badge first, then runtime, port and TLS health of the routes that reach it. */
export function describeService(s: Service, host: Host, routes: ProxyRoute[], owner: Tenant | undefined, now: number): Described {
  const { glyph, accent } = serviceGlyph(s);
  const badges: Badge[] = [];
  if (owner) badges.push({ kind: 'owner', label: owner.name, tone: 'info' });
  badges.push({ kind: 'runtime', label: RUNTIME_LABEL[s.runtime] ?? s.runtime, tone: 'neutral', glyph: s.runtime });
  const ip = primaryIp(host);
  const port = s.ports.find((x) => x.isPrimary) ?? s.ports[0];
  let sublabel: string | undefined;
  if (port) {
    badges.push({ kind: 'port', label: port.hostPort && port.hostPort !== port.containerPort ? `${port.hostPort}→${port.containerPort}` : `:${port.containerPort}`, tone: 'neutral' });
    sublabel = port.hostPort && ip ? `${ip}:${port.hostPort}` : `internal :${port.containerPort}`;
  }
  const states = routes.map((r) => tlsState(r, now));
  if (states.includes('expired')) badges.push({ kind: 'tlsWarn', label: 'TLS expired', tone: 'danger', glyph: 'lock' });
  else if (states.includes('warn')) badges.push({ kind: 'tlsWarn', label: 'TLS < 14d', tone: 'warn', glyph: 'lock' });
  else if (states.some((x) => x === 'ok' || x === 'managed')) badges.push({ kind: 'tls', label: 'HTTPS', tone: 'ok', glyph: 'lock' });
  return { label: s.name, sublabel, glyph, accent, badges, ownerColor: owner ? owner.color ?? DEFAULT_TENANT_COLOR : undefined };
}

/** `domain :443 → ip:port → :containerPort` */
export function routeLabel(r: ProxyRoute, target?: Service): string {
  const cport = target?.ports.find((p) => p.hostPort === r.targetPort)?.containerPort;
  return `${r.domain}  :${r.inboundPort} → ${r.targetIp}:${r.targetPort}${cport && cport !== r.targetPort ? ` → :${cport}` : ''}`;
}

export function ingressText(px: ReverseProxy, host: Host): string {
  return isTunnel(px) ? 'Cloudflare edge ⇢ outbound tunnel' : `${publicIp(host) ?? 'public IP'} :443`;
}
