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
export type CloudProvider = 'drive' | 'onedrive' | 'mega';
export type KdfProfile = 'standard' | 'hardened';

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

export interface SyncStatus {
  linked: { id: string; provider: string; label: string; remotePath: string }[];
  transport?: 'container' | 'binary' | 'folder' | null;
  lastOutcome?: string | null;
  lastSyncedAtMs?: number | null;
  busy: boolean;
}

export type CloudStep =
  | { step: 'provisioning'; done?: number; total?: number | null }
  | { step: 'consent'; url: string }
  | { step: 'downloading' }
  | { step: 'done'; vaultPath: string }
  | { step: 'error'; message: string };
