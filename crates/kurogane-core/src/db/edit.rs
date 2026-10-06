//! Create / update / delete for every entity, with validation and
//! human-readable errors. All writes for one entity happen in a single
//! transaction; the caller saves the vault afterwards.

use std::net::IpAddr;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::models::*;
use super::repo::{field_aad, new_id};
use super::Database;
use crate::crypto;
use crate::error::{Error, Result};
use crate::secure::Key256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntityKind {
    Tenant,
    Network,
    Host,
    Service,
    Proxy,
    Route,
    Credential,
}

impl EntityKind {
    fn table(self) -> &'static str {
        match self {
            EntityKind::Tenant => "tenants",
            EntityKind::Network => "networks",
            EntityKind::Host => "hosts",
            EntityKind::Service => "services",
            EntityKind::Proxy => "reverse_proxies",
            EntityKind::Route => "proxy_routes",
            EntityKind::Credential => "credentials",
        }
    }
}

/// How to treat one sealed field when saving a credential.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretUpdate {
    #[default]
    Keep,
    Clear,
    Set(Zeroizing<String>),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub id: Option<String>,
    pub owner: CredentialOwner,
    pub kind: String,
    pub label: String,
    pub username: Option<String>,
    pub url: Option<String>,
    pub public_key: Option<String>,
    pub expires_at: Option<String>,
    #[serde(default)]
    pub secret: SecretUpdate,
    #[serde(default)]
    pub private_key: SecretUpdate,
    #[serde(default)]
    pub notes: SecretUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub display_name: String,
    pub lock_timeout_secs: u32,
    pub clipboard_clear_secs: u32,
    pub lock_on_suspend: bool,
}

/// What a delete would take with it — shown in the confirmation dialog.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteImpact {
    pub hosts: i64,
    pub services: i64,
    pub proxies: i64,
    pub routes: i64,
    pub credentials: i64,
    pub networks: i64,
}

// ------------------------------------------------------------- validation

fn opt(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

fn required<'a>(v: &'a str, what: &str) -> Result<&'a str> {
    let t = v.trim();
    if t.is_empty() {
        Err(Error::invalid(format!("{what} is required")))
    } else {
        Ok(t)
    }
}

fn check_ip(v: Option<&str>, what: &str) -> Result<()> {
    if let Some(ip) = v {
        ip.parse::<IpAddr>().map_err(|_| Error::invalid(format!("{what} \"{ip}\" is not a valid IP address")))?;
    }
    Ok(())
}

fn check_cidr(v: &str) -> Result<()> {
    let (ip, len) = v.split_once('/').ok_or_else(|| Error::invalid(format!("\"{v}\" is not CIDR notation (e.g. 192.168.1.0/24)")))?;
    let addr: IpAddr = ip.parse().map_err(|_| Error::invalid(format!("\"{v}\" is not a valid network")))?;
    let max = if addr.is_ipv4() { 32 } else { 128 };
    match len.parse::<u8>() {
        Ok(l) if l <= max => Ok(()),
        _ => Err(Error::invalid(format!("\"{v}\" has an invalid prefix length"))),
    }
}

fn check_domain(d: &str) -> Result<()> {
    let ok = !d.is_empty()
        && d.len() <= 253
        && !d.starts_with('.')
        && d.split('.').all(|l| !l.is_empty() && l.len() <= 63 && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'*'));
    if ok {
        Ok(())
    } else {
        Err(Error::invalid(format!("\"{d}\" is not a valid domain name")))
    }
}

fn check_port(p: u16, what: &str) -> Result<()> {
    if p == 0 {
        Err(Error::invalid(format!("{what} must be between 1 and 65535")))
    } else {
        Ok(())
    }
}

