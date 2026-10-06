import { useEffect, useRef, useState } from 'react';
import { useRun, useStore } from '../store';
import { Brand } from './Brand';
import { Icon } from './Icon';

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function fmt(secs: number) {
  const m = Math.floor(secs / 60);
  return `${m}:${(secs % 60).toString().padStart(2, '0')}`;
}

function ago(ms?: number | null) {
  if (!ms) return 'not yet';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function TopBar({ onSearch, remainingSecs, timeoutSecs, onLock, memoryLocked }: {
  onSearch: () => void;
  remainingSecs: number;
  timeoutSecs: number;
  onLock: () => void;
  memoryLocked: boolean;
}) {
  const { topo, sync, setSync, backend, openModal } = useStore();
  const run = useRun();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);
  const frac = timeoutSecs ? remainingSecs / timeoutSecs : 0;
  const r = 9;
  const c = 2 * Math.PI * r;
  const hasT = topo.tenants.length > 0;
  const add = (fn: () => void) => () => (setMenu(false), fn());
  return (
    <header className="topbar">
      <Brand />
      <div className="vault-name" title={topo.vaultName}>{topo.vaultName}</div>
      {!memoryLocked && <span className="pill danger" title="The OS refused to lock key memory">memory not locked</span>}
      <button className="search-trigger" onClick={onSearch}>
        <Icon name="search" size={15} />
        <span>Search hosts, IPs, ports, domains…</span>
        <kbd>{mod}</kbd><kbd>K</kbd>
      </button>
      <div className="add-menu" ref={menuRef}>
        <button className="btn primary small" aria-expanded={menu} aria-haspopup="true" onClick={() => setMenu(!menu)} onKeyDown={(e) => { if (e.key === 'Escape') setMenu(false); }}><Icon name="plus" size={14} /> New</button>
        {menu && (
          <div className="menu">
            <button onClick={add(() => openModal({ type: 'tenant' }))}><Icon name="shield" size={14} /> Company</button>
            <button disabled={!hasT} onClick={add(() => openModal({ type: 'host' }))}><Icon name="server" size={14} /> Machine</button>
            <button disabled={!topo.hosts.length} onClick={add(() => openModal({ type: 'service' }))}><Icon name="container" size={14} /> Service</button>
            <button disabled={!topo.hosts.length} onClick={add(() => openModal({ type: 'proxy' }))}><Icon name="proxy" size={14} /> Reverse proxy</button>
            <button disabled={!hasT} onClick={add(() => openModal({ type: 'credential' }))}><Icon name="key" size={14} /> Account</button>
            <button disabled={!hasT} onClick={add(() => openModal({ type: 'network' }))}><Icon name="switch" size={14} /> Network</button>
            <hr />
            <button onClick={add(() => openModal({ type: 'import' }))}><Icon name="upload" size={14} /> Import from spreadsheet…</button>
          </div>
        )}
      </div>
      <div className="spacer" />
      {sync && sync.linked.length > 0 ? (
        <button
          className={`tb-btn sync ${sync.busy ? 'busy' : ''} ${sync.lastError ? 'err' : ''} ${sync.conflict ? 'warn' : ''}`}
          disabled={sync.busy}
          onClick={() => run(async () => setSync(await backend.syncNow()))}
          title={`${sync.linked.map((l) => `${l.label}: ${l.remotePath}`).join('\n')}${sync.lastError ? `\n\n${sync.lastError}` : ''}\n\nClick to sync now`}
        >
          <Icon name={sync.lastError || sync.conflict ? 'alert' : 'sync'} size={15} className={sync.busy ? 'spin' : ''} />
          <span>{sync.busy ? 'Syncing…' : sync.conflict ? 'Sync conflict' : sync.lastError ? 'Sync failed' : `Synced ${ago(sync.lastSyncedAtMs)}`}</span>
        </button>
      ) : (
        <button className="tb-btn" onClick={() => openModal({ type: 'settings', tab: 'sync' })} title="Sync this vault between computers">
          <Icon name="cloud" size={15} /><span>Set up sync</span>
        </button>
      )}
      <button className="tb-btn icon-only" title="Settings" onClick={() => openModal({ type: 'settings' })}><Icon name="settings" size={16} /></button>
      <button className="lock-pill" onClick={onLock} title={`Auto-lock in ${fmt(remainingSecs)} · ${mod}+L to lock now`}>
        <svg width={22} height={22} viewBox="0 0 22 22">
          <circle cx={11} cy={11} r={r} className="track" />
          <circle cx={11} cy={11} r={r} className={`bar ${frac < 0.15 ? 'low' : ''}`} strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 11 11)" />
        </svg>
        <Icon name="lock" size={14} />
        <span className="mono">{fmt(remainingSecs)}</span>
      </button>
    </header>
  );
}
