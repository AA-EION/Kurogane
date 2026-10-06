import { useEffect, useRef, useState } from 'react';
import type { AppStatus, LockReason } from '../api/types';
import { Icon } from './Drawer';
import { Brand } from './Brand';

const REASON: Record<LockReason, string> = {
  inactivity: 'Locked after inactivity — keys were wiped from memory.',
  systemSuspend: 'Locked because the system went to sleep.',
  screenLocked: 'Locked because the screen was locked.',
  manual: 'Vault locked.',
};

export function LockScreen({ status, onUnlock, onSwitch }: {
  status: AppStatus;
  onUnlock: (pw: string, totp?: string) => Promise<void>;
  onSwitch: () => void;
}) {
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => pwRef.current?.focus(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await onUnlock(pw, status.totpRequired ? code : undefined);
      setPw('');
      setCode('');
    } catch (ex) {
      setErr(String(ex).replace(/^Error: /, ''));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <Brand large />
        <div className="vault-chip">
          <Icon name="lock" size={14} />
          <span className="mono ellipsis" title={status.vaultPath ?? ''}>{status.vaultPath}</span>
        </div>
        {status.lastLockReason && <div className="notice">{REASON[status.lastLockReason]}</div>}
        <label className="field">
          <span>Master password</span>
          <input ref={pwRef} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" disabled={busy} />
        </label>
        {status.totpRequired && (
          <label className="field">
            <span>Authenticator code</span>
            <input
              className="otp"
              inputMode="numeric"
              pattern="[0-9 ]*"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="••• •••"
              autoComplete="one-time-code"
              disabled={busy}
            />
          </label>
        )}
        {err && <div className="error">{err}</div>}
        <button className="primary" type="submit" disabled={busy || !pw || (status.totpRequired && code.length < 6)}>
          {busy ? <span className="spinner" /> : <Icon name="key" size={16} />}
          {busy ? 'Deriving key (Argon2id)…' : 'Unlock'}
        </button>
        <button type="button" className="ghost" onClick={onSwitch}>Open a different vault</button>
      </form>
    </div>
  );
}
