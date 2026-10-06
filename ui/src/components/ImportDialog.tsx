import { useState } from 'react';
import type { Counts, ImportPreview } from '../api/types';
import { errorText, useStore } from '../store';
import { Icon } from './Icon';
import { Button, FormError, Modal } from './ui';

const LABELS: [keyof Counts, string][] = [
  ['companies', 'Companies'], ['networks', 'Networks'], ['machines', 'Machines'], ['cards', 'Network cards'], ['services', 'Services'],
  ['ports', 'Ports'], ['proxies', 'Proxies'], ['routes', 'Routes'], ['accounts', 'Accounts'],
];

/** Template download → fill in → preview (dry run) → import. */
export function ImportDialog() {
  const { backend, closeModal, applyTopology, toast } = useStore();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const r = preview?.report;
  const total = r ? LABELS.reduce((s, [k]) => s + r.created[k] + r.updated[k], 0) : 0;
  return (
    <Modal
      wide
      title="Import from spreadsheet"
      subtitle="Fill the Excel template (or a previous export), preview the changes, then import."
      icon="upload"
      onClose={closeModal}
      footer={
        <>
          <Button onClick={closeModal}>Close</Button>
          {preview && (
            <Button
              kind="primary"
              busy={busy}
              disabled={!r || r.errors.length > 0 || total === 0}
              onClick={() =>
                act(async () => {
                  const res = await backend.importApply();
                  applyTopology(res.topology);
                  closeModal();
                  toast(`Imported ${preview.fileName}`, 'ok');
                })
              }
            >
              Import {total} change{total === 1 ? '' : 's'}
            </Button>
          )}
        </>
      }
    >
      <ol className="steps">
        <li>
          <b>Download the template</b>
          <span>One sheet per kind of record, with dropdowns and an example row. Machines reference companies by name, services reference machines, and so on.</span>
          <Button icon="download" onClick={() => act(async () => {
            const p = await backend.downloadTemplate();
            if (p) toast(`Template saved to ${p}`, 'ok');
          })}>Download template (.xlsx)</Button>
        </li>
        <li>
          <b>Fill it in</b>
          <span>Excel, LibreOffice or Google Sheets. Re-importing updates existing records by name instead of duplicating them; an empty password keeps the stored one.</span>
        </li>
        <li>
          <b>Upload and review</b>
          <span>Nothing is written until you confirm. A JSON export from Kurogane works too.</span>
          <Button icon="upload" busy={busy && !preview} onClick={() => act(async () => setPreview(await backend.importPreview()))}>Choose file…</Button>
        </li>
      </ol>
      {preview && r && (
        <div className="import-preview">
          <div className="ip-head">
            <Icon name={r.errors.length ? 'alert' : 'check'} size={16} className={r.errors.length ? 'bad' : 'good'} />
            <b>{preview.fileName}</b>
            <span className="muted">{r.errors.length ? `${r.errors.length} problem(s) — fix them in the file and choose it again` : total ? 'Ready to import' : 'No changes found'}</span>
          </div>
          <table className="counts">
            <thead><tr><th /><th>New</th><th>Updated</th></tr></thead>
            <tbody>
              {LABELS.filter(([k]) => r.created[k] + r.updated[k] > 0).map(([k, l]) => (
                <tr key={k}><td>{l}</td><td className="mono">{r.created[k] || ''}</td><td className="mono">{r.updated[k] || ''}</td></tr>
              ))}
            </tbody>
          </table>
          {r.errors.length > 0 && (
            <ul className="issues">
              {r.errors.slice(0, 50).map((e, i) => (
                <li key={i}><span className="mono">{e.sheet} · row {e.row}</span> {e.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <FormError error={error} />
    </Modal>
  );
}
