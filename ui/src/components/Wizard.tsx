import { useState } from 'react';
import type { Backend } from '../api/backend';
import type { CloudProvider, CloudStep, KdfProfile, TotpEnrollment } from '../api/types';
import { Brand } from './Brand';
import { Icon } from './Drawer';

type Step = 'choose' | 'create' | 'enroll' | 'cloud' | 'cloud-run';

interface Props {
  backend: Backend;
  /** Vault created and unlocked. */
  onCreated: () => void;
  /** Vault selected or downloaded; go to the lock screen. */
  onOpened: () => void;
}

function strength(pw: string): { score: number; label: string } {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  const bits = pw.length * Math.log2(Math.max(pool, 1));
  const score = bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : bits < 100 ? 3 : 4;
  return { score, label: ['too weak', 'weak', 'fair', 'strong', 'excellent'][score] + ` · ~${Math.round(bits)} bits` };
}

const PROVIDERS: { id: CloudProvider; name: string; note: string }[] = [
  { id: 'drive', name: 'Google Drive', note: 'Browser consent · app-created files only (drive.file)' },
  { id: 'onedrive', name: 'OneDrive', note: 'Browser consent · personal or business' },
  { id: 'mega', name: 'MEGA', note: 'Account e-mail + password, end-to-end encrypted' },
];

