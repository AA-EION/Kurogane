import { useMemo, useState } from 'react';
import type { ProxyRoute, Service, ServicePort } from '../api/types';
import { Icon } from '../components/Icon';
import { Button, Field, FormError, GroupedSelect, Modal, NumberInput, Section, Select, Text, TextArea } from '../components/ui';
import { primaryIp } from '../canvas/layout';
import { INBOUND, PROTOCOLS, RUNTIMES, SCHEMES, TLS_MODES } from '../options';
import { errorText, useStore } from '../store';
import { blank } from './common';

interface NewDomain {
  proxyId: string;
  domain: string;
  inboundProtocol: string;
  inboundPort: number | null;
  tlsMode: string;
}

const port = (first: boolean): ServicePort => ({ id: '', serviceId: '', containerPort: 0, hostPort: null, bindAddress: '0.0.0.0', protocol: 'tcp', isPrimary: first });

export function ServiceForm({ value, hostId, publish }: { value?: Service; hostId?: string; publish?: boolean }) {
  const { backend, closeModal, topo, lookup, applyTopology, toast } = useStore();
  const [s, setS] = useState<Service>(
    value ?? { id: '', hostId: hostId ?? '', name: '', runtime: 'docker', image: null, scheme: 'http', healthPath: null, description: null, icon: null, ownerTenantId: null, ports: [port(true)] },
  );
  const [domains, setDomains] = useState<NewDomain[]>(
    publish && topo.proxies.length ? [{ proxyId: topo.proxies[0].id, domain: '', inboundProtocol: 'https', inboundPort: 443, tlsMode: 'letsencrypt' }] : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<Service>) => setS({ ...s, ...p });
  const setPort = (i: number, p: Partial<ServicePort>) => set({ ports: s.ports.map((x, j) => (j === i ? { ...x, ...p } : p.isPrimary ? { ...x, isPrimary: false } : x)) });

  const hostGroups = useMemo(
    () => topo.tenants.map((t) => ({ label: t.name, options: topo.hosts.filter((h) => h.tenantId === t.id).map((h) => ({ value: h.id, label: h.name })) })),
    [topo],
  );
  const proxyOptions = topo.proxies.map((p) => {
    const h = lookup.host.get(p.hostId);
    return { value: p.id, label: `${p.name} on ${h?.name ?? '?'} (${lookup.tenant.get(h?.tenantId ?? '')?.name ?? ''})` };
  });
  const existingRoutes = value ? lookup.routesToService.get(value.id) ?? [] : [];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const ports = s.ports.filter((p) => p.containerPort > 0);
      const pending = domains.filter((d) => d.domain.trim());
      if (pending.some((d) => !d.proxyId || !topo.proxies.some((p) => p.id === d.proxyId))) throw new Error('Choose a reverse proxy for each domain');
      if (new Set(pending.map((d) => `${d.proxyId}:${d.domain.trim()}`)).size !== pending.length) throw new Error('Each domain should appear once per proxy');
      if (pending.length) {
        const host = topo.hosts.find((h) => h.id === s.hostId);
        if (!host || !primaryIp(host)) throw new Error('The machine needs a network card with a private IP before a proxy can route to it');
        if (!ports.length) throw new Error('Add a port so the proxy knows where to send traffic');
      }
      const saved = await backend.saveService({ ...s, image: blank(s.image), description: blank(s.description), ownerTenantId: blank(s.ownerTenantId), ports });
      let topology = saved.topology;
      // Preserve the assigned ID immediately: a later proxy failure must not
      // create another service on retry or hide successfully saved changes.
      setS(topology.services.find((service) => service.id === saved.id)!);
      applyTopology(topology, saved.id);
      if (pending.length) {
        const host = topology.hosts.find((h) => h.id === s.hostId);
        const svc = topology.services.find((x) => x.id === saved.id)!;
        const prim = svc.ports.find((p) => p.isPrimary) ?? svc.ports[0];
        const targetIp = host ? primaryIp(host) : undefined;
        if (!targetIp) throw new Error('The machine needs a network card with a private IP before a proxy can route to it');
        if (!prim) throw new Error('Add a port so the proxy knows where to send traffic');
        for (const proxyId of [...new Set(pending.map((d) => d.proxyId))]) {
          const proxy = topology.proxies.find((p) => p.id === proxyId)!;
          const routes: ProxyRoute[] = pending
            .filter((d) => d.proxyId === proxyId && !proxy.routes.some((r) => r.serviceId === saved.id && r.domain === d.domain.trim() && r.pathPrefix === '/'))
            .map((d) => ({
              id: '',
              proxyId,
              domain: d.domain.trim(),
              pathPrefix: '/',
              inboundPort: d.inboundPort ?? (d.inboundProtocol === 'http' ? 80 : 443),
              inboundProtocol: d.inboundProtocol,
              tlsMode: d.inboundProtocol === 'https' ? d.tlsMode : 'none',
              tlsExpiresAt: null,
              targetHostId: s.hostId,
              targetIp,
              targetPort: prim.hostPort ?? prim.containerPort,
              targetScheme: svc.scheme === 'https' ? 'https' : 'http',
              serviceId: saved.id,
              enabled: true,
            }));
          topology = (await backend.saveProxy({ ...proxy, routes: [...proxy.routes, ...routes] })).topology;
          applyTopology(topology, saved.id);
        }
      }
      applyTopology(topology, saved.id);
      closeModal();
      toast(value ? 'Service saved' : `Added ${s.name}`, 'ok');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => (e.preventDefault(), save())}>
      <Modal
        wide
        title={value ? `Edit ${value.name}` : 'Add service'}
        subtitle="A container, VM service, SMB share or native daemon running on a machine."
        icon="container"
        onClose={closeModal}
        footer={<><Button onClick={closeModal}>Cancel</Button><Button kind="primary" type="submit" busy={busy} disabled={!s.name.trim() || !s.hostId}>{value ? 'Save' : 'Add service'}</Button></>}
      >
        <div className="f-grid three">
          <Field label="Machine" required>
            <GroupedSelect value={s.hostId} onChange={(hostId) => set({ hostId })} groups={hostGroups} placeholder="Choose a machine" />
          </Field>
          <Field label="Name" required>
            <Text value={s.name} onChange={(name) => set({ name })} placeholder="website, gitea, postgres" autoFocus />
          </Field>
          <Field label="Runs as">
            <Select value={s.runtime} onChange={(runtime) => set({ runtime })} options={RUNTIMES} />
          </Field>
          <Field label="Image / package" span={2}>
            <Text value={s.image} onChange={(image) => set({ image })} placeholder="nginx:1.27, wordpress:6" mono />
          </Field>
          <Field label="App protocol" hint="What the app itself speaks, before any proxy.">
            <Select value={s.scheme} onChange={(scheme) => set({ scheme })} options={SCHEMES} />
          </Field>
          <Field label="Owned by" hint="Only if it isn't the machine's company — e.g. your own site on your employer's VPS." span={3}>
            <Select
              value={s.ownerTenantId}
              onChange={(ownerTenantId) => set({ ownerTenantId: ownerTenantId || null })}
              options={topo.tenants.filter((t) => t.id !== lookup.host.get(s.hostId)?.tenantId).map((t) => ({ value: t.id, label: t.name }))}
              allowEmpty
              placeholder={`Same as the machine (${lookup.tenant.get(lookup.host.get(s.hostId)?.tenantId ?? '')?.name ?? '—'})`}
            />
          </Field>
        </div>

        <Section title="Ports" action={<button type="button" className="chip-btn" onClick={() => set({ ports: [...s.ports, port(s.ports.length === 0)] })}><Icon name="plus" size={12} /> Add port</button>}>
          <div className="rows">
            <div className="row-head port-row"><span>Internal port</span><span>Published on machine</span><span>Bind address</span><span>Protocol</span><span>Primary</span><span /></div>
            {s.ports.map((p, i) => (
              <div className="port-row" key={i}>
                <NumberInput value={p.containerPort || null} onChange={(v) => setPort(i, { containerPort: v ?? 0 })} placeholder="80" />
                <NumberInput value={p.hostPort} onChange={(hostPort) => setPort(i, { hostPort })} placeholder="not published" />
                <Text value={p.bindAddress} onChange={(bindAddress) => setPort(i, { bindAddress })} mono />
                <Select value={p.protocol} onChange={(protocol) => setPort(i, { protocol })} options={PROTOCOLS} />
                <input type="radio" name="primary-port" checked={p.isPrimary} onChange={() => setPort(i, { isPrimary: true })} />
                <button type="button" className="icon-btn tiny" onClick={() => set({ ports: s.ports.filter((_, j) => j !== i) })}><Icon name="trash" size={13} /></button>
              </div>
            ))}
          </div>
          <p className="muted small">Internal = the port the app listens on (inside the container). Published = the port on the machine's IP (Docker <code>-p 8080:80</code> → published 8080, internal 80).</p>
        </Section>

        <Section
          title="Public domains (through a reverse proxy)"
          action={
            topo.proxies.length > 0 ? (
              <button type="button" className="chip-btn" onClick={() => setDomains([...domains, { proxyId: topo.proxies[0].id, domain: '', inboundProtocol: 'https', inboundPort: 443, tlsMode: 'letsencrypt' }])}>
                <Icon name="plus" size={12} /> Add domain
              </button>
            ) : undefined
          }
        >
          {existingRoutes.map(({ route, proxy }) => (
            <div key={route.id} className="route-pill"><Icon name="globe" size={13} /> <span className="mono">{route.domain}</span> <span className="muted">via {proxy.name} → :{route.targetPort}</span></div>
          ))}
          {topo.proxies.length === 0 && <p className="muted small">No reverse proxy yet. Add one to a machine (e.g. your nginx) and then publish domains here.</p>}
          {domains.map((d, i) => (
            <div className="domain-row" key={i}>
              <Select value={d.proxyId} onChange={(proxyId) => setDomains(domains.map((x, j) => (j === i ? { ...x, proxyId } : x)))} options={proxyOptions} />
              <Text value={d.domain} onChange={(domain) => setDomains(domains.map((x, j) => (j === i ? { ...x, domain } : x)))} placeholder="app.example.com" mono />
              <Select value={d.inboundProtocol} onChange={(inboundProtocol) => setDomains(domains.map((x, j) => (j === i ? { ...x, inboundProtocol, inboundPort: inboundProtocol === 'http' ? 80 : 443 } : x)))} options={INBOUND} />
              <NumberInput value={d.inboundPort} onChange={(inboundPort) => setDomains(domains.map((x, j) => (j === i ? { ...x, inboundPort } : x)))} />
              <Select value={d.tlsMode} onChange={(tlsMode) => setDomains(domains.map((x, j) => (j === i ? { ...x, tlsMode } : x)))} options={TLS_MODES} />
              <button type="button" className="icon-btn tiny" onClick={() => setDomains(domains.filter((_, j) => j !== i))}><Icon name="trash" size={13} /></button>
            </div>
          ))}
        </Section>

        <Field label="Description" span={3}>
          <TextArea value={s.description} onChange={(description) => set({ description })} rows={2} />
        </Field>
        <FormError error={error} />
      </Modal>
    </form>
  );
}
