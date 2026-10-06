import { createContext, useCallback, useContext } from 'react';
import type { Backend } from './api/backend';
import type { CredentialMeta, EntityKind, Host, Network, OwnerKind, ReverseProxy, Service, SyncStatus, Tenant, Topology } from './api/types';
import type { Scene } from './canvas/layout';
import type { Lookup } from './model';

export type ModalSpec =
  | { type: 'tenant'; value?: Tenant }
  | { type: 'network'; value?: Network; tenantId?: string }
  | { type: 'host'; value?: Host; tenantId?: string; parentHostId?: string }
  | { type: 'service'; value?: Service; hostId?: string; publish?: boolean }
  | { type: 'proxy'; value?: ReverseProxy; hostId?: string; routeForServiceId?: string }
  | { type: 'credential'; value?: CredentialMeta; owner?: { kind: OwnerKind; id: string } }
  | { type: 'settings'; tab?: SettingsTab }
  | { type: 'import' }
  | { type: 'delete'; kind: EntityKind; id: string; name: string; onDone?: () => void };

export type SettingsTab = 'general' | 'security' | 'sync' | 'data' | 'about';

export interface Store {
  backend: Backend;
  topo: Topology;
  scene: Scene;
  lookup: Lookup;
  sync: SyncStatus | null;
  setSync: (s: SyncStatus) => void;
  /** Replace the topology after a save; optionally focus a record by id. */
  applyTopology: (t: Topology, focusRef?: string) => void;
  selected: string | null;
  select: (nodeId: string | null) => void;
  /** Pan the map to a scene node/zone id and select it. */
  focus: (nodeId: string) => void;
  focusRef: (recordId: string) => void;
  toast: (msg: string, tone?: 'ok' | 'warn' | 'error') => void;
  openModal: (m: ModalSpec) => void;
  closeModal: () => void;
}

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore outside provider');
  return s;
}

/** Wrap an async action: errors become toasts, returns undefined on failure. */
export function useRun() {
  const { toast } = useStore();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (success) toast(success, 'ok');
        return r;
      } catch (e) {
        toast(errorText(e), 'error');
        return undefined;
      }
    },
    [toast],
  );
}

export function errorText(e: unknown): string {
  const s = String(e instanceof Error ? e.message : e).replace(/^Error: /, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
