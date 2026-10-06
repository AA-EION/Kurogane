import { useState } from 'react';
import type { TotpEnrollment } from '../api/types';
import { Button, FormError } from './ui';

/** QR + manual key + confirmation code. Used by the wizard and Settings. */
export function TotpPairing({ enrollment, onConfirm, onSkip, skipLabel = 'Skip for now' }: {
  enrollment: TotpEnrollment;
  onConfirm: (code: string) => Promise<void>;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="totp-pair"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onConfirm(code);
        } catch (ex) {
          setError(String(ex).replace(/^Error: /, ''));
          setCode('');
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted small">
        Scan with Google Authenticator, Authy, 1Password, Aegis… The secret is stored <i>inside</i> the encrypted vault, so the same
        authenticator entry keeps working on every machine you open this vault on.
      </p>
      {enrollment.qrSvg ? <div className="qr" dangerouslySetInnerHTML={{ __html: enrollment.qrSvg }} /> : <div className="qr placeholder">QR code</div>}
      <div className="secret-box mono" title="Manual entry key">{enrollment.secretBase32.replace(/(.{4})/g, '$1 ').trim()}</div>
      <label className="f-field">
        <span className="f-label">6-digit code from the app</span>
        <input className="f-input otp" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
      </label>
      <FormError error={error} />
      <div className="row">
        {onSkip && <Button kind="ghost" onClick={onSkip}>{skipLabel}</Button>}
        <Button kind="primary" type="submit" busy={busy} disabled={code.length !== 6}>Enable two-factor</Button>
      </div>
    </form>
  );
}
