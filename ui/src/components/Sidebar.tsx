import { useMemo, useState } from 'react';
import type { CredentialMeta, Host } from '../api/types';
import { primaryIp } from '../canvas/layout';
import { CREDENTIAL_KINDS, labelOf } from '../options';
import { useRun, useStore } from '../store';
import { Icon } from './Icon';

type Tab = 'inventory' | 'accounts';

export function Sidebar() {
  const [tab, setTab] = useState<Tab>('inventory');
  const [q, setQ] = useState('');
  return (
    <aside className="sidebar">
      <div className="side-tabs">
        <button className={tab === 'inventory' ? 'on' : ''} onClick={() => setTab('inventory')}><Icon name="list" size={14} /> Inventory</button>
        <button className={tab === 'accounts' ? 'on' : ''} onClick={() => setTab('accounts')}><Icon name="key" size={14} /> Accounts</button>
      </div>
      <div className="side-filter">
        <Icon name="search" size={14} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'inventory' ? 'Filter…' : 'Find an account…'} spellCheck={false} />
        {q && <button className="icon-btn tiny" onClick={() => setQ('')}><Icon name="close" size={12} /></button>}
      </div>
      {tab === 'inventory' ? <Inventory q={q.trim().toLowerCase()} /> : <Accounts q={q.trim().toLowerCase()} />}
    </aside>
  );
}

