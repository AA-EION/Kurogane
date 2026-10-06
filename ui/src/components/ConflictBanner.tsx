import { useState } from 'react';
import { useRun, useStore } from '../store';
import { Icon } from './Icon';

function when(ms: number) {
  return new Date(ms).toLocaleString();
}

/** Both this computer and another one changed the vault since the last sync. */
export function ConflictBanner() {
  const { sync, setSync, backend, toast } = useStore();
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const c = sync?.conflict;
  if (!c) return null;
  const resolve = (choice: 'mine' | 'theirs') =>
    run(async () => {
      setBusy(true);
      try {
        setSync(await backend.resolveConflict(choice));
        toast(choice === 'mine' ? 'Kept this computer’s version and uploaded it' : `Switched to the ${c.label} version`, 'ok');
      } finally {
        setBusy(false);
      }
    });
  return (
    <div className="conflict">
      <Icon name="alert" size={18} />
      <div>
        <b>Sync conflict with {c.label}.</b> This computer and another one both changed the vault.
        <span className="muted small"> This computer: {when(c.localSavedAtMs)} · {c.label}: {when(c.remoteSavedAtMs)}. The version you don’t keep is preserved as a .bak backup file.</span>
      </div>
      <button className="btn secondary small" disabled={busy} onClick={() => resolve('mine')}>Keep this computer’s</button>
      <button className="btn secondary small" disabled={busy} onClick={() => resolve('theirs')}>Use {c.label}’s</button>
    </div>
  );
}