export function Wizard({ backend, onCreated, onOpened }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // create
  const [name, setName] = useState('Infrastructure');
  const [account, setAccount] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [kdf, setKdf] = useState<KdfProfile>('standard');
  const [path, setPath] = useState<string | null>(null);
  const [seedDemo, setSeedDemo] = useState(false);
  const [enrol, setEnrol] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  // cloud
  const [provider, setProvider] = useState<CloudProvider>('drive');
  const [megaUser, setMegaUser] = useState('');
  const [megaPw, setMegaPw] = useState('');
  const [cloudSteps, setCloudSteps] = useState<CloudStep[]>([]);

  const st = strength(pw);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'choose')
    return (
      <div className="gate">
        <div className="wizard">
          <Brand large />
          <p className="lede">Offline-first infrastructure atlas and zero-knowledge vault. Choose how to start:</p>
          <div className="choices">
            <button className="choice" onClick={() => setStep('create')}>
              <Icon name="plus" size={26} />
              <b>Create new vault</b>
              <span>Argon2id master key, portable TOTP, empty schema.</span>
            </button>
            <button className="choice" onClick={() => run(async () => ((await backend.openVault()) ? onOpened() : undefined))}>
              <Icon name="folder" size={26} />
              <b>Open existing vault</b>
              <span>Select a <code>.kurogane</code> file from disk or a USB stick.</span>
            </button>
            <button className="choice" onClick={() => setStep('cloud')}>
              <Icon name="cloud" size={26} />
              <b>Connect cloud vault</b>
              <span>Google Drive, OneDrive or MEGA through an isolated sync sidecar.</span>
            </button>
          </div>
          {backend.kind === 'mock' && (
            <button className="ghost" onClick={() => run(async () => ((await backend.openVault()) ? onOpened() : undefined))}>
              Explore the demo vault →
            </button>
          )}
          {err && <div className="error">{err}</div>}
        </div>
      </div>
    );

  if (step === 'create')
    return (
      <div className="gate">
        <form
          className="wizard narrow"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              if (pw !== pw2) throw new Error('Passwords do not match');
              setEnrol(await backend.createVault({ path, displayName: name, password: pw, kdf, account: account || 'admin', seedDemo }));
              setStep('enroll');
            });
          }}
        >
          <h2>Create vault</h2>
          <label className="field">
            <span>Vault name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span>Authenticator label (e-mail or handle)</span>
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="ops@example.com" />
          </label>
          <label className="field">
            <span>Master password</span>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={12} required />
            <div className={`meter s${st.score}`}><i /><i /><i /><i /></div>
            <small className="dim">{pw ? st.label : 'At least 12 characters; a passphrase of 4+ random words is ideal.'}</small>
          </label>
          <label className="field">
            <span>Repeat password</span>
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
          </label>
          <fieldset className="kdf">
            <legend>Key derivation (Argon2id)</legend>
            <label className={kdf === 'standard' ? 'on' : ''}>
              <input type="radio" checked={kdf === 'standard'} onChange={() => setKdf('standard')} />
              <b>Standard</b> 256 MiB · 3 passes · 4 lanes
            </label>
            <label className={kdf === 'hardened' ? 'on' : ''}>
              <input type="radio" checked={kdf === 'hardened'} onChange={() => setKdf('hardened')} />
              <b>Hardened</b> 1 GiB · 4 passes — for vaults synced to the cloud
            </label>
          </fieldset>
          <label className="check">
            <input type="checkbox" checked={seedDemo} onChange={(e) => setSeedDemo(e.target.checked)} />
            Pre-load the demo topology (3 tenants, 14 hosts) to explore the canvas
          </label>
          {backend.kind === 'tauri' && (
            <div className="field">
              <span>Location</span>
              <button type="button" className="ghost left" onClick={async () => setPath(await backend.pickVaultForCreate())}>
                <Icon name="folder" size={14} /> {path ?? 'Choose where to save…'}
              </button>
            </div>
          )}
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button type="button" className="ghost" onClick={() => setStep('choose')}>Back</button>
            <button className="primary" disabled={busy || pw.length < 12 || st.score < 1 || (backend.kind === 'tauri' && !path)}>
              {busy ? <span className="spinner" /> : null}
              {busy ? 'Deriving key…' : 'Create vault'}
            </button>
          </div>
        </form>
      </div>
    );

  if (step === 'enroll' && enrol)
    return (
      <div className="gate">
        <form
          className="wizard narrow"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await backend.confirmTotp(code);
              onCreated();
            });
          }}
        >
          <h2>Pair your authenticator</h2>
          <p className="lede small">
            Scan with Google Authenticator, Authy, 1Password or Aegis. The seed is sealed <i>inside</i> the vault, so moving the file to
            another machine never requires re-pairing.
          </p>
          <div className="qr" dangerouslySetInnerHTML={{ __html: enrol.qrSvg }} />
          <div className="secret-box mono">{enrol.secretBase32.replace(/(.{4})/g, '$1 ').trim()}</div>
          <label className="field">
            <span>Enter the 6-digit code to confirm</span>
            <input className="otp" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          </label>
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button type="button" className="ghost" onClick={onCreated}>Skip for now</button>
            <button className="primary" disabled={busy || code.length !== 6}>Enable two-factor</button>
          </div>
        </form>
      </div>
    );

  if (step === 'cloud')
    return (
      <div className="gate">
        <form
          className="wizard narrow"
          onSubmit={(e) => {
            e.preventDefault();
            setCloudSteps([]);
            setStep('cloud-run');
            run(async () => {
              await backend.connectCloud(provider, (s) => setCloudSteps((xs) => [...xs.filter((x) => x.step !== s.step), s]), provider === 'mega' ? { user: megaUser, password: megaPw } : undefined);
            });
          }}
        >
          <h2>Connect cloud vault</h2>
          <p className="lede small">
            No developer accounts or API keys. Kurogane runs its own sandboxed sync engine — a pinned rclone build in a locked-down container,
            or a checksum-verified binary inside the app sandbox. Your desktop cloud clients and their logins are never touched.
          </p>
          <div className="providers">
            {PROVIDERS.map((p) => (
              <label key={p.id} className={`provider ${provider === p.id ? 'on' : ''}`}>
                <input type="radio" checked={provider === p.id} onChange={() => setProvider(p.id)} />
                <Icon name={p.id === 'mega' ? 'shield' : 'cloud'} size={20} />
                <b>{p.name}</b>
                <span>{p.note}</span>
              </label>
            ))}
          </div>
          {provider === 'mega' && (
            <>
              <label className="field"><span>MEGA e-mail</span><input value={megaUser} onChange={(e) => setMegaUser(e.target.value)} required /></label>
              <label className="field"><span>MEGA password</span><input type="password" value={megaPw} onChange={(e) => setMegaPw(e.target.value)} required /></label>
            </>
          )}
          <div className="row">
            <button type="button" className="ghost" onClick={() => setStep('choose')}>Back</button>
            <button className="primary">Connect</button>
          </div>
        </form>
      </div>
    );

  // cloud-run
  const has = (k: CloudStep['step']) => cloudSteps.find((s) => s.step === k);
  const prov = has('provisioning') as Extract<CloudStep, { step: 'provisioning' }> | undefined;
  const consent = has('consent') as Extract<CloudStep, { step: 'consent' }> | undefined;
  const failed = (has('error') as Extract<CloudStep, { step: 'error' }> | undefined)?.message ?? err;
  const done = has('done');
  const pct = prov?.total ? Math.round(((prov.done ?? 0) / prov.total) * 100) : null;
  const rows: { key: string; label: string; state: 'done' | 'active' | 'todo'; detail?: React.ReactNode }[] = [
    { key: 'p', label: 'Prepare isolated sync engine', state: consent || has('downloading') || done ? 'done' : prov ? 'active' : 'todo', detail: pct !== null && pct < 100 ? `rclone 1.75.1 · ${pct}% · SHA-256 pinned` : 'rclone 1.75.1 · verified' },
    ...(provider !== 'mega'
      ? [{ key: 'c', label: 'Approve access in your browser', state: (has('downloading') || done ? 'done' : consent ? 'active' : 'todo') as 'done' | 'active' | 'todo', detail: consent ? <a href={consent.url} target="_blank" rel="noreferrer" className="mono">{consent.url}</a> : undefined }]
      : []),
    { key: 'd', label: 'Download, verify header & integrity', state: done ? 'done' : has('downloading') ? 'active' : 'todo' },
  ];
  return (
    <div className="gate">
      <div className="wizard narrow">
        <h2>Connecting {PROVIDERS.find((p) => p.id === provider)?.name}</h2>
        <ol className="progress">
          {rows.map((r) => (
            <li key={r.key} className={r.state}>
              <span className="pdot">{r.state === 'done' ? '✓' : r.state === 'active' ? <span className="spinner" /> : ''}</span>
              <div>
                <div>{r.label}</div>
                {r.detail && r.state !== 'todo' && <small className="dim">{r.detail}</small>}
              </div>
            </li>
          ))}
        </ol>
        {failed && <div className="error">{failed}</div>}
        <div className="row">
          <button className="ghost" onClick={() => setStep('cloud')} disabled={busy && !failed}>Back</button>
          <button className="primary" disabled={!done} onClick={onOpened}>Continue to unlock</button>
        </div>
      </div>
    </div>
  );
}
