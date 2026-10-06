import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Backend } from './backend';
import type {
  AppStatus, CloudConnect, CloudStep, DeleteImpact, ImportPreview, ImportReport, LockReason, Saved, Settings, SyncStatus,
  Topology, TotpEnrollment,
} from './types';

function channel(onStep: (s: CloudStep) => void) {
  const ch = new Channel<CloudStep>();
  ch.onmessage = onStep;
  return ch;
}

function subscribe<T>(event: string, cb: (payload: T) => void) {
  let un: (() => void) | undefined;
  let dead = false;
  listen<T>(event, (e) => cb(e.payload)).then((u) => (dead ? u() : (un = u)));
  return () => {
    dead = true;
    un?.();
  };
}

async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Typed wrapper over the Rust commands in `src-tauri/src/{commands,io,sync}.rs`. */
export function createTauriBackend(): Backend {
  return {
    kind: 'tauri',
    status: () => invoke<AppStatus>('app_status'),
    createVault: (args) => invoke<TotpEnrollment>('create_vault', { args }),
    pickVaultForCreate: () => invoke<string | null>('pick_vault_save_path'),
    openVault: (path) => invoke<AppStatus | null>('open_vault', { path: path ?? null }),
    closeVault: () => invoke<AppStatus>('close_vault'),
    unlock: (password, totp) => invoke<AppStatus>('unlock', { password, totp: totp ?? null }),
    lock: () => invoke('lock'),
    touch: () => invoke('touch'),
    onLocked: (cb) => subscribe<LockReason>('vault://locked', cb),
    onVaultChanged: (cb) => subscribe<null>('vault://changed', () => cb()),
    topology: () => invoke<Topology>('topology'),
    saveTenant: (tenant) => invoke<Saved>('save_tenant', { tenant }),
    saveNetwork: (network) => invoke<Saved>('save_network', { network }),
    saveHost: (host) => invoke<Saved>('save_host', { host }),
    saveService: (service) => invoke<Saved>('save_service', { service }),
    saveProxy: (proxy) => invoke<Saved>('save_proxy', { proxy }),
    saveCredential: (credential) => invoke<Saved>('save_credential', { credential }),
    deleteImpact: (kind, id) => invoke<DeleteImpact>('delete_impact', { kind, id }),
    deleteEntity: (kind, id) => invoke<Topology>('delete_entity', { kind, id }),
    reveal: (credentialId, field) => invoke<string>('reveal_secret', { credentialId, field }),
    copySecret: (credentialId, field) => invoke<{ clearsInSecs: number }>('copy_secret', { credentialId, field }),
    copyText: (text) => invoke('copy_text', { text }),
    launchSsh: (hostId, credentialId) => invoke<string>('launch_ssh', { hostId, credentialId: credentialId ?? null }),
    launchRdp: (hostId, credentialId) => invoke<string>('launch_rdp', { hostId, credentialId: credentialId ?? null }),
    launchWeb: (url) => invoke('launch_web', { url }),
    getSettings: () => invoke<Settings>('get_settings'),
    updateSettings: (settings) => invoke('update_settings', { settings }),
    changePassword: (current, next, kdf) => invoke('change_password', { current, newPassword: next, kdf: kdf ?? null }),
    totpBegin: (account) => invoke<TotpEnrollment>('totp_begin', { account }),
    confirmTotp: (code) => invoke('confirm_totp', { code }),
    totpDisable: (code) => invoke('totp_disable', { code }),
    downloadTemplate: () => invoke<string | null>('download_template'),
    exportData: (format, includeSecrets, password) => invoke<string | null>('export_data', { format, includeSecrets, password: password ?? null }),
    exportBackup: () => invoke<string | null>('export_backup'),
    importPreview: () => invoke<ImportPreview | null>('import_preview'),
    importApply: () => invoke<{ report: ImportReport; topology: Topology }>('import_apply'),
    saveFile: async (name, data, filterName, extensions) =>
      invoke<string | null>('save_file', { suggestedName: name, dataBase64: await blobToBase64(data), filterName, extensions }),
    connectCloud: (provider, onStep, mega) => invoke<CloudConnect | null>('connect_cloud', { provider, mega: mega ?? null, onStep: channel(onStep) }),
    connectCloudFinish: (remotePath, onStep) => invoke<string>('connect_cloud_finish', { remotePath, onStep: channel(onStep) }),
    linkRemote: (provider, onStep, mega) => invoke<SyncStatus>('link_remote', { provider, mega: mega ?? null, onStep: channel(onStep) }),
    linkFolder: () => invoke<SyncStatus | null>('link_folder'),
    unlinkRemote: (id) => invoke<SyncStatus>('unlink_remote', { id }),
    syncStatus: () => invoke<SyncStatus>('sync_status'),
    setAutoSync: (enabled) => invoke<SyncStatus>('set_auto_sync', { enabled }),
    syncNow: () => invoke<SyncStatus>('sync_now'),
    resolveConflict: (choice) => invoke<SyncStatus>('resolve_conflict', { choice }),
    onSyncStatus: (cb) => subscribe<SyncStatus>('sync://status', cb),
  };
}
