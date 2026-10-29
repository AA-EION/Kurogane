import { useEffect, useState } from 'react';
import type { DeleteImpact, EntityKind } from '../api/types';
import { errorText, useStore } from '../store';
import { Button, FormError, Modal } from './ui';

const NOUN: Record<EntityKind, string> = { tenant: 'company', network: 'network', host: 'machine', service: 'service', proxy: 'proxy', route: 'route', credential: 'account' };

export function DeleteDialog({ kind, id, name, onDone }: { kind: EntityKind; id: string; name: string; onDone?: () => void }) {
  const { backend, closeModal, applyTopology, toast, select } = useStore();
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setImpact(null);
    setError(null);
    backend.deleteImpact(kind, id).then((value) => { if (active) setImpact(value); }).catch((e) => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [backend, kind, id]);
  const parts = impact
    ? ([
        ['machine', impact.hosts], ['network', impact.networks], ['service', impact.services], ['proxy', impact.proxies], ['route', impact.routes], ['account', impact.credentials],
      ] as [string, number][]).filter(([, n]) => n > 0).map(([w, n]) => `${n} ${n === 1 ? w : w === 'proxy' ? 'proxies' : `${w}s`}`)
    : [];
  const go = async () => {
    if (!impact || busy) return;
    setBusy(true);
    try {
      const t = await backend.deleteEntity(kind, id);
      select(null);
      applyTopology(t);
      closeModal();
      onDone?.();
      toast(`Deleted ${name}`, 'ok');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Delete ${NOUN[kind]} “${name}”?`}
      icon="trash"
      onClose={closeModal}
      footer={<><Button onClick={closeModal}>Cancel</Button><Button kind="danger" onClick={go} busy={busy} disabled={!impact}>Delete</Button></>}
    >
      {!impact && !error && <p role="status">Checking what will be deleted…</p>}
      {impact && (parts.length > 0 ? (
        <p>Everything that belongs to it goes too: <b>{parts.join(', ')}</b>.</p>
      ) : (
        <p>This cannot be undone (the previous version stays in the <code>.bak</code> file next to your vault until the next save).</p>
      ))}
      {kind === 'service' && <p className="muted small">Proxy routes pointing at this service are kept but lose their target link.</p>}
      <FormError error={error} />
    </Modal>
  );
}
