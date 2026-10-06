//! Repository functions. Secret columns are sealed/unsealed here and only here.

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension, Row};
use zeroize::Zeroizing;

use super::models::*;
use super::Database;
use crate::crypto;
use crate::error::{Error, Result};
use crate::secure::Key256;
use crate::totp::{Algorithm, TotpConfig};

pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn id_or_new(id: &str) -> String {
    if id.is_empty() {
        new_id()
    } else {
        id.to_string()
    }
}

pub(crate) fn field_aad(cred_id: &str, field: SecretField) -> Vec<u8> {
    format!("credentials:{cred_id}:{}", field.column()).into_bytes()
}

fn sync_aad(remote_id: &str) -> Vec<u8> {
    format!("sync_remotes:{remote_id}:rclone_section_sealed").into_bytes()
}

/// TOTP settings as stored, with the seed still sealed.
pub struct TotpRecord {
    pub sealed_secret: Option<Vec<u8>>,
    pub config: TotpConfig,
    pub enabled: bool,
    pub last_counter: u64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSettings {
    pub display_name: String,
    pub lock_timeout_secs: u32,
    pub clipboard_clear_secs: u32,
    pub lock_on_suspend: bool,
}

/// Input for creating or updating a sync remote.
pub struct NewSyncRemote<'a> {
    /// `None` creates a new remote.
    pub id: Option<&'a str>,
    pub provider: &'a str,
    pub label: &'a str,
    pub remote_path: &'a str,
    /// rclone.conf section body (sealed before storage).
    pub rclone_section: &'a str,
    pub transport: &'a str,
}

/// One row of the `v_route_traces` view.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTrace {
    pub route_id: String,
    pub domain: String,
    pub edge_public_ip: Option<String>,
    pub target_ip: String,
    pub target_port: u16,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRemoteMeta {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub remote_path: String,
    pub transport: String,
}

impl Database {
    // ----------------------------------------------------------------- meta

    pub fn init_meta(&self, vault_id: &str, display_name: &str) -> Result<()> {
        self.conn().execute("INSERT INTO vault_meta (id, vault_id, display_name) VALUES (1, ?1, ?2)", params![vault_id, display_name])?;
        self.conn().execute("INSERT INTO vault_security (id) VALUES (1)", [])?;
        Ok(())
    }

    pub fn settings(&self) -> Result<VaultSettings> {
        Ok(self.conn().query_row(
            "SELECT display_name, lock_timeout_secs, clipboard_clear_secs, lock_on_suspend FROM vault_meta WHERE id = 1",
            [],
            |r| {
                Ok(VaultSettings {
                    display_name: r.get(0)?,
                    lock_timeout_secs: r.get(1)?,
                    clipboard_clear_secs: r.get(2)?,
                    lock_on_suspend: r.get(3)?,
                })
            },
        )?)
    }

    pub fn set_lock_timeout(&self, secs: u32) -> Result<()> {
        self.conn().execute("UPDATE vault_meta SET lock_timeout_secs = ?1 WHERE id = 1", [secs])?;
        Ok(())
    }

    // ----------------------------------------------------------------- TOTP

    pub fn totp_record(&self) -> Result<TotpRecord> {
        Ok(self.conn().query_row(
            "SELECT totp_secret_sealed, totp_algorithm, totp_digits, totp_period, totp_enabled, totp_last_counter
             FROM vault_security WHERE id = 1",
            [],
            |r| {
                let algo: String = r.get(1)?;
                Ok(TotpRecord {
                    sealed_secret: r.get(0)?,
                    config: TotpConfig {
                        algorithm: Algorithm::parse(&algo).unwrap_or(Algorithm::Sha1),
                        digits: r.get(2)?,
                        period: r.get::<_, i64>(3)? as u64,
                    },
                    enabled: r.get(4)?,
                    last_counter: r.get::<_, i64>(5)? as u64,
                })
            },
        )?)
    }

