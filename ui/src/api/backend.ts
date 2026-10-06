import type {
  AppStatus, CloudProvider, CloudStep, CreateVaultArgs, LockReason, SecretField, SyncStatus, Topology, TotpEnrollment,
} from './types';

/**
 * Everything the UI may ask of the native core. The Tauri implementation
 * forwards to Rust commands; the mock implementation powers the browser demo.
 * Secrets cross this boundary only through `reveal` (explicit, audited) —
 * `copySecret` keeps the plaintext entirely on the native side.
 */
export interface Backend {
  readonly kind: 'tauri' | 'mock';
  status(): Promise<AppStatus>;
  createVault(args: CreateVaultArgs): Promise<TotpEnrollment>;
  confirmTotp(code: string): Promise<void>;
  pickVaultForCreate(): Promise<string | null>;
  openVault(path?: string): Promise<AppStatus | null>;
  connectCloud(provider: CloudProvider, onStep: (s: CloudStep) => void, mega?: { user: string; password: string }): Promise<void>;
  unlock(password: string, totp?: string): Promise<AppStatus>;
  lock(): Promise<void>;
  touch(): Promise<void>;
  topology(): Promise<Topology>;
  reveal(credentialId: string, field: SecretField): Promise<string>;
  copySecret(credentialId: string, field: SecretField): Promise<{ clearsInSecs: number }>;
  copyText(text: string): Promise<void>;
  launchSsh(hostId: string, credentialId?: string): Promise<string>;
  launchRdp(hostId: string, credentialId?: string): Promise<string>;
  launchWeb(url: string): Promise<void>;
  syncStatus(): Promise<SyncStatus>;
  syncNow(): Promise<string>;
  onLocked(cb: (reason: LockReason) => void): () => void;
  exportText?(suggestedName: string, content: string): Promise<boolean>;
  /** Browser demo only: the public demo password and the current demo TOTP. */
  demoCredentials?(): Promise<{ password: string; totp: string }>;
}

let instance: Backend | null = null;

export async function getBackend(): Promise<Backend> {
  if (instance) return instance;
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  instance = isTauri ? (await import('./tauri')).createTauriBackend() : (await import('../mock/mockBackend')).createMockBackend();
  return instance;
}
