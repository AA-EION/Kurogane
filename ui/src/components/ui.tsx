import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { Option } from '../options';
import { Icon } from './Icon';

export function Modal({ title, subtitle, onClose, children, footer, wide, icon }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  icon?: string;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="modal-head">
          {icon && <span className="modal-icon"><Icon name={icon} size={18} /></span>}
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)"><Icon name="close" /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, required, span }: { label: string; hint?: ReactNode; children: ReactNode; required?: boolean; span?: 1 | 2 | 3 }) {
  return (
    <label className={`f-field span-${span ?? 1}`}>
      <span className="f-label">{label}{required && <i className="req">*</i>}</span>
      {children}
      {hint && <small className="f-hint">{hint}</small>}
    </label>
  );
}

export function Text({ value, onChange, placeholder, mono, autoFocus, type, list }: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
  type?: string;
  list?: string;
}) {
  return (
    <input
      className={`f-input ${mono ? 'mono' : ''}`}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      type={type ?? 'text'}
      spellCheck={false}
      autoComplete="off"
      list={list}
    />
  );
}

export function NumberInput({ value, onChange, placeholder, min = 1, max = 65535 }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; min?: number; max?: number }) {
  return (
    <input
      className="f-input mono"
      inputMode="numeric"
      value={value ?? ''}
      placeholder={placeholder}
      onChange={(e) => {
        const d = e.target.value.replace(/\D/g, '').slice(0, 6);
        onChange(d ? Math.max(min - 1, Math.min(max, parseInt(d, 10))) : null);
      }}
    />
  );
}

export function Select({ value, onChange, options, placeholder, allowEmpty }: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  return (
    <select className="f-input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {(allowEmpty || !value) && <option value="">{placeholder ?? '—'}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}{o.hint ? ` — ${o.hint}` : ''}</option>
      ))}
    </select>
  );
}

export function GroupedSelect({ value, onChange, groups, placeholder }: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  groups: { label: string; options: Option[] }[];
  placeholder?: string;
}) {
  return (
    <select className="f-input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder ?? '—'}</option>
      {groups.filter((g) => g.options.length).map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function TextArea({ value, onChange, placeholder, rows = 3, mono }: { value: string | null | undefined; onChange: (v: string) => void; placeholder?: string; rows?: number; mono?: boolean }) {
  return <textarea className={`f-input ${mono ? 'mono' : ''}`} rows={rows} value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="thumb" /></span>
      <span>{label}</span>
    </label>
  );
}

export function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Option[] }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button type="button" key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Button({ children, onClick, kind = 'secondary', disabled, busy, type = 'button', icon, title }: {
  children?: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  icon?: string;
  title?: string;
}) {
  return (
    <button type={type} className={`btn ${kind}`} onClick={onClick} disabled={disabled || busy} title={title}>
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </button>
  );
}

export function FormError({ error }: { error: string | null }) {
  return error ? <div className="error" role="alert">{error}</div> : null;
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="f-section">
      <header>
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

/** Password field with show/hide and a strong generator. */
export function SecretInput({ value, onChange, placeholder, generate = true }: { value: string; onChange: (v: string) => void; placeholder?: string; generate?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="secret-input">
      <input className="f-input mono" type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="new-password" spellCheck={false} />
      <button type="button" className="icon-btn tiny" title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)}><Icon name={show ? 'eyeOff' : 'eye'} size={14} /></button>
      {generate && (
        <button type="button" className="icon-btn tiny" title="Generate a strong password" onClick={() => (onChange(generatePassword()), setShow(true))}>
          <Icon name="sync" size={14} />
        </button>
      )}
    </div>
  );
}

export function generatePassword(len = 24): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%+=';
  const out: string[] = [];
  const buf = new Uint32Array(len * 2);
  crypto.getRandomValues(buf);
  for (let i = 0; out.length < len && i < buf.length; i++) {
    const limit = Math.floor(0x100000000 / chars.length) * chars.length;
    if (buf[i] < limit) out.push(chars[buf[i] % chars.length]);
  }
  return out.join('');
}

export function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

export function useDatalistId() {
  return useId().replace(/:/g, '');
}