/// Translate SQLite constraint failures into sentences a user can act on.
fn friendly(e: rusqlite::Error) -> Error {
    let msg = e.to_string();
    let m = |s: &str| Error::Invalid(s.to_string());
    if msg.contains("UNIQUE constraint failed: tenants.name") {
        return m("A company with this name already exists");
    }
    if msg.contains("UNIQUE constraint failed: hosts.tenant_id, hosts.name") {
        return m("This company already has a machine with that name");
    }
    if msg.contains("UNIQUE constraint failed: services.host_id, services.name") {
        return m("This machine already has a service with that name");
    }
    if msg.contains("UNIQUE constraint failed: networks.tenant_id, networks.cidr") {
        return m("This company already has a network with that CIDR");
    }
    if msg.contains("UNIQUE constraint failed: networks.tenant_id, networks.name") {
        return m("This company already has a network with that name");
    }
    if msg.contains("UNIQUE constraint failed: network_interfaces.host_id, network_interfaces.name") {
        return m("Two network cards on this machine have the same name");
    }
    if msg.contains("UNIQUE constraint failed: service_ports.service_id") {
        return m("The same internal port/protocol is listed twice");
    }
    if msg.contains("UNIQUE constraint failed: reverse_proxies.host_id, reverse_proxies.name") {
        return m("This machine already has a proxy with that name");
    }
    if msg.contains("UNIQUE constraint failed: proxy_routes") {
        return m("This proxy already routes that domain/path/port");
    }
    if msg.contains("UNIQUE constraint failed: sync_remotes") {
        return m("That remote is already linked");
    }
    if msg.contains("host port already published") {
        return m("That published port is already used by another service on this machine");
    }
    if msg.contains("FOREIGN KEY constraint failed") {
        return m("A referenced item no longer exists (was it deleted?)");
    }
    if msg.contains("CHECK constraint failed") {
        if msg.contains("tls_mode") || msg.contains("inbound_protocol") {
            return m("HTTPS routes need a TLS mode other than \"none\"");
        }
        if msg.contains("private_key_sealed") {
            return m("SSH key accounts need a private key");
        }
        return m("A value is outside the allowed range");
    }
    Error::Db(e)
}

// ------------------------------------------------------------------ writes

