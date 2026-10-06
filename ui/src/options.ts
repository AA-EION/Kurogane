// Human labels for every fixed list. Codes match the SQL CHECK constraints
// and the Excel template (kurogane-core/src/interchange.rs).

export type Option = { value: string; label: string; hint?: string };

const o = (pairs: [string, string, string?][]): Option[] => pairs.map(([value, label, hint]) => ({ value, label, hint }));

export const ENVIRONMENTS = o([
  ['corporate', 'Corporate'], ['client', 'Client'], ['personal', 'Personal'], ['lab', 'Lab'], ['staging', 'Staging'], ['production', 'Production'],
]);
export const CATEGORIES = o([
  ['vps', 'VPS', 'Cloud / rented server'],
  ['local_server', 'Local server', 'Physical server on site'],
  ['vm', 'Virtual machine', 'Runs on a hypervisor'],
  ['router', 'Router'],
  ['firewall', 'Firewall'],
  ['switch', 'Switch'],
  ['access_point', 'Access point'],
  ['nvr', 'NVR', 'Camera recorder'],
  ['nas', 'NAS', 'Network storage'],
  ['edge_device', 'Edge device', 'Raspberry Pi, IoT…'],
  ['workstation', 'Workstation'],
]);
export const OS_FAMILIES = o([
  ['linux', 'Linux'], ['windows', 'Windows'], ['macos', 'macOS'], ['bsd', 'BSD'], ['routeros', 'RouterOS'], ['embedded', 'Firmware'], ['other', 'Other'],
]);
export const RUNTIMES = o([
  ['docker', 'Docker'], ['podman', 'Podman'], ['systemd', 'Native'], ['smb', 'SMB share'], ['kubernetes', 'Kubernetes'],
  ['windows_service', 'Windows service'], ['lxc', 'LXC'], ['other', 'Other'],
]);
export const SCHEMES = o([['http', 'HTTP'], ['https', 'HTTPS'], ['tcp', 'TCP'], ['udp', 'UDP'], ['smb', 'SMB'], ['rtsp', 'RTSP'], ['none', 'None']]);
export const PROXY_KINDS = o([
  ['nginx', 'Nginx'], ['npm', 'Nginx Proxy Manager'], ['traefik', 'Traefik'], ['caddy', 'Caddy'], ['haproxy', 'HAProxy'],
  ['cloudflare_tunnel', 'Cloudflare Tunnel'], ['other', 'Other'],
]);
export const INBOUND = o([['https', 'HTTPS'], ['http', 'HTTP'], ['tcp', 'TCP'], ['udp', 'UDP']]);
export const TLS_MODES = o([
  ['letsencrypt', "Let's Encrypt"], ['custom', 'Custom certificate'], ['cloudflare', 'Cloudflare'], ['passthrough', 'Passthrough'], ['none', 'None'],
]);
export const TARGET_SCHEMES = o([['http', 'HTTP'], ['https', 'HTTPS'], ['tcp', 'TCP'], ['udp', 'UDP']]);
export const PROTOCOLS = o([['tcp', 'TCP'], ['udp', 'UDP']]);
export const NETWORK_KINDS = o([
  ['lan', 'LAN'], ['dmz', 'DMZ'], ['wan', 'WAN'], ['vpn', 'VPN'], ['overlay', 'Overlay'], ['mgmt', 'Management'], ['iot', 'IoT'],
]);
export const CREDENTIAL_KINDS = o([
  ['ssh_password', 'SSH password'], ['ssh_key', 'SSH key'], ['rdp', 'RDP'], ['web_gui', 'Web login'], ['admin_login', 'Admin login'],
  ['db_user', 'Database user'], ['api_token', 'API token'], ['smb', 'SMB'], ['winrm', 'WinRM'], ['snmp', 'SNMP'], ['other', 'Other'],
]);
export const TENANT_COLORS = ['#e8590c', '#4c8dff', '#2fbf71', '#b197fc', '#ffc247', '#38d9a9', '#ff6b9a', '#74c0fc', '#adb5bd'];

export function labelOf(list: Option[], value?: string | null): string {
  return list.find((x) => x.value === value)?.label ?? value ?? '';
}