function Inventory({ q }: { q: string }) {
  const { topo, scene, selected, focus, openModal } = useStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const match = (...xs: (string | null | undefined)[]) => !q || xs.some((x) => x?.toLowerCase().includes(q));
  const hostMatches = (h: Host) =>
    match(h.name, h.fqdn, ...h.interfaces.flatMap((n) => [n.internalIp, n.publicIp])) ||
    topo.services.some((s) => s.hostId === h.id && match(s.name, s.image)) ||
    topo.proxies.some((p) => p.hostId === h.id && (match(p.name) || p.routes.some((r) => match(r.domain))));
  const node = (ref: string) => scene.refToNode.get(ref);
  const glyph = (ref: string) => scene.byId.get(node(ref) ?? '')?.glyph ?? 'server';

  return (
    <div className="tree">
      {topo.tenants.map((t) => {
        const hosts = topo.hosts.filter((h) => h.tenantId === t.id && hostMatches(h));
        if (q && !match(t.name) && hosts.length === 0) return null;
        const open = !collapsed.has(t.id) || !!q;
        return (
          <div key={t.id} className="tree-group">
            <div className={`tree-row tenant ${selected === node(t.id) ? 'on' : ''}`} style={{ ['--tc' as string]: t.color ?? '#868e96' }}>
              <button className="twisty" onClick={() => toggle(t.id)}><Icon name="chevron" size={12} className={open ? 'open' : ''} /></button>
              <button className="tree-main" onClick={() => focus(node(t.id)!)}>
                <i className="dot" />
                <span className="name">{t.name}</span>
                <span className="count">{topo.hosts.filter((h) => h.tenantId === t.id).length}</span>
              </button>
              <button className="tree-add" title="Add machine" onClick={() => openModal({ type: 'host', tenantId: t.id })}><Icon name="plus" size={13} /></button>
            </div>
            {open && (
              <div className="tree-children">
                {hosts.map((h) => {
                  const kids = [
                    ...topo.proxies.filter((p) => p.hostId === h.id && !p.serviceId).map((p) => ({ id: p.id, name: p.name, sub: `${p.routes.length} routes`, icon: 'proxy' })),
                    ...topo.services.filter((s) => s.hostId === h.id).map((s) => ({
                      id: s.id,
                      name: s.name,
                      sub: s.ports.map((p) => p.hostPort ?? p.containerPort).join(', '),
                      icon: glyph(s.id),
                    })),
                  ];
                  return (
                    <div key={h.id}>
                      <div className={`tree-row host ${selected === node(h.id) ? 'on' : ''}`}>
                        <button className="tree-main" onClick={() => focus(node(h.id)!)}>
                          <Icon name={glyph(h.id)} size={14} />
                          <span className="name">{h.name}</span>
                          <span className="sub mono">{primaryIp(h) ?? ''}</span>
                        </button>
                        <button className="tree-add" title="Add service" onClick={() => openModal({ type: 'service', hostId: h.id })}><Icon name="plus" size={13} /></button>
                      </div>
                      {kids.map((k) => (
                        <div key={k.id} className={`tree-row leaf ${selected === node(k.id) ? 'on' : ''}`}>
                          <button className="tree-main" onClick={() => focus(node(k.id)!)}>
                            <Icon name={k.icon} size={13} />
                            <span className="name">{k.name}</span>
                            <span className="sub mono">{k.sub}</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })}
                {topo.services.filter((s) => s.ownerTenantId === t.id && match(s.name)).map((s) => (
                  <div key={`own-${s.id}`} className={`tree-row leaf ${selected === node(s.id) ? 'on' : ''}`}>
                    <button className="tree-main" onClick={() => focus(node(s.id)!)} title="Owned by this company, hosted elsewhere">
                      <Icon name={glyph(s.id)} size={13} />
                      <span className="name">{s.name}</span>
                      <span className="sub">on {topo.hosts.find((h) => h.id === s.hostId)?.name}</span>
                    </button>
                  </div>
                ))}
                {hosts.length === 0 && !q && (
                  <button className="tree-empty" onClick={() => openModal({ type: 'host', tenantId: t.id })}>+ Add the first machine</button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="tree-actions">
        <button onClick={() => openModal({ type: 'tenant' })}><Icon name="plus" size={13} /> Company</button>
        <button onClick={() => openModal({ type: 'import' })}><Icon name="upload" size={13} /> Import</button>
      </div>
    </div>
  );
}

function ownerPath(c: CredentialMeta, l: ReturnType<typeof useStore>['lookup']): { tenant: string; path: string; nodeRef: string } {
  switch (c.owner.kind) {
    case 'tenant':
      return { tenant: l.tenant.get(c.owner.id)?.name ?? '', path: 'company', nodeRef: c.owner.id };
    case 'host': {
      const h = l.host.get(c.owner.id);
      return { tenant: l.tenant.get(h?.tenantId ?? '')?.name ?? '', path: h?.name ?? '', nodeRef: c.owner.id };
    }
    case 'service': {
      const s = l.service.get(c.owner.id);
      const h = l.host.get(s?.hostId ?? '');
      return { tenant: l.tenant.get(s?.ownerTenantId ?? h?.tenantId ?? '')?.name ?? '', path: `${h?.name} / ${s?.name}`, nodeRef: c.owner.id };
    }
    case 'proxy': {
      const p = l.proxy.get(c.owner.id);
      const h = l.host.get(p?.hostId ?? '');
      return { tenant: l.tenant.get(h?.tenantId ?? '')?.name ?? '', path: `${h?.name} / ${p?.name}`, nodeRef: c.owner.id };
    }
  }
}

function Accounts({ q }: { q: string }) {
  const { topo, lookup, openModal } = useStore();
  const rows = useMemo(
    () =>
      topo.credentials
        .map((c) => ({ c, ...ownerPath(c, lookup) }))
        .filter(({ c, tenant, path }) => !q || [c.label, c.username, c.url, tenant, path, labelOf(CREDENTIAL_KINDS, c.kind)].some((x) => x?.toLowerCase().includes(q)))
        .sort((a, b) => a.tenant.localeCompare(b.tenant) || a.path.localeCompare(b.path) || a.c.label.localeCompare(b.c.label)),
    [topo, lookup, q],
  );
  let lastTenant = '';
  return (
    <div className="accounts">
      {rows.map((r) => {
        const header = r.tenant !== lastTenant ? <div className="acc-tenant" key={`t-${r.tenant}`}>{r.tenant}</div> : null;
        lastTenant = r.tenant;
        return (
          <div key={r.c.id}>
            {header}
            <AccountRow c={r.c} path={r.path} nodeRef={r.nodeRef} />
          </div>
        );
      })}
      {rows.length === 0 && <p className="muted small pad">{topo.credentials.length ? 'No matching accounts.' : 'No accounts yet.'}</p>}
      <div className="tree-actions">
        <button onClick={() => openModal({ type: 'credential' })} disabled={!topo.tenants.length}><Icon name="plus" size={13} /> Account</button>
      </div>
    </div>
  );
}

function AccountRow({ c, path, nodeRef }: { c: CredentialMeta; path: string; nodeRef: string }) {
  const { backend, toast, focusRef, openModal } = useStore();
  const run = useRun();
  const [shown, setShown] = useState<string | null>(null);
  const field = c.hasSecret ? 'secret' : c.hasPrivateKey ? 'privateKey' : null;
  return (
    <div className="acc-row">
      <button className="acc-main" onClick={() => focusRef(nodeRef)} title="Show on map">
        <span className="acc-label">{c.label}</span>
        <span className="acc-sub">{labelOf(CREDENTIAL_KINDS, c.kind)} · {path}</span>
        {c.username && <span className="acc-user mono">{c.username}</span>}
        {shown && <span className="acc-secret mono">{shown}</span>}
      </button>
      <div className="acc-actions">
        {c.username && (
          <button className="icon-btn tiny" title="Copy username" onClick={() => run(async () => { await backend.copyText(c.username!); toast('Username copied', 'ok'); })}>
            <Icon name="user" size={13} />
          </button>
        )}
        {field && (
          <>
            <button className="icon-btn tiny" title={shown ? 'Hide' : 'Reveal for 10 s'} onClick={() => run(async () => {
              if (shown) return setShown(null);
              setShown(await backend.reveal(c.id, field));
              setTimeout(() => setShown(null), 10_000);
            })}>
              <Icon name={shown ? 'eyeOff' : 'eye'} size={13} />
            </button>
            <button className="icon-btn tiny" title="Copy password (auto-clears)" onClick={() => run(async () => {
              const r = await backend.copySecret(c.id, field);
              toast(`Copied — clipboard clears in ${r.clearsInSecs}s`, 'ok');
            })}>
              <Icon name="copy" size={13} />
            </button>
          </>
        )}
        {c.url && <button className="icon-btn tiny" title={c.url} onClick={() => run(() => backend.launchWeb(c.url!))}><Icon name="external" size={13} /></button>}
        <button className="icon-btn tiny" title="Edit" onClick={() => openModal({ type: 'credential', value: c })}><Icon name="edit" size={13} /></button>
      </div>
    </div>
  );
}
