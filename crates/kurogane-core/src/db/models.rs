//! Row types. Everything here is safe to hand to the UI: secret material never
//! appears in these structs, only `has_*` flags.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tenant {
    pub id: String,
    pub name: String,
    /// corporate | client | personal | lab | staging | production
    pub environment: String,
    pub environment_label: Option<String>,
    pub color: Option<String>,
    pub sla_notes: Option<String>,
    pub admin_notes: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub id: String,
    pub tenant_id: String,
    pub name: String,
    /// lan | dmz | wan | vpn | overlay | mgmt | iot
    pub kind: String,
    pub cidr: String,
    pub vlan_id: Option<u16>,
    pub gateway: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    pub id: String,
    pub host_id: String,
    pub network_id: Option<String>,
    pub name: String,
    pub mac: Option<String>,
    pub internal_ip: Option<String>,
    pub gateway: Option<String>,
    pub public_ip: Option<String>,
    pub is_primary: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub tenant_id: String,
    pub parent_host_id: Option<String>,
    pub name: String,
    /// vps | local_server | vm | switch | access_point | router | firewall | nvr | nas | edge_device | workstation
    pub category: String,
    /// linux | windows | macos | bsd | routeros | embedded | other
    pub os_family: Option<String>,
    pub fqdn: Option<String>,
    pub ssh_port: Option<u16>,
    pub rdp_port: Option<u16>,
    pub winrm_port: Option<u16>,
    pub web_admin_url: Option<String>,
    pub provider: Option<String>,
    pub location: Option<String>,
    pub icon: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub interfaces: Vec<NetworkInterface>,
}

impl Host {
    /// Best address to reach the machine from an admin workstation:
    /// FQDN, then primary NIC's internal IP, then any public IP.
    pub fn management_address(&self) -> Option<&str> {
        if let Some(f) = self.fqdn.as_deref() {
            return Some(f);
        }
        let primary = self.interfaces.iter().find(|n| n.is_primary).or_else(|| self.interfaces.first());
        primary.and_then(|n| n.internal_ip.as_deref()).or_else(|| self.interfaces.iter().find_map(|n| n.public_ip.as_deref()))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePort {
    pub id: String,
    pub service_id: String,
    pub container_port: u16,
    pub host_port: Option<u16>,
    pub bind_address: String,
    /// tcp | udp
    pub protocol: String,
    pub is_primary: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub host_id: String,
    pub name: String,
    /// docker | podman | systemd | smb | kubernetes | windows_service | lxc | other
    pub runtime: String,
    pub image: Option<String>,
    /// http | https | tcp | udp | smb | rtsp | none
    pub scheme: String,
    pub health_path: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    /// Company that owns the service when it differs from the machine's.
    #[serde(default)]
    pub owner_tenant_id: Option<String>,
    #[serde(default)]
    pub ports: Vec<ServicePort>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRoute {
    pub id: String,
    pub proxy_id: String,
    pub domain: String,
    pub path_prefix: String,
    pub inbound_port: u16,
    /// http | https | tcp | udp
    pub inbound_protocol: String,
    /// none | letsencrypt | custom | cloudflare | passthrough
    pub tls_mode: String,
    pub tls_expires_at: Option<String>,
    pub target_host_id: Option<String>,
    pub target_ip: String,
    pub target_port: u16,
    pub target_scheme: String,
    pub service_id: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseProxy {
    pub id: String,
    pub host_id: String,
    pub service_id: Option<String>,
    pub name: String,
    /// nginx | traefik | npm | caddy | haproxy | cloudflare_tunnel | other
    pub kind: String,
    pub admin_url: Option<String>,
    #[serde(default)]
    pub routes: Vec<ProxyRoute>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnerKind {
    Tenant,
    Host,
    Service,
    Proxy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialOwner {
    pub kind: OwnerKind,
    pub id: String,
}

/// Metadata only — secrets are fetched one at a time via `reveal`/`copy`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMeta {
    pub id: String,
    pub owner: CredentialOwner,
    /// ssh_password | ssh_key | rdp | winrm | web_gui | admin_login | db_user | api_token | smb | snmp | other
    pub kind: String,
    pub label: String,
    pub username: Option<String>,
    pub url: Option<String>,
    pub public_key: Option<String>,
    pub has_secret: bool,
    pub has_private_key: bool,
    pub has_notes: bool,
    pub expires_at: Option<String>,
}

/// Input for creating a credential; plaintext is sealed before it is stored.
#[derive(Clone, Debug)]
pub struct NewCredential<'a> {
    pub id: Option<String>,
    pub owner: CredentialOwner,
    pub kind: &'a str,
    pub label: &'a str,
    pub username: Option<&'a str>,
    pub secret: Option<&'a str>,
    pub private_key: Option<&'a str>,
    pub public_key: Option<&'a str>,
    pub notes: Option<&'a str>,
    pub url: Option<&'a str>,
    pub expires_at: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretField {
    Secret,
    PrivateKey,
    Notes,
}

impl SecretField {
    pub fn column(self) -> &'static str {
        match self {
            SecretField::Secret => "secret_sealed",
            SecretField::PrivateKey => "private_key_sealed",
            SecretField::Notes => "notes_sealed",
        }
    }
}

/// The complete, secret-free picture the canvas renders.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topology {
    pub vault_name: String,
    pub tenants: Vec<Tenant>,
    pub networks: Vec<Network>,
    pub hosts: Vec<Host>,
    pub services: Vec<Service>,
    pub proxies: Vec<ReverseProxy>,
    pub credentials: Vec<CredentialMeta>,
}
