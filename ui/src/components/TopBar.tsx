import type { SyncStatus, Tenant } from '../api/types';
import { Brand } from './Brand';
import { Icon } from './Drawer';

interface Props {
  vaultName: string;
  tenants: Tenant[];
  dimmed: Set<string>;
  onToggleTenant: (id: string) => void;
  onSearch: () => void;
  remainingSecs: number;
  timeoutSecs: number;
  onLock: () => void;
  sync: SyncStatus | null;
  onSync: () => void;
  onExport: () => void;
  demo: boolean;
  memoryLocked: boolean;
}

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function fmt(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function ago(ms?: number | null) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function TopBar(p: Props) {
  const frac = p.timeoutSecs ? p.remainingSecs / p.timeoutSecs : 0;
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <header className="topbar">
      <Brand />
      <div className="vault-name">
        <span className="dim">vault</span> {p.vaultName}
        {p.demo && <span className="pill warn">demo</span>}
        {!p.memoryLocked && <span className="pill danger" title="mlock failed: keys could be swapped to disk">memory not locked</span>}
      </div>
      <div className="tenant-chips">
        {p.tenants.map((t) => (
          <button
            key={t.id}
            className={`tchip ${p.dimmed.has(t.id) ? 'off' : ''}`}
            style={{ ['--tc' as string]: t.color ?? '#868e96' }}
            onClick={() => p.onToggleTenant(t.id)}
            title={p.dimmed.has(t.id) ? 'Show' : 'Fade out'}
          >
            <i />
            {t.name}
          </button>
        ))}
      </div>
      <button className="search-trigger" onClick={p.onSearch}>
        <Icon name="search" size={15} />
        <span>Search hosts, IPs, ports, domains…</span>
        <kbd>{mod}</kbd>
        <kbd>K</kbd>
      </button>
      <div className="spacer" />
      <button className="tb-btn" onClick={p.onExport} title="Export diagram as FossFLOW JSON">
        <Icon name="download" size={15} />
        <span>FossFLOW</span>
      </button>
      {p.sync && p.sync.linked.length > 0 && (
        <button className={`tb-btn sync ${p.sync.busy ? 'busy' : ''}`} onClick={p.onSync} title={`${p.sync.linked.map((l) => `${l.label}: ${l.remotePath}`).join('\n')}\ntransport: ${p.sync.transport ?? 'auto'}`}>
          <Icon name="sync" size={15} className={p.sync.busy ? 'spin' : ''} />
          <span>{p.sync.busy ? 'Syncing…' : `${p.sync.linked[0].label} · ${ago(p.sync.lastSyncedAtMs)}`}</span>
        </button>
      )}
      <button className="lock-pill" onClick={p.onLock} title={`Auto-lock in ${fmt(p.remainingSecs)} · ${mod}+L to lock now`}>
        <svg width={22} height={22} viewBox="0 0 22 22">
          <circle cx={11} cy={11} r={r} className="track" />
          <circle cx={11} cy={11} r={r} className={`bar ${frac < 0.15 ? 'low' : ''}`} strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 11 11)" />
        </svg>
        <Icon name="lock" size={14} />
        <span className="mono">{fmt(p.remainingSecs)}</span>
      </button>
    </header>
  );
}