impl Database {
    fn tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<T>) -> Result<T> {
        let tx = self.conn().unchecked_transaction()?;
        let out = f(&tx).map_err(friendly)?;
        tx.commit().map_err(friendly)?;
        Ok(out)
    }

    pub fn update_settings(&self, s: &SettingsUpdate) -> Result<()> {
        let name = required(&s.display_name, "Vault name")?;
        if !(60..=86400).contains(&s.lock_timeout_secs) {
            return Err(Error::invalid("Auto-lock must be between 1 minute and 24 hours"));
        }
        if !(5..=600).contains(&s.clipboard_clear_secs) {
            return Err(Error::invalid("Clipboard clearing must be between 5 and 600 seconds"));
        }
        self.conn()
            .execute(
                "UPDATE vault_meta SET display_name = ?1, lock_timeout_secs = ?2, clipboard_clear_secs = ?3, lock_on_suspend = ?4 WHERE id = 1",
                params![name, s.lock_timeout_secs, s.clipboard_clear_secs, s.lock_on_suspend],
            )
            .map_err(friendly)?;
        Ok(())
    }

    pub fn save_tenant(&self, t: &Tenant) -> Result<String> {
        let name = required(&t.name, "Company name")?;
        let id = if t.id.is_empty() { new_id() } else { t.id.clone() };
        self.tx(|tx| {
            tx.execute(
                "INSERT INTO tenants (id, name, environment, environment_label, color, sla_notes, admin_notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, environment = excluded.environment,
                   environment_label = excluded.environment_label, color = excluded.color,
                   sla_notes = excluded.sla_notes, admin_notes = excluded.admin_notes",
                params![id, name, t.environment, opt(&t.environment_label), opt(&t.color), opt(&t.sla_notes), opt(&t.admin_notes)],
            )
        })?;
        Ok(id)
    }

    pub fn save_network(&self, n: &Network) -> Result<String> {
        let name = required(&n.name, "Network name")?;
        let cidr = required(&n.cidr, "CIDR")?;
        check_cidr(cidr)?;
        check_ip(opt(&n.gateway), "Gateway")?;
        let id = if n.id.is_empty() { new_id() } else { n.id.clone() };
        self.tx(|tx| {
            tx.execute(
                "INSERT INTO networks (id, tenant_id, name, kind, cidr, vlan_id, gateway) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, name = excluded.name, kind = excluded.kind,
                   cidr = excluded.cidr, vlan_id = excluded.vlan_id, gateway = excluded.gateway",
                params![id, n.tenant_id, name, if n.kind.is_empty() { "lan" } else { &n.kind }, cidr, n.vlan_id, opt(&n.gateway)],
            )
        })?;
        Ok(id)
    }

    /// Upsert a machine and replace its network cards with `h.interfaces`.
    pub fn save_host(&self, h: &Host) -> Result<String> {
        let name = required(&h.name, "Machine name")?;
        for n in &h.interfaces {
            required(&n.name, "Network card name")?;
            check_ip(opt(&n.internal_ip), "Private IP")?;
            check_ip(opt(&n.public_ip), "Public IP")?;
            check_ip(opt(&n.gateway), "Gateway")?;
        }
        for (p, what) in [(h.ssh_port, "SSH port"), (h.rdp_port, "RDP port"), (h.winrm_port, "WinRM port")] {
            if let Some(p) = p {
                check_port(p, what)?;
            }
        }
        let id = if h.id.is_empty() { new_id() } else { h.id.clone() };
        if h.parent_host_id.as_deref() == Some(id.as_str()) {
            return Err(Error::invalid("A machine cannot run on itself"));
        }
        self.tx(|tx| {
            tx.execute(
                "INSERT INTO hosts (id, tenant_id, parent_host_id, name, category, os_family, fqdn, ssh_port, rdp_port, winrm_port,
                                    web_admin_url, provider, location, icon, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, parent_host_id = excluded.parent_host_id,
                   name = excluded.name, category = excluded.category, os_family = excluded.os_family, fqdn = excluded.fqdn,
                   ssh_port = excluded.ssh_port, rdp_port = excluded.rdp_port, winrm_port = excluded.winrm_port,
                   web_admin_url = excluded.web_admin_url, provider = excluded.provider, location = excluded.location,
                   icon = excluded.icon, notes = excluded.notes",
                params![
                    id,
                    h.tenant_id,
                    opt(&h.parent_host_id),
                    name,
                    h.category,
                    opt(&h.os_family),
                    opt(&h.fqdn),
                    h.ssh_port,
                    h.rdp_port,
                    h.winrm_port,
                    opt(&h.web_admin_url),
                    opt(&h.provider),
                    opt(&h.location),
                    opt(&h.icon),
                    opt(&h.notes)
                ],
            )?;
            // Interfaces are owned exclusively by the host and referenced by
            // nothing else, so replace them wholesale.
            tx.execute("DELETE FROM network_interfaces WHERE host_id = ?1", [&id])?;
            let primary = h.interfaces.iter().position(|n| n.is_primary).unwrap_or(0);
            for (i, n) in h.interfaces.iter().enumerate() {
                tx.execute(
                    "INSERT INTO network_interfaces (id, host_id, network_id, name, mac, internal_ip, gateway, public_ip, is_primary)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        if n.id.is_empty() { new_id() } else { n.id.clone() },
                        id,
                        opt(&n.network_id),
                        n.name.trim(),
                        opt(&n.mac),
                        opt(&n.internal_ip),
                        opt(&n.gateway),
                        opt(&n.public_ip),
                        i == primary
                    ],
                )?;
            }
            Ok(())
        })?;
        Ok(id)
    }

    /// Upsert a service and replace its port bindings with `s.ports`.
    pub fn save_service(&self, s: &Service) -> Result<String> {
        let name = required(&s.name, "Service name")?;
        for p in &s.ports {
            check_port(p.container_port, "Internal port")?;
            if let Some(hp) = p.host_port {
                check_port(hp, "Published port")?;
            }
        }
        let id = if s.id.is_empty() { new_id() } else { s.id.clone() };
        self.tx(|tx| {
            tx.execute(
                "INSERT INTO services (id, host_id, name, runtime, image, scheme, health_path, description, icon, owner_tenant_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET host_id = excluded.host_id, name = excluded.name, runtime = excluded.runtime,
                   image = excluded.image, scheme = excluded.scheme, health_path = excluded.health_path,
                   description = excluded.description, icon = excluded.icon, owner_tenant_id = excluded.owner_tenant_id",
                params![
                    id,
                    s.host_id,
                    name,
                    s.runtime,
                    opt(&s.image),
                    s.scheme,
                    opt(&s.health_path),
                    opt(&s.description),
                    opt(&s.icon),
                    opt(&s.owner_tenant_id)
                ],
            )?;
            tx.execute("DELETE FROM service_ports WHERE service_id = ?1", [&id])?;
            let primary = s.ports.iter().position(|p| p.is_primary).unwrap_or(0);
            for (i, p) in s.ports.iter().enumerate() {
                tx.execute(
                    "INSERT INTO service_ports (id, service_id, container_port, host_port, bind_address, protocol, is_primary)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        if p.id.is_empty() { new_id() } else { p.id.clone() },
                        id,
                        p.container_port,
                        p.host_port,
                        if p.bind_address.trim().is_empty() { "0.0.0.0" } else { p.bind_address.trim() },
                        if p.protocol.is_empty() { "tcp" } else { p.protocol.as_str() },
                        i == primary
                    ],
                )?;
            }
            Ok(())
        })?;
        Ok(id)
    }

    /// Upsert a reverse proxy and reconcile its routes (ids are kept stable so
    /// deletions are tracked in `tombstones`).
    pub fn save_proxy(&self, p: &ReverseProxy) -> Result<String> {
        let name = required(&p.name, "Proxy name")?;
        for r in &p.routes {
            check_domain(required(&r.domain, "Domain")?)?;
            check_port(r.inbound_port, "Inbound port")?;
            check_port(r.target_port, "Target port")?;
            check_ip(Some(required(&r.target_ip, "Target IP")?), "Target IP")?;
        }
        let id = if p.id.is_empty() { new_id() } else { p.id.clone() };
        self.tx(|tx| {
            tx.execute(
                "INSERT INTO reverse_proxies (id, host_id, service_id, name, kind, admin_url) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET host_id = excluded.host_id, service_id = excluded.service_id, name = excluded.name,
                   kind = excluded.kind, admin_url = excluded.admin_url",
                params![id, p.host_id, opt(&p.service_id), name, p.kind, opt(&p.admin_url)],
            )?;
            let keep: Vec<String> = p.routes.iter().filter(|r| !r.id.is_empty()).map(|r| r.id.clone()).collect();
            let existing: Vec<String> = {
                let mut st = tx.prepare("SELECT id FROM proxy_routes WHERE proxy_id = ?1")?;
                let rows = st.query_map([&id], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for old in existing.iter().filter(|e| !keep.contains(e)) {
                tx.execute("DELETE FROM proxy_routes WHERE id = ?1", [old])?;
            }
            for r in &p.routes {
                let rid = if r.id.is_empty() { new_id() } else { r.id.clone() };
                tx.execute(
                    "INSERT INTO proxy_routes (id, proxy_id, domain, path_prefix, inbound_port, inbound_protocol, tls_mode, tls_expires_at,
                                               target_host_id, target_ip, target_port, target_scheme, service_id, enabled)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                     ON CONFLICT(id) DO UPDATE SET proxy_id = excluded.proxy_id, domain = excluded.domain, path_prefix = excluded.path_prefix,
                       inbound_port = excluded.inbound_port, inbound_protocol = excluded.inbound_protocol, tls_mode = excluded.tls_mode,
                       tls_expires_at = excluded.tls_expires_at, target_host_id = excluded.target_host_id, target_ip = excluded.target_ip,
                       target_port = excluded.target_port, target_scheme = excluded.target_scheme, service_id = excluded.service_id,
                       enabled = excluded.enabled",
                    params![
                        rid,
                        id,
                        r.domain.trim().to_ascii_lowercase(),
                        if r.path_prefix.trim().is_empty() { "/" } else { r.path_prefix.trim() },
                        r.inbound_port,
                        r.inbound_protocol,
                        if r.inbound_protocol == "https" && r.tls_mode == "none" { "letsencrypt" } else { r.tls_mode.as_str() },
                        opt(&r.tls_expires_at),
                        opt(&r.target_host_id),
                        r.target_ip.trim(),
                        r.target_port,
                        r.target_scheme,
                        opt(&r.service_id),
                        r.enabled
                    ],
                )?;
            }
            Ok(())
        })?;
        Ok(id)
    }

    /// Upsert a credential. Secret fields follow their [`SecretUpdate`].
    pub fn save_credential(&self, field_key: &Key256, c: &CredentialInput) -> Result<String> {
        let label = required(&c.label, "Label")?;
        let id = c.id.clone().filter(|s| !s.is_empty()).unwrap_or_else(new_id);
        let (tenant, host, service, proxy) = match c.owner.kind {
            OwnerKind::Tenant => (Some(&c.owner.id), None, None, None),
            OwnerKind::Host => (None, Some(&c.owner.id), None, None),
            OwnerKind::Service => (None, None, Some(&c.owner.id), None),
            OwnerKind::Proxy => (None, None, None, Some(&c.owner.id)),
        };
        let mut sealed: Vec<(SecretField, Option<Vec<u8>>)> = Vec::new();
        for (field, upd) in [(SecretField::Secret, &c.secret), (SecretField::PrivateKey, &c.private_key), (SecretField::Notes, &c.notes)] {
            match upd {
                SecretUpdate::Keep => {}
                SecretUpdate::Clear => sealed.push((field, None)),
                SecretUpdate::Set(v) if v.is_empty() => sealed.push((field, None)),
                SecretUpdate::Set(v) => sealed.push((field, Some(crypto::seal(field_key, &field_aad(&id, field), v.as_bytes())?))),
            }
        }
        self.tx(|tx| {
            tx.execute(
                "INSERT INTO credentials (id, tenant_id, host_id, service_id, proxy_id, kind, label, username, public_key, url, expires_at,
                                          private_key_sealed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CASE WHEN ?6 = 'ssh_key' THEN x'00' ELSE NULL END)
                 ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, host_id = excluded.host_id, service_id = excluded.service_id,
                   proxy_id = excluded.proxy_id, kind = excluded.kind, label = excluded.label, username = excluded.username,
                   public_key = excluded.public_key, url = excluded.url, expires_at = excluded.expires_at",
                params![
                    id,
                    tenant,
                    host,
                    service,
                    proxy,
                    c.kind,
                    label,
                    opt(&c.username),
                    opt(&c.public_key),
                    opt(&c.url),
                    opt(&c.expires_at)
                ],
            )?;
            for (field, blob) in &sealed {
                tx.execute(&format!("UPDATE credentials SET {} = ?1 WHERE id = ?2", field.column()), params![blob, id])?;
            }
            // Placeholder used only to satisfy the ssh_key CHECK during insert.
            let pk: Option<Vec<u8>> = tx.query_row("SELECT private_key_sealed FROM credentials WHERE id = ?1", [&id], |r| r.get(0))?;
            if pk.as_deref() == Some(&[0u8][..]) {
                tx.execute("UPDATE credentials SET private_key_sealed = NULL WHERE id = ?1", [&id])?;
            }
            Ok(())
        })?;
        Ok(id)
    }

    pub fn delete_impact(&self, kind: EntityKind, id: &str) -> Result<DeleteImpact> {
        let c = |sql: &str| -> Result<i64> { Ok(self.conn().query_row(sql, [id], |r| r.get(0))?) };
        Ok(match kind {
            EntityKind::Tenant => DeleteImpact {
                hosts: c("SELECT count(*) FROM hosts WHERE tenant_id = ?1")?,
                services: c("SELECT count(*) FROM services s JOIN hosts h ON h.id = s.host_id WHERE h.tenant_id = ?1")?,
                proxies: c("SELECT count(*) FROM reverse_proxies p JOIN hosts h ON h.id = p.host_id WHERE h.tenant_id = ?1")?,
                routes: c("SELECT count(*) FROM proxy_routes r JOIN reverse_proxies p ON p.id = r.proxy_id JOIN hosts h ON h.id = p.host_id WHERE h.tenant_id = ?1")?,
                credentials: c("SELECT count(*) FROM credentials c LEFT JOIN hosts h ON h.id = c.host_id
                                LEFT JOIN services s ON s.id = c.service_id LEFT JOIN hosts sh ON sh.id = s.host_id
                                LEFT JOIN reverse_proxies p ON p.id = c.proxy_id LEFT JOIN hosts ph ON ph.id = p.host_id
                                WHERE c.tenant_id = ?1 OR h.tenant_id = ?1 OR sh.tenant_id = ?1 OR ph.tenant_id = ?1")?,
                networks: c("SELECT count(*) FROM networks WHERE tenant_id = ?1")?,
            },
            EntityKind::Host => DeleteImpact {
                services: c("SELECT count(*) FROM services WHERE host_id = ?1")?,
                proxies: c("SELECT count(*) FROM reverse_proxies WHERE host_id = ?1")?,
                routes: c("SELECT count(*) FROM proxy_routes r JOIN reverse_proxies p ON p.id = r.proxy_id WHERE p.host_id = ?1")?,
                credentials: c("SELECT count(*) FROM credentials c LEFT JOIN services s ON s.id = c.service_id
                                LEFT JOIN reverse_proxies p ON p.id = c.proxy_id
                                WHERE c.host_id = ?1 OR s.host_id = ?1 OR p.host_id = ?1")?,
                ..Default::default()
            },
            EntityKind::Service => DeleteImpact { credentials: c("SELECT count(*) FROM credentials WHERE service_id = ?1")?, ..Default::default() },
            EntityKind::Proxy => DeleteImpact {
                routes: c("SELECT count(*) FROM proxy_routes WHERE proxy_id = ?1")?,
                credentials: c("SELECT count(*) FROM credentials WHERE proxy_id = ?1")?,
                ..Default::default()
            },
            _ => DeleteImpact::default(),
        })
    }

    pub fn delete_entity(&self, kind: EntityKind, id: &str) -> Result<()> {
        let n = self.conn().execute(&format!("DELETE FROM {} WHERE id = ?1", kind.table()), [id]).map_err(friendly)?;
        if n == 0 {
            return Err(Error::NotFound(format!("{kind:?} {id}")));
        }
        Ok(())
    }

    pub fn delete_sync_remote(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM sync_remotes WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn tenant_id_by_name(&self, name: &str) -> Result<Option<String>> {
        Ok(self.conn().query_row("SELECT id FROM tenants WHERE name = ?1", [name.trim()], |r| r.get(0)).optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (Database, Key256) {
        let db = Database::open_in_memory(&Key256::random()).unwrap();
        db.init_meta("00000000-0000-0000-0000-000000000000", "Test").unwrap();
        (db, Key256::random())
    }

    fn tenant(db: &Database, name: &str) -> String {
        db.save_tenant(&Tenant { name: name.into(), environment: "corporate".into(), ..Default::default() }).unwrap()
    }

    #[test]
    fn full_lifecycle_from_empty_vault() {
        let (db, fk) = db();
        assert!(db.load_topology().unwrap().tenants.is_empty(), "new vaults start empty");
        let t = tenant(&db, "ACME");
        assert_eq!(
            db.save_tenant(&Tenant { name: "acme".into(), environment: "client".into(), ..Default::default() }).unwrap_err().to_string(),
            "invalid input: A company with this name already exists"
        );

        let vps = db
            .save_host(&Host {
                tenant_id: t.clone(),
                name: "vps-1".into(),
                category: "vps".into(),
                ssh_port: Some(22),
                interfaces: vec![NetworkInterface {
                    name: "eth0".into(),
                    internal_ip: Some("10.0.0.5".into()),
                    public_ip: Some("203.0.113.9".into()),
                    is_primary: true,
                    ..Default::default()
                }],
                ..Default::default()
            })
            .unwrap();
        let web = db
            .save_service(&Service {
                host_id: vps.clone(),
                name: "website".into(),
                runtime: "docker".into(),
                scheme: "http".into(),
                ports: vec![ServicePort { container_port: 80, host_port: Some(8080), ..Default::default() }],
                ..Default::default()
            })
            .unwrap();
        let px = db
            .save_proxy(&ReverseProxy {
                host_id: vps.clone(),
                name: "nginx".into(),
                kind: "nginx".into(),
                routes: vec![ProxyRoute {
                    domain: "Example.COM".into(),
                    inbound_port: 443,
                    inbound_protocol: "https".into(),
                    tls_mode: "none".into(),
                    target_ip: "10.0.0.5".into(),
                    target_port: 8080,
                    target_scheme: "http".into(),
                    service_id: Some(web.clone()),
                    target_host_id: Some(vps.clone()),
                    enabled: true,
                    ..Default::default()
                }],
                ..Default::default()
            })
            .unwrap();
        let cred = db
            .save_credential(
                &fk,
                &CredentialInput {
                    id: None,
                    owner: CredentialOwner { kind: OwnerKind::Service, id: web.clone() },
                    kind: "admin_login".into(),
                    label: "wp-admin".into(),
                    username: Some("me".into()),
                    url: None,
                    public_key: None,
                    expires_at: None,
                    secret: SecretUpdate::Set(Zeroizing::new("s3cret".into())),
                    private_key: SecretUpdate::Keep,
                    notes: SecretUpdate::Keep,
                },
            )
            .unwrap();
        let topo = db.load_topology().unwrap();
        let route = &topo.proxies[0].routes[0];
        assert_eq!(route.domain, "example.com", "domains are normalised");
        assert_eq!(route.tls_mode, "letsencrypt", "https never stored with tls none");
        assert_eq!(db.credential_secret(&fk, &cred, SecretField::Secret).unwrap().as_str(), "s3cret");

        // Edit: rename + keep secret, then change ports.
        let input = CredentialInput {
            id: Some(cred.clone()),
            owner: CredentialOwner { kind: OwnerKind::Service, id: web.clone() },
            kind: "admin_login".into(),
            label: "WordPress admin".into(),
            username: Some("me".into()),
            url: None,
            public_key: None,
            expires_at: None,
            secret: SecretUpdate::Keep,
            private_key: SecretUpdate::Keep,
            notes: SecretUpdate::Set(Zeroizing::new("rotated quarterly".into())),
        };
        db.save_credential(&fk, &input).unwrap();
        assert_eq!(db.credential_secret(&fk, &cred, SecretField::Secret).unwrap().as_str(), "s3cret");
        assert_eq!(db.credential_meta(&cred).unwrap().label, "WordPress admin");
        assert!(db.credential_meta(&cred).unwrap().has_notes);

        // Impact + delete cascade.
        let impact = db.delete_impact(EntityKind::Host, &vps).unwrap();
        assert_eq!((impact.services, impact.proxies, impact.routes, impact.credentials), (1, 1, 1, 1));
        db.delete_entity(EntityKind::Proxy, &px).unwrap();
        db.delete_entity(EntityKind::Tenant, &t).unwrap();
        assert!(db.load_topology().unwrap().hosts.is_empty());
    }

    #[test]
    fn service_owner_can_differ_from_host_company() {
        let (db, _) = db();
        let work = tenant(&db, "Employer");
        let me = tenant(&db, "Personal");
        let vps =
            db.save_host(&Host { tenant_id: work.clone(), name: "vps".into(), category: "vps".into(), ..Default::default() }).unwrap();
        db.save_service(&Service {
            host_id: vps,
            name: "my-site".into(),
            runtime: "docker".into(),
            scheme: "http".into(),
            owner_tenant_id: Some(me.clone()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(db.load_topology().unwrap().services[0].owner_tenant_id.as_deref(), Some(me.as_str()));
        db.delete_entity(EntityKind::Tenant, &me).unwrap();
        assert_eq!(db.load_topology().unwrap().services[0].owner_tenant_id, None, "owner deletion keeps the service");
        assert_eq!(db.schema_version().unwrap(), 2);
    }

    /// Guards the values the desktop app and CLI write against the schema CHECKs.
    #[test]
    fn sync_remote_values_match_schema() {
        let (db, k) = db();
        for (provider, path) in [
            ("local", "/mnt/nas/v.kurogane"),
            ("drive", "Kurogane/v.kurogane"),
            ("onedrive", "Kurogane/w.kurogane"),
            ("mega", "Kurogane/x.kurogane"),
        ] {
            db.upsert_sync_remote(
                &k,
                &crate::db::NewSyncRemote {
                    id: None,
                    provider,
                    label: provider,
                    remote_path: path,
                    rclone_section: "type = local\n",
                    transport: "auto",
                },
            )
            .unwrap_or_else(|e| panic!("{provider}: {e}"));
        }
        assert_eq!(db.sync_remotes().unwrap().len(), 4);
    }

    #[test]
    fn validation_messages_are_human() {
        let (db, _) = db();
        let t = tenant(&db, "X");
        let bad_ip = Host {
            tenant_id: t.clone(),
            name: "h".into(),
            category: "vps".into(),
            interfaces: vec![NetworkInterface { name: "eth0".into(), internal_ip: Some("10.0.0.999".into()), ..Default::default() }],
            ..Default::default()
        };
        assert!(db.save_host(&bad_ip).unwrap_err().to_string().contains("not a valid IP address"));
        assert!(db
            .save_network(&Network { tenant_id: t.clone(), name: "lan".into(), cidr: "10.0.0.0".into(), ..Default::default() })
            .unwrap_err()
            .to_string()
            .contains("CIDR"));
        let h = db.save_host(&Host { tenant_id: t.clone(), name: "h".into(), category: "vps".into(), ..Default::default() }).unwrap();
        let svc = |name: &str| Service {
            host_id: h.clone(),
            name: name.into(),
            runtime: "docker".into(),
            scheme: "http".into(),
            ports: vec![ServicePort { container_port: 80, host_port: Some(8080), ..Default::default() }],
            ..Default::default()
        };
        db.save_service(&svc("a")).unwrap();
        assert!(db.save_service(&svc("b")).unwrap_err().to_string().contains("already used by another service"));
        // Re-saving the same service with the same port is fine (no self-collision).
        let a = db.load_topology().unwrap().services[0].clone();
        db.save_service(&a).unwrap();
    }
}
