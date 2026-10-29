import { useEffect, useState } from 'react';
import type { CloudStep, Settings, TotpEnrollment } from '../api/types';
import { toFossflowModel } from '../canvas/fossflowExport';
import { mapToSvg, svgToPng } from '../canvas/mapExport';
import { errorText, type SettingsTab, useRun, useStore } from '../store';
import { Icon } from './Icon';
import { setAppearance, useAppearance, type Appearance } from '../theme';
import { TotpPairing } from './TotpPairing';
import { Button, Field, FormError, Modal, NumberInput, SecretInput, Segmented, Text, Toggle } from './ui';
import licenseText from '../../../LICENSE?raw';

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'sync', label: 'Sync', icon: 'sync' },
  { id: 'data', label: 'Import & export', icon: 'download' },
  { id: 'about', label: 'About', icon: 'globe' },
];

export function SettingsModal({ tab: initial }: { tab?: SettingsTab }) {
  const { backend, closeModal } = useStore();
  const [tab, setTab] = useState<SettingsTab>(initial ?? 'general');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = () => backend.getSettings().then(setSettings);
  useEffect(() => { reload().catch((e) => setLoadError(errorText(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal wide title="Settings" icon="settings" onClose={closeModal}>
      <div className="settings">
        <nav className="settings-nav">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={15} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {loadError && <><FormError error={loadError} /><Button onClick={() => { setLoadError(null); reload().catch((e) => setLoadError(errorText(e))); }}>Try again</Button></>}
          {!settings && !loadError && <span className="spinner" />}
          {settings && tab === 'general' && <General s={settings} onSaved={reload} />}
          {settings && tab === 'security' && <Security s={settings} onSaved={reload} />}
          {tab === 'sync' && <SyncTab />}
          {tab === 'data' && <DataTab />}
          {settings && tab === 'about' && <About s={settings} />}
        </div>
      </div>
    </Modal>
  );
}

function General({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const appearance = useAppearance();
  const { backend, toast, applyTopology } = useStore();
  const [d, setD] = useState({ displayName: s.displayName, lockTimeoutSecs: s.lockTimeoutSecs, clipboardClearSecs: s.clipboardClearSecs, lockOnSuspend: s.lockOnSuspend });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const minutes = Math.round(d.lockTimeoutSecs / 60);
  return (
    <div className="stack">
      <Field label="Appearance" hint="Saved on this computer. System follows your operating system’s appearance.">
        <Segmented value={appearance} onChange={(value) => setAppearance(value as Appearance)} options={[
          { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
        ]} />
      </Field>
      <Field label="Vault name">
        <Text value={d.displayName} onChange={(displayName) => setD({ ...d, displayName })} />
      </Field>
      <Field label="Lock automatically after" hint="Keys are wiped from memory when the vault locks.">
        <Segmented
          value={String(minutes)}
          onChange={(v) => setD({ ...d, lockTimeoutSecs: Number(v) * 60 })}
          options={[1, 5, 15, 30, 60, 240].map((m) => ({ value: String(m), label: m < 60 ? `${m} min` : `${m / 60} h` }))}
        />
      </Field>
      <Field label="Clear copied passwords after (seconds)">
        <NumberInput value={d.clipboardClearSecs} onChange={(v) => setD({ ...d, clipboardClearSecs: v ?? 30 })} min={5} max={600} />
      </Field>
      <Toggle checked={d.lockOnSuspend} onChange={(lockOnSuspend) => setD({ ...d, lockOnSuspend })} label="Lock when the computer sleeps" />
      <FormError error={error} />
      <div className="row">
        <Button
          kind="primary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await backend.updateSettings(d);
              applyTopology(await backend.topology());
              onSaved();
              toast('Settings saved', 'ok');
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function Security({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const { backend, toast } = useStore();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [kdf, setKdf] = useState<'keep' | 'standard' | 'hardened'>('keep');
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<TotpEnrollment | null>(null);
  const [disableCode, setDisableCode] = useState('');
  const [totpErr, setTotpErr] = useState<string | null>(null);
  return (
    <div className="stack">
      <section className="card">
        <h3>Master password</h3>
        <div className="f-grid">
          <Field label="Current password" span={2}><SecretInput value={cur} onChange={setCur} generate={false} /></Field>
          <Field label="New password"><SecretInput value={next} onChange={setNext} /></Field>
          <Field label="Repeat new password"><SecretInput value={next2} onChange={setNext2} generate={false} /></Field>
          <Field label="Key derivation (Argon2id)" span={2} hint={`Current: ${Math.round(s.kdf.mCostKib / 1024)} MiB, ${s.kdf.tCost} passes, ${s.kdf.parallelism} lanes`}>
            <Segmented value={kdf} onChange={(v) => setKdf(v as typeof kdf)} options={[{ value: 'keep', label: 'Keep' }, { value: 'standard', label: 'Standard · 256 MiB' }, { value: 'hardened', label: 'Hardened · 1 GiB' }]} />
          </Field>
        </div>
        <FormError error={pwErr} />
        <div className="row">
          <Button
            kind="primary"
            busy={busy}
            disabled={!cur || next.length < 12 || next !== next2}
            onClick={async () => {
              setBusy(true);
              setPwErr(null);
              try {
                await backend.changePassword(cur, next, kdf === 'keep' ? undefined : kdf);
                setCur('');
                setNext('');
                setNext2('');
                onSaved();
                toast('Master password changed', 'ok');
              } catch (e) {
                setPwErr(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Change password
          </Button>
        </div>
        {next && next.length < 12 && <small className="muted">At least 12 characters.</small>}
      </section>

      <section className="card">
        <h3>Two-factor unlock {s.totpEnabled ? <span className="pill ok">on</span> : <span className="pill">off</span>}</h3>
        {!s.totpEnabled && !pairing && (
          <>
            <p className="muted small">Require a code from your authenticator app, in addition to the master password, to unlock this vault.</p>
            <Button icon="shield" onClick={async () => setPairing(await backend.totpBegin('kurogane'))}>Set up two-factor</Button>
          </>
        )}
        {pairing && (
          <TotpPairing
            enrollment={pairing}
            skipLabel="Cancel"
            onSkip={() => setPairing(null)}
            onConfirm={async (code) => {
              await backend.confirmTotp(code);
              setPairing(null);
              onSaved();
              toast('Two-factor enabled', 'ok');
            }}
          />
        )}
        {s.totpEnabled && (
          <div className="f-grid">
            <Field label="Current code (to turn it off)">
              <input className="f-input otp" inputMode="numeric" maxLength={6} value={disableCode} onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))} />
            </Field>
            <div className="f-field bottom">
              <Button
                kind="danger"
                disabled={disableCode.length !== 6}
                onClick={async () => {
                  setTotpErr(null);
                  try {
                    await backend.totpDisable(disableCode);
                    setDisableCode('');
                    onSaved();
                    toast('Two-factor turned off', 'warn');
                  } catch (e) {
                    setTotpErr(errorText(e));
                  }
                }}
              >
                Turn off
              </Button>
            </div>
          </div>
        )}
        <FormError error={totpErr} />
      </section>
      {!s.memoryLocked && <div className="notice">The operating system refused to lock key memory, so keys could be written to swap. Raise the memlock limit or disable swap.</div>}
    </div>
  );
}

function ago(ms?: number | null) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function SyncTab() {
  const { backend, sync, setSync, toast } = useStore();
  const run = useRun();
  const [linking, setLinking] = useState<string | null>(null);
  const [steps, setSteps] = useState<CloudStep[]>([]);
  const [mega, setMega] = useState({ user: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void backend.syncStatus().then(setSync), [backend, setSync]);
  const link = async (provider: 'drive' | 'onedrive' | 'mega') => {
    setLinking(provider);
    setSteps([]);
    setError(null);
    try {
      setSync(await backend.linkRemote(provider, (s) => setSteps((xs) => [...xs.filter((x) => x.step !== s.step), s]), provider === 'mega' ? mega : undefined));
      toast('Linked — first sync starting', 'ok');
      setLinking(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const last = steps[steps.length - 1];
  const prov = steps.find((s) => s.step === 'provisioning') as Extract<CloudStep, { step: 'provisioning' }> | undefined;
  return (
    <div className="stack">
      <p className="muted small">
        Kurogane keeps the encrypted vault file in sync between your computers. Only the encrypted file leaves this machine. Cloud accounts are linked
        with a browser login — no API keys — through Kurogane's own sandboxed sync engine, separate from any Drive/OneDrive app you have installed.
      </p>
      <section className="card">
        <h3>Linked locations</h3>
        {sync?.linked.length ? (
          <ul className="remote-list">
            {sync.linked.map((r) => (
              <li key={r.id}>
                <Icon name={r.provider === 'local' ? 'folder' : 'cloud'} size={16} />
                <div>
                  <b>{r.label}</b>
                  <span className="mono muted small">{r.remotePath}</span>
                </div>
                <Button kind="ghost" icon="trash" onClick={() => run(async () => setSync(await backend.unlinkRemote(r.id)), 'Unlinked')} title="Unlink (the remote file is kept)" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Not synced yet.</p>
        )}
        <div className="row left">
          <Button icon="cloud" onClick={() => link('drive')} disabled={!!linking}>Google Drive</Button>
          <Button icon="cloud" onClick={() => link('onedrive')} disabled={!!linking}>OneDrive</Button>
          <Button icon="shield" onClick={() => setLinking('mega-form')} disabled={!!linking && linking !== 'mega-form'}>MEGA</Button>
          <Button icon="folder" onClick={() => run(async () => { const s = await backend.linkFolder(); if (s) setSync(s); })} disabled={!!linking}>Synced folder…</Button>
        </div>
        {linking === 'mega-form' && (
          <div className="f-grid">
            <Field label="MEGA e-mail"><Text value={mega.user} onChange={(user) => setMega({ ...mega, user })} /></Field>
            <Field label="MEGA password"><SecretInput value={mega.password} onChange={(password) => setMega({ ...mega, password })} generate={false} /></Field>
            <div className="row span-2">
              <Button kind="ghost" onClick={() => setLinking(null)}>Cancel</Button>
              <Button kind="primary" disabled={!mega.user || !mega.password} onClick={() => link('mega')}>Link MEGA</Button>
            </div>
          </div>
        )}
        {linking && linking !== 'mega-form' && (
          <div className="link-progress">
            {!last && <span><span className="spinner" /> Preparing…</span>}
            {last?.step === 'provisioning' && <span><span className="spinner" /> Preparing sync engine {prov?.total ? `${Math.round(((prov.done ?? 0) / prov.total) * 100)}%` : ''}</span>}
            {last?.step === 'consent' && <span><span className="spinner" /> Approve access in your browser… <a href={last.url} target="_blank" rel="noreferrer">reopen</a></span>}
            {error && <><FormError error={error} /><Button kind="ghost" onClick={() => setLinking(null)}>Close</Button></>}
          </div>
        )}
      </section>
      <section className="card">
        <h3>Status</h3>
        <Toggle checked={!!sync?.autoSync} onChange={(v) => run(async () => setSync(await backend.setAutoSync(v)))} label="Sync automatically (after changes, on unlock and every 5 minutes)" />
        <p className="small">
          Last sync: <b>{ago(sync?.lastSyncedAtMs)}</b>
          {sync?.transport && <span className="muted"> · engine: {sync.transport}</span>}
        </p>
        {sync?.lastOutcome && <p className="small muted">{sync.lastOutcome}</p>}
        {sync?.lastError && <div className="error">{sync.lastError}</div>}
        <Button icon="sync" busy={sync?.busy} disabled={!sync?.linked.length} onClick={() => run(async () => setSync(await backend.syncNow()))}>Sync now</Button>
      </section>
    </div>
  );
}

function DataTab() {
  const { backend, toast, topo, scene, openModal } = useStore();
  const run = useRun();
  const [withPw, setWithPw] = useState(false);
  const [pw, setPw] = useState('');
  const saved = (p: string | null | undefined) => p && toast(`Saved ${p}`, 'ok');
  const stamp = new Date().toISOString().slice(0, 10);
  return (
    <div className="stack">
      <section className="card">
        <h3>Import</h3>
        <p className="muted small">Bulk-add companies, machines, services, routes and accounts from the Excel template.</p>
        <div className="row left">
          <Button icon="upload" kind="primary" onClick={() => openModal({ type: 'import' })}>Import from spreadsheet…</Button>
          <Button icon="download" onClick={() => run(async () => saved(await backend.downloadTemplate()))}>Download empty template</Button>
        </div>
      </section>
      <section className="card">
        <h3>Export inventory</h3>
        <Toggle checked={withPw} onChange={setWithPw} label="Include passwords and keys (the file is NOT encrypted)" />
        {withPw && (
          <Field label="Master password" hint="Required to export secrets.">
            <SecretInput value={pw} onChange={setPw} generate={false} />
          </Field>
        )}
        <div className="row left">
          <Button icon="download" disabled={withPw && !pw} onClick={() => run(async () => saved(await backend.exportData('xlsx', withPw, withPw ? pw : undefined)))}>Excel (.xlsx)</Button>
          <Button icon="download" disabled={withPw && !pw} onClick={() => run(async () => saved(await backend.exportData('json', withPw, withPw ? pw : undefined)))}>JSON</Button>
        </div>
      </section>
      <section className="card">
        <h3>Backup</h3>
        <p className="muted small">A copy of the encrypted vault file. Open it on any machine with your master password.</p>
        <Button icon="shield" onClick={() => run(async () => saved(await backend.exportBackup()))}>Save encrypted backup…</Button>
      </section>
      <section className="card">
        <h3>Map</h3>
        <div className="row left">
          <Button icon="image" disabled={!topo.tenants.length} onClick={() => run(async () => {
            const { svg, width, height } = mapToSvg(scene);
            saved(await backend.saveFile(`kurogane-map-${stamp}.png`, await svgToPng(svg, width, height), 'PNG image', ['png']));
          })}>PNG image</Button>
          <Button icon="image" disabled={!topo.tenants.length} onClick={() => run(async () => {
            const { svg } = mapToSvg(scene);
            saved(await backend.saveFile(`kurogane-map-${stamp}.svg`, new Blob([svg], { type: 'image/svg+xml' }), 'SVG image', ['svg']));
          })}>SVG (vector)</Button>
          <Button icon="map" disabled={!topo.tenants.length} onClick={() => run(async () => {
            const json = JSON.stringify(toFossflowModel(topo, scene), null, 2);
            saved(await backend.saveFile(`kurogane-${stamp}.fossflow.json`, new Blob([json], { type: 'application/json' }), 'FossFLOW diagram', ['json']));
          })}>FossFLOW diagram</Button>
        </div>
        <p className="muted small">Map exports never contain passwords.</p>
      </section>
    </div>
  );
}

function About({ s }: { s: Settings }) {
  const { backend } = useStore();
  const run = useRun();
  return (
    <div className="stack">
      <p><b>Kurogane</b> {s.appVersion} — offline infrastructure map and credential vault.</p>
      <p>A product of <b>Issen Software Group</b>.</p>
      <p className="small">Copyright © 2026 Issen Software Group and Kurogane contributors. AGPLv3-or-later; redistribution is permitted under its terms. Provided without warranty.</p>
      <details><summary>Read the AGPL license</summary><pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{licenseText}</pre></details>
      <button className="link-btn" onClick={() => run(() => backend.launchWeb('https://github.com/AA-EION/Kurogane'))}>Source code and third-party notices</button>
      <button className="link-btn" onClick={() => run(() => backend.launchWeb('https://issen.kurokamicorp.com'))}>issen.kurokamicorp.com</button>
      <p className="small muted mono">{s.vaultPath}</p>
      <p className="small">
        Encryption: Argon2id ({Math.round(s.kdf.mCostKib / 1024)} MiB) → AES-256-GCM container → SQLCipher database → per-field AES-256-GCM for secrets.
        {!s.kdfMeetsFloor && <b> Key derivation is below the recommended strength — change it under Security.</b>}
      </p>
      <p className="small muted">Map projection adapted from Isoflow / FossFLOW (MIT). Sync engine: rclone (MIT).</p>
    </div>
  );
}
