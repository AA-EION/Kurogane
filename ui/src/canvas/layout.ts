/**
 * Automatic isometric layout: database records in, positioned scene out.
 *
 * No manual diagramming. The relational model already encodes the picture:
 *
 *   Tenant  ──contains──►  Host  ──runs──►  Service / Proxy
 *   Proxy route: domain ─► target IP:port ─► Service
 *
 * Layers (z = elevation):
 *   z = 0     tenant floors (flat zones, FossFLOW "rectangles")
 *   z = 0..1  host slabs (machine boundaries)
 *   z = 1     containers / services / proxies standing on their host
 *   z = 1     route traces running at slab height between nodes
 *   z = 6     the Internet, floating above the scene, with ingress beams
 *
 * Placement is deterministic (sorted inputs, no randomness) so the canvas
 * looks the same on every machine that opens the vault.
 */

import type { Host, ProxyRoute, ReverseProxy, Service, Tenant, Topology } from '../api/types';
import { type Coords, type Size, footprintCenter, tileToScreen } from './iso';
import { block, createGrid, elbow, findPath, markUsage, simplify } from './pathfinder';

export type NodeKind = 'internet' | 'host' | 'service' | 'proxy' | 'ip';

export type Glyph =
  | 'cloud' | 'server' | 'vps' | 'vm' | 'switch' | 'ap' | 'router' | 'firewall' | 'nvr' | 'nas' | 'edge'
  | 'workstation' | 'container' | 'proxy' | 'tunnel' | 'share' | 'gear' | 'windows' | 'db' | 'globe';

export type BadgeKind = 'runtime' | 'os' | 'port' | 'tls' | 'tlsWarn' | 'routes' | 'ip' | 'kind';

export interface Badge {
  kind: BadgeKind;
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
  glyph?: string;
}

export interface SceneNode {
  id: string;
  kind: NodeKind;
  /** Primary record id (host/service/proxy id). */
  refId: string;
  tenantId?: string;
  hostId?: string;
  tile: Coords;
  size: Size;
  /** Elevation of the node's base. */
  z: number;
  /** Block height in elevation units. */
  height: number;
  /** Screen-space override for nodes that do not sit on the grid (Internet). */
  screen?: Coords;
  label: string;
  sublabel?: string;
  glyph: Glyph;
  accent: string;
  badges: Badge[];
  /** Host has services standing on it (rendered as a slab, not a box). */
  slab?: boolean;
}

export interface SceneZone {
  id: string;
  refId: string;
  from: Coords;
  to: Coords;
  color: string;
  label: string;
  sublabel: string;
}

export interface SceneConnector {
  id: string;
  kind: 'ingress' | 'route' | 'parent';
  from: string;
  to: string;
  /** Grid path (tiles) for routed connectors. */
  tiles?: Coords[];
  /** Screen polyline for ingress beams. */
  points?: Coords[];
  z: number;
  routeIds: string[];
  label?: string;
  secure: boolean;
  tunnel?: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  zones: SceneZone[];
  connectors: SceneConnector[];
  byId: Map<string, SceneNode>;
  /** record id (tenant/host/service/proxy/route/credential owner) → scene node or zone id */
  refToNode: Map<string, string>;
  /** route id → connector ids forming the full trace */
  routeTrace: Map<string, string[]>;
  bounds: { min: Coords; max: Coords };
}

// ---------------------------------------------------------------- constants

const CELL = 2; // tiles per item slot on a host
const HOST_GAP = 2;
const ZONE_PAD = 2;
const ZONE_LABEL_DEPTH = 2; // extra front space for the floor label
const TENANT_GAP = 4;
export const SLAB_HEIGHT = 0.45;
const ITEM_HEIGHT = 1.25;
const APPLIANCE_HEIGHT = 0.9;
export const INTERNET_Z = 7;

