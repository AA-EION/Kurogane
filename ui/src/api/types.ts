// Mirrors kurogane-core `db::models` (serde camelCase). Secret-free by design.

export type Environment = 'corporate' | 'client' | 'personal' | 'lab' | 'staging' | 'production';

export interface Tenant {
  id: string;
  name: string;
  environment: Environment;
  environmentLabel?: string | null;
  color?: string | null;
  slaNotes?: string | null;
  adminNotes?: string | null;
}

export interface Network {
  id: string;
  tenantId: string;
  name: string;
  kind: string;
  cidr: string;
  vlanId?: number | null;
  gateway?: string | null;
}

export interface NetworkInterface {
  id: string;
  hostId: string;
  networkId?: string | null;
  name: string;
  mac?: string | null;
  internalIp?: string | null;
  gateway?: string | null;
  publicIp?: string | null;
  isPrimary: boolean;
}

export type HostCategory =
  | 'vps' | 'local_server' | 'vm' | 'switch' | 'access_point' | 'router'
  | 'firewall' | 'nvr' | 'nas' | 'edge_device' | 'workstation';

export interface Host {
  id: string;
  tenantId: string;
  parentHostId?: string | null;
  name: string;
  category: HostCategory;
  osFamily?: string | null;
  fqdn?: string | null;
  sshPort?: number | null;
  rdpPort?: number | null;
  winrmPort?: number | null;
  webAdminUrl?: string | null;
  provider?: string | null;
  location?: string | null;
  icon?: string | null;
  notes?: string | null;
  interfaces: NetworkInterface[];
}

export interface ServicePort {
  id: string;
  serviceId: string;
  containerPort: number;
  hostPort?: number | null;
  bindAddress: string;
  protocol: string;
  isPrimary: boolean;
}

export interface Service {
  id: string;
  hostId: string;
  name: string;
  runtime: string;
  image?: string | null;
  scheme: string;
  healthPath?: string | null;
  description?: string | null;
  icon?: string | null;
  /** Owning company when it differs from the machine's company. */
  ownerTenantId?: string | null;
  ports: ServicePort[];
}

export interface ProxyRoute {
  id: string;
  proxyId: string;
  domain: string;
  pathPrefix: string;
  inboundPort: number;
  inboundProtocol: string;
  tlsMode: string;
  tlsExpiresAt?: string | null;
  targetHostId?: string | null;
  targetIp: string;
  targetPort: number;
  targetScheme: string;
  serviceId?: string | null;
  enabled: boolean;
}

export interface ReverseProxy {
  id: string;
  hostId: string;
  serviceId?: string | null;
  name: string;
  kind: string;
  adminUrl?: string | null;
  routes: ProxyRoute[];
}

export type OwnerKind = 'tenant' | 'host' | 'service' | 'proxy';

export interface CredentialMeta {
  id: string;
  owner: { kind: OwnerKind; id: string };
  kind: string;
  label: string;
  username?: string | null;
  url?: string | null;
  publicKey?: string | null;
  hasSecret: boolean;
  hasPrivateKey: boolean;
  hasNotes: boolean;
  expiresAt?: string | null;
}

export interface Topology {
  vaultName: string;
  tenants: Tenant[];
  networks: Network[];
  hosts: Host[];
  services: Service[];
  proxies: ReverseProxy[];
  credentials: CredentialMeta[];
}

export type SecretField = 'secret' | 'privateKey' | 'notes';
export type Stage = 'wizard' | 'locked' | 'unlocked';
export type LockReason = 'inactivity' | 'systemSuspend' | 'screenLocked' | 'manual';
export type CloudProvider = 'drive' | 'onedrive' | 'mega' | 'folder';
export type KdfProfile = 'standard' | 'hardened';
export type EntityKind = 'tenant' | 'network' | 'host' | 'service' | 'proxy' | 'route' | 'credential';

export interface AppStatus {
  stage: Stage;
  vaultPath?: string | null;
  vaultName?: string | null;
  totpRequired: boolean;
  lockTimeoutSecs: number;
  remainingSecs: number;
  memoryLocked: boolean;
  demo: boolean;
  lastLockReason?: LockReason | null;
  recentVaults?: string[];
}

export interface TotpEnrollment {
  secretBase32: string;
  otpauthUri: string;
  qrSvg: string;
}

export interface CreateVaultArgs {
  path?: string | null;
  displayName: string;
  password: string;
  kdf: KdfProfile;
  account: string;
}

/** `'keep'` leaves the stored value, `'clear'` removes it, `{ set }` replaces it. */
export type SecretUpdate = 'keep' | 'clear' | { set: string };

export interface CredentialInput {
  id?: string | null;
  owner: { kind: OwnerKind; id: string };
  kind: string;
  label: string;
  username?: string | null;
  url?: string | null;
  publicKey?: string | null;
  expiresAt?: string | null;
  secret: SecretUpdate;
  privateKey: SecretUpdate;
  notes: SecretUpdate;
}

export interface Saved {
  id: string;
  topology: Topology;
}

export interface DeleteImpact {
  hosts: number;
  services: number;
  proxies: number;
  routes: number;
  credentials: number;
  networks: number;
}

export interface Settings {
  displayName: string;
  lockTimeoutSecs: number;
  clipboardClearSecs: number;
  lockOnSuspend: boolean;
  totpEnabled: boolean;
  kdf: { mCostKib: number; tCost: number; parallelism: number };
  kdfProfile: 'standard' | 'hardened' | 'custom';
  kdfMeetsFloor: boolean;
  vaultPath: string;
  memoryLocked: boolean;
  autoSync: boolean;
  appVersion: string;
}

export interface SettingsUpdate {
  displayName: string;
  lockTimeoutSecs: number;
  clipboardClearSecs: number;
  lockOnSuspend: boolean;
}

export interface Counts {
  companies: number;
  networks: number;
  machines: number;
  cards: number;
  services: number;
  ports: number;
  proxies: number;
  routes: number;
  accounts: number;
}

export interface ImportReport {
  created: Counts;
  updated: Counts;
  errors: { sheet: string; row: number; message: string }[];
  warnings: { sheet: string; row: number; message: string }[];
  applied: boolean;
}

export interface ImportPreview {
  fileName: string;
  format: 'xlsx' | 'json';
  report: ImportReport;
}

export interface LinkedRemote {
  id: string;
  provider: string;
  label: string;
  remotePath: string;
  transport: string;
}

export interface SyncConflict {
  remoteId: string;
  label: string;
  conflictCopy: string;
  localSavedAtMs: number;
  remoteSavedAtMs: number;
}

export interface SyncStatus {
  linked: LinkedRemote[];
  autoSync: boolean;
  busy: boolean;
  transport?: string | null;
  lastOutcome?: string | null;
  lastError?: string | null;
  lastSyncedAtMs?: number | null;
  conflict?: SyncConflict | null;
}

export type CloudStep =
  | { step: 'provisioning'; done?: number; total?: number | null }
  | { step: 'consent'; url: string }
  | { step: 'listing' }
  | { step: 'downloading' }
  | { step: 'done'; vaultPath: string }
  | { step: 'error'; message: string };

export interface CloudConnect {
  candidates: string[];
  vaultPath?: string | null;
}
