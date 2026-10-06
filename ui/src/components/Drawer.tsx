import { useEffect, useRef, useState } from 'react';
import type { CredentialMeta, Host, OwnerKind, ProxyRoute, ReverseProxy, SecretField } from '../api/types';
import { publicIp, tlsState } from '../canvas/layout';
import { CATEGORY_LABEL, CRED_KIND_LABEL, daysUntil, routeUrl, serviceEndpoints, traceFor } from '../model';
import { ENVIRONMENTS, OS_FAMILIES, RUNTIMES, labelOf } from '../options';
import { useRun, useStore } from '../store';
import { Icon } from './Icon';

export { Icon } from './Icon';

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

function KV({ k, v, mono, copy }: { k: string; v?: string | number | null; mono?: boolean; copy?: boolean }) {
  const { backend, toast } = useStore();
  if (v === undefined || v === null || v === '') return null;
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={`v ${mono ? 'mono' : ''}`}>
        {v}
        {copy && (
          <button className="icon-btn tiny" title="Copy" onClick={() => backend.copyText(String(v)).then(() => toast('Copied', 'ok'))}>
            <Icon name="copy" size={13} />
          </button>
        )}
      </span>
    </div>
  );
}

function AddChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="chip-btn" onClick={onClick}>
      <Icon name="plus" size={12} /> {label}
    </button>
  );
}

function portOf(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `:${u.port}` : u.protocol.replace(':', '');
  } catch {
    return 'link';
  }
}

const REVEAL_SECS = 15;

/** One account: masked by default, reveal auto-hides, copy never touches JS memory. */
function CredentialRow({ cred, onSsh, onRdp }: { cred: CredentialMeta; onSsh?: () => void; onRdp?: () => void }) {
  const { backend, toast, openModal } = useStore();
  const run = useRun();
  const field: SecretField | null = cred.hasSecret && cred.kind !== 'ssh_key' ? 'secret' : cred.hasPrivateKey ? 'privateKey' : cred.hasSecret ? 'secret' : null;
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
  return (
    <div className="cred">
      <div className="cred-head">
        <span className={`cred-kind kind-${cred.kind}`}>{CRED_KIND_LABEL[cred.kind] ?? cred.kind}</span>
        <span className="cred-label">{cred.label}</span>
        {(cred.kind === 'ssh_key' || cred.kind === 'ssh_password') && onSsh && (
          <button className="chip-btn" onClick={onSsh} title="Open SSH with this account"><Icon name="terminal" size={13} /> SSH</button>
        )}
        {cred.kind === 'rdp' && onRdp && <button className="chip-btn" onClick={onRdp}><Icon name="desktop" size={13} /> RDP</button>}
        {cred.url && <button className="chip-btn" onClick={() => run(() => backend.launchWeb(cred.url!))} title={cred.url}><Icon name="external" size={12} /> Open</button>}
        <button className="icon-btn tiny" title="Edit account" onClick={() => openModal({ type: 'credential', value: cred })}><Icon name="edit" size={13} /></button>
        <button className="icon-btn tiny" title="Delete account" onClick={() => openModal({ type: 'delete', kind: 'credential', id: cred.id, name: cred.label })}><Icon name="trash" size={13} /></button>
      </div>
      {cred.username && (
        <div className="cred-line">
          <span className="k">user</span>
          <span className="mono">{cred.username}</span>
          <button className="icon-btn tiny" title="Copy username" onClick={() => run(async () => { await backend.copyText(cred.username!); toast('Username copied', 'ok'); })}>
            <Icon name="copy" size={13} />
          </button>
        </div>
      )}
      {field && (
        <div className="cred-line secret">
          <span className="k">{field === 'privateKey' ? 'key' : cred.kind === 'api_token' ? 'token' : 'password'}</span>
          <span className={`mono secret-val ${revealed ? 'shown' : ''}`}>{revealed ?? '•'.repeat(14)}</span>
          {revealed && <span className="reveal-timer">{revealLeft}s</span>}
          <button className="icon-btn tiny" title={revealed ? 'Hide' : `Reveal for ${REVEAL_SECS}s`} onClick={() => run(async () => {
            if (revealed) return setRevealed(null);
            setRevealed(await backend.reveal(cred.id, field));
            countdown(REVEAL_SECS, setRevealLeft, () => setRevealed(null));
          })}>
            <Icon name={revealed ? 'eyeOff' : 'eye'} size={14} />
          </button>
          <button className={`icon-btn tiny ${clipLeft ? 'armed' : ''}`} title="Copy (auto-clears)" onClick={() => run(async () => {
            const { clearsInSecs } = await backend.copySecret(cred.id, field);
            countdown(clearsInSecs, setClipLeft);
            toast(`Copied ${cred.label} — clipboard clears in ${clearsInSecs}s`, 'ok');
          })}>
            {clipLeft ? <ClipRing left={clipLeft} total={30} /> : <Icon name="copy" size={14} />}
          </button>
        </div>
      )}
      {cred.url && <div className="cred-line"><span className="k">url</span><span className="mono dim ellipsis">{cred.url}</span></div>}
    </div>
  );
}