    pub fn store_totp_secret(&self, sealed: &[u8], cfg: &TotpConfig) -> Result<()> {
        self.conn().execute(
            "UPDATE vault_security SET totp_secret_sealed = ?1, totp_algorithm = ?2, totp_digits = ?3,
                    totp_period = ?4, totp_enabled = 0, totp_last_counter = 0 WHERE id = 1",
            params![sealed, cfg.algorithm.as_str(), cfg.digits, cfg.period as i64],
        )?;
        Ok(())
    }

    pub fn set_totp_enabled(&self, enabled: bool, last_counter: u64) -> Result<()> {
        self.conn().execute(
            "UPDATE vault_security SET totp_enabled = ?1, totp_last_counter = ?2 WHERE id = 1",
            params![enabled, last_counter as i64],
        )?;
        Ok(())
    }

    pub fn clear_totp(&self) -> Result<()> {
        self.conn()
            .execute("UPDATE vault_security SET totp_enabled = 0, totp_secret_sealed = NULL, totp_last_counter = 0 WHERE id = 1", [])?;
        Ok(())
    }

    pub fn set_totp_last_counter(&self, counter: u64) -> Result<()> {
        self.conn().execute("UPDATE vault_security SET totp_last_counter = ?1 WHERE id = 1", [counter as i64])?;
        Ok(())
    }

    // -------------------------------------------------------------- inserts

    pub fn insert_tenant(&self, t: &Tenant) -> Result<String> {
        let id = id_or_new(&t.id);
        self.conn().execute(
            "INSERT INTO tenants (id, name, environment, environment_label, color, sla_notes, admin_notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, t.name, t.environment, t.environment_label, t.color, t.sla_notes, t.admin_notes],
        )?;
        Ok(id)
    }

    pub fn insert_network(&self, n: &Network) -> Result<String> {
        let id = id_or_new(&n.id);
        self.conn().execute(
            "INSERT INTO networks (id, tenant_id, name, kind, cidr, vlan_id, gateway) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, n.tenant_id, n.name, n.kind, n.cidr, n.vlan_id, n.gateway],
        )?;
        Ok(id)
    }