const CATEGORY_ORDER: Record<string, number> = {
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

const PROXY_LABEL: Record<string, string> = {
  traefik: 'Traefik', nginx: 'nginx', npm: 'NPM', caddy: 'Caddy', haproxy: 'HAProxy', cloudflare_tunnel: 'CF Tunnel', other: 'Proxy',
};

const RUNTIME_LABEL: Record<string, string> = {
  docker: 'Docker', podman: 'Podman', systemd: 'systemd', smb: 'SMB', kubernetes: 'k8s', windows_service: 'Windows', lxc: 'LXC', other: 'native',
};

const OS_LABEL: Record<string, string> = {
  linux: 'Linux', windows: 'Windows', macos: 'macOS', bsd: 'BSD', routeros: 'RouterOS', embedded: 'Firmware', other: 'Other',
};

// ------------------------------------------------------------------ helpers

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export function primaryIp(h: Host): string | undefined {
  const nic = h.interfaces.find((n) => n.isPrimary) ?? h.interfaces[0];
  return nic?.internalIp ?? undefined;
}

export function publicIp(h: Host): string | undefined {
  return h.interfaces.find((n) => n.publicIp)?.publicIp ?? undefined;
}

export type TlsState = 'ok' | 'warn' | 'expired' | 'managed' | 'none';

export function tlsState(r: ProxyRoute, now: number): TlsState {
  if (r.inboundProtocol !== 'https') return 'none';
  if (!r.tlsExpiresAt) return 'managed';
  const days = (Date.parse(r.tlsExpiresAt) - now) / 86_400_000;
  if (days < 0) return 'expired';
  if (days < 14) return 'warn';
  return 'ok';
}

function serviceGlyph(s: Service): { glyph: Glyph; accent: string } {
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

interface HostItem {
  kind: 'service' | 'proxy';
  service?: Service;
  proxy?: ReverseProxy;
  id: string;
  name: string;
}

// ------------------------------------------------------------------- layout

export function layoutTopology(topo: Topology, now = Date.now()): Scene {
  const nodes: SceneNode[] = [];
  const zones: SceneZone[] = [];
  const connectors: SceneConnector[] = [];
  const refToNode = new Map<string, string>();
  const routeTrace = new Map<string, string[]>();

  const hostsByTenant = new Map<string, Host[]>();
  for (const h of topo.hosts) hostsByTenant.set(h.tenantId, [...(hostsByTenant.get(h.tenantId) ?? []), h]);
  const servicesByHost = new Map<string, Service[]>();
  for (const s of topo.services) servicesByHost.set(s.hostId, [...(servicesByHost.get(s.hostId) ?? []), s]);
  const proxyByService = new Map<string, ReverseProxy>();
  const standaloneProxiesByHost = new Map<string, ReverseProxy[]>();
  for (const p of topo.proxies) {
    if (p.serviceId) proxyByService.set(p.serviceId, p);
    else standaloneProxiesByHost.set(p.hostId, [...(standaloneProxiesByHost.get(p.hostId) ?? []), p]);
  }
  const proxyHosts = new Set(topo.proxies.map((p) => p.hostId));
  const routesByService = new Map<string, ProxyRoute[]>();
  for (const p of topo.proxies)
    for (const r of p.routes) if (r.serviceId) routesByService.set(r.serviceId, [...(routesByService.get(r.serviceId) ?? []), r]);

  // --- 1. size every host block -------------------------------------------
  const hostItems = new Map<string, HostItem[]>();
  const hostSize = new Map<string, Size>();
  for (const h of topo.hosts) {
    const svcs = [...(servicesByHost.get(h.id) ?? [])].sort((a, b) => {
      const pa = proxyByService.has(a.id) ? 0 : 1;
      const pb = proxyByService.has(b.id) ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    });
    const items: HostItem[] = [
      ...(standaloneProxiesByHost.get(h.id) ?? []).sort(byName).map((p) => ({ kind: 'proxy' as const, proxy: p, id: p.id, name: p.name })),
      ...svcs.map((s) => ({ kind: proxyByService.has(s.id) ? ('proxy' as const) : ('service' as const), service: s, proxy: proxyByService.get(s.id), id: s.id, name: s.name })),
    ];
    hostItems.set(h.id, items);
    if (items.length === 0) {
      hostSize.set(h.id, { w: 1, h: 1 });
    } else {
      const cols = Math.ceil(Math.sqrt(items.length));
      const rows = Math.ceil(items.length / cols);
      hostSize.set(h.id, { w: cols * CELL + 1, h: rows * CELL + 1 });
    }
  }

  // --- 2. pack hosts inside each tenant zone (shelf packing) ---------------
  const tenants = [...topo.tenants].sort(byName);
  interface Packed {
    tenant: Tenant;
    size: Size;
    hosts: { host: Host; at: Coords }[];
  }
  const packed: Packed[] = tenants.map((tenant) => {
    const hosts = [...(hostsByTenant.get(tenant.id) ?? [])];
    const order = new Map<string, number>();
    const rank = (h: Host) => (proxyHosts.has(h.id) ? -1 : CATEGORY_ORDER[h.category] ?? 99);
    hosts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).forEach((h, i) => order.set(h.id, i));
    // Keep VMs right after their hypervisor.
    const key = (h: Host) => (h.parentHostId && order.has(h.parentHostId) ? order.get(h.parentHostId)! + 0.5 + order.get(h.id)! / 1000 : order.get(h.id)!);
    hosts.sort((a, b) => key(a) - key(b));

    // Hosts with workloads become slabs packed in shelves; bare appliances
    // (switches, APs, NVRs…) line up in a tight strip in front of them.
    const slabs = hosts.filter((h) => (hostItems.get(h.id) ?? []).length > 0);
    const gear = hosts.filter((h) => (hostItems.get(h.id) ?? []).length === 0);
    const area = slabs.reduce((s, h) => s + (hostSize.get(h.id)!.w + HOST_GAP) * (hostSize.get(h.id)!.h + HOST_GAP), 0);
    const maxRow = Math.max(8, Math.ceil(Math.sqrt(area) * 1.25), gear.length * 2 - 1);
    let x = ZONE_PAD;
    let y = ZONE_PAD;
    let rowH = 0;
    let maxX = 0;
    const out: { host: Host; at: Coords }[] = [];
    for (const h of slabs) {
      const sz = hostSize.get(h.id)!;
      if (x > ZONE_PAD && x + sz.w > ZONE_PAD + maxRow) {
        x = ZONE_PAD;
        y += rowH + HOST_GAP;
        rowH = 0;
      }
      out.push({ host: h, at: { x, y } });
      x += sz.w + HOST_GAP;
      rowH = Math.max(rowH, sz.h);
      maxX = Math.max(maxX, x - HOST_GAP);
    }
    if (gear.length) {
      y += slabs.length ? rowH + HOST_GAP : 0;
      x = ZONE_PAD;
      rowH = 1;
      for (const h of gear) {
        if (x > ZONE_PAD && x + 1 > ZONE_PAD + maxRow) {
          x = ZONE_PAD;
          y += 2;
        }
        out.push({ host: h, at: { x, y } });
        x += 2;
        maxX = Math.max(maxX, x - 1);
      }
    }
    const size = { w: Math.max(maxX, 6) + ZONE_PAD, h: y + rowH + ZONE_PAD + ZONE_LABEL_DEPTH };
    return { tenant, size, hosts: out };
  });

  // --- 3. arrange tenant zones in a grid (diamond in isometric view) -------
  const cols = Math.max(1, Math.ceil(Math.sqrt(packed.length)));
  const colW: number[] = [];
  const rowD: number[] = [];
  packed.forEach((p, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c] ?? 0, p.size.w);
    rowD[r] = Math.max(rowD[r] ?? 0, p.size.h);
  });
  const colX = colW.map((_, c) => colW.slice(0, c).reduce((s, w) => s + w + TENANT_GAP, 0));
  const rowY = rowD.map((_, r) => rowD.slice(0, r).reduce((s, d) => s + d + TENANT_GAP, 0));

  const hostNodeId = (id: string) => `host:${id}`;
  const itemNodeId = (it: HostItem) => (it.kind === 'proxy' && !it.service ? `proxy:${it.id}` : `svc:${it.id}`);

  packed.forEach((p, i) => {
    const origin = { x: colX[i % cols], y: rowY[Math.floor(i / cols)] };
    const env = p.tenant.environmentLabel ?? p.tenant.environment;
    const zoneId = `tenant:${p.tenant.id}`;
    zones.push({
      id: zoneId,
      refId: p.tenant.id,
      from: origin,
      to: { x: origin.x + p.size.w, y: origin.y + p.size.h },
      color: p.tenant.color ?? '#868e96',
      label: p.tenant.name,
      sublabel: `${env} · ${p.hosts.length} hosts`,
    });
    refToNode.set(p.tenant.id, zoneId);

    for (const { host, at } of p.hosts) {
      const tile = { x: origin.x + at.x, y: origin.y + at.y };
      const size = hostSize.get(host.id)!;
      const items = hostItems.get(host.id)!;
      const ip = primaryIp(host);
      const pub = publicIp(host);
      const badges: Badge[] = [];
      if (host.osFamily) badges.push({ kind: 'os', label: OS_LABEL[host.osFamily] ?? host.osFamily, tone: 'neutral', glyph: host.osFamily });
      if (pub) badges.push({ kind: 'ip', label: pub, tone: 'info' });
      const hn: SceneNode = {
        id: hostNodeId(host.id),
        kind: 'host',
        refId: host.id,
        tenantId: p.tenant.id,
        hostId: host.id,
        tile,
        size,
        z: 0,
        height: items.length ? SLAB_HEIGHT : APPLIANCE_HEIGHT,
        label: host.name,
        sublabel: ip ?? host.fqdn ?? undefined,
        glyph: CATEGORY_GLYPH[host.category] ?? 'server',
        accent: items.length ? ACCENT.host : ACCENT.appliance,
        badges,
        slab: items.length > 0,
      };
      nodes.push(hn);
      refToNode.set(host.id, hn.id);

      const icols = Math.ceil(Math.sqrt(items.length));
      items.forEach((it, k) => {
        const c = k % icols;
        const r = Math.floor(k / icols);
        const itTile = { x: tile.x + 1 + c * CELL, y: tile.y + 1 + r * CELL };
        const b: Badge[] = [];
        let glyph: Glyph;
        let accent: string;
        let sub: string | undefined;
        if (it.kind === 'proxy') {
          const px = it.proxy!;
          glyph = px.kind === 'cloudflare_tunnel' ? 'tunnel' : 'proxy';
          accent = ACCENT.proxy;
          b.push({ kind: 'kind', label: PROXY_LABEL[px.kind] ?? px.kind, tone: 'neutral' });
          if (px.routes.length) b.push({ kind: 'routes', label: `${px.routes.length} route${px.routes.length > 1 ? 's' : ''}`, tone: 'info' });
          if (px.routes.some((r) => r.inboundProtocol === 'https')) b.push({ kind: 'tls', label: px.kind === 'cloudflare_tunnel' ? 'edge TLS' : ':443', tone: 'ok', glyph: 'lock' });
          sub = px.kind === 'cloudflare_tunnel' ? 'outbound tunnel' : pub ? `${pub}:443` : undefined;
        } else {
          const s = it.service!;
          ({ glyph, accent } = serviceGlyph(s));
          b.push({ kind: 'runtime', label: RUNTIME_LABEL[s.runtime] ?? s.runtime, tone: 'neutral', glyph: s.runtime });
          const port = s.ports.find((x) => x.isPrimary) ?? s.ports[0];
          if (port) {
            b.push({ kind: 'port', label: port.hostPort && port.hostPort !== port.containerPort ? `${port.hostPort}→${port.containerPort}` : `:${port.containerPort}`, tone: 'neutral' });
            sub = port.hostPort && ip ? `${ip}:${port.hostPort}` : `internal :${port.containerPort}`;
          }
          const routes = routesByService.get(s.id) ?? [];
          const states = routes.map((r) => tlsState(r, now));
          if (states.includes('expired')) b.push({ kind: 'tlsWarn', label: 'TLS expired', tone: 'danger', glyph: 'lock' });
          else if (states.includes('warn')) b.push({ kind: 'tlsWarn', label: 'TLS < 14d', tone: 'warn', glyph: 'lock' });
          else if (states.some((x) => x === 'ok' || x === 'managed')) b.push({ kind: 'tls', label: 'HTTPS', tone: 'ok', glyph: 'lock' });
        }
        const node: SceneNode = {
          id: itemNodeId(it),
          kind: it.kind,
          refId: it.id,
          tenantId: p.tenant.id,
          hostId: host.id,
          tile: itTile,
          size: { w: 1, h: 1 },
          z: SLAB_HEIGHT,
          height: it.kind === 'proxy' ? ITEM_HEIGHT * 1.15 : ITEM_HEIGHT,
          label: it.name,
          sublabel: sub,
          glyph,
          accent,
          badges: b,
        };
        nodes.push(node);
        refToNode.set(it.id, node.id);
        if (it.proxy) refToNode.set(it.proxy.id, node.id);
      });
    }
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // --- 4. bounds + routing grid --------------------------------------------
  const min = { x: Math.min(...zones.map((z) => z.from.x), 0) - 2, y: Math.min(...zones.map((z) => z.from.y), 0) - 2 };
  const max = { x: Math.max(...zones.map((z) => z.to.x), 1) + 2, y: Math.max(...zones.map((z) => z.to.y), 1) + 2 };
  const grid = createGrid(min, max);
  for (const n of nodes) if (n.kind !== 'host' || !n.slab) for (let dx = 0; dx < n.size.w; dx++) for (let dy = 0; dy < n.size.h; dy++) block(grid, { x: n.tile.x + dx, y: n.tile.y + dy });

  const route = (fromNode: SceneNode, toNode: SceneNode): Coords[] => {
    const a = { x: fromNode.tile.x + Math.floor(fromNode.size.w / 2), y: fromNode.tile.y + Math.floor(fromNode.size.h / 2) };
    const b = { x: toNode.tile.x + Math.floor(toNode.size.w / 2), y: toNode.tile.y + Math.floor(toNode.size.h / 2) };
    const path = findPath(grid, a, b) ?? elbow(a, b);
    markUsage(grid, path);
    return simplify(path);
  };

  // --- 5. route traces: proxy → target service -----------------------------
  const svcById = new Map(topo.services.map((s) => [s.id, s]));
  for (const px of [...topo.proxies].sort(byName)) {
    const from = byId.get(refToNode.get(px.id) ?? '');
    if (!from) continue;
    for (const r of px.routes) {
      const targetRef = r.serviceId ?? r.targetHostId;
      const to = targetRef ? byId.get(refToNode.get(targetRef) ?? '') : undefined;
      if (!to || to.id === from.id) continue;
      const svc = r.serviceId ? svcById.get(r.serviceId) : undefined;
      const cport = svc?.ports.find((p) => p.hostPort === r.targetPort)?.containerPort;
      const id = `route:${r.id}`;
      connectors.push({
        id,
        kind: 'route',
        from: from.id,
        to: to.id,
        tiles: route(from, to),
        z: SLAB_HEIGHT,
        routeIds: [r.id],
        label: `${r.domain}  :${r.inboundPort} → ${r.targetIp}:${r.targetPort}${cport && cport !== r.targetPort ? ` → :${cport}` : ''}`,
        secure: r.inboundProtocol === 'https',
        tunnel: px.kind === 'cloudflare_tunnel',
      });
      routeTrace.set(r.id, [id]);
      refToNode.set(r.id, to.id);
    }
  }

  // --- 6. hypervisor links --------------------------------------------------
  for (const h of topo.hosts) {
    if (!h.parentHostId) continue;
    const a = byId.get(hostNodeId(h.id));
    const b = byId.get(hostNodeId(h.parentHostId));
    if (!a || !b) continue;
    connectors.push({ id: `parent:${h.id}`, kind: 'parent', from: a.id, to: b.id, tiles: route(a, b), z: 0.05, routeIds: [], secure: false });
  }

  // --- 7. the Internet, public IP pins and ingress beams --------------------
  const corners = [
    tileToScreen(min), tileToScreen({ x: max.x, y: min.y }), tileToScreen(max), tileToScreen({ x: min.x, y: max.y }),
  ];
  const cx = (Math.min(...corners.map((c) => c.x)) + Math.max(...corners.map((c) => c.x))) / 2;
  const top = Math.min(...corners.map((c) => c.y));
  const internet: SceneNode = {
    id: 'internet',
    kind: 'internet',
    refId: 'internet',
    tile: { x: min.x, y: min.y },
    size: { w: 2, h: 2 },
    z: INTERNET_Z,
    height: 0,
    screen: { x: cx, y: top - 120 },
    label: 'Public Internet',
    sublabel: `${topo.proxies.reduce((s, p) => s + p.routes.length, 0)} published routes`,
    glyph: 'globe',
    accent: ACCENT.internet,
    badges: [],
  };
  nodes.push(internet);
  byId.set(internet.id, internet);

  const hostById = new Map(topo.hosts.map((h) => [h.id, h]));
  for (const px of [...topo.proxies].sort(byName)) {
    const pnode = byId.get(refToNode.get(px.id) ?? '');
    const host = hostById.get(px.hostId);
    const hnode = host ? byId.get(hostNodeId(host.id)) : undefined;
    if (!pnode || !host || !hnode) continue;
    const tunnel = px.kind === 'cloudflare_tunnel';
    const pub = publicIp(host);
    const target = footprintCenter(pnode.tile, pnode.size, pnode.z + pnode.height);
    const points: Coords[] = [internet.screen!];
    let ipNodeId: string | undefined;
    if (pub && !tunnel) {
      // A pin at the slab's front edge stands for the host's public address.
      const pin: SceneNode = {
        id: `ip:${host.id}`,
        kind: 'ip',
        refId: host.id,
        tenantId: host.tenantId,
        hostId: host.id,
        tile: { x: hnode.tile.x + hnode.size.w - 0.5, y: hnode.tile.y - 0.5 },
        size: { w: 0, h: 0 },
        z: SLAB_HEIGHT + 2.2,
        height: 0,
        label: pub,
        sublabel: 'public IP',
        glyph: 'globe',
        accent: ACCENT.proxy,
        badges: [],
      };
      if (!byId.has(pin.id)) {
        nodes.push(pin);
        byId.set(pin.id, pin);
      }
      ipNodeId = pin.id;
      points.push(tileToScreen(pin.tile, pin.z));
    }
    points.push(target);
    const id = `ingress:${px.id}`;
    connectors.push({
      id,
      kind: 'ingress',
      from: 'internet',
      to: pnode.id,
      points,
      z: 0,
      routeIds: px.routes.map((r) => r.id),
      label: tunnel ? 'Cloudflare edge ⇢ outbound tunnel' : `${pub ?? '?'} :443`,
      secure: true,
      tunnel,
    });
    for (const r of px.routes) routeTrace.set(r.id, [id, ...(routeTrace.get(r.id) ?? [])]);
    if (ipNodeId) refToNode.set(`${host.id}:public`, ipNodeId);
  }

  return { nodes, zones, connectors, byId, refToNode, routeTrace, bounds: { min, max } };
}

/** Connectors to light up when a node is selected or hovered. */
export function connectorsFor(scene: Scene, nodeId: string | null): Set<string> {
  const out = new Set<string>();
  if (!nodeId) return out;
  const node = scene.byId.get(nodeId);
  const zone = scene.zones.find((z) => z.id === nodeId);
  const memberIds = new Set<string>([nodeId]);
  if (node?.kind === 'host') for (const n of scene.nodes) if (n.hostId === node.refId) memberIds.add(n.id);
  if (zone) for (const n of scene.nodes) if (n.tenantId === zone.refId) memberIds.add(n.id);
  for (const c of scene.connectors) {
    if (memberIds.has(c.from) || memberIds.has(c.to)) {
      out.add(c.id);
      for (const rid of c.routeIds) for (const cid of scene.routeTrace.get(rid) ?? []) {
        // An ingress beam is shared by all routes of a proxy; only pull it in,
        // never fan out from it to sibling routes.
        if (c.kind === 'route' || cid.startsWith('ingress:')) out.add(cid);
      }
    }
  }
  if (nodeId === 'internet') for (const c of scene.connectors) if (c.kind === 'ingress') out.add(c.id);
  return out;
}
