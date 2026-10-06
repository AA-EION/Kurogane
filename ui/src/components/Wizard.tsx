import { useState } from 'react';
import type { Backend } from '../api/backend';
import type { CloudProvider, CloudStep, KdfProfile, TotpEnrollment } from '../api/types';
import { errorText } from '../store';
import { Brand } from './Brand';
import { Icon } from './Icon';
import { TotpPairing } from './TotpPairing';

type Step = 'choose' | 'create' | 'pair' | 'cloud' | 'cloud-run';

interface Props {
  backend: Backend;
  recent: string[];
  /** Vault created and unlocked. */
  onCreated: () => void;
  /** Vault selected or downloaded; go to the lock screen. */
  onOpened: () => void;
  toast: (m: string, tone?: 'ok' | 'warn' | 'error') => void;
}

function strength(pw: string): { score: number; label: string } {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  const bits = pw.length * Math.log2(Math.max(pool, 1));
  const score = bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : bits < 100 ? 3 : 4;
  return { score, label: ['too weak', 'weak', 'fair', 'strong', 'excellent'][score] };
}

const PROVIDERS: { id: CloudProvider; name: string; note: string; icon: string }[] = [
  { id: 'drive', name: 'Google Drive', note: 'Sign in with your browser · Kurogane only sees files it created', icon: 'cloud' },
  { id: 'onedrive', name: 'OneDrive', note: 'Sign in with your browser · personal or work account', icon: 'cloud' },
  { id: 'mega', name: 'MEGA', note: 'E-mail and password', icon: 'shield' },
  { id: 'folder', name: 'Synced folder', note: 'A vault inside Dropbox, Syncthing, a NAS share or a USB stick', icon: 'folder' },
];

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function Wizard({ backend, recent, onCreated, onOpened, toast }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('Infrastructure');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [kdf, setKdf] = useState<KdfProfile>('standard');
  const [path, setPath] = useState<string | null>(null);
  const [enrol, setEnrol] = useState<TotpEnrollment | null>(null);
  const [provider, setProvider] = useState<CloudProvider>('drive');
  const [megaUser, setMegaUser] = useState('');
  const [megaPw, setMegaPw] = useState('');
  const [steps, setSteps] = useState<CloudStep[]>([]);
  const [candidates, setCandidates] = useState<string[] | null>(null);

  const st = strength(pw);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const onStep = (s: CloudStep) => setSteps((xs) => [...xs.filter((x) => x.step !== s.step), s]);
  const finishCloud = (remotePath: string) =>
    run(async () => {
      await backend.connectCloudFinish(remotePath, onStep);
      onOpened();
    });

  if (step === 'choose')
    return (
      <div className="gate">
        <div className="wizard">
          <Brand large />
          <p className="lede">Your infrastructure map and password vault — encrypted, offline, yours. How do you want to start?</p>
          <div className="choices">
            <button className="choice" onClick={() => setStep('create')}>
              <Icon name="plus" size={26} />
              <b>Create a new vault</b>
              <span>Start fresh on this computer. You choose a master password.</span>
            </button>
            <button className="choice" onClick={() => run(async () => ((await backend.openVault()) ? onOpened() : undefined))}>
              <Icon name="folder" size={26} />
              <b>Open a vault file</b>
              <span>A <code>.kurogane</code> file on this disk, a USB stick or a network share.</span>
            </button>
            <button className="choice" onClick={() => setStep('cloud')}>
              <Icon name="cloud" size={26} />
              <b>Get it from the cloud</b>
              <span>Already syncing from another computer? Connect Google Drive, OneDrive, MEGA or a synced folder.</span>
            </button>
          </div>
          {recent.length > 0 && (
            <div className="recent">
              <h4>Recent vaults</h4>
              {recent.map((p) => (
                <button key={p} className="recent-row" onClick={() => run(async () => ((await backend.openVault(p)) ? onOpened() : undefined))}>
                  <Icon name="lock" size={14} />
                  <b>{fileName(p)}</b>
                  <span className="mono muted ellipsis">{p}</span>
                </button>
              ))}
            </div>
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
              if (pw !== pw2) throw new Error('The passwords do not match');
              setEnrol(await backend.createVault({ path, displayName: name, password: pw, kdf, account: name }));
              setStep('pair');
            });
          }}
        >
          <h2>Create vault</h2>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span>Master password</span>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={12} required autoFocus />
            <div className={`meter s${st.score}`}><i /><i /><i /><i /></div>
            <small className="dim">{pw ? st.label : 'At least 12 characters. A sentence of 4–5 random words is strong and easy to remember.'}</small>
          </label>
          <label className="field">
            <span>Repeat password</span>
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
          </label>
          <div className="notice small">There is no password recovery. If you forget it, the vault cannot be opened — by anyone.</div>
          <details className="advanced">
            <summary>Advanced</summary>
            <fieldset className="kdf">
              <legend>Key strength (Argon2id)</legend>
              <label className={kdf === 'standard' ? 'on' : ''}>
                <input type="radio" checked={kdf === 'standard'} onChange={() => setKdf('standard')} />
                <b>Standard</b> 256 MiB — unlocks in about a second
              </label>
              <label className={kdf === 'hardened' ? 'on' : ''}>
                <input type="radio" checked={kdf === 'hardened'} onChange={() => setKdf('hardened')} />
                <b>Hardened</b> 1 GiB — slower unlock, stronger against stolen files
              </label>
            </fieldset>
          </details>
          {backend.kind === 'tauri' && (
            <div className="field">
              <span>Where to save it</span>
              <button type="button" className="ghost left" onClick={async () => setPath(await backend.pickVaultForCreate())}>
                <Icon name="folder" size={14} /> {path ?? 'Choose location…'}
              </button>
              <small className="dim">Tip: put it in a folder you back up. You can add cloud sync later.</small>
            </div>
          )}
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button type="button" className="ghost" onClick={() => setStep('choose')}>Back</button>
            <button className="primary" disabled={busy || pw.length < 12 || st.score < 1 || (backend.kind === 'tauri' && !path)}>
              {busy ? <span className="spinner" /> : null}
              {busy ? 'Creating…' : 'Create vault'}
            </button>
          </div>
        </form>
      </div>
    );

  if (step === 'pair' && enrol)
    return (
      <div className="gate">
        <div className="wizard narrow">
          <h2>Add two-factor? <span className="pill">optional</span></h2>
          <p className="lede small">Ask for a code from your phone as well as the password when unlocking. You can also do this later in Settings → Security.</p>
          <TotpPairing
            enrollment={enrol}
            onSkip={onCreated}
            onConfirm={async (code) => {
              await backend.confirmTotp(code);
              toast('Two-factor enabled', 'ok');
              onCreated();
            }}
          />
        </div>
      </div>
    );

  if (step === 'cloud')
    return (
      <div className="gate">
        <form
          className="wizard narrow"
          onSubmit={(e) => {
            e.preventDefault();
            setSteps([]);
            setCandidates(null);
            run(async () => {
              const res = await backend.connectCloud(provider, onStep, provider === 'mega' ? { user: megaUser, password: megaPw } : undefined);
              if (!res) return; // dialog cancelled
              if (res.vaultPath) return onOpened();
              setStep('cloud-run');
              if (res.candidates.length === 1) await finishCloud(res.candidates[0]);
              else setCandidates(res.candidates);
            });
          }}
        >
          <h2>Get your vault from the cloud</h2>
          <p className="lede small">Kurogane uses its own sandboxed sync engine. Your installed Drive/OneDrive apps are not touched and no API keys are needed.</p>
          <div className="providers">
            {PROVIDERS.map((p) => (
              <label key={p.id} className={`provider ${provider === p.id ? 'on' : ''}`}>
                <input type="radio" checked={provider === p.id} onChange={() => setProvider(p.id)} />
                <Icon name={p.icon} size={20} />
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
          {busy && <CloudProgress steps={steps} />}
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button type="button" className="ghost" onClick={() => setStep('choose')} disabled={busy}>Back</button>
            <button className="primary" disabled={busy}>{busy ? <span className="spinner" /> : null}{provider === 'folder' ? 'Choose vault file…' : 'Connect'}</button>
          </div>
        </form>
      </div>
    );

  // cloud-run: pick which vault to download
  return (
    <div className="gate">
      <div className="wizard narrow">
        <h2>Choose your vault</h2>
        {candidates === null && <CloudProgress steps={steps} />}
        {candidates?.length === 0 && (
          <div className="notice">
            No vault found in the <code>Kurogane</code> folder of this account. On the computer that has your vault, open Settings → Sync and link this account first.
          </div>
        )}
        {candidates && candidates.length > 0 && (
          <div className="recent">
            {candidates.map((c) => (
              <button key={c} className="recent-row" disabled={busy} onClick={() => finishCloud(c)}>
                <Icon name="lock" size={14} />
                <b>{fileName(c)}</b>
                <span className="mono muted">{c}</span>
              </button>
            ))}
          </div>
        )}
        {busy && candidates !== null && <CloudProgress steps={steps} />}
        {err && <div className="error">{err}</div>}
        <div className="row">
          <button className="ghost" onClick={() => setStep('cloud')} disabled={busy}>Back</button>
        </div>
      </div>
    </div>
  );
}

function CloudProgress({ steps }: { steps: CloudStep[] }) {
  const last = steps[steps.length - 1];
  const prov = steps.find((s) => s.step === 'provisioning') as Extract<CloudStep, { step: 'provisioning' }> | undefined;
  const pct = prov?.total ? Math.round(((prov.done ?? 0) / prov.total) * 100) : null;
  const text =
    !last ? 'Starting…'
    : last.step === 'provisioning' ? `Preparing the sync engine${pct !== null ? ` · ${pct}%` : ''}`
    : last.step === 'consent' ? 'Approve access in the browser window that just opened…'
    : last.step === 'listing' ? 'Looking for vaults…'
    : last.step === 'downloading' ? 'Downloading and verifying…'
    : last.step === 'done' ? 'Done'
    : last.message;
  return (
    <div className="cloud-progress">
      <span className="spinner" /> {text}
      {last?.step === 'consent' && <a href={last.url} target="_blank" rel="noreferrer" className="small">Reopen the login page</a>}
    </div>
  );
}
