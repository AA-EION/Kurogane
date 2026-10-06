import { invoke, Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Backend } from './backend';
import type { AppStatus, CloudStep, LockReason, SyncStatus, Topology, TotpEnrollment } from './types';

/** Thin typed wrapper over the Rust commands in `src-tauri/src/commands.rs`. */
export function createTauriBackend(): Backend {
  return {
    kind: 'tauri',
    status: () => invoke<AppStatus>('app_status'),
    createVault: (args) => invoke<TotpEnrollment>('create_vault', { args }),
    confirmTotp: (code) => invoke('confirm_totp', { code }),
    pickVaultForCreate: () => invoke<string | null>('pick_vault_save_path'),
    openVault: (path) => invoke<AppStatus | null>('open_vault', { path: path ?? null }),
    connectCloud: async (provider, onStep, mega) => {
      const ch = new Channel<CloudStep>();
      ch.onmessage = onStep;
      await invoke('connect_cloud', { provider, mega: mega ?? null, onStep: ch });
    },
    unlock: (password, totp) => invoke<AppStatus>('unlock', { password, totp: totp ?? null }),
    lock: () => invoke('lock'),
    touch: () => invoke('touch'),
    topology: () => invoke<Topology>('topology'),
    reveal: (credentialId, field) => invoke<string>('reveal_secret', { credentialId, field }),
    copySecret: (credentialId, field) => invoke<{ clearsInSecs: number }>('copy_secret', { credentialId, field }),
    copyText: (text) => invoke('copy_text', { text }),
    launchSsh: (hostId, credentialId) => invoke<string>('launch_ssh', { hostId, credentialId: credentialId ?? null }),
    launchRdp: (hostId, credentialId) => invoke<string>('launch_rdp', { hostId, credentialId: credentialId ?? null }),
    launchWeb: (url) => invoke('launch_web', { url }),
    syncStatus: () => invoke<SyncStatus>('sync_status'),
    syncNow: () => invoke<string>('sync_now'),
    onLocked: (cb) => {
      let un: (() => void) | undefined;
      listen<LockReason>('vault://locked', (e) => cb(e.payload)).then((u) => (un = u));
      return () => un?.();
    },
  };
}
