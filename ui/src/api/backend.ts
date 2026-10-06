import type {
  AppStatus, CloudConnect, CloudProvider, CloudStep, CreateVaultArgs, CredentialInput, DeleteImpact, EntityKind, Host,
  ImportPreview, ImportReport, LockReason, Network, ReverseProxy, Saved, SecretField, Service, Settings, SettingsUpdate,
  SyncStatus, Tenant, Topology, TotpEnrollment,
} from './types';

export interface MegaLogin {
  user: string;
  password: string;
}

/**
 * Everything the UI may ask of the native core. Secrets cross this boundary
 * only through `reveal` (explicit, audited); `copySecret` and the launchers
 * keep plaintext on the native side.
 */
export interface Backend {
  readonly kind: 'tauri' | 'mock';
  // lifecycle
  status(): Promise<AppStatus>;
  createVault(args: CreateVaultArgs): Promise<TotpEnrollment>;
  pickVaultForCreate(): Promise<string | null>;
  openVault(path?: string): Promise<AppStatus | null>;
  closeVault(): Promise<AppStatus>;
  unlock(password: string, totp?: string): Promise<AppStatus>;
  lock(): Promise<void>;
  touch(): Promise<void>;
  onLocked(cb: (reason: LockReason) => void): () => void;
  onVaultChanged(cb: () => void): () => void;
  // data
  topology(): Promise<Topology>;
  saveTenant(t: Tenant): Promise<Saved>;
  saveNetwork(n: Network): Promise<Saved>;
  saveHost(h: Host): Promise<Saved>;
  saveService(s: Service): Promise<Saved>;
  saveProxy(p: ReverseProxy): Promise<Saved>;
  saveCredential(c: CredentialInput): Promise<Saved>;
  deleteImpact(kind: EntityKind, id: string): Promise<DeleteImpact>;
  deleteEntity(kind: EntityKind, id: string): Promise<Topology>;
  // secrets & launchers
  reveal(credentialId: string, field: SecretField): Promise<string>;
  copySecret(credentialId: string, field: SecretField): Promise<{ clearsInSecs: number }>;
  copyText(text: string): Promise<void>;
  launchSsh(hostId: string, credentialId?: string): Promise<string>;
  launchRdp(hostId: string, credentialId?: string): Promise<string>;
  launchWeb(url: string): Promise<void>;
  // settings & security
  getSettings(): Promise<Settings>;
  updateSettings(s: SettingsUpdate): Promise<void>;
  changePassword(current: string, next: string, kdf?: 'standard' | 'hardened'): Promise<void>;
  totpBegin(account: string): Promise<TotpEnrollment>;
  confirmTotp(code: string): Promise<void>;
  totpDisable(code: string): Promise<void>;
  // import / export
  downloadTemplate(): Promise<string | null>;
  exportData(format: 'xlsx' | 'json', includeSecrets: boolean, password?: string): Promise<string | null>;
  exportBackup(): Promise<string | null>;
  importPreview(): Promise<ImportPreview | null>;
  importApply(): Promise<{ report: ImportReport; topology: Topology }>;
  saveFile(name: string, data: Blob, filterName: string, extensions: string[]): Promise<string | null>;
  // sync
  connectCloud(provider: CloudProvider, onStep: (s: CloudStep) => void, mega?: MegaLogin): Promise<CloudConnect | null>;
  connectCloudFinish(remotePath: string, onStep: (s: CloudStep) => void): Promise<string>;
  linkRemote(provider: Exclude<CloudProvider, 'folder'>, onStep: (s: CloudStep) => void, mega?: MegaLogin): Promise<SyncStatus>;
  linkFolder(): Promise<SyncStatus | null>;
  unlinkRemote(id: string): Promise<SyncStatus>;
  syncStatus(): Promise<SyncStatus>;
  setAutoSync(enabled: boolean): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  resolveConflict(choice: 'mine' | 'theirs'): Promise<SyncStatus>;
  onSyncStatus(cb: (s: SyncStatus) => void): () => void;
}

let instance: Backend | null = null;

export async function getBackend(): Promise<Backend> {
  if (instance) return instance;
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (isTauri) {
    instance = (await import('./tauri')).createTauriBackend();
  } else if (import.meta.env.DEV || import.meta.env.VITE_ENABLE_MOCK === '1') {
    // Browser-only development backend; tree-shaken out of production builds.
    instance = (await import('../mock/mockBackend')).createMockBackend();
  } else {
    throw new Error('Kurogane must run inside the desktop app.');
  }
  return instance;
}
