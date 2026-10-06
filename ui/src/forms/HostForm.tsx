import { useState } from 'react';
import type { Host, NetworkInterface } from '../api/types';
import { Icon } from '../components/Icon';
import { Button, Field, FormError, Modal, NumberInput, Section, Select, Text, TextArea } from '../components/ui';
import { CATEGORIES, OS_FAMILIES } from '../options';
import { useStore } from '../store';
import { blank, useSubmit } from './common';

const NO_SHELL = new Set(['switch', 'access_point', 'nvr']);

function newCard(first: boolean): NetworkInterface {
  return { id: '', hostId: '', name: first ? 'eth0' : '', internalIp: null, gateway: null, publicIp: null, mac: null, networkId: null, isPrimary: first };
}

export function HostForm({ value, tenantId, parentHostId }: { value?: Host; tenantId?: string; parentHostId?: string }) {
  const { backend, closeModal, topo } = useStore();
  const [h, setH] = useState<Host>(
    value ?? {
      id: '',
      tenantId: tenantId ?? topo.tenants[0]?.id ?? '',
      parentHostId: parentHostId ?? null,
      name: '',
      category: parentHostId ? 'vm' : 'vps',
      osFamily: 'linux',
      fqdn: null,
      sshPort: 22,
      rdpPort: null,
      winrmPort: null,
      webAdminUrl: null,
      provider: null,
      location: null,
      icon: null,
      notes: null,
      interfaces: [newCard(true)],
    },
  );
  const { busy, error, submit } = useSubmit();
  const set = (p: Partial<Host>) => setH({ ...h, ...p });
  const setCard = (i: number, p: Partial<NetworkInterface>) =>
    set({ interfaces: h.interfaces.map((n, j) => (j === i ? { ...n, ...p } : p.isPrimary ? { ...n, isPrimary: false } : n)) });
  const networks = topo.networks.filter((n) => n.tenantId === h.tenantId);
  const parents = topo.hosts.filter((x) => x.tenantId === h.tenantId && x.id !== h.id && ['local_server', 'vps', 'nas', 'workstation'].includes(x.category));

  const onCategory = (category: string) => {
    const p: Partial<Host> = { category: category as Host['category'] };
    if (NO_SHELL.has(category)) Object.assign(p, { osFamily: 'embedded', sshPort: category === 'switch' ? h.sshPort : null });
    if (category === 'router' && !h.osFamily) p.osFamily = 'embedded';
    set(p);
  };
  const onOs = (osFamily: string) => {
    const p: Partial<Host> = { osFamily: osFamily || null };
    if (osFamily === 'windows') Object.assign(p, { rdpPort: h.rdpPort ?? 3389, sshPort: h.sshPort === 22 ? null : h.sshPort });
    if (osFamily === 'linux' && h.sshPort == null) p.sshPort = 22;
    set(p);
  };

  const save = () =>
    submit(
      () =>
        backend.saveHost({
          ...h,
          parentHostId: blank(h.parentHostId),
          fqdn: blank(h.fqdn),
          webAdminUrl: blank(h.webAdminUrl),
          provider: blank(h.provider),
          location: blank(h.location),
          notes: blank(h.notes),
          interfaces: h.interfaces
            .filter((n) => n.name.trim() || n.internalIp || n.publicIp)
            .map((n, i) => ({ ...n, name: n.name.trim() || `eth${i}`, internalIp: blank(n.internalIp), publicIp: blank(n.publicIp), gateway: blank(n.gateway), mac: blank(n.mac), networkId: blank(n.networkId) })),
        }),
      value ? 'Machine saved' : `Added ${h.name}`,
    );

  return (
    <form onSubmit={(e) => (e.preventDefault(), save())}>
      <Modal
        wide
        title={value ? `Edit ${value.name}` : 'Add machine'}
        subtitle="Servers, VPS, VMs and network devices — anything with an address."
        icon="server"
        onClose={closeModal}
        footer={<><Button onClick={closeModal}>Cancel</Button><Button kind="primary" type="submit" busy={busy} disabled={!h.name.trim() || !h.tenantId}>{value ? 'Save' : 'Add machine'}</Button></>}
      >
        <div className="f-grid three">
          <Field label="Company" required>
            <Select value={h.tenantId} onChange={(tenantId) => set({ tenantId, parentHostId: null, interfaces: h.interfaces.map((n) => ({ ...n, networkId: null })) })} options={topo.tenants.map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
          <Field label="Name" required>
            <Text value={h.name} onChange={(name) => set({ name })} placeholder="vps-01, office-server, core-switch" autoFocus />
          </Field>
          <Field label="Type">
            <Select value={h.category} onChange={onCategory} options={CATEGORIES} />
          </Field>
          <Field label="Operating system">
            <Select value={h.osFamily} onChange={onOs} options={OS_FAMILIES} allowEmpty placeholder="Unknown" />
          </Field>
          <Field label="Runs on" hint="For VMs: the hypervisor / host machine.">
            <Select value={h.parentHostId} onChange={(parentHostId) => set({ parentHostId })} options={parents.map((p) => ({ value: p.id, label: p.name }))} allowEmpty placeholder="— (bare metal / cloud)" />
          </Field>
          <Field label="FQDN / hostname">
            <Text value={h.fqdn} onChange={(fqdn) => set({ fqdn })} placeholder="vps-01.example.com" mono />
          </Field>
        </div>

        <Section
          title="Network cards"
          action={<button type="button" className="chip-btn" onClick={() => set({ interfaces: [...h.interfaces, newCard(h.interfaces.length === 0)] })}><Icon name="plus" size={12} /> Add card</button>}
        >
          <div className="rows">
            <div className="row-head nic-row">
              <span>Name</span><span>Private IP</span><span>Gateway</span><span>Public IP</span><span>Network</span><span title="Primary">Primary</span><span />
            </div>
            {h.interfaces.map((n, i) => (
              <div className="nic-row" key={i}>
                <Text value={n.name} onChange={(name) => setCard(i, { name })} placeholder="eth0" mono />
                <Text value={n.internalIp} onChange={(internalIp) => setCard(i, { internalIp })} placeholder="10.0.0.5" mono />
                <Text value={n.gateway} onChange={(gateway) => setCard(i, { gateway })} placeholder="10.0.0.1" mono />
                <Text value={n.publicIp} onChange={(publicIp) => setCard(i, { publicIp })} placeholder="optional" mono />
                <Select value={n.networkId} onChange={(networkId) => setCard(i, { networkId })} options={networks.map((x) => ({ value: x.id, label: `${x.name} (${x.cidr})` }))} allowEmpty placeholder="—" />
                <input type="radio" name="primary-nic" checked={n.isPrimary} onChange={() => setCard(i, { isPrimary: true })} title="Primary card (used for SSH/RDP)" />
                <button type="button" className="icon-btn tiny" title="Remove" onClick={() => set({ interfaces: h.interfaces.filter((_, j) => j !== i) })}><Icon name="trash" size={13} /></button>
              </div>
            ))}
            {h.interfaces.length === 0 && <p className="muted small">No network cards. Add one so Kurogane knows how to reach this machine.</p>}
          </div>
        </Section>

        <Section title="Remote access">
          <div className="f-grid three">
            <Field label="SSH port" hint="Empty = no SSH">
              <NumberInput value={h.sshPort} onChange={(sshPort) => set({ sshPort })} placeholder="22" />
            </Field>
            <Field label="RDP port" hint="Empty = no RDP">
              <NumberInput value={h.rdpPort} onChange={(rdpPort) => set({ rdpPort })} placeholder="3389" />
            </Field>
            <Field label="Web admin URL" hint="Router / NVR / hypervisor UI">
              <Text value={h.webAdminUrl} onChange={(webAdminUrl) => set({ webAdminUrl })} placeholder="https://192.168.1.1" mono />
            </Field>
          </div>
        </Section>

        <Section title="Details">
          <div className="f-grid three">
            <Field label="Provider">
              <Text value={h.provider} onChange={(provider) => set({ provider })} placeholder="Hetzner, OVH, office rack" />
            </Field>
            <Field label="Location">
              <Text value={h.location} onChange={(location) => set({ location })} />
            </Field>
            <Field label="Notes" span={3}>
              <TextArea value={h.notes} onChange={(notes) => set({ notes })} rows={2} />
            </Field>
          </div>
        </Section>
        <FormError error={error} />
      </Modal>
    </form>
  );
}
