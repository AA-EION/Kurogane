import { useState } from 'react';
import type { Network } from '../api/types';
import { Button, Field, FormError, Modal, NumberInput, Select, Text } from '../components/ui';
import { NETWORK_KINDS } from '../options';
import { useStore } from '../store';
import { blank, useSubmit } from './common';

export function NetworkForm({ value, tenantId }: { value?: Network; tenantId?: string }) {
  const { backend, closeModal, topo } = useStore();
  const [n, setN] = useState<Network>(value ?? { id: '', tenantId: tenantId ?? topo.tenants[0]?.id ?? '', name: '', kind: 'lan', cidr: '', vlanId: null, gateway: null });
  const { busy, error, submit } = useSubmit();
  const set = (p: Partial<Network>) => setN({ ...n, ...p });
  return (
    <form onSubmit={(e) => (e.preventDefault(), submit(() => backend.saveNetwork({ ...n, gateway: blank(n.gateway) }), value ? 'Network saved' : `Added ${n.name}`))}>
      <Modal
        title={value ? `Edit ${value.name}` : 'Add network'}
        subtitle="Subnets let you attach network cards and keep IP plans documented."
        icon="switch"
        onClose={closeModal}
        footer={<><Button onClick={closeModal}>Cancel</Button><Button kind="primary" type="submit" busy={busy} disabled={!n.name.trim() || !n.cidr.trim() || !n.tenantId}>Save</Button></>}
      >
        <div className="f-grid">
          <Field label="Company" required span={2}>
            <Select value={n.tenantId} onChange={(tenantId) => set({ tenantId })} options={topo.tenants.map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
          <Field label="Name" required>
            <Text value={n.name} onChange={(name) => set({ name })} placeholder="Office LAN" autoFocus />
          </Field>
          <Field label="Kind">
            <Select value={n.kind} onChange={(kind) => set({ kind })} options={NETWORK_KINDS} />
          </Field>
          <Field label="CIDR" required>
            <Text value={n.cidr} onChange={(cidr) => set({ cidr })} placeholder="192.168.1.0/24" mono />
          </Field>
          <Field label="Gateway">
            <Text value={n.gateway} onChange={(gateway) => set({ gateway })} placeholder="192.168.1.1" mono />
          </Field>
          <Field label="VLAN">
            <NumberInput value={n.vlanId} onChange={(vlanId) => set({ vlanId })} max={4094} />
          </Field>
        </div>
        <FormError error={error} />
      </Modal>
    </form>
  );
}