    /// Insert a host together with its interfaces (one transaction).
    pub fn insert_host(&self, h: &Host) -> Result<String> {
        let tx = self.conn().unchecked_transaction()?;
        let id = id_or_new(&h.id);
        tx.execute(
            "INSERT INTO hosts (id, tenant_id, parent_host_id, name, category, os_family, fqdn, ssh_port, rdp_port,
                                winrm_port, web_admin_url, provider, location, icon, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                id,
                h.tenant_id,
                h.parent_host_id,
                h.name,
                h.category,
                h.os_family,
                h.fqdn,
                h.ssh_port,
                h.rdp_port,
                h.winrm_port,
                h.web_admin_url,
                h.provider,
                h.location,
                h.icon,
                h.notes
            ],
        )?;
        for n in &h.interfaces {
            tx.execute(
                "INSERT INTO network_interfaces (id, host_id, network_id, name, mac, internal_ip, gateway, public_ip, is_primary)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id_or_new(&n.id), id, n.network_id, n.name, n.mac, n.internal_ip, n.gateway, n.public_ip, n.is_primary],
            )?;
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn insert_service(&self, s: &Service) -> Result<String> {
        let tx = self.conn().unchecked_transaction()?;
        let id = id_or_new(&s.id);
        tx.execute(
            "INSERT INTO services (id, host_id, name, runtime, image, scheme, health_path, description, icon, owner_tenant_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, s.host_id, s.name, s.runtime, s.image, s.scheme, s.health_path, s.description, s.icon, s.owner_tenant_id],
        )?;
        for p in &s.ports {
            tx.execute(
                "INSERT INTO service_ports (id, service_id, container_port, host_port, bind_address, protocol, is_primary)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id_or_new(&p.id),
                    id,
                    p.container_port,
                    p.host_port,
                    if p.bind_address.is_empty() { "0.0.0.0" } else { p.bind_address.as_str() },
                    if p.protocol.is_empty() { "tcp" } else { p.protocol.as_str() },
                    p.is_primary
                ],
            )?;
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn insert_proxy(&self, p: &ReverseProxy) -> Result<String> {
        let tx = self.conn().unchecked_transaction()?;
        let id = id_or_new(&p.id);
        tx.execute(
            "INSERT INTO reverse_proxies (id, host_id, service_id, name, kind, admin_url) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, p.host_id, p.service_id, p.name, p.kind, p.admin_url],
        )?;
        for r in &p.routes {
            tx.execute(
                "INSERT INTO proxy_routes (id, proxy_id, domain, path_prefix, inbound_port, inbound_protocol, tls_mode,
                                           tls_expires_at, target_host_id, target_ip, target_port, target_scheme, service_id, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    id_or_new(&r.id),
                    id,
                    r.domain,
                    if r.path_prefix.is_empty() { "/" } else { r.path_prefix.as_str() },
                    r.inbound_port,
                    r.inbound_protocol,
                    r.tls_mode,
                    r.tls_expires_at,
                    r.target_host_id,
                    r.target_ip,
                    r.target_port,
                    r.target_scheme,
                    r.service_id,
                    r.enabled
                ],
            )?;
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn insert_credential(&self, field_key: &Key256, c: &NewCredential<'_>) -> Result<String> {
        let id = c.id.clone().unwrap_or_else(new_id);
        let seal = |v: Option<&str>, f: SecretField| -> Result<Option<Vec<u8>>> {
            v.map(|s| crypto::seal(field_key, &field_aad(&id, f), s.as_bytes())).transpose()
        };
        let (tenant, host, service, proxy) = match c.owner.kind {
            OwnerKind::Tenant => (Some(&c.owner.id), None, None, None),
            OwnerKind::Host => (None, Some(&c.owner.id), None, None),
            OwnerKind::Service => (None, None, Some(&c.owner.id), None),
            OwnerKind::Proxy => (None, None, None, Some(&c.owner.id)),
        };
        self.conn().execute(
            "INSERT INTO credentials (id, tenant_id, host_id, service_id, proxy_id, kind, label, username,
                                      secret_sealed, private_key_sealed, public_key, notes_sealed, url, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                id,
                tenant,
                host,
                service,
                proxy,
                c.kind,
                c.label,
                c.username,
                seal(c.secret, SecretField::Secret)?,
                seal(c.private_key, SecretField::PrivateKey)?,
                c.public_key,
                seal(c.notes, SecretField::Notes)?,
                c.url,
                c.expires_at
            ],
        )?;
        Ok(id)
    }

    /// Replace one sealed field of a credential (password rotation etc).
    pub fn update_credential_secret(&self, field_key: &Key256, id: &str, field: SecretField, value: &str) -> Result<()> {
        let sealed = crypto::seal(field_key, &field_aad(id, field), value.as_bytes())?;
        let sql =
            format!("UPDATE credentials SET {} = ?1, rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2", field.column());
        if self.conn().execute(&sql, params![sealed, id])? == 0 {
            return Err(Error::NotFound(format!("credential {id}")));
        }
        Ok(())
    }

    /// Decrypt a single secret. The caller is responsible for auditing and for
    /// keeping the plaintext's lifetime short.
    pub fn credential_secret(&self, field_key: &Key256, id: &str, field: SecretField) -> Result<Zeroizing<String>> {
        let sql = format!("SELECT {} FROM credentials WHERE id = ?1", field.column());
        let blob: Option<Vec<u8>> =
            self.conn().query_row(&sql, [id], |r| r.get(0)).optional()?.ok_or_else(|| Error::NotFound(format!("credential {id}")))?;
        let blob = blob.ok_or_else(|| Error::NotFound(format!("credential {id} has no {field:?}")))?;
        let plain = crypto::unseal(field_key, &field_aad(id, field), &blob)?;
        let s = std::str::from_utf8(&plain).map_err(|_| Error::Integrity("secret is not UTF-8".into()))?;
        Ok(Zeroizing::new(s.to_owned()))
    }

    pub fn credential_meta(&self, id: &str) -> Result<CredentialMeta> {
        self.conn()
            .query_row(&format!("{CRED_SELECT} WHERE id = ?1"), [id], cred_from_row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("credential {id}")))
    }

    pub fn host(&self, id: &str) -> Result<Host> {
        let topo_hosts = self.load_hosts(Some(id))?;
        topo_hosts.into_iter().next().ok_or_else(|| Error::NotFound(format!("host {id}")))
    }

    // ----------------------------------------------------------- sync remotes

    pub fn upsert_sync_remote(&self, sync_key: &Key256, r: &NewSyncRemote<'_>) -> Result<String> {
        let id = r.id.map(str::to_owned).unwrap_or_else(new_id);
        let sealed = crypto::seal(sync_key, &sync_aad(&id), r.rclone_section.as_bytes())?;
        self.conn().execute(
            "INSERT INTO sync_remotes (id, provider, label, remote_path, rclone_section_sealed, transport)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET label = excluded.label, remote_path = excluded.remote_path,
                 rclone_section_sealed = excluded.rclone_section_sealed, transport = excluded.transport",
            params![id, r.provider, r.label, r.remote_path, sealed, r.transport],
        )?;
        Ok(id)
    }

    pub fn sync_remotes(&self) -> Result<Vec<SyncRemoteMeta>> {
        let mut st = self.conn().prepare("SELECT id, provider, label, remote_path, transport FROM sync_remotes ORDER BY label")?;
        let rows = st.query_map([], |r| {
            Ok(SyncRemoteMeta { id: r.get(0)?, provider: r.get(1)?, label: r.get(2)?, remote_path: r.get(3)?, transport: r.get(4)? })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn sync_remote_section(&self, sync_key: &Key256, id: &str) -> Result<Zeroizing<String>> {
        let blob: Vec<u8> = self
            .conn()
            .query_row("SELECT rclone_section_sealed FROM sync_remotes WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("sync remote {id}")))?;
        let plain = crypto::unseal(sync_key, &sync_aad(id), &blob)?;
        Ok(Zeroizing::new(String::from_utf8(plain.to_vec()).map_err(|_| Error::Integrity("rclone section not UTF-8".into()))?))
    }

    // ----------------------------------------------------------------- audit

    pub fn audit(&self, action: &str, entity_type: Option<&str>, entity_id: Option<&str>, detail: Option<&str>) -> Result<()> {
        self.conn().execute(
            "INSERT INTO audit_log (action, entity_type, entity_id, detail) VALUES (?1, ?2, ?3, ?4)",
            params![action, entity_type, entity_id, detail],
        )?;
        Ok(())
    }

    pub fn audit_count(&self, action: &str) -> Result<i64> {
        Ok(self.conn().query_row("SELECT count(*) FROM audit_log WHERE action = ?1", [action], |r| r.get(0))?)
    }

    // -------------------------------------------------------------- topology

    pub fn load_topology(&self) -> Result<Topology> {
        let vault_name = self.settings()?.display_name;
        let tenants = {
            let mut st = self
                .conn()
                .prepare("SELECT id, name, environment, environment_label, color, sla_notes, admin_notes FROM tenants ORDER BY name")?;
            let rows = st.query_map([], |r| {
                Ok(Tenant {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    environment: r.get(2)?,
                    environment_label: r.get(3)?,
                    color: r.get(4)?,
                    sla_notes: r.get(5)?,
                    admin_notes: r.get(6)?,
                })
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let networks = {
            let mut st =
                self.conn().prepare("SELECT id, tenant_id, name, kind, cidr, vlan_id, gateway FROM networks ORDER BY tenant_id, cidr")?;
            let rows = st.query_map([], |r| {
                Ok(Network {
                    id: r.get(0)?,
                    tenant_id: r.get(1)?,
                    name: r.get(2)?,
                    kind: r.get(3)?,
                    cidr: r.get(4)?,
                    vlan_id: r.get(5)?,
                    gateway: r.get(6)?,
                })
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let hosts = self.load_hosts(None)?;
        let services = self.load_services()?;
        let proxies = self.load_proxies()?;
        let credentials = {
            let mut st = self.conn().prepare(&format!("{CRED_SELECT} ORDER BY label"))?;
            let rows = st.query_map([], cred_from_row)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        Ok(Topology { vault_name, tenants, networks, hosts, services, proxies, credentials })
    }

    fn load_hosts(&self, only: Option<&str>) -> Result<Vec<Host>> {
        let mut nics: HashMap<String, Vec<NetworkInterface>> = HashMap::new();
        {
            let mut st = self.conn().prepare(
                "SELECT id, host_id, network_id, name, mac, internal_ip, gateway, public_ip, is_primary
                 FROM network_interfaces WHERE (?1 IS NULL OR host_id = ?1) ORDER BY is_primary DESC, name",
            )?;
            let rows = st.query_map([only], |r| {
                Ok(NetworkInterface {
                    id: r.get(0)?,
                    host_id: r.get(1)?,
                    network_id: r.get(2)?,
                    name: r.get(3)?,
                    mac: r.get(4)?,
                    internal_ip: r.get(5)?,
                    gateway: r.get(6)?,
                    public_ip: r.get(7)?,
                    is_primary: r.get(8)?,
                })
            })?;
            for n in rows {
                let n = n?;
                nics.entry(n.host_id.clone()).or_default().push(n);
            }
        }
        let mut st = self.conn().prepare(
            "SELECT id, tenant_id, parent_host_id, name, category, os_family, fqdn, ssh_port, rdp_port, winrm_port,
                    web_admin_url, provider, location, icon, notes
             FROM hosts WHERE (?1 IS NULL OR id = ?1) ORDER BY tenant_id, name",
        )?;
        let rows = st.query_map([only], |r| {
            Ok(Host {
                id: r.get(0)?,
                tenant_id: r.get(1)?,
                parent_host_id: r.get(2)?,
                name: r.get(3)?,
                category: r.get(4)?,
                os_family: r.get(5)?,
                fqdn: r.get(6)?,
                ssh_port: r.get(7)?,
                rdp_port: r.get(8)?,
                winrm_port: r.get(9)?,
                web_admin_url: r.get(10)?,
                provider: r.get(11)?,
                location: r.get(12)?,
                icon: r.get(13)?,
                notes: r.get(14)?,
                interfaces: Vec::new(),
            })
        })?;
        let mut hosts = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        for h in &mut hosts {
            h.interfaces = nics.remove(&h.id).unwrap_or_default();
        }
        Ok(hosts)
    }

    fn load_services(&self) -> Result<Vec<Service>> {
        let mut ports: HashMap<String, Vec<ServicePort>> = HashMap::new();
        {
            let mut st = self.conn().prepare(
                "SELECT id, service_id, container_port, host_port, bind_address, protocol, is_primary
                 FROM service_ports ORDER BY is_primary DESC, container_port",
            )?;
            let rows = st.query_map([], |r| {
                Ok(ServicePort {
                    id: r.get(0)?,
                    service_id: r.get(1)?,
                    container_port: r.get(2)?,
                    host_port: r.get(3)?,
                    bind_address: r.get(4)?,
                    protocol: r.get(5)?,
                    is_primary: r.get(6)?,
                })
            })?;
            for p in rows {
                let p = p?;
                ports.entry(p.service_id.clone()).or_default().push(p);
            }
        }
        let mut st = self.conn().prepare(
            "SELECT id, host_id, name, runtime, image, scheme, health_path, description, icon, owner_tenant_id FROM services ORDER BY host_id, name",
        )?;
        let rows = st.query_map([], |r| {
            Ok(Service {
                id: r.get(0)?,
                host_id: r.get(1)?,
                name: r.get(2)?,
                runtime: r.get(3)?,
                image: r.get(4)?,
                scheme: r.get(5)?,
                health_path: r.get(6)?,
                description: r.get(7)?,
                icon: r.get(8)?,
                owner_tenant_id: r.get(9)?,
                ports: Vec::new(),
            })
        })?;
        let mut services = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        for s in &mut services {
            s.ports = ports.remove(&s.id).unwrap_or_default();
        }
        Ok(services)
    }

    fn load_proxies(&self) -> Result<Vec<ReverseProxy>> {
        let mut routes: HashMap<String, Vec<ProxyRoute>> = HashMap::new();
        {
            let mut st = self.conn().prepare(
                "SELECT id, proxy_id, domain, path_prefix, inbound_port, inbound_protocol, tls_mode, tls_expires_at,
                        target_host_id, target_ip, target_port, target_scheme, service_id, enabled
                 FROM proxy_routes ORDER BY domain, path_prefix",
            )?;
            let rows = st.query_map([], |r| {
                Ok(ProxyRoute {
                    id: r.get(0)?,
                    proxy_id: r.get(1)?,
                    domain: r.get(2)?,
                    path_prefix: r.get(3)?,
                    inbound_port: r.get(4)?,
                    inbound_protocol: r.get(5)?,
                    tls_mode: r.get(6)?,
                    tls_expires_at: r.get(7)?,
                    target_host_id: r.get(8)?,
                    target_ip: r.get(9)?,
                    target_port: r.get(10)?,
                    target_scheme: r.get(11)?,
                    service_id: r.get(12)?,
                    enabled: r.get(13)?,
                })
            })?;
            for rt in rows {
                let rt = rt?;
                routes.entry(rt.proxy_id.clone()).or_default().push(rt);
            }
        }
        let mut st =
            self.conn().prepare("SELECT id, host_id, service_id, name, kind, admin_url FROM reverse_proxies ORDER BY host_id, name")?;
        let rows = st.query_map([], |r| {
            Ok(ReverseProxy {
                id: r.get(0)?,
                host_id: r.get(1)?,
                service_id: r.get(2)?,
                name: r.get(3)?,
                kind: r.get(4)?,
                admin_url: r.get(5)?,
                routes: Vec::new(),
            })
        })?;
        let mut proxies = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        for p in &mut proxies {
            p.routes = routes.remove(&p.id).unwrap_or_default();
        }
        Ok(proxies)
    }

    pub fn route_traces(&self) -> Result<Vec<RouteTrace>> {
        let mut st =
            self.conn().prepare("SELECT route_id, domain, edge_public_ip, target_ip, target_port FROM v_route_traces ORDER BY domain")?;
        let rows = st.query_map([], |r| {
            Ok(RouteTrace {
                route_id: r.get(0)?,
                domain: r.get(1)?,
                edge_public_ip: r.get(2)?,
                target_ip: r.get(3)?,
                target_port: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}

pub(crate) const CRED_SELECT: &str = "SELECT id, tenant_id, host_id, service_id, proxy_id, kind, label, username, url, public_key,
        secret_sealed IS NOT NULL, private_key_sealed IS NOT NULL, notes_sealed IS NOT NULL, expires_at FROM credentials";

pub(crate) fn cred_from_row(r: &Row<'_>) -> rusqlite::Result<CredentialMeta> {
    let owner = if let Some(id) = r.get::<_, Option<String>>(1)? {
        CredentialOwner { kind: OwnerKind::Tenant, id }
    } else if let Some(id) = r.get::<_, Option<String>>(2)? {
        CredentialOwner { kind: OwnerKind::Host, id }
    } else if let Some(id) = r.get::<_, Option<String>>(3)? {
        CredentialOwner { kind: OwnerKind::Service, id }
    } else {
        CredentialOwner { kind: OwnerKind::Proxy, id: r.get(4)? }
    };
    Ok(CredentialMeta {
        id: r.get(0)?,
        owner,
        kind: r.get(5)?,
        label: r.get(6)?,
        username: r.get(7)?,
        url: r.get(8)?,
        public_key: r.get(9)?,
        has_secret: r.get(10)?,
        has_private_key: r.get(11)?,
        has_notes: r.get(12)?,
        expires_at: r.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (Database, Key256) {
        let db = Database::open_in_memory(&Key256::random()).unwrap();
        db.init_meta("00000000-0000-0000-0000-000000000000", "Test").unwrap();
        (db, Key256::random())
    }

    #[test]
    fn seeded_topology_loads_without_secrets() {
        let (db, fk) = db();
        let secrets = crate::db::seed::seed_demo(&db, &fk).unwrap();
        let topo = db.load_topology().unwrap();
        assert_eq!(topo.tenants.len(), 3);
        assert!(topo.hosts.len() >= 10);
        assert!(topo.proxies.iter().any(|p| !p.routes.is_empty()));
        let json = serde_json::to_string(&topo).unwrap();
        for (_, plain) in secrets.values() {
            assert!(!json.contains(plain.as_str()), "topology JSON must never contain secrets");
        }
        // Reveal round-trips.
        let (id, (field, plain)) = secrets.iter().next().unwrap();
        assert_eq!(db.credential_secret(&fk, id, *field).unwrap().as_str(), plain);
        assert!(!db.route_traces().unwrap().is_empty());
    }

    #[test]
    fn constraints_hold() {
        let (db, fk) = db();
        crate::db::seed::seed_demo(&db, &fk).unwrap();
        let topo = db.load_topology().unwrap();
        let svc = topo.services.iter().find(|s| s.ports.iter().any(|p| p.host_port.is_some())).unwrap();
        let used = svc.ports.iter().find_map(|p| p.host_port).unwrap();
        // Same host port on the same host → trigger aborts.
        let clash = Service {
            host_id: svc.host_id.clone(),
            name: "clash".into(),
            runtime: "docker".into(),
            scheme: "http".into(),
            ports: vec![ServicePort { container_port: 80, host_port: Some(used), ..Default::default() }],
            ..Default::default()
        };
        let err = db.insert_service(&clash).unwrap_err();
        assert!(err.to_string().contains("host port already published"), "{err}");
        // Credential with two owners violates the CHECK.
        let r = db.conn().execute(
            "INSERT INTO credentials (id, host_id, service_id, kind, label) VALUES ('x', ?1, ?2, 'other', 'bad')",
            params![svc.host_id, svc.id],
        );
        assert!(r.is_err());
        // Deleting a tenant cascades to everything it owns and leaves tombstones.
        let tenant = &topo.tenants[0];
        db.conn().execute("DELETE FROM tenants WHERE id = ?1", [&tenant.id]).unwrap();
        let after = db.load_topology().unwrap();
        assert!(after.hosts.iter().all(|h| h.tenant_id != tenant.id));
        let tombs: i64 = db.conn().query_row("SELECT count(*) FROM tombstones", [], |r| r.get(0)).unwrap();
        assert!(tombs > 1);
    }

    #[test]
    fn sealed_fields_are_bound_to_their_row() {
        let (db, fk) = db();
        let secrets = crate::db::seed::seed_demo(&db, &fk).unwrap();
        let mut ids = secrets.iter().filter(|(_, (f, _))| *f == SecretField::Secret).map(|(id, _)| id.clone());
        let (a, b) = (ids.next().unwrap(), ids.next().unwrap());
        // Copy row A's ciphertext into row B: must fail to unseal.
        db.conn()
            .execute(
                "UPDATE credentials SET secret_sealed = (SELECT secret_sealed FROM credentials WHERE id = ?1) WHERE id = ?2",
                params![a, b],
            )
            .unwrap();
        assert!(db.credential_secret(&fk, &b, SecretField::Secret).is_err());
    }
}
