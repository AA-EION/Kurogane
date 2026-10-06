import { useMemo, useState } from 'react';
import type { ProxyRoute, ReverseProxy } from '../api/types';
import { Icon } from '../components/Icon';
import { Button, Field, FormError, GroupedSelect, Modal, NumberInput, Section, Select, Text } from '../components/ui';
import { primaryIp } from '../canvas/layout';
import { INBOUND, PROXY_KINDS, TARGET_SCHEMES, TLS_MODES } from '../options';
import { useStore } from '../store';
import { blank, useSubmit } from './common';

function newRoute(): ProxyRoute {
  return {
    id: '',
    proxyId: '',
    domain: '',
    pathPrefix: '/',
    inboundPort: 443,
    inboundProtocol: 'https',
    tlsMode: 'letsencrypt',
    tlsExpiresAt: null,
    targetHostId: null,
    targetIp: '',
    targetPort: 0,
    targetScheme: 'http',
    serviceId: null,
    enabled: true,
  };
}

export function ProxyForm({ value, hostId, routeForServiceId }: { value?: ReverseProxy; hostId?: string; routeForServiceId?: string }) {
  const { backend, closeModal, topo, lookup } = useStore();
  const fillTarget = (r: ProxyRoute, serviceId: string | null): ProxyRoute => {
    const svc = serviceId ? lookup.service.get(serviceId) : undefined;
    if (!svc) return { ...r, serviceId: null };
    const host = lookup.host.get(svc.hostId);
    const p = svc.ports.find((x) => x.isPrimary) ?? svc.ports[0];
    return {
      ...r,
      serviceId,
      targetHostId: svc.hostId,
      targetIp: (host && primaryIp(host)) ?? r.targetIp,
      targetPort: p ? p.hostPort ?? p.containerPort : r.targetPort,
      targetScheme: svc.scheme === 'https' ? 'https' : 'http',
    };
  };
  const [p, setP] = useState<ReverseProxy>(() => {
    const base = value ?? { id: '', hostId: hostId ?? '', serviceId: null, name: 'nginx', kind: 'nginx', adminUrl: null, routes: [] };
    return routeForServiceId ? { ...base, routes: [...base.routes, fillTarget(newRoute(), routeForServiceId)] } : base;
  });
  const { busy, error, submit } = useSubmit();
  const set = (x: Partial<ReverseProxy>) => setP({ ...p, ...x });
  const setRoute = (i: number, r: Partial<ProxyRoute>) => set({ routes: p.routes.map((x, j) => (j === i ? { ...x, ...r } : x)) });

  const hostGroups = useMemo(
    () => topo.tenants.map((t) => ({ label: t.name, options: topo.hosts.filter((h) => h.tenantId === t.id).map((h) => ({ value: h.id, label: h.name })) })),
    [topo],
  );
  const serviceGroups = useMemo(
    () =>
      topo.hosts.map((h) => ({
        label: `${lookup.tenant.get(h.tenantId)?.name ?? ''} / ${h.name}`,
        options: topo.services.filter((s) => s.hostId === h.id).map((s) => ({ value: s.id, label: s.name })),
      })),
    [topo, lookup],
  );
  const sameHostServices = topo.services.filter((s) => s.hostId === p.hostId).map((s) => ({ value: s.id, label: s.name }));

  const save = () =>
    submit(
      () =>
        backend.saveProxy({
          ...p,
          serviceId: blank(p.serviceId),
          adminUrl: blank(p.adminUrl),
          routes: p.routes.filter((r) => r.domain.trim()).map((r) => ({ ...r, tlsMode: r.inboundProtocol === 'https' ? r.tlsMode : 'none', tlsExpiresAt: r.tlsExpiresAt ? `${r.tlsExpiresAt.slice(0, 10)}T00:00:00Z` : null })),
        }),
      value ? 'Proxy saved' : `Added ${p.name}`,
    );

  return (
    <form onSubmit={(e) => (e.preventDefault(), save())}>
      <Modal
        wide
        title={value?.id ? `Edit ${value.name}` : 'Add reverse proxy'}
        subtitle="Nginx, Nginx Proxy Manager, Traefik, Caddy or a Cloudflare Tunnel — and the domains it publishes."
        icon="proxy"
        onClose={closeModal}
        footer={<><Button onClick={closeModal}>Cancel</Button><Button kind="primary" type="submit" busy={busy} disabled={!p.name.trim() || !p.hostId}>{value?.id ? 'Save' : 'Add proxy'}</Button></>}
      >
        <div className="f-grid three">
          <Field label="Runs on machine" required>
            <GroupedSelect value={p.hostId} onChange={(hostId) => set({ hostId, serviceId: null })} groups={hostGroups} placeholder="Choose a machine" />
          </Field>
          <Field label="Name" required>
            <Text value={p.name} onChange={(name) => set({ name })} placeholder="nginx" autoFocus={!routeForServiceId} />
          </Field>
          <Field label="Kind">
            <Select value={p.kind} onChange={(kind) => set({ kind })} options={PROXY_KINDS} />
          </Field>
          <Field label="Is the service" hint="Optional: the container that is this proxy.">
            <Select value={p.serviceId} onChange={(serviceId) => set({ serviceId })} options={sameHostServices} allowEmpty placeholder="—" />
          </Field>
          <Field label="Admin URL" span={2}>
            <Text value={p.adminUrl} onChange={(adminUrl) => set({ adminUrl })} placeholder="http://10.0.0.5:81" mono />
          </Field>
        </div>

        <Section title={`Routes · ${p.routes.length}`} action={<button type="button" className="chip-btn" onClick={() => set({ routes: [...p.routes, newRoute()] })}><Icon name="plus" size={12} /> Add route</button>}>
          {p.routes.length === 0 && <p className="muted small">Each route maps a public domain to a service. Example: <code>app.example.com → 10.0.0.5:8080</code>.</p>}
          {p.routes.map((r, i) => (
            <div className="route-card" key={i}>
              <div className="route-line">
                <Field label="Domain" required>
                  <Text value={r.domain} onChange={(domain) => setRoute(i, { domain })} placeholder="app.example.com" mono autoFocus={!!routeForServiceId && i === p.routes.length - 1} />
                </Field>
                <Field label="Path">
                  <Text value={r.pathPrefix} onChange={(pathPrefix) => setRoute(i, { pathPrefix })} mono />
                </Field>
                <Field label="Inbound">
                  <Select value={r.inboundProtocol} onChange={(inboundProtocol) => setRoute(i, { inboundProtocol, inboundPort: inboundProtocol === 'http' ? 80 : inboundProtocol === 'https' ? 443 : r.inboundPort })} options={INBOUND} />
                </Field>
                <Field label="Port">
                  <NumberInput value={r.inboundPort} onChange={(v) => setRoute(i, { inboundPort: v ?? 0 })} />
                </Field>
                <Field label="TLS">
                  <Select value={r.inboundProtocol === 'https' ? r.tlsMode : 'none'} onChange={(tlsMode) => setRoute(i, { tlsMode })} options={TLS_MODES} />
                </Field>
                <Field label="Cert expires">
                  <input className="f-input mono" type="date" value={r.tlsExpiresAt?.slice(0, 10) ?? ''} onChange={(e) => setRoute(i, { tlsExpiresAt: e.target.value || null })} />
                </Field>
              </div>
              <div className="route-line target">
                <span className="arrow">→</span>
                <Field label="Target service">
                  <GroupedSelect value={r.serviceId} onChange={(sid) => setRoute(i, fillTarget(r, sid || null))} groups={serviceGroups} placeholder="(manual target)" />
                </Field>
                <Field label="Target IP" required>
                  <Text value={r.targetIp} onChange={(targetIp) => setRoute(i, { targetIp })} placeholder="10.0.0.5" mono />
                </Field>
                <Field label="Target port" required>
                  <NumberInput value={r.targetPort || null} onChange={(v) => setRoute(i, { targetPort: v ?? 0 })} placeholder="8080" />
                </Field>
                <Field label="Scheme">
                  <Select value={r.targetScheme} onChange={(targetScheme) => setRoute(i, { targetScheme })} options={TARGET_SCHEMES} />
                </Field>
                <button type="button" className="icon-btn" title="Remove route" onClick={() => set({ routes: p.routes.filter((_, j) => j !== i) })}><Icon name="trash" size={14} /></button>
              </div>
            </div>
          ))}
        </Section>
        <FormError error={error} />
      </Modal>
    </form>
  );
}