function ClipRing({ left, total }: { left: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" className="clip-ring">
      <circle cx={9} cy={9} r={r} className="track" />
      <circle cx={9} cy={9} r={r} className="bar" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, left / total))} />
      <text x={9} y={12} textAnchor="middle">{left}</text>
    </svg>
  );
}

function Trace({ route, proxy }: { route: ProxyRoute; proxy: ReverseProxy }) {
  const { lookup } = useStore();
  return (
    <ol className="trace">
      {traceFor(route, proxy, lookup).map((s, i) => (
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
  if (st === 'managed') return <span className="tls ok">TLS</span>;
  const d = daysUntil(route.tlsExpiresAt!);
  return <span className={`tls ${st}`}>{st === 'expired' ? 'cert expired' : `cert ${d}d left`}</span>;
}

export function Drawer() {
  const { backend, scene, lookup, selected, select, focus, focusRef, openModal, toast } = useStore();
  const run = useRun();
  if (!selected) return null;
  const node = scene.byId.get(selected);
  const zone = scene.zones.find((z) => z.id === selected);

  const ssh = (h: Host, credId?: string) => run(async () => toast(await backend.launchSsh(h.id, credId), 'ok'));
  const rdp = (h: Host, credId?: string) => run(async () => toast(await backend.launchRdp(h.id, credId), 'ok'));
  const web = (url: string) => run(async () => { await backend.launchWeb(url); toast(`Opened ${url}`, 'ok'); });

  const creds = (ownerKind: OwnerKind, ownerId: string, h?: Host) => {
    const list = lookup.credsByOwner.get(ownerId) ?? [];
    return (
      <Section title={`Accounts · ${list.length}`} right={<AddChip label="Account" onClick={() => openModal({ type: 'credential', owner: { kind: ownerKind, id: ownerId } })} />}>
        {list.map((c) => (
          <CredentialRow key={c.id} cred={c} onSsh={h?.sshPort ? () => ssh(h, c.id) : undefined} onRdp={h?.rdpPort ? () => rdp(h, c.id) : undefined} />
        ))}
        {list.length === 0 && <p className="muted small">No accounts yet. Add the logins used for this {ownerKind === 'host' ? 'machine (SSH, RDP, web UI)' : ownerKind === 'tenant' ? 'company (registrar, cloud console…)' : 'service (admin, database user, API token)'}.</p>}
      </Section>
    );
  };

  let title = '';
  let kicker = '';
  let glyph = 'server';
  let accent = '#adb5bd';
  let actions: React.ReactNode = null;
  let body: React.ReactNode = null;

  if (zone) {
    const t = lookup.tenant.get(zone.refId)!;
    const hosts = lookup.topo.hosts.filter((h) => h.tenantId === t.id);
    title = t.name;
    kicker = `Company · ${t.environmentLabel || labelOf(ENVIRONMENTS, t.environment)}`;
    glyph = 'shield';
    accent = t.color ?? accent;
    actions = (
      <>
        <button className="icon-btn" title="Edit company" onClick={() => openModal({ type: 'tenant', value: t })}><Icon name="edit" /></button>
        <button className="icon-btn" title="Delete company" onClick={() => openModal({ type: 'delete', kind: 'tenant', id: t.id, name: t.name })}><Icon name="trash" /></button>
      </>
    );
    body = (
      <>
        <div className="quick-add">
          <AddChip label="Machine" onClick={() => openModal({ type: 'host', tenantId: t.id })} />
          <AddChip label="Network" onClick={() => openModal({ type: 'network', tenantId: t.id })} />
          <AddChip label="Account" onClick={() => openModal({ type: 'credential', owner: { kind: 'tenant', id: t.id } })} />
        </div>
        {(t.slaNotes || t.adminNotes) && (
          <Section title="Notes">
            <KV k="SLA" v={t.slaNotes} />
            <KV k="Admin" v={t.adminNotes} />
          </Section>
        )}
        <Section title={`Machines · ${hosts.length}`}>
          <ul className="link-list">
            {hosts.map((h) => (
              <li key={h.id}>
                <button onClick={() => focus(`host:${h.id}`)}>
                  <Icon name={scene.byId.get(`host:${h.id}`)?.glyph ?? 'server'} size={14} />
                  <span>{h.name}</span>
                  <span className="mono dim">{h.interfaces.find((n) => n.isPrimary)?.internalIp ?? h.interfaces[0]?.internalIp}</span>
                </button>
              </li>
            ))}
          </ul>
          {hosts.length === 0 && <p className="muted small">No machines yet.</p>}
        </Section>
        {lookup.topo.services.some((s) => s.ownerTenantId === t.id) && (
          <Section title="Hosted on other companies' machines">
            <ul className="link-list">
              {lookup.topo.services.filter((s) => s.ownerTenantId === t.id).map((s) => (
                <li key={s.id}>
                  <button onClick={() => focusRef(s.id)}>
                    <Icon name="container" size={14} />
                    <span>{s.name}</span>
                    <span className="dim">{lookup.host.get(s.hostId)?.name} · {lookup.tenant.get(lookup.host.get(s.hostId)?.tenantId ?? '')?.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="Networks">
          {lookup.topo.networks.filter((n) => n.tenantId === t.id).map((n) => (
            <div key={n.id} className="kv clickable" onClick={() => openModal({ type: 'network', value: n })} title="Edit network">
              <span className="k">{n.name}</span>
              <span className="v mono">{n.cidr}{n.vlanId ? ` · VLAN ${n.vlanId}` : ''}{n.gateway ? ` · gw ${n.gateway}` : ''}</span>
            </div>
          ))}
          {lookup.topo.networks.filter((n) => n.tenantId === t.id).length === 0 && <p className="muted small">No networks documented.</p>}
        </Section>
        {creds('tenant', t.id)}
      </>
    );
  } else if (node?.kind === 'host') {
    const h = lookup.host.get(node.refId)!;
    const t = lookup.tenant.get(h.tenantId);
    const services = lookup.topo.services.filter((s) => s.hostId === h.id);
    const proxies = lookup.topo.proxies.filter((p) => p.hostId === h.id && !p.serviceId);
    title = h.name;
    kicker = `${CATEGORY_LABEL[h.category] ?? h.category} · ${t?.name ?? ''}`;
    glyph = node.glyph;
    accent = t?.color ?? accent;
    actions = (
      <>
        <button className="icon-btn" title="Edit machine" onClick={() => openModal({ type: 'host', value: h })}><Icon name="edit" /></button>
        <button className="icon-btn" title="Delete machine" onClick={() => openModal({ type: 'delete', kind: 'host', id: h.id, name: h.name })}><Icon name="trash" /></button>
      </>
    );
    const addr = h.fqdn ?? h.interfaces.find((n) => n.isPrimary)?.internalIp ?? h.interfaces[0]?.internalIp;
    body = (
      <>
        <div className="hud">
          <button className="hud-btn" disabled={!h.sshPort || !addr} onClick={() => ssh(h)} title={h.sshPort ? `ssh -p ${h.sshPort} ${addr ?? ''}` : 'No SSH port set'}>
            <Icon name="terminal" size={18} /><span>SSH</span><small>{h.sshPort ? `:${h.sshPort}` : '—'}</small>
          </button>
          <button className="hud-btn" disabled={!h.rdpPort || !addr} onClick={() => rdp(h)}>
            <Icon name="desktop" size={18} /><span>RDP</span><small>{h.rdpPort ? `:${h.rdpPort}` : '—'}</small>
          </button>
          <button className="hud-btn" disabled={!h.webAdminUrl} onClick={() => h.webAdminUrl && web(h.webAdminUrl)}>
            <Icon name="external" size={18} /><span>Web UI</span><small>{h.webAdminUrl ? portOf(h.webAdminUrl) : '—'}</small>
          </button>
        </div>
        <div className="quick-add">
          <AddChip label="Service" onClick={() => openModal({ type: 'service', hostId: h.id })} />
          <AddChip label="Proxy" onClick={() => openModal({ type: 'proxy', hostId: h.id })} />
          {['local_server', 'vps', 'nas'].includes(h.category) && <AddChip label="VM" onClick={() => openModal({ type: 'host', tenantId: h.tenantId, parentHostId: h.id })} />}
        </div>
        <Section title="Machine">
          <KV k="OS" v={labelOf(OS_FAMILIES, h.osFamily)} />
          <KV k="Provider" v={h.provider} />
          <KV k="Location" v={h.location} />
          <KV k="FQDN" v={h.fqdn} mono copy />
          {h.parentHostId && <KV k="Runs on" v={lookup.host.get(h.parentHostId)?.name} />}
          <KV k="Notes" v={h.notes} />
        </Section>
        <Section title="Network cards">
          {h.interfaces.map((n) => (
            <div key={n.id} className="nic">
              <div className="nic-head mono">{n.name} {n.isPrimary && <span className="pill">primary</span>}</div>
              <KV k="Private IP" v={n.internalIp} mono copy />
              <KV k="Gateway" v={n.gateway} mono />
              <KV k="Public IP" v={n.publicIp} mono copy />
              <KV k="Network" v={lookup.topo.networks.find((x) => x.id === n.networkId)?.name} />
              <KV k="MAC" v={n.mac} mono />
            </div>
          ))}
          {h.interfaces.length === 0 && <p className="muted small">No network cards — edit the machine to add its IPs.</p>}
        </Section>
        {(services.length > 0 || proxies.length > 0) && (
          <Section title={`Running here · ${services.length + proxies.length}`}>
            <ul className="link-list">
              {proxies.map((p) => (
                <li key={p.id}><button onClick={() => focusRef(p.id)}><Icon name="proxy" size={14} /><span>{p.name}</span><span className="mono dim">{p.routes.length} routes</span></button></li>
              ))}
              {services.map((s) => (
                <li key={s.id}>
                  <button onClick={() => focusRef(s.id)}>
                    <Icon name={scene.byId.get(scene.refToNode.get(s.id)!)?.glyph ?? 'container'} size={14} />
                    <span>{s.name}</span>
                    <span className="mono dim">{s.ports.map((p) => (p.hostPort ? `${p.hostPort}→${p.containerPort}` : p.containerPort)).join(', ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {creds('host', h.id, h)}
      </>
    );
  } else if (node?.kind === 'service' || node?.kind === 'proxy') {
    const s = lookup.service.get(node.refId);
    const proxy = lookup.proxy.get(node.refId) ?? (s ? lookup.proxyByService.get(s.id) : undefined);
    const h = lookup.host.get(node.hostId!)!;
    title = s?.name ?? proxy!.name;
    kicker = `${proxy ? `Reverse proxy · ${proxy.kind}` : `${labelOf(RUNTIMES, s!.runtime)} service`} · ${h.name}`;
    glyph = node.glyph;
    accent = node.accent;
    actions = (
      <>
        {s && <button className="icon-btn" title="Edit service" onClick={() => openModal({ type: 'service', value: s })}><Icon name="edit" /></button>}
        {proxy && !s && <button className="icon-btn" title="Edit proxy" onClick={() => openModal({ type: 'proxy', value: proxy })}><Icon name="edit" /></button>}
        <button
          className="icon-btn"
          title="Delete"
          onClick={() => (s ? openModal({ type: 'delete', kind: 'service', id: s.id, name: s.name }) : openModal({ type: 'delete', kind: 'proxy', id: proxy!.id, name: proxy!.name }))}
        >
          <Icon name="trash" />
        </button>
      </>
    );
    const endpoints = s ? serviceEndpoints(s, lookup) : [];
    const routesIn = s ? lookup.routesToService.get(s.id) ?? [] : [];
    body = (
      <>
        {endpoints.length > 0 && (
          <div className="launch">
            <button className="launch-btn" onClick={() => web(endpoints[0].url)}>
              <Icon name="external" size={18} />
              <span>Open <b>{endpoints[0].url.replace(/\/$/, '')}</b></span>
            </button>
          </div>
        )}
        <div className="quick-add">
          {s && <AddChip label="Public domain" onClick={() => (lookup.topo.proxies.length ? openModal({ type: 'service', value: s, publish: true }) : openModal({ type: 'proxy', hostId: h.id, routeForServiceId: s.id }))} />}
          {proxy && <AddChip label="Route" onClick={() => openModal({ type: 'proxy', value: proxy })} />}
          {s && !proxy && <AddChip label="Make it a proxy" onClick={() => openModal({ type: 'proxy', hostId: h.id, value: { id: '', hostId: h.id, serviceId: s.id, name: s.name, kind: 'nginx', adminUrl: null, routes: [] } })} />}
        </div>
        {s && (
          <Section title="Service">
            <KV k="Runs as" v={labelOf(RUNTIMES, s.runtime)} />
            <KV k="Image" v={s.image} mono copy />
            <KV k="App protocol" v={s.scheme.toUpperCase()} />
            <KV k="Machine" v={`${h.name}${h.interfaces[0]?.internalIp ? ` · ${h.interfaces[0].internalIp}` : ''}`} />
            <KV k="Owner" v={lookup.tenant.get(s.ownerTenantId ?? h.tenantId)?.name} />
            <KV k="Description" v={s.description} />
          </Section>
        )}
        {s && s.ports.length > 0 && (
          <Section title="Ports">
            <table className="ports">
              <thead><tr><th>internal</th><th /><th>published</th><th>bind</th><th>proto</th></tr></thead>
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
          <Section title="How to reach it">
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
          <Section key={route.id} title={`Route · ${route.domain}`} right={<TlsChip route={route} />}>
            <Trace route={route} proxy={p} />
          </Section>
        ))}
        {proxy && (
          <Section title={`Routes · ${proxy.routes.length}`} right={proxy.adminUrl ? <button className="chip-btn" onClick={() => web(proxy.adminUrl!)}><Icon name="external" size={12} /> admin</button> : undefined}>
            <table className="routes">
              <tbody>
                {proxy.routes.map((r) => (
                  <tr key={r.id} onClick={() => r.serviceId && focusRef(r.serviceId)}>
                    <td>
                      <div className="mono">{r.domain}{r.pathPrefix !== '/' ? r.pathPrefix : ''}</div>
                      <div className="dim mono small">:{r.inboundPort} → {r.targetIp}:{r.targetPort} {r.serviceId ? `· ${lookup.service.get(r.serviceId)?.name}` : ''}</div>
                    </td>
                    <td><TlsChip route={r} /></td>
                    <td><button className="icon-btn tiny" title={routeUrl(r)} onClick={(e) => (e.stopPropagation(), web(routeUrl(r)))}><Icon name="external" size={13} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {proxy.routes.length === 0 && <p className="muted small">No routes yet — use “+ Route” to publish a domain.</p>}
            {publicIp(h) && <KV k="Public address" v={`${publicIp(h)} (${h.name})`} mono />}
          </Section>
        )}
        {proxy && creds('proxy', proxy.id)}
        {s && creds('service', s.id)}
      </>
    );
  } else if (node?.kind === 'internet') {
    title = 'Public Internet';
    kicker = 'Everything published through a proxy';
    glyph = 'globe';
    accent = '#e9ecef';
    const all = lookup.topo.proxies.flatMap((p) => p.routes.map((r) => ({ r, p })));
    body = (
      <Section title={`Published domains · ${all.length}`}>
        <table className="routes">
          <tbody>
            {all.map(({ r, p }) => (
              <tr key={r.id} onClick={() => r.serviceId && focusRef(r.serviceId)}>
                <td>
                  <div className="mono">{r.domain}</div>
                  <div className="dim small">{p.name} → {r.serviceId ? lookup.service.get(r.serviceId)?.name : `${r.targetIp}:${r.targetPort}`}</div>
                </td>
                <td><TlsChip route={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {all.length === 0 && <p className="muted small">Nothing is published yet. Add a reverse proxy to a machine and give your services domains.</p>}
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
              {node.badges.map((b, i) => <span key={i} className={`badge-chip tone-${b.tone}`}>{b.label}</span>)}
            </div>
          )}
        </div>
        <div className="drawer-actions">
          {actions}
          <button className="icon-btn" onClick={() => select(null)} title="Close (Esc)"><Icon name="close" /></button>
        </div>
      </header>
      <div className="drawer-body">{body}</div>
    </aside>
  );
}
