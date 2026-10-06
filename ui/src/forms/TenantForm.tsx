import { useState } from 'react';
import type { Tenant } from '../api/types';
import { Button, Field, FormError, Modal, Segmented, Text, TextArea } from '../components/ui';
import { ENVIRONMENTS, TENANT_COLORS } from '../options';
import { useStore } from '../store';
import { blank, useSubmit } from './common';

export function TenantForm({ value }: { value?: Tenant }) {
  const { backend, closeModal, topo } = useStore();
  const [t, setT] = useState<Tenant>(
    value ?? { id: '', name: '', environment: 'corporate', environmentLabel: null, color: TENANT_COLORS[topo.tenants.length % TENANT_COLORS.length], slaNotes: null, adminNotes: null },
  );
  const { busy, error, submit } = useSubmit();
  const set = (p: Partial<Tenant>) => setT({ ...t, ...p });
  return (
    <form onSubmit={(e) => (e.preventDefault(), submit(() => backend.saveTenant({ ...t, environmentLabel: blank(t.environmentLabel), slaNotes: blank(t.slaNotes), adminNotes: blank(t.adminNotes) }), value ? 'Company saved' : `Added ${t.name}`))}>
      <Modal
        title={value ? `Edit ${value.name}` : 'Add company'}
        subtitle="A company groups the machines, services and accounts it owns."
        icon="shield"
        onClose={closeModal}
        footer={<><Button onClick={closeModal}>Cancel</Button><Button kind="primary" type="submit" busy={busy} disabled={!t.name.trim()}>{value ? 'Save' : 'Add company'}</Button></>}
      >
        <div className="f-grid">
          <Field label="Name" required span={2}>
            <Text value={t.name} onChange={(name) => set({ name })} placeholder="e.g. ACME Corp, My homelab" autoFocus />
          </Field>
          <Field label="Type" span={2}>
            <Segmented value={t.environment} onChange={(environment) => set({ environment: environment as Tenant['environment'] })} options={ENVIRONMENTS} />
          </Field>
          <Field label="Tag" hint="Shown on the map, e.g. “Client Alpha”, “Personal”.">
            <Text value={t.environmentLabel} onChange={(environmentLabel) => set({ environmentLabel })} />
          </Field>
          <Field label="Colour on the map">
            <div className="swatches">
              {TENANT_COLORS.map((c) => (
                <button type="button" key={c} className={`swatch ${t.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set({ color: c })} aria-label={c} />
              ))}
            </div>
          </Field>
          <Field label="SLA / support notes" span={2}>
            <TextArea value={t.slaNotes} onChange={(slaNotes) => set({ slaNotes })} rows={2} placeholder="Business hours, contract number…" />
          </Field>
          <Field label="Admin notes" span={2}>
            <TextArea value={t.adminNotes} onChange={(adminNotes) => set({ adminNotes })} rows={2} />
          </Field>
        </div>
        <FormError error={error} />
      </Modal>
    </form>
  );
}
