import { useEffect, useRef, useState } from 'react';
import type { Backend } from '../api/backend';
import type { CredentialMeta, Host, ProxyRoute, ReverseProxy, SecretField, Service } from '../api/types';
import { GLYPHS } from '../canvas/glyphs';
import { type Scene, publicIp, tlsState } from '../canvas/layout';
import { CATEGORY_LABEL, CRED_KIND_LABEL, type Lookup, daysUntil, routeUrl, serviceEndpoints, traceFor } from '../model';

interface Props {
  backend: Backend;
  scene: Scene;
  lookup: Lookup;
  selected: string;
  onClose: () => void;
  onFocus: (nodeId: string) => void;
  toast: (msg: string, tone?: 'ok' | 'warn' | 'error') => void;
}

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d={GLYPHS[name] ?? GLYPHS.server} />
    </svg>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="dsec">
      <header>
        <h3>{title}</h3>
        {right}
      </header>
      {children}
    </section>
  );
}

function KV({ k, v, mono, copy, onCopy }: { k: string; v?: string | number | null; mono?: boolean; copy?: boolean; onCopy?: (t: string) => void }) {
  if (v === undefined || v === null || v === '') return null;
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={`v ${mono ? 'mono' : ''}`}>
        {v}
        {copy && onCopy && (
          <button className="icon-btn tiny" title="Copy" onClick={() => onCopy(String(v))}>
            <Icon name="copy" size={13} />
          </button>
        )}
      </span>
    </div>
  );
}

const REVEAL_SECS = 15;

function portOf(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `:${u.port}` : u.protocol.replace(':', '');
  } catch {
    return 'link';
  }
}

