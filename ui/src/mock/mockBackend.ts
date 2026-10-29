import type { Backend } from '../api/backend';
import type {
  AppStatus, CredentialInput, CredentialMeta, DeleteImpact, EntityKind, ImportReport, LockReason, SecretField, SecretUpdate, Settings,
  SyncStatus, Topology,
} from '../api/types';
import { verifyTotp } from './totp';
import demo from '../canvas/__fixtures__/demo-topology.json';

/**
 * In-memory stand-in for the native core, used only by `npm run dev` in a
 * plain browser. It starts EMPTY (like a new vault) and mirrors the Rust
 * behaviour closely enough to develop and test every screen: validation
 * messages, cascading deletes, sealed secrets, inactivity lock, optional 2FA.
 */
export function createMockBackend(): Backend {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const uid = () => crypto.randomUUID();
  const lockListeners = new Set<(r: LockReason) => void>();
  const syncListeners = new Set<(s: SyncStatus) => void>();
  let stage: AppStatus['stage'] = 'wizard';
  let vaultPath: string | null = null;
  let password = '';
  let lastActivity = Date.now();
  let lastReason: LockReason | null = null;
  let totpSecret: string | null = null;
  let pendingTotp: string | null = null;
  let settings = { displayName: 'Infrastructure', lockTimeoutSecs: 900, clipboardClearSecs: 30, lockOnSuspend: true };
  let topo: Topology = { vaultName: 'Infrastructure', tenants: [], networks: [], hosts: [], services: [], proxies: [], credentials: [] };
  const secrets = new Map<string, Partial<Record<SecretField, string>>>();
  let sync: SyncStatus = { linked: [], autoSync: true, busy: false, transport: null, lastOutcome: null, lastError: null, lastSyncedAtMs: null, conflict: null };
  let pendingImport: Topology | null = null;
  // Explicit, development-only visual fixture. Never enabled in installers.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === '1') {
    stage = 'unlocked';
    vaultPath = 'Synthetic preview.kurogane';
    topo = structuredClone(demo.topology) as Topology;
    settings.displayName = topo.vaultName;
  }

  const remaining = () => Math.max(0, settings.lockTimeoutSecs - Math.floor((Date.now() - lastActivity) / 1000));
  const status = (): AppStatus => ({
    stage,
    vaultPath,
    vaultName: stage === 'unlocked' ? settings.displayName : null,
    totpRequired: !!totpSecret,
    lockTimeoutSecs: settings.lockTimeoutSecs,
    remainingSecs: remaining(),
    memoryLocked: true,
    demo: true,
    lastLockReason: lastReason,
    recentVaults: vaultPath ? [vaultPath] : [],
  });
  const doLock = (reason: LockReason) => {
    if (stage !== 'unlocked') return;
    stage = 'locked';
    lastReason = reason;
    lockListeners.forEach((cb) => cb(reason));
  };
  setInterval(() => stage === 'unlocked' && remaining() === 0 && doLock('inactivity'), 1000);
  const live = () => {
    if (stage !== 'unlocked') throw new Error('Vault is locked');
    lastActivity = Date.now();
  };
  const snapshot = (): Topology => ({ ...structuredClone(topo), vaultName: settings.displayName });
  const fail = (m: string): never => {
    throw new Error(m);
  };
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const ip = (v: string | null | undefined, what: string) => {
    if (v && !/^(\d{1,3}\.){3}\d{1,3}$/.test(v) && !v.includes(':')) fail(`${what} "${v}" is not a valid IP address`);
    if (v && /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').some((x) => +x > 255)) fail(`${what} "${v}" is not a valid IP address`);
  };
  const upsert = <T extends { id: string }>(list: T[], item: T): string => {
    const id = item.id || uid();
    const i = list.findIndex((x) => x.id === id);
    const v = { ...item, id };
    if (i >= 0) list[i] = v;
    else list.push(v);
    return id;
  };
  const credMeta = (c: CredentialInput, id: string): CredentialMeta => {
    const s = secrets.get(id) ?? {};
    return {
      id,
      owner: c.owner,
      kind: c.kind,
      label: c.label.trim(),
      username: c.username || null,
      url: c.url || null,
      publicKey: c.publicKey || null,
      hasSecret: !!s.secret,
      hasPrivateKey: !!s.privateKey,
      hasNotes: !!s.notes,
      expiresAt: c.expiresAt || null,
    };
  };
  const applySecret = (id: string, field: SecretField, u: SecretUpdate) => {
    const s = secrets.get(id) ?? {};
    if (u === 'clear') delete s[field];
    else if (u !== 'keep') {
      if (u.set) s[field] = u.set;
      else delete s[field];
    }
    secrets.set(id, s);
  };

  // --- cascading deletes, mirroring ON DELETE CASCADE / SET NULL
  const deleteService = (id: string) => {
    topo.services = topo.services.filter((s) => s.id !== id);
    topo.credentials = topo.credentials.filter((c) => !(c.owner.kind === 'service' && c.owner.id === id));
    topo.proxies.forEach((p) => {
      if (p.serviceId === id) p.serviceId = null;
      p.routes.forEach((r) => r.serviceId === id && (r.serviceId = null));
    });
  };
  const deleteProxy = (id: string) => {
    topo.proxies = topo.proxies.filter((p) => p.id !== id);
    topo.credentials = topo.credentials.filter((c) => !(c.owner.kind === 'proxy' && c.owner.id === id));
  };
  const deleteHost = (id: string) => {
    topo.services.filter((s) => s.hostId === id).forEach((s) => deleteService(s.id));
    topo.proxies.filter((p) => p.hostId === id).forEach((p) => deleteProxy(p.id));
    topo.hosts = topo.hosts.filter((h) => h.id !== id);
    topo.hosts.forEach((h) => h.parentHostId === id && (h.parentHostId = null));
    topo.proxies.forEach((p) => p.routes.forEach((r) => r.targetHostId === id && (r.targetHostId = null)));
    topo.credentials = topo.credentials.filter((c) => !(c.owner.kind === 'host' && c.owner.id === id));
  };
  const deleteTenant = (id: string) => {
    topo.hosts.filter((h) => h.tenantId === id).forEach((h) => deleteHost(h.id));
    topo.networks = topo.networks.filter((n) => n.tenantId !== id);
    topo.tenants = topo.tenants.filter((t) => t.id !== id);
    topo.credentials = topo.credentials.filter((c) => !(c.owner.kind === 'tenant' && c.owner.id === id));
  };
  const saved = (id: string) => ({ id, topology: snapshot() });
  const emitSync = () => syncListeners.forEach((cb) => cb(structuredClone(sync)));

  return {
    kind: 'mock',
    status: async () => status(),
    createVault: async (args) => {
      if (args.password.length < 12) fail('master password must be at least 12 characters');
      await sleep(600);
      vaultPath = args.path ?? `~/Documents/${args.displayName || 'infrastructure'}.kurogane`;
      password = args.password;
      settings = { ...settings, displayName: args.displayName || 'Infrastructure' };
      stage = 'unlocked';
      lastActivity = Date.now();
      pendingTotp = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
      return { secretBase32: pendingTotp, otpauthUri: `otpauth://totp/Kurogane:${args.account}?secret=${pendingTotp}`, qrSvg: '' };
    },
    pickVaultForCreate: async () => null,
    openVault: async () => {
      if (!vaultPath) fail('No vault in this browser session yet — create one first');
      stage = 'locked';
      return status();
    },
    closeVault: async () => {
      doLock('manual');
      stage = 'wizard';
      return status();
    },
    unlock: async (pw, code) => {
      await sleep(400);
      if (pw !== password) fail('wrong master password or corrupted vault');
      if (totpSecret) {
        if (!code) fail('a two-factor code is required to unlock this vault');
        if (!(await verifyTotp(totpSecret, code!))) fail('invalid or reused two-factor code');
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
    onLocked: (cb) => {
      lockListeners.add(cb);
      return () => lockListeners.delete(cb);
    },
    onVaultChanged: () => () => undefined,
    topology: async () => (live(), snapshot()),
    saveTenant: async (t) => {
      live();
      if (!t.name.trim()) fail('Company name is required');
      if (topo.tenants.some((x) => x.id !== t.id && same(x.name, t.name))) fail('A company with this name already exists');
      return saved(upsert(topo.tenants, { ...t, name: t.name.trim() }));
    },
    saveNetwork: async (n) => {
      live();
      if (!n.name.trim()) fail('Network name is required');
      if (!/^[\d.:a-fA-F]+\/\d{1,3}$/.test(n.cidr)) fail(`"${n.cidr}" is not CIDR notation (e.g. 192.168.1.0/24)`);
      return saved(upsert(topo.networks, n));
    },
    saveHost: async (h) => {
      live();
      if (!h.name.trim()) fail('Machine name is required');
      if (topo.hosts.some((x) => x.id !== h.id && x.tenantId === h.tenantId && same(x.name, h.name))) fail('This company already has a machine with that name');
      h.interfaces.forEach((n) => (ip(n.internalIp, 'Private IP'), ip(n.publicIp, 'Public IP'), ip(n.gateway, 'Gateway')));
      const id = h.id || uid();
      const primary = Math.max(0, h.interfaces.findIndex((n) => n.isPrimary));
      return saved(upsert(topo.hosts, { ...h, id, name: h.name.trim(), interfaces: h.interfaces.map((n, i) => ({ ...n, id: n.id || uid(), hostId: id, isPrimary: i === primary })) }));
    },
    saveService: async (s) => {
      live();
      if (!s.name.trim()) fail('Service name is required');
      if (topo.services.some((x) => x.id !== s.id && x.hostId === s.hostId && same(x.name, s.name))) fail('This machine already has a service with that name');
      for (const p of s.ports)
        if (p.hostPort && topo.services.some((o) => o.id !== s.id && o.hostId === s.hostId && o.ports.some((q) => q.hostPort === p.hostPort && q.protocol === p.protocol)))
          fail('That published port is already used by another service on this machine');
      const id = s.id || uid();
      const primary = Math.max(0, s.ports.findIndex((p) => p.isPrimary));
      return saved(upsert(topo.services, { ...s, id, name: s.name.trim(), ports: s.ports.map((p, i) => ({ ...p, id: p.id || uid(), serviceId: id, isPrimary: i === primary })) }));
    },
    saveProxy: async (p) => {
      live();
      if (!p.name.trim()) fail('Proxy name is required');
      p.routes.forEach((r) => {
        if (!r.domain.trim()) fail('Domain is required');
        ip(r.targetIp, 'Target IP');
        if (!r.targetIp) fail('Target IP is required');
      });
      const id = p.id || uid();
      return saved(
        upsert(topo.proxies, {
          ...p,
          id,
          routes: p.routes.map((r) => ({ ...r, id: r.id || uid(), proxyId: id, domain: r.domain.trim().toLowerCase(), tlsMode: r.inboundProtocol === 'https' && r.tlsMode === 'none' ? 'letsencrypt' : r.tlsMode })),
        }),
      );
    },
    saveCredential: async (c) => {
      live();
      if (!c.label.trim()) fail('Label is required');
      const id = c.id || uid();
      applySecret(id, 'secret', c.secret);
      applySecret(id, 'privateKey', c.privateKey);
      applySecret(id, 'notes', c.notes);
      if (c.kind === 'ssh_key' && !secrets.get(id)?.privateKey) fail('SSH key accounts need a private key');
      upsert(topo.credentials, credMeta(c, id));
      return saved(id);
    },
    deleteImpact: async (kind, id): Promise<DeleteImpact> => {
      live();
      const imp = { hosts: 0, services: 0, proxies: 0, routes: 0, credentials: 0, networks: 0 };
      const hostIds = kind === 'tenant' ? topo.hosts.filter((h) => h.tenantId === id).map((h) => h.id) : kind === 'host' ? [id] : [];
      const svcIds = kind === 'service' ? [id] : topo.services.filter((s) => hostIds.includes(s.hostId)).map((s) => s.id);
      const pxs = kind === 'proxy' ? topo.proxies.filter((p) => p.id === id) : topo.proxies.filter((p) => hostIds.includes(p.hostId));
      if (kind === 'tenant') (imp.hosts = hostIds.length), (imp.networks = topo.networks.filter((n) => n.tenantId === id).length);
      if (kind !== 'service') imp.services = svcIds.length;
      if (kind === 'tenant' || kind === 'host') imp.proxies = pxs.length;
      imp.routes = pxs.reduce((s, p) => s + p.routes.length, 0);
      const owners = new Set([id, ...hostIds, ...svcIds, ...pxs.map((p) => p.id)]);
      imp.credentials = topo.credentials.filter((c) => owners.has(c.owner.id)).length;
      return imp;
    },
    deleteEntity: async (kind: EntityKind, id) => {
      live();
      ({
        tenant: () => deleteTenant(id),
        network: () => (topo.networks = topo.networks.filter((n) => n.id !== id)),
        host: () => deleteHost(id),
        service: () => deleteService(id),
        proxy: () => deleteProxy(id),
        route: () => topo.proxies.forEach((p) => (p.routes = p.routes.filter((r) => r.id !== id))),
        credential: () => (topo.credentials = topo.credentials.filter((c) => c.id !== id)),
      })[kind]();
      return snapshot();
    },
    reveal: async (id, field) => {
      live();
      return secrets.get(id)?.[field] ?? fail('No such secret');
    },
    copySecret: async (id, field) => {
      live();
      const v = secrets.get(id)?.[field] ?? fail('No such secret');
      await navigator.clipboard?.writeText(v).catch(() => undefined);
      setTimeout(async () => {
        try {
          if ((await navigator.clipboard.readText()) === v) await navigator.clipboard.writeText('');
        } catch {
          /* clipboard read not permitted */
        }
      }, settings.clipboardClearSecs * 1000);
      return { clearsInSecs: settings.clipboardClearSecs };
    },
    copyText: async (t) => void (await navigator.clipboard?.writeText(t).catch(() => undefined)),
    launchSsh: async (hostId) => {
      live();
      const h = topo.hosts.find((x) => x.id === hostId)!;
      return `Would run: ssh -p ${h.sshPort ?? 22} ${h.interfaces[0]?.internalIp ?? h.fqdn} (browser preview)`;
    },
    launchRdp: async (hostId) => {
      live();
      const h = topo.hosts.find((x) => x.id === hostId)!;
      return `Would open RDP to ${h.interfaces[0]?.internalIp}:${h.rdpPort ?? 3389} (browser preview)`;
    },
    launchWeb: async (url) => void (live(), window.open(url, '_blank', 'noopener,noreferrer')),
    getSettings: async (): Promise<Settings> => (
      live(),
      {
        ...settings,
        totpEnabled: !!totpSecret,
        kdf: { mCostKib: 262144, tCost: 3, parallelism: 4 },
        kdfProfile: 'standard',
        kdfMeetsFloor: true,
        vaultPath: vaultPath ?? '',
        memoryLocked: true,
        autoSync: sync.autoSync,
        appVersion: '0.1.0-dev',
      }
    ),
    updateSettings: async (s) => {
      live();
      if (!s.displayName.trim()) fail('Vault name is required');
      settings = { ...s };
    },
    changePassword: async (cur, next) => {
      await sleep(500);
      if (cur !== password) fail('Current password is incorrect');
      if (next.length < 12) fail('master password must be at least 12 characters');
      password = next;
    },
    totpBegin: async (account) => {
      pendingTotp = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
      return { secretBase32: pendingTotp, otpauthUri: `otpauth://totp/Kurogane:${account}?secret=${pendingTotp}`, qrSvg: '' };
    },
    confirmTotp: async (code) => {
      if (!pendingTotp) fail('start pairing first');
      if (!(await verifyTotp(pendingTotp!, code))) fail('invalid or reused two-factor code');
      totpSecret = pendingTotp;
      pendingTotp = null;
    },
    totpDisable: async (code) => {
      if (totpSecret && !(await verifyTotp(totpSecret, code))) fail('invalid or reused two-factor code');
      totpSecret = null;
    },
    downloadTemplate: async () => fail('The Excel template is generated by the desktop app'),
    exportData: async (format, includeSecrets) => {
      live();
      if (format !== 'json') fail('Excel export runs in the desktop app');
      const doc = { format: 'kurogane-export/1', exportedAtMs: Date.now(), topology: snapshot(), secrets: includeSecrets ? Object.fromEntries(secrets) : undefined };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
      a.download = 'kurogane-export.json';
      a.click();
      return 'kurogane-export.json';
    },
    exportBackup: async () => fail('Backups are written by the desktop app'),
    importPreview: async () => {
      live();
      const file = await new Promise<File | null>((resolve) => {
        const i = document.createElement('input');
        i.type = 'file';
        i.accept = '.json';
        i.onchange = () => resolve(i.files?.[0] ?? null);
        i.click();
      });
      if (!file) return null;
      const doc = JSON.parse(await file.text());
      if (doc.format !== 'kurogane-export/1') fail('Not a Kurogane JSON export');
      pendingImport = doc.topology;
      const t = doc.topology as Topology;
      const z = { companies: 0, networks: 0, machines: 0, cards: 0, services: 0, ports: 0, proxies: 0, routes: 0, accounts: 0 };
      const report: ImportReport = {
        created: { ...z, companies: t.tenants.length, networks: t.networks.length, machines: t.hosts.length, services: t.services.length, proxies: t.proxies.length, accounts: t.credentials.length },
        updated: z,
        errors: [],
        warnings: [],
        applied: false,
      };
      return { fileName: file.name, format: 'json', report };
    },
    importApply: async () => {
      live();
      if (!pendingImport) fail('Choose a file to import first');
      const t = pendingImport!;
      t.tenants.forEach((x) => upsert(topo.tenants, x));
      t.networks.forEach((x) => upsert(topo.networks, x));
      t.hosts.forEach((x) => upsert(topo.hosts, x));
      t.services.forEach((x) => upsert(topo.services, x));
      t.proxies.forEach((x) => upsert(topo.proxies, x));
      t.credentials.forEach((x) => upsert(topo.credentials, x));
      pendingImport = null;
      const z = { companies: 0, networks: 0, machines: 0, cards: 0, services: 0, ports: 0, proxies: 0, routes: 0, accounts: 0 };
      return { report: { created: z, updated: z, errors: [], warnings: [], applied: true }, topology: snapshot() };
    },
    saveFile: async (name, data) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(data);
      a.download = name;
      a.click();
      return name;
    },
    connectCloud: async (_provider, onStep) => {
      onStep({ step: 'error', message: 'Cloud linking runs in the desktop app' });
      return fail('Cloud linking runs in the desktop app');
    },
    connectCloudFinish: async () => fail('Cloud linking runs in the desktop app'),
    linkRemote: async () => fail('Cloud linking runs in the desktop app'),
    linkFolder: async () => {
      live();
      sync = { ...sync, linked: [...sync.linked, { id: uid(), provider: 'local', label: 'Synced folder', remotePath: '~/Dropbox/Kurogane/infrastructure.kurogane', transport: 'auto' }] };
      emitSync();
      return structuredClone(sync);
    },
    unlinkRemote: async (id) => {
      sync = { ...sync, linked: sync.linked.filter((l) => l.id !== id) };
      emitSync();
      return structuredClone(sync);
    },
    syncStatus: async () => structuredClone(sync),
    setAutoSync: async (enabled) => ((sync = { ...sync, autoSync: enabled }), emitSync(), structuredClone(sync)),
    syncNow: async () => {
      sync = { ...sync, busy: true };
      emitSync();
      await sleep(700);
      sync = { ...sync, busy: false, lastOutcome: sync.linked.map((l) => `${l.label}: up to date`).join(' · ') || null, lastSyncedAtMs: Date.now() };
      emitSync();
      return structuredClone(sync);
    },
    resolveConflict: async () => ((sync = { ...sync, conflict: null }), structuredClone(sync)),
    onSyncStatus: (cb) => {
      syncListeners.add(cb);
      return () => syncListeners.delete(cb);
    },
  };
}
