import type { Backend } from '../api/backend';
import type { AppStatus, LockReason, SecretField, Topology } from '../api/types';
import fixture from './demo-fixture.json';
import { totpAt, verifyTotp } from './totp';

/**
 * Browser-only stand-in for the native core so the UI can be developed and
 * demoed without Tauri. Behaviour mirrors the Rust side: password + TOTP
 * unlock, inactivity lock, secrets fetched one at a time, clipboard clearing.
 */
export function createMockBackend(): Backend {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const secrets = fixture.secrets as Record<string, { field: SecretField; value: string }>;
  const lockListeners = new Set<(r: LockReason) => void>();
  const timeoutSecs = 15 * 60;
  let stage: AppStatus['stage'] = 'wizard';
  let lastActivity = Date.now();
  let totpEnabled = true;
  let lastReason: LockReason | null = null;
  let clipboardTimer: ReturnType<typeof setTimeout> | undefined;
  let vaultPath = '~/Documents/Demo Infrastructure.kurogane';

  const remaining = () => Math.max(0, timeoutSecs - Math.floor((Date.now() - lastActivity) / 1000));
  const status = (): AppStatus => ({
    stage,
    vaultPath: stage === 'wizard' ? null : vaultPath,
    vaultName: stage === 'wizard' ? null : fixture.topology.vaultName,
    totpRequired: totpEnabled,
    lockTimeoutSecs: timeoutSecs,
    remainingSecs: remaining(),
    memoryLocked: true,
    demo: true,
    lastLockReason: lastReason,
  });
  const doLock = (reason: LockReason) => {
    if (stage !== 'unlocked') return;
    stage = 'locked';
    lastReason = reason;
    lockListeners.forEach((cb) => cb(reason));
  };
  setInterval(() => {
    if (stage === 'unlocked' && remaining() === 0) doLock('inactivity');
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    // Stand-in for OS screen-lock notifications in the native build.
    if (document.visibilityState === 'hidden' && localStorage.getItem('kurogane.lockOnHide') === '1') doLock('screenLocked');
  });
  const requireUnlocked = () => {
    if (stage !== 'unlocked') throw new Error('Vault is locked');
    lastActivity = Date.now();
  };

  return {
    kind: 'mock',
    status: async () => status(),
    createVault: async (args) => {
      if (args.password.length < 12) throw new Error('Master password must be at least 12 characters');
      await sleep(900); // Argon2id
      vaultPath = args.path ?? `~/Documents/${args.displayName}.kurogane`;
      totpEnabled = false;
      stage = 'unlocked';
      lastActivity = Date.now();
      return fixture.demoTotp;
    },
    confirmTotp: async (code) => {
      if (!(await verifyTotp(fixture.demoTotp.secretBase32, code))) throw new Error('Invalid two-factor code');
      totpEnabled = true;
    },
    pickVaultForCreate: async () => null,
    openVault: async (path) => {
      vaultPath = path ?? vaultPath;
      stage = 'locked';
      return status();
    },
    connectCloud: async (provider, onStep) => {
      onStep({ step: 'provisioning', done: 0, total: 31_000_000 });
      for (let i = 1; i <= 10; i++) {
        await sleep(120);
        onStep({ step: 'provisioning', done: i * 3_100_000, total: 31_000_000 });
      }
      if (provider !== 'mega') {
        onStep({ step: 'consent', url: 'http://127.0.0.1:53682/auth?state=demo' });
        await sleep(1600);
      }
      onStep({ step: 'downloading' });
      await sleep(900);
      vaultPath = `${provider}:Kurogane/infra.kurogane`;
      stage = 'locked';
      onStep({ step: 'done', vaultPath });
    },
    unlock: async (password, totp) => {
      await sleep(700); // Argon2id
      if (password !== fixture.demoPassword) throw new Error('Wrong master password or corrupted vault');
      if (totpEnabled) {
        if (!totp) throw new Error('A two-factor code is required to unlock this vault');
        if (!(await verifyTotp(fixture.demoTotp.secretBase32, totp))) throw new Error('Invalid or reused two-factor code');
      }
      stage = 'unlocked';
      lastReason = null;
      lastActivity = Date.now();
      return status();
    },
    lock: async () => doLock('manual'),
    touch: async () => {
      if (stage === 'unlocked') lastActivity = Date.now();
    },
    topology: async () => {
      requireUnlocked();
      return structuredClone(fixture.topology) as Topology;
    },
    reveal: async (id, field) => {
      requireUnlocked();
      const s = secrets[id];
      if (!s || s.field !== field) throw new Error('No such secret');
      return s.value;
    },
    copySecret: async (id, field) => {
      requireUnlocked();
      const s = secrets[id];
      if (!s || s.field !== field) throw new Error('No such secret');
      await navigator.clipboard?.writeText(s.value).catch(() => undefined);
      clearTimeout(clipboardTimer);
      clipboardTimer = setTimeout(async () => {
        try {
          if ((await navigator.clipboard.readText()) === s.value) await navigator.clipboard.writeText('');
        } catch {
          /* clipboard read not permitted in this browser */
        }
      }, 30_000);
      return { clearsInSecs: 30 };
    },
    copyText: async (text) => {
      await navigator.clipboard?.writeText(text).catch(() => undefined);
    },
    launchSsh: async (hostId) => {
      requireUnlocked();
      const h = fixture.topology.hosts.find((x) => x.id === hostId)!;
      const ip = h.interfaces[0]?.internalIp;
      return `ssh -p ${h.sshPort ?? 22} -- ${ip}  (demo: not executed)`;
    },
    launchRdp: async (hostId) => {
      requireUnlocked();
      const h = fixture.topology.hosts.find((x) => x.id === hostId)!;
      return `.rdp for ${h.interfaces[0]?.internalIp}:${h.rdpPort} (demo: not executed)`;
    },
    launchWeb: async (url) => {
      requireUnlocked();
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    syncStatus: async () => ({
      linked: [{ id: 'demo', provider: 'drive', label: 'Google Drive', remotePath: 'Kurogane/infra.kurogane' }],
      transport: 'binary',
      lastOutcome: 'inSync',
      lastSyncedAtMs: Date.now() - 4 * 60_000,
      busy: false,
    }),
    syncNow: async () => {
      await sleep(800);
      return 'inSync';
    },
    onLocked: (cb) => {
      lockListeners.add(cb);
      return () => lockListeners.delete(cb);
    },
    demoCredentials: async () => ({ password: fixture.demoPassword, totp: await totpAt(fixture.demoTotp.secretBase32, Date.now() / 1000) }),
  };
}