/** One credential: masked by default, reveal auto-hides, copy never touches JS memory. */
function CredentialRow({ cred, backend, toast, onSsh, onRdp }: { cred: CredentialMeta; backend: Backend; toast: Props['toast']; onSsh?: () => void; onRdp?: () => void }) {
  const field: SecretField | null = cred.hasSecret ? 'secret' : cred.hasPrivateKey ? 'privateKey' : null;
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealLeft, setRevealLeft] = useState(0);
  const [clipLeft, setClipLeft] = useState(0);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearInterval), []);

  const countdown = (secs: number, set: (n: number) => void, done?: () => void) => {
    set(secs);
    const started = Date.now();
    const t = window.setInterval(() => {
      const left = Math.max(0, secs - Math.floor((Date.now() - started) / 1000));
      set(left);
      if (left === 0) {
        clearInterval(t);
        done?.();
      }
    }, 250);
    timers.current.push(t);
  };

  const reveal = async () => {
    if (!field) return;
    if (revealed) {
      setRevealed(null);
      return;
    }
    try {
      const s = await backend.reveal(cred.id, field);
      setRevealed(s);
      countdown(REVEAL_SECS, setRevealLeft, () => setRevealed(null));
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  const copy = async () => {
    if (!field) return;
    try {
      const { clearsInSecs } = await backend.copySecret(cred.id, field);
      countdown(clearsInSecs, setClipLeft);
      toast(`Copied ${cred.label} — clipboard clears in ${clearsInSecs}s`, 'ok');
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  return (
    <div className="cred">
      <div className="cred-head">
        <span className={`cred-kind kind-${cred.kind}`}>{CRED_KIND_LABEL[cred.kind] ?? cred.kind}</span>
        <span className="cred-label">{cred.label}</span>
        {cred.kind === 'ssh_key' || cred.kind === 'ssh_password' ? (
          onSsh && (
            <button className="chip-btn" onClick={onSsh} title="Open SSH with this credential">
              <Icon name="terminal" size={13} /> SSH
            </button>
          )
        ) : cred.kind === 'rdp' && onRdp ? (
          <button className="chip-btn" onClick={onRdp} title="Open RDP">
            <Icon name="desktop" size={13} /> RDP
          </button>
        ) : null}
      </div>
      {cred.username && (
        <div className="cred-line">
          <span className="k">user</span>
          <span className="mono">{cred.username}</span>
          <button className="icon-btn tiny" title="Copy username" onClick={() => backend.copyText(cred.username!).then(() => toast('Username copied', 'ok'))}>
            <Icon name="copy" size={13} />
          </button>
        </div>
      )}
      {field && (
        <div className="cred-line secret">
          <span className="k">{field === 'privateKey' ? 'key' : 'secret'}</span>
          <span className={`mono secret-val ${revealed ? 'shown' : ''}`}>{revealed ?? '•'.repeat(14)}</span>
          {revealed && <span className="reveal-timer">{revealLeft}s</span>}
          <button className="icon-btn tiny" title={revealed ? 'Hide' : `Reveal for ${REVEAL_SECS}s`} onClick={reveal}>
            <Icon name={revealed ? 'eyeOff' : 'eye'} size={14} />
          </button>
          <button className={`icon-btn tiny ${clipLeft ? 'armed' : ''}`} title="Copy (auto-clears)" onClick={copy}>
            {clipLeft ? <ClipRing left={clipLeft} total={30} /> : <Icon name="copy" size={14} />}
          </button>
        </div>
      )}
      {cred.url && <div className="cred-line"><span className="k">url</span><span className="mono dim">{cred.url}</span></div>}
      {cred.publicKey && <div className="cred-line"><span className="k">pub</span><span className="mono dim ellipsis">{cred.publicKey}</span></div>}
    </div>
  );
}

function ClipRing({ left, total }: { left: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" className="clip-ring">
      <circle cx={9} cy={9} r={r} className="track" />
      <circle cx={9} cy={9} r={r} className="bar" strokeDasharray={c} strokeDashoffset={c * (1 - left / total)} />
      <text x={9} y={12} textAnchor="middle">{left}</text>
    </svg>
  );
}

function Trace({ route, proxy, lookup }: { route: ProxyRoute; proxy: ReverseProxy; lookup: Lookup }) {
  const steps = traceFor(route, proxy, lookup);
  return (
    <ol className="trace">
      {steps.map((s, i) => (
        <li key={i} className={`step ${s.kind}`}>
          <span className="dot" />
          <span className="lbl mono">{s.label}</span>
          <span className="det">{s.detail}</span>
        </li>
      ))}
    </ol>
  );
}

function TlsChip({ route }: { route: ProxyRoute }) {
  const st = tlsState(route, Date.now());
  if (st === 'none') return <span className="tls none">plain HTTP</span>;
  if (st === 'managed') return <span className="tls ok">edge-managed TLS</span>;
  const d = daysUntil(route.tlsExpiresAt!);
  return <span className={`tls ${st}`}>{st === 'expired' ? 'expired' : `${d}d left`}</span>;
}

export function Drawer({ backend, scene, lookup, selected, onClose, onFocus, toast }: Props) {
  const node = scene.byId.get(selected);
  const zone = scene.zones.find((z) => z.id === selected);
  const copyText = (t: string) => backend.copyText(t).then(() => toast('Copied', 'ok'));

  const ssh = async (h: Host, credId?: string) => {
    try {
      toast(`SSH → ${h.name}: ${await backend.launchSsh(h.id, credId)}`, 'ok');
    } catch (e) {
      toast(String(e), 'error');
    }
  };
  const rdp = async (h: Host, credId?: string) => {
    try {
      toast(`RDP → ${h.name}: ${await backend.launchRdp(h.id, credId)}`, 'ok');
    } catch (e) {
      toast(String(e), 'error');
    }
  };
  const web = async (url: string) => {
    try {
      await backend.launchWeb(url);
      toast(`Opened ${url}`, 'ok');
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  let title = '';
  let kicker = '';
  let glyph = 'server';
  let accent = '#adb5bd';
  let body: React.ReactNode = null;

  const creds = (ownerId: string, h?: Host) => {
    const list = lookup.credsByOwner.get(ownerId) ?? [];
    if (!list.length) return null;
    return (
      <Section title={`Credentials · ${list.length}`}>
        {list.map((c) => (
          <CredentialRow key={c.id} cred={c} backend={backend} toast={toast} onSsh={h?.sshPort ? () => ssh(h, c.id) : undefined} onRdp={h?.rdpPort ? () => rdp(h, c.id) : undefined} />
        ))}
      </Section>
    );
  };

  if (zone) {
    const t = lookup.tenant.get(zone.refId)!;
    const hosts = lookup.topo.hosts.filter((h) => h.tenantId === t.id);
    title = t.name;
    kicker = t.environmentLabel ?? t.environment;
    glyph = 'shield';
    accent = t.color ?? accent;
    body = (
      <>
        <Section title="Tenant">
          <KV k="Environment" v={t.environment} />
          <KV k="SLA" v={t.slaNotes} />
          <KV k="Notes" v={t.adminNotes} />
        </Section>
        <Section title="Networks">
          {lookup.topo.networks.filter((n) => n.tenantId === t.id).map((n) => (
            <KV key={n.id} k={n.name} v={`${n.cidr}${n.vlanId ? ` · VLAN ${n.vlanId}` : ''}${n.gateway ? ` · gw ${n.gateway}` : ''}`} mono />
          ))}
        </Section>
        <Section title={`Hosts · ${hosts.length}`}>
          <ul className="link-list">
            {hosts.map((h) => (
              <li key={h.id}>
                <button onClick={() => onFocus(`host:${h.id}`)}>
                  <Icon name={scene.byId.get(`host:${h.id}`)?.glyph ?? 'server'} size={14} />
                  <span>{h.name}</span>
                  <span className="mono dim">{h.interfaces[0]?.internalIp}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
        {creds(t.id)}
      </>
    );
  } else if (node?.kind === 'host') {
    const h = lookup.host.get(node.refId)!;
    const t = lookup.tenant.get(h.tenantId);
    const services = lookup.topo.services.filter((s) => s.hostId === h.id);
    title = h.name;
    kicker = `${CATEGORY_LABEL[h.category] ?? h.category} · ${t?.name ?? ''}`;
    glyph = node.glyph;
    accent = t?.color ?? accent;
    const addr = h.fqdn ?? h.interfaces.find((n) => n.isPrimary)?.internalIp ?? h.interfaces[0]?.internalIp;
    body = (
      <>
        <div className="hud">
          <button className="hud-btn" disabled={!h.sshPort} onClick={() => ssh(h)} title={h.sshPort ? `ssh -p ${h.sshPort} ${addr}` : 'No SSH port'}>
            <Icon name="terminal" size={18} />
            <span>SSH</span>
            <small>{h.sshPort ? `:${h.sshPort}` : '—'}</small>
          </button>
          <button className="hud-btn" disabled={!h.rdpPort} onClick={() => rdp(h)}>
            <Icon name="desktop" size={18} />
            <span>RDP</span>
            <small>{h.rdpPort ? `:${h.rdpPort}` : '—'}</small>
          </button>
          <button className="hud-btn" disabled={!h.webAdminUrl} onClick={() => h.webAdminUrl && web(h.webAdminUrl)}>
            <Icon name="external" size={18} />
            <span>Web UI</span>
            <small>{h.webAdminUrl ? portOf(h.webAdminUrl) : '—'}</small>
          </button>
        </div>
        <Section title="Machine">
          <KV k="OS" v={h.osFamily} />
          <KV k="Provider" v={h.provider} />
          <KV k="FQDN" v={h.fqdn} mono copy onCopy={copyText} />
          {h.parentHostId && <KV k="Runs on" v={lookup.host.get(h.parentHostId)?.name} />}
        </Section>
        <Section title="Interfaces">
          {h.interfaces.map((n) => (
            <div key={n.id} className="nic">
              <div className="nic-head mono">
                {n.name} {n.isPrimary && <span className="pill">primary</span>}
              </div>
              <KV k="Internal" v={n.internalIp} mono copy onCopy={copyText} />
              <KV k="Gateway" v={n.gateway} mono />
              <KV k="Public egress" v={n.publicIp} mono copy onCopy={copyText} />
              <KV k="MAC" v={n.mac} mono />
            </div>
          ))}
        </Section>
        {services.length > 0 && (
          <Section title={`Workloads · ${services.length}`}>
            <ul className="link-list">
              {services.map((s) => (
                <li key={s.id}>
                  <button onClick={() => onFocus(scene.refToNode.get(s.id)!)}>
                    <Icon name={scene.byId.get(scene.refToNode.get(s.id)!)?.glyph ?? 'container'} size={14} />
                    <span>{s.name}</span>
                    <span className="mono dim">{s.ports.map((p) => p.hostPort ?? p.containerPort).join(', ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {creds(h.id, h)}
      </>
    );
  } else if (node?.kind === 'service' || node?.kind === 'proxy') {
    const s: Service | undefined = lookup.service.get(node.refId);
    const proxy = lookup.proxy.get(node.refId) ?? (s ? lookup.proxyByService.get(s.id) : undefined);
    const h = lookup.host.get(node.hostId!)!;
    const t = lookup.tenant.get(h.tenantId);
    title = s?.name ?? proxy!.name;
    kicker = `${proxy ? `Reverse proxy · ${proxy.kind}` : `${s!.runtime} service`} · ${h.name}`;
    glyph = node.glyph;
    accent = node.accent;
    const endpoints = s ? serviceEndpoints(s, lookup) : [];
    const routesIn = s ? lookup.routesToService.get(s.id) ?? [] : [];
    body = (
      <>
        {endpoints.length > 0 && (
          <div className="launch">
            <button className="launch-btn" onClick={() => web(endpoints[0].url)}>
              <Icon name="external" size={18} />
              <span>
                Launch <b>{endpoints[0].url.replace(/\/$/, '')}</b>
              </span>
            </button>
          </div>
        )}
        {s && (
          <Section title="Service">
            <KV k="Runtime" v={s.runtime} />
            <KV k="Image" v={s.image} mono copy onCopy={copyText} />
            <KV k="Scheme" v={s.scheme} />
            <KV k="Host" v={`${h.name} · ${h.interfaces[0]?.internalIp ?? ''}`} />
            <KV k="Tenant" v={t?.name} />
          </Section>
        )}
        {s && s.ports.length > 0 && (
          <Section title="Port bindings">
            <table className="ports">
              <thead>
                <tr><th>container</th><th /><th>host</th><th>bind</th><th>proto</th></tr>
              </thead>
              <tbody>
                {s.ports.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.containerPort}</td>
                    <td className="dim">{p.hostPort ? '←' : ''}</td>
                    <td className="mono">{p.hostPort ?? <span className="dim">not published</span>}</td>
                    <td className="mono dim">{p.bindAddress}</td>
                    <td className="dim">{p.protocol}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}
        {endpoints.length > 0 && (
          <Section title="Endpoints">
            {endpoints.map((e) => (
              <div key={e.url} className="endpoint">
                <span className={`ep-kind ${e.kind}`}>{e.kind}</span>
                <button className="link mono" onClick={() => web(e.url)}>{e.url}</button>
                <span className="dim">{e.note}</span>
              </div>
            ))}
          </Section>
        )}
        {routesIn.map(({ route, proxy: p }) => (
          <Section key={route.id} title={`Route trace · ${route.domain}`} right={<TlsChip route={route} />}>
            <Trace route={route} proxy={p} lookup={lookup} />
          </Section>
        ))}
        {proxy && (
          <Section title={`Routes · ${proxy.routes.length}`} right={proxy.adminUrl ? <button className="chip-btn" onClick={() => web(proxy.adminUrl!)}><Icon name="external" size={12} /> admin</button> : undefined}>
            <table className="routes">
              <tbody>
                {proxy.routes.map((r) => (
                  <tr key={r.id} onClick={() => r.serviceId && onFocus(scene.refToNode.get(r.serviceId)!)}>
                    <td>
                      <div className="mono">{r.domain}</div>
                      <div className="dim mono small">
                        :{r.inboundPort} → {r.targetIp}:{r.targetPort} {r.serviceId ? `· ${lookup.service.get(r.serviceId)?.name}` : ''}
                      </div>
                    </td>
                    <td><TlsChip route={r} /></td>
                    <td>
                      <button className="icon-btn tiny" title={routeUrl(r)} onClick={(e) => (e.stopPropagation(), web(routeUrl(r)))}>
                        <Icon name="external" size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {publicIp(h) && <KV k="Edge address" v={`${publicIp(h)} (${h.name})`} mono />}
          </Section>
        )}
        {proxy && creds(proxy.id)}
        {s && creds(s.id)}
      </>
    );
  } else if (node?.kind === 'internet') {
    title = 'Public Internet';
    kicker = 'Ingress overview';
    glyph = 'globe';
    accent = '#e9ecef';
    body = (
      <Section title="Published routes">
        <table className="routes">
          <tbody>
            {lookup.topo.proxies.flatMap((p) =>
              p.routes.map((r) => (
                <tr key={r.id} onClick={() => r.serviceId && onFocus(scene.refToNode.get(r.serviceId)!)}>
                  <td>
                    <div className="mono">{r.domain}</div>
                    <div className="dim small">{p.name} → {r.serviceId ? lookup.service.get(r.serviceId)?.name : r.targetIp}</div>
                  </td>
                  <td><TlsChip route={r} /></td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </Section>
    );
  } else {
    return null;
  }

  return (
    <aside className="drawer" style={{ ['--accent' as string]: accent }}>
      <header className="drawer-head">
        <div className="drawer-glyph"><Icon name={glyph} size={22} /></div>
        <div className="drawer-titles">
          <div className="kicker">{kicker}</div>
          <h2>{title}</h2>
          {node && node.badges.length > 0 && (
            <div className="drawer-badges">
              {node.badges.map((b, i) => (
                <span key={i} className={`badge-chip tone-${b.tone}`}>{b.label}</span>
              ))}
            </div>
          )}
        </div>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          <Icon name="close" />
        </button>
      </header>
      <div className="drawer-body">{body}</div>
    </aside>
  );
}
