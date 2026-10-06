import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from './api/backend';
import { getBackend } from './api/backend';
import type { AppStatus, SyncStatus, Topology } from './api/types';
import { toFossflowModel } from './canvas/fossflowExport';
import { IsoCanvas } from './canvas/IsoCanvas';
import { layoutTopology } from './canvas/layout';
import { Drawer } from './components/Drawer';
import { LockScreen } from './components/LockScreen';
import { Omnibox } from './components/Omnibox';
import { type Toast, Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { Wizard } from './components/Wizard';
import { buildLookup } from './model';
import { buildIndex } from './search/index';

const TOUCH_THROTTLE_MS = 10_000;

export function App() {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [topo, setTopo] = useState<Topology | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [omni, setOmni] = useState(false);
  const [dimmed, setDimmed] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [remaining, setRemaining] = useState(0);
  const lastTouch = useRef(Date.now());
  const lastSent = useRef(0);

  const toast = useCallback((msg: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const refresh = useCallback(async (b: Backend) => setStatus(await b.status()), []);

  useEffect(() => {
    getBackend().then((b) => {
      setBackend(b);
      refresh(b);
    });
  }, [refresh]);

  // Locked from the native side (inactivity, suspend, screen lock): drop
  // everything derived from vault contents.
  useEffect(() => {
    if (!backend) return;
    return backend.onLocked((reason) => {
      setTopo(null);
      setSelected(null);
      setOmni(false);
      setStatus((s) => (s ? { ...s, stage: 'locked', lastLockReason: reason } : s));
    });
  }, [backend]);

  useEffect(() => {
    if (!backend || status?.stage !== 'unlocked') return;
    backend.topology().then(setTopo).catch((e) => toast(String(e), 'error'));
    backend.syncStatus().then(setSync).catch(() => setSync(null));
    lastTouch.current = Date.now();
  }, [backend, status?.stage, toast]);

  // Activity → keep the session alive (throttled) + local countdown display.
  useEffect(() => {
    if (!backend || status?.stage !== 'unlocked') return;
    const onActivity = () => {
      lastTouch.current = Date.now();
      if (Date.now() - lastSent.current > TOUCH_THROTTLE_MS) {
        lastSent.current = Date.now();
        backend.touch().catch(() => undefined);
      }
    };
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    evs.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const timer = setInterval(() => {
      const timeout = status.lockTimeoutSecs;
      // Display accounts for the throttle so we never show more time than the core has.
      const since = (Date.now() - Math.min(lastTouch.current, lastSent.current || lastTouch.current)) / 1000;
      setRemaining(Math.max(0, Math.round(timeout - since)));
    }, 1000);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, onActivity));
      clearInterval(timer);
    };
  }, [backend, status?.stage, status?.lockTimeoutSecs]);

  const scene = useMemo(() => (topo ? layoutTopology(topo) : null), [topo]);
  const lookup = useMemo(() => (topo ? buildLookup(topo) : null), [topo]);
  const index = useMemo(() => (topo && scene ? buildIndex(topo, scene) : []), [topo, scene]);

  const lock = useCallback(async () => {
    await backend?.lock();
  }, [backend]);

  const focusOn = useCallback((id: string) => {
    setSelected(id);
    setFocus({ id, nonce: Date.now() });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const modKey = e.metaKey || e.ctrlKey;
      if (status?.stage !== 'unlocked') return;
      if (modKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOmni((o) => !o);
      } else if (modKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        lock();
      } else if (e.key === 'Escape' && !omni) {
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status?.stage, omni, lock]);

  const exportFossflow = async () => {
    if (!topo || !scene) return;
    const json = JSON.stringify(toFossflowModel(topo, scene), null, 2);
    const name = `${topo.vaultName.replace(/[^\w.-]+/g, '-')}.fossflow.json`;
    if (backend?.exportText) {
      if (await backend.exportText(name, json)) toast('Exported FossFLOW diagram', 'ok');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exported FossFLOW diagram (no secrets included)', 'ok');
  };

  const syncNow = async () => {
    if (!backend) return;
    setSync((s) => (s ? { ...s, busy: true } : s));
    try {
      toast(`Sync: ${await backend.syncNow()}`, 'ok');
    } catch (e) {
      toast(String(e), 'error');
    }
    setSync(await backend.syncStatus().catch(() => null));
  };

  if (!backend || !status) return <div className="boot"><span className="spinner" /></div>;

  if (status.stage === 'wizard')
    return <Wizard backend={backend} onCreated={() => refresh(backend)} onOpened={() => refresh(backend)} />;

  if (status.stage === 'locked')
    return (
      <LockScreen
        status={status}
        demoCredentials={backend.demoCredentials}
        onUnlock={async (pw, totp) => setStatus(await backend.unlock(pw, totp))}
        onSwitch={() => setStatus({ ...status, stage: 'wizard' })}
      />
    );

  return (
    <div className="app">
      <TopBar
        vaultName={topo?.vaultName ?? status.vaultName ?? ''}
        tenants={topo?.tenants ?? []}
        dimmed={dimmed}
        onToggleTenant={(id) => setDimmed((d) => {
          const n = new Set(d);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        })}
        onSearch={() => setOmni(true)}
        remainingSecs={remaining || status.remainingSecs}
        timeoutSecs={status.lockTimeoutSecs}
        onLock={lock}
        sync={sync}
        onSync={syncNow}
        onExport={exportFossflow}
        demo={status.demo}
        memoryLocked={status.memoryLocked}
      />
      <main className="stage">
        {scene && <IsoCanvas scene={scene} selected={selected} onSelect={setSelected} focus={focus} dimmedTenants={dimmed} />}
        {!scene && <div className="boot"><span className="spinner" /></div>}
        {scene && lookup && selected && (
          <Drawer key={selected} backend={backend} scene={scene} lookup={lookup} selected={selected} onClose={() => setSelected(null)} onFocus={focusOn} toast={toast} />
        )}
      </main>
      {omni && <Omnibox index={index} onPick={focusOn} onClose={() => setOmni(false)} />}
      <Toasts toasts={toasts} />
    </div>
  );
}
