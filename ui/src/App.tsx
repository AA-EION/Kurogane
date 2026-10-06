import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from './api/backend';
import { getBackend } from './api/backend';
import type { AppStatus, SyncStatus, Topology } from './api/types';
import { IsoCanvas } from './canvas/IsoCanvas';
import { layoutTopology } from './canvas/layout';
import { ConflictBanner } from './components/ConflictBanner';
import { DeleteDialog } from './components/DeleteDialog';
import { Drawer } from './components/Drawer';
import { EmptyState } from './components/EmptyState';
import { ImportDialog } from './components/ImportDialog';
import { LockScreen } from './components/LockScreen';
import { Omnibox } from './components/Omnibox';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { type Toast, Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { Wizard } from './components/Wizard';
import { CredentialForm } from './forms/CredentialForm';
import { HostForm } from './forms/HostForm';
import { NetworkForm } from './forms/NetworkForm';
import { ProxyForm } from './forms/ProxyForm';
import { ServiceForm } from './forms/ServiceForm';
import { TenantForm } from './forms/TenantForm';
import { buildLookup } from './model';
import { buildIndex } from './search/index';
import { type ModalSpec, type Store, StoreContext } from './store';

const TOUCH_THROTTLE_MS = 10_000;

function ModalHost({ modal }: { modal: ModalSpec | null }) {
  if (!modal) return null;
  switch (modal.type) {
    case 'tenant':
      return <TenantForm value={modal.value} />;
    case 'network':
      return <NetworkForm value={modal.value} tenantId={modal.tenantId} />;
    case 'host':
      return <HostForm value={modal.value} tenantId={modal.tenantId} parentHostId={modal.parentHostId} />;
    case 'service':
      return <ServiceForm value={modal.value} hostId={modal.hostId} publish={modal.publish} />;
    case 'proxy':
      return <ProxyForm value={modal.value} hostId={modal.hostId} routeForServiceId={modal.routeForServiceId} />;
    case 'credential':
      return <CredentialForm value={modal.value} owner={modal.owner} />;
    case 'settings':
      return <SettingsModal tab={modal.tab} />;
    case 'import':
      return <ImportDialog />;
    case 'delete':
      return <DeleteDialog kind={modal.kind} id={modal.id} name={modal.name} onDone={modal.onDone} />;
  }
}

export function App() {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [topo, setTopo] = useState<Topology | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState<{ id: string; nonce: number } | null>(null);
  const [pendingFocusRef, setPendingFocusRef] = useState<string | null>(null);
  const [omni, setOmni] = useState(false);
  const [modal, setModal] = useState<ModalSpec | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [remaining, setRemaining] = useState(0);
  const lastTouch = useRef(Date.now());
  const lastSent = useRef(0);

  const toast = useCallback((msg: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4200);
  }, []);

  const refresh = useCallback(async (b: Backend) => setStatus(await b.status()), []);

  useEffect(() => {
    getBackend()
      .then((b) => {
        setBackend(b);
        return refresh(b);
      })
      .catch((e) => setBootError(String(e)));
  }, [refresh]);

  useEffect(() => {
    if (!backend) return;
    const offLock = backend.onLocked((reason) => {
      setTopo(null);
      setSelected(null);
      setOmni(false);
      setModal(null);
      setStatus((s) => (s ? { ...s, stage: 'locked', lastLockReason: reason } : s));
      // Re-read: settings (e.g. two-factor) may have changed while unlocked.
      backend.status().then(setStatus).catch(() => undefined);
    });
    const offChanged = backend.onVaultChanged(() => {
      backend.topology().then(setTopo).catch(() => undefined);
      toast('Updated with changes from another computer', 'ok');
    });
    const offSync = backend.onSyncStatus(setSync);
    return () => (offLock(), offChanged(), offSync());
  }, [backend, toast]);

  useEffect(() => {
    if (!backend || status?.stage !== 'unlocked') return;
    backend.topology().then(setTopo).catch((e) => toast(String(e), 'error'));
    backend.syncStatus().then(setSync).catch(() => setSync(null));
    lastTouch.current = Date.now();
  }, [backend, status?.stage, toast]);

  // Activity keeps the session alive (throttled) and drives the countdown.
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
      const since = (Date.now() - Math.min(lastTouch.current, lastSent.current || lastTouch.current)) / 1000;
      setRemaining(Math.max(0, Math.round(status.lockTimeoutSecs - since)));
    }, 1000);
    return () => (evs.forEach((e) => window.removeEventListener(e, onActivity)), clearInterval(timer));
  }, [backend, status?.stage, status?.lockTimeoutSecs]);

  const scene = useMemo(() => (topo ? layoutTopology(topo) : null), [topo]);
  const lookup = useMemo(() => (topo ? buildLookup(topo) : null), [topo]);
  const index = useMemo(() => (topo && scene ? buildIndex(topo, scene) : []), [topo, scene]);

  const focus = useCallback((id: string) => {
    setSelected(id);
    setFocusReq({ id, nonce: Date.now() });
  }, []);

  // After a save, focus the record that was just created/edited.
  useEffect(() => {
    if (!pendingFocusRef || !scene || !topo) return;
    // Accounts are not drawn on the map: focus what they belong to.
    const owner = topo.credentials.find((c) => c.id === pendingFocusRef)?.owner.id;
    const id = scene.refToNode.get(pendingFocusRef) ?? (owner ? scene.refToNode.get(owner) : undefined);
    if (id) focus(id);
    setPendingFocusRef(null);
  }, [scene, topo, pendingFocusRef, focus]);

  const lock = useCallback(async () => {
    await backend?.lock();
    // The mock backend's listener covers the UI; Tauri emits vault://locked too.
  }, [backend]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (status?.stage !== 'unlocked') return;
      const modKey = e.metaKey || e.ctrlKey;
      if (modKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOmni((o) => !o);
      } else if (modKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        lock();
      } else if (e.key === 'Escape' && !omni && !modal) {
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status?.stage, omni, modal, lock]);

  if (bootError) return <div className="boot error-screen">{bootError}</div>;
  if (!backend || !status) return <div className="boot"><span className="spinner" /></div>;

  if (status.stage === 'wizard')
    return (
      <>
        <Wizard backend={backend} recent={status.recentVaults ?? []} onCreated={() => refresh(backend)} onOpened={() => refresh(backend)} toast={toast} />
        <Toasts toasts={toasts} />
      </>
    );

  if (status.stage === 'locked')
    return (
      <LockScreen
        status={status}
        onUnlock={async (pw, totp) => setStatus(await backend.unlock(pw, totp))}
        onSwitch={async () => setStatus(await backend.closeVault())}
      />
    );

  if (!topo || !scene || !lookup) return <div className="boot"><span className="spinner" /></div>;

  const store: Store = {
    backend,
    topo,
    scene,
    lookup,
    sync,
    setSync,
    applyTopology: (t, ref) => {
      setTopo(t);
      if (ref) setPendingFocusRef(ref);
    },
    selected,
    select: setSelected,
    focus,
    focusRef: (ref) => {
      const id = scene.refToNode.get(ref);
      if (id) focus(id);
    },
    toast,
    openModal: setModal,
    closeModal: () => setModal(null),
  };

  const empty = topo.tenants.length === 0;
  return (
    <StoreContext.Provider value={store}>
      <div className="app">
        <TopBar onSearch={() => setOmni(true)} remainingSecs={remaining || status.remainingSecs} timeoutSecs={status.lockTimeoutSecs} onLock={lock} memoryLocked={status.memoryLocked} />
        <div className="workspace">
          {!empty && <Sidebar />}
          <main className="stage">
            <ConflictBanner />
            {empty ? <EmptyState /> : <IsoCanvas scene={scene} selected={selected} onSelect={setSelected} focus={focusReq} dimmedTenants={new Set()} />}
            {!empty && selected && <Drawer key={selected} />}
          </main>
        </div>
        {omni && <Omnibox index={index} onPick={focus} onClose={() => setOmni(false)} />}
        <ModalHost modal={modal} />
        <Toasts toasts={toasts} />
      </div>
    </StoreContext.Provider>
  );
}
