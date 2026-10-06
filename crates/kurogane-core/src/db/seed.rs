//! Demo / mock data loader: three tenants covering every entity type.
//!
//! IDs are UUIDv5 of a readable slug so the UI fixture generated from this
//! seed (`kurogane-cli demo-fixture`) is stable across runs. The credentials
//! are obviously fake.

use std::collections::BTreeMap;

use super::models::*;
use super::Database;
use crate::error::Result;
use crate::secure::Key256;

const NS: uuid::Uuid = uuid::uuid!("6b1f3c1e-6d4a-4b8f-9a77-6b75726f6761"); // "kuroga"

pub fn demo_id(slug: &str) -> String {
    uuid::Uuid::new_v5(&NS, slug.as_bytes()).to_string()
}

/// Plaintext secrets keyed by credential id, returned for tests and the UI mock.
pub type DemoSecrets = BTreeMap<String, (SecretField, String)>;

fn s(v: &str) -> Option<String> {
    Some(v.to_string())
}

fn nic(slug: &str, name: &str, ip: &str, gw: Option<&str>, public: Option<&str>, net: Option<&str>) -> NetworkInterface {
    NetworkInterface {
        id: demo_id(slug),
        name: name.into(),
        internal_ip: s(ip),
        gateway: gw.map(Into::into),
        public_ip: public.map(Into::into),
        network_id: net.map(demo_id),
        is_primary: true,
        ..Default::default()
    }
}

fn port(container: u16, host: Option<u16>) -> ServicePort {
    ServicePort { container_port: container, host_port: host, protocol: "tcp".into(), is_primary: true, ..Default::default() }
}

struct HostSpec<'a> {
    slug: &'a str,
    tenant: &'a str,
    name: &'a str,
    category: &'a str,
    os: Option<&'a str>,
    ssh: Option<u16>,
    rdp: Option<u16>,
    web: Option<&'a str>,
    provider: Option<&'a str>,
    nic: NetworkInterface,
    parent: Option<&'a str>,
}

fn host(db: &Database, h: HostSpec<'_>) -> Result<String> {
    db.insert_host(&Host {
        id: demo_id(h.slug),
        tenant_id: demo_id(h.tenant),
        parent_host_id: h.parent.map(demo_id),
        name: h.name.into(),
        category: h.category.into(),
        os_family: h.os.map(Into::into),
        ssh_port: h.ssh,
        rdp_port: h.rdp,
        web_admin_url: h.web.map(Into::into),
        provider: h.provider.map(Into::into),
        interfaces: vec![h.nic],
        ..Default::default()
    })
}

#[allow(clippy::too_many_arguments)]
fn svc(
    db: &Database,
    slug: &str,
    host: &str,
    name: &str,
    runtime: &str,
    image: Option<&str>,
    scheme: &str,
    ports: Vec<ServicePort>,
) -> Result<String> {
    db.insert_service(&Service {
        id: demo_id(slug),
        host_id: demo_id(host),
        name: name.into(),
        runtime: runtime.into(),
        image: image.map(Into::into),
        scheme: scheme.into(),
        ports,
        ..Default::default()
    })
}

#[allow(clippy::too_many_arguments)]
fn route(
    slug: &str,
    domain: &str,
    target_host: &str,
    target_ip: &str,
    target_port: u16,
    service: &str,
    tls_expiry: Option<&str>,
    tls_mode: &str,
) -> ProxyRoute {
    ProxyRoute {
        id: demo_id(slug),
        domain: domain.into(),
        path_prefix: "/".into(),
        inbound_port: 443,
        inbound_protocol: "https".into(),
        tls_mode: tls_mode.into(),
        tls_expires_at: tls_expiry.map(Into::into),
        target_host_id: Some(demo_id(target_host)),
        target_ip: target_ip.into(),
        target_port,
        target_scheme: "http".into(),
        service_id: Some(demo_id(service)),
        enabled: true,
        ..Default::default()
    }
}

pub fn seed_demo(db: &Database, field_key: &Key256) -> Result<DemoSecrets> {
    let mut secrets = DemoSecrets::new();

    // ------------------------------------------------------------- tenants
    for (slug, name, env, label, color, sla) in [
        ("t-corp", "Kurogane Corp", "corporate", "Corporate", "#e8590c", "24/7 on-call · P1 response 15 min"),
        ("t-alpha", "Client Alpha", "client", "Client Alpha", "#4c8dff", "Business hours · managed hosting contract MH-2207"),
        ("t-home", "Homelab", "personal", "Personal Homelab", "#2fbf71", "Best effort"),
    ] {
        db.insert_tenant(&Tenant {
            id: demo_id(slug),
            name: name.into(),
            environment: env.into(),
            environment_label: s(label),
            color: s(color),
            sla_notes: s(sla),
            admin_notes: None,
        })?;
    }

    for (slug, tenant, name, kind, cidr, vlan, gw) in [
        ("n-corp-lan", "t-corp", "Office LAN", "lan", "10.10.0.0/24", Some(10u16), "10.10.0.1"),
        ("n-corp-cctv", "t-corp", "CCTV", "iot", "10.10.50.0/24", Some(50), "10.10.50.1"),
        ("n-corp-edge", "t-corp", "Edge VPC", "dmz", "172.16.0.0/24", None, "172.16.0.1"),
        ("n-alpha-lan", "t-alpha", "Alpha LAN", "lan", "192.168.20.0/24", None, "192.168.20.1"),
        ("n-home-lan", "t-home", "Home LAN", "lan", "192.168.1.0/24", None, "192.168.1.1"),
    ] {
        db.insert_network(&Network {
            id: demo_id(slug),
            tenant_id: demo_id(tenant),
            name: name.into(),
            kind: kind.into(),
            cidr: cidr.into(),
            vlan_id: vlan,
            gateway: s(gw),
        })?;
    }

    // -------------------------------------------------------- Kurogane Corp
    host(
        db,
        HostSpec {
            slug: "h-edge-01",
            tenant: "t-corp",
            name: "edge-01",
            category: "vps",
            os: Some("linux"),
            ssh: Some(22),
            rdp: None,
            web: None,
            provider: Some("Hetzner FSN1"),
            nic: nic("i-edge-01", "eth0", "172.16.0.10", Some("172.16.0.1"), Some("203.0.113.10"), Some("n-corp-edge")),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-app-01",
            tenant: "t-corp",
            name: "app-01",
            category: "local_server",
            os: Some("linux"),
            ssh: Some(2222),
            rdp: None,
            web: None,
            provider: Some("Rack A · U12"),
            nic: nic("i-app-01", "ens18", "10.10.0.21", Some("10.10.0.1"), None, Some("n-corp-lan")),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-win-01",
            tenant: "t-corp",
            name: "dc-01",
            category: "local_server",
            os: Some("windows"),
            ssh: None,
            rdp: Some(3389),
            web: None,
            provider: Some("Rack A · U14"),
            nic: nic("i-win-01", "Ethernet0", "10.10.0.5", Some("10.10.0.1"), None, Some("n-corp-lan")),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-core-sw",
            tenant: "t-corp",
            name: "core-sw",
            category: "switch",
            os: Some("embedded"),
            ssh: Some(22),
            rdp: None,
            web: Some("https://10.10.0.2"),
            provider: None,
            nic: nic("i-core-sw", "mgmt0", "10.10.0.2", Some("10.10.0.1"), None, Some("n-corp-lan")),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-gw",
            tenant: "t-corp",
            name: "gw-fw",
            category: "firewall",
            os: Some("bsd"),
            ssh: Some(22),
            rdp: None,
            web: Some("https://10.10.0.1"),
            provider: None,
            nic: nic("i-gw", "igb0", "10.10.0.1", None, Some("198.51.100.4"), Some("n-corp-lan")),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-nvr",
            tenant: "t-corp",
            name: "nvr-01",
            category: "nvr",
            os: Some("embedded"),
            ssh: None,
            rdp: None,
            web: Some("http://10.10.50.10"),
            provider: None,
            nic: nic("i-nvr", "eth0", "10.10.50.10", Some("10.10.50.1"), None, Some("n-corp-cctv")),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-ap-lobby",
            tenant: "t-corp",
            name: "ap-lobby",
            category: "access_point",
            os: Some("embedded"),
            ssh: Some(22),
            rdp: None,
            web: Some("https://10.10.0.40"),
            provider: None,
            nic: nic("i-ap-lobby", "br0", "10.10.0.40", Some("10.10.0.1"), None, Some("n-corp-lan")),
            parent: None,
        },
    )?;

    svc(
        db,
        "s-traefik",
        "h-edge-01",
        "traefik",
        "docker",
        Some("traefik:v3.1"),
        "https",
        vec![port(443, Some(443)), ServicePort { container_port: 80, host_port: Some(80), protocol: "tcp".into(), ..Default::default() }],
    )?;
    svc(db, "s-grafana", "h-edge-01", "grafana", "docker", Some("grafana/grafana:11.2.0"), "http", vec![port(3000, Some(3000))])?;
    svc(
        db,
        "s-gitea",
        "h-app-01",
        "gitea",
        "docker",
        Some("gitea/gitea:1.22"),
        "http",
        vec![
            port(3000, Some(8081)),
            ServicePort { container_port: 22, host_port: Some(2223), protocol: "tcp".into(), ..Default::default() },
        ],
    )?;
    svc(db, "s-wiki", "h-app-01", "wiki.js", "docker", Some("requarks/wiki:2"), "http", vec![port(3000, Some(8082))])?;
    svc(db, "s-postgres", "h-app-01", "postgres", "docker", Some("postgres:16"), "tcp", vec![port(5432, None)])?;
    svc(db, "s-ad", "h-win-01", "Active Directory", "windows_service", None, "tcp", vec![port(389, Some(389))])?;

    db.insert_proxy(&ReverseProxy {
        id: demo_id("p-traefik"),
        host_id: demo_id("h-edge-01"),
        service_id: Some(demo_id("s-traefik")),
        name: "traefik-edge".into(),
        kind: "traefik".into(),
        admin_url: s("https://traefik.corp.example/dashboard/"),
        routes: vec![
            route("r-git", "git.corp.example", "h-app-01", "10.10.0.21", 8081, "s-gitea", Some("2026-12-02T00:00:00Z"), "letsencrypt"),
            route("r-wiki", "wiki.corp.example", "h-app-01", "10.10.0.21", 8082, "s-wiki", Some("2026-10-19T00:00:00Z"), "letsencrypt"),
            route(
                "r-grafana",
                "grafana.corp.example",
                "h-edge-01",
                "172.16.0.10",
                3000,
                "s-grafana",
                Some("2027-01-15T00:00:00Z"),
                "letsencrypt",
            ),
        ],
    })?;

    // ---------------------------------------------------------- Client Alpha
    host(
        db,
        HostSpec {
            slug: "h-alpha-vps",
            tenant: "t-alpha",
            name: "alpha-web",
            category: "vps",
            os: Some("linux"),
            ssh: Some(22),
            rdp: None,
            web: None,
            provider: Some("OVH GRA"),
            nic: nic("i-alpha-vps", "eth0", "10.0.0.5", Some("10.0.0.1"), Some("192.0.2.45"), None),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-alpha-nas",
            tenant: "t-alpha",
            name: "alpha-nas",
            category: "nas",
            os: Some("linux"),
            ssh: Some(22),
            rdp: None,
            web: Some("https://192.168.20.10:5001"),
            provider: Some("Client office"),
            nic: nic("i-alpha-nas", "eth0", "192.168.20.10", Some("192.168.20.1"), None, Some("n-alpha-lan")),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-alpha-rtr",
            tenant: "t-alpha",
            name: "alpha-router",
            category: "router",
            os: Some("routeros"),
            ssh: Some(22),
            rdp: None,
            web: Some("https://192.168.20.1"),
            provider: None,
            nic: nic("i-alpha-rtr", "ether1", "192.168.20.1", None, Some("192.0.2.200"), Some("n-alpha-lan")),
            parent: None,
        },
    )?;

    svc(
        db,
        "s-npm",
        "h-alpha-vps",
        "nginx-proxy-manager",
        "docker",
        Some("jc21/nginx-proxy-manager:2"),
        "https",
        vec![port(443, Some(443)), ServicePort { container_port: 81, host_port: Some(81), protocol: "tcp".into(), ..Default::default() }],
    )?;
    svc(db, "s-wp", "h-alpha-vps", "wordpress", "docker", Some("wordpress:6.6"), "http", vec![port(80, Some(8080))])?;
    svc(db, "s-mariadb", "h-alpha-vps", "mariadb", "docker", Some("mariadb:11"), "tcp", vec![port(3306, None)])?;
    svc(db, "s-shop", "h-alpha-vps", "odoo", "docker", Some("odoo:17"), "http", vec![port(8069, Some(8069))])?;
    svc(db, "s-smb", "h-alpha-nas", "office-share", "smb", None, "smb", vec![port(445, Some(445))])?;

    db.insert_proxy(&ReverseProxy {
        id: demo_id("p-npm"),
        host_id: demo_id("h-alpha-vps"),
        service_id: Some(demo_id("s-npm")),
        name: "npm".into(),
        kind: "npm".into(),
        admin_url: s("http://10.0.0.5:81"),
        routes: vec![
            route("r-alpha-www", "www.alpha.example", "h-alpha-vps", "10.0.0.5", 8080, "s-wp", Some("2026-11-30T00:00:00Z"), "letsencrypt"),
            route(
                "r-alpha-shop",
                "shop.alpha.example",
                "h-alpha-vps",
                "10.0.0.5",
                8069,
                "s-shop",
                Some("2026-10-12T00:00:00Z"),
                "letsencrypt",
            ),
        ],
    })?;

    // --------------------------------------------------------------- Homelab
    host(
        db,
        HostSpec {
            slug: "h-pve",
            tenant: "t-home",
            name: "pve",
            category: "local_server",
            os: Some("linux"),
            ssh: Some(22),
            rdp: None,
            web: Some("https://192.168.1.10:8006"),
            provider: Some("Closet"),
            nic: nic("i-pve", "vmbr0", "192.168.1.10", Some("192.168.1.1"), None, Some("n-home-lan")),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-docker-vm",
            tenant: "t-home",
            name: "docker-vm",
            category: "vm",
            os: Some("linux"),
            ssh: Some(22),
            rdp: None,
            web: None,
            provider: None,
            nic: nic("i-docker-vm", "ens18", "192.168.1.20", Some("192.168.1.1"), None, Some("n-home-lan")),
            parent: Some("h-pve"),
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-rpi",
            tenant: "t-home",
            name: "rpi-tunnel",
            category: "edge_device",
            os: Some("linux"),
            ssh: Some(22),
            rdp: None,
            web: None,
            provider: None,
            nic: nic("i-rpi", "wlan0", "192.168.1.30", Some("192.168.1.1"), None, Some("n-home-lan")),
            parent: None,
        },
    )?;
    host(
        db,
        HostSpec {
            slug: "h-home-ap",
            tenant: "t-home",
            name: "u6-lite",
            category: "access_point",
            os: Some("embedded"),
            ssh: Some(22),
            rdp: None,
            web: None,
            provider: None,
            nic: nic("i-home-ap", "br0", "192.168.1.4", Some("192.168.1.1"), None, Some("n-home-lan")),
            parent: None,
        },
    )?;

    svc(db, "s-cloudflared", "h-rpi", "cloudflared", "systemd", None, "none", vec![])?;
    svc(db, "s-jellyfin", "h-docker-vm", "jellyfin", "docker", Some("jellyfin/jellyfin:10.9"), "http", vec![port(8096, Some(8096))])?;
    svc(
        db,
        "s-ha",
        "h-docker-vm",
        "home-assistant",
        "docker",
        Some("ghcr.io/home-assistant/home-assistant:stable"),
        "http",
        vec![port(8123, Some(8123))],
    )?;
    svc(db, "s-vault", "h-docker-vm", "vaultwarden", "docker", Some("vaultwarden/server:1.32"), "http", vec![port(80, Some(8000))])?;

    db.insert_proxy(&ReverseProxy {
        id: demo_id("p-cf"),
        host_id: demo_id("h-rpi"),
        service_id: Some(demo_id("s-cloudflared")),
        name: "cloudflare-tunnel".into(),
        kind: "cloudflare_tunnel".into(),
        admin_url: s("https://one.dash.cloudflare.com/"),
        routes: vec![
            route("r-jf", "media.home.example", "h-docker-vm", "192.168.1.20", 8096, "s-jellyfin", None, "cloudflare"),
            route("r-ha", "ha.home.example", "h-docker-vm", "192.168.1.20", 8123, "s-ha", None, "cloudflare"),
            route("r-vw", "vault.home.example", "h-docker-vm", "192.168.1.20", 8000, "s-vault", None, "cloudflare"),
        ],
    })?;

    // ----------------------------------------------------------- credentials
    let mut cred = |slug: &str,
                    kind: OwnerKind,
                    owner: &str,
                    ckind: &str,
                    label: &str,
                    user: Option<&str>,
                    secret: Option<&str>,
                    key: Option<&str>,
                    url: Option<&str>|
     -> Result<()> {
        let id = demo_id(slug);
        db.insert_credential(
            field_key,
            &NewCredential {
                id: Some(id.clone()),
                owner: CredentialOwner { kind, id: demo_id(owner) },
                kind: ckind,
                label,
                username: user,
                secret,
                private_key: key,
                public_key: key.map(|_| "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoDemoDemoDemoDemoDemoDemoDemoDemoDemo kurogane-demo"),
                notes: None,
                url,
                expires_at: None,
            },
        )?;
        if let Some(sv) = secret {
            secrets.insert(id, (SecretField::Secret, sv.to_string()));
        } else if let Some(k) = key {
            secrets.insert(id, (SecretField::PrivateKey, k.to_string()));
        }
        Ok(())
    };
    const DEMO_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nDEMO-ONLY-NOT-A-REAL-KEY\n-----END OPENSSH PRIVATE KEY-----";
    cred("c-edge-ssh", OwnerKind::Host, "h-edge-01", "ssh_key", "deploy key", Some("deploy"), None, Some(DEMO_KEY), None)?;
    cred("c-app-ssh", OwnerKind::Host, "h-app-01", "ssh_password", "root shell", Some("root"), Some("Tama-hagane!42"), None, None)?;
    cred("c-dc-rdp", OwnerKind::Host, "h-win-01", "rdp", "domain admin", Some("CORP\\kadmin"), Some("Orochi-9-Heads#"), None, None)?;
    cred(
        "c-sw-web",
        OwnerKind::Host,
        "h-core-sw",
        "web_gui",
        "switch admin",
        Some("admin"),
        Some("sw1tch-Kurogane"),
        None,
        Some("https://10.10.0.2"),
    )?;
    cred(
        "c-gw-web",
        OwnerKind::Host,
        "h-gw",
        "web_gui",
        "pfSense",
        Some("admin"),
        Some("fw-Ironwall-77"),
        None,
        Some("https://10.10.0.1"),
    )?;
    cred(
        "c-nvr-web",
        OwnerKind::Host,
        "h-nvr",
        "web_gui",
        "NVR viewer",
        Some("security"),
        Some("cam-Watcher-12"),
        None,
        Some("http://10.10.50.10"),
    )?;
    cred(
        "c-traefik-dash",
        OwnerKind::Proxy,
        "p-traefik",
        "admin_login",
        "dashboard basic-auth",
        Some("ops"),
        Some("tr43fik-Dash"),
        None,
        None,
    )?;
    cred(
        "c-gitea-admin",
        OwnerKind::Service,
        "s-gitea",
        "admin_login",
        "gitea admin",
        Some("kadmin"),
        Some("g1tea-Forge-2026"),
        None,
        None,
    )?;
    cred("c-pg", OwnerKind::Service, "s-postgres", "db_user", "app database", Some("app"), Some("pg-Shirogane-55"), None, None)?;
    cred(
        "c-grafana-token",
        OwnerKind::Service,
        "s-grafana",
        "api_token",
        "provisioning token",
        None,
        Some("glsa_DEMO_8f3b2c1d9e0a7b6c5d4e3f2a1b0c9d8e"),
        None,
        None,
    )?;
    cred("c-alpha-ssh", OwnerKind::Host, "h-alpha-vps", "ssh_password", "ubuntu", Some("ubuntu"), Some("Alpha-Vps-2026!"), None, None)?;
    cred(
        "c-npm-admin",
        OwnerKind::Proxy,
        "p-npm",
        "admin_login",
        "NPM admin",
        Some("admin@alpha.example"),
        Some("npm-Changeme-Not"),
        None,
        Some("http://10.0.0.5:81"),
    )?;
    cred("c-wp-admin", OwnerKind::Service, "s-wp", "admin_login", "wp-admin", Some("alpha-editor"), Some("Wp-Press-Ink-8"), None, None)?;
    cred("c-maria", OwnerKind::Service, "s-mariadb", "db_user", "wordpress db", Some("wp"), Some("maria-Db-Alpha-3"), None, None)?;
    cred("c-smb", OwnerKind::Service, "s-smb", "smb", "office share", Some("ALPHA\\scanner"), Some("Scan-To-Folder-1"), None, None)?;
    cred(
        "c-alpha-rtr",
        OwnerKind::Host,
        "h-alpha-rtr",
        "web_gui",
        "RouterOS",
        Some("admin"),
        Some("mikro-Tik-Alpha"),
        None,
        Some("https://192.168.20.1"),
    )?;
    cred(
        "c-registrar",
        OwnerKind::Tenant,
        "t-alpha",
        "web_gui",
        "domain registrar",
        Some("billing@alpha.example"),
        Some("Registrar-Lock-99"),
        None,
        Some("https://registrar.example"),
    )?;
    cred(
        "c-pve",
        OwnerKind::Host,
        "h-pve",
        "web_gui",
        "Proxmox root@pam",
        Some("root"),
        Some("pve-Homelab-Root"),
        None,
        Some("https://192.168.1.10:8006"),
    )?;
    cred("c-docker-ssh", OwnerKind::Host, "h-docker-vm", "ssh_key", "homelab key", Some("kuro"), None, Some(DEMO_KEY), None)?;
    cred("c-cf-token", OwnerKind::Proxy, "p-cf", "api_token", "tunnel token", None, Some("eyJhIjoiREVNTyJ9.DEMO.TUNNEL"), None, None)?;
    cred("c-jf", OwnerKind::Service, "s-jellyfin", "admin_login", "jellyfin admin", Some("kuro"), Some("Jelly-Fin-Movie"), None, None)?;
    cred("c-ha", OwnerKind::Service, "s-ha", "admin_login", "home assistant", Some("kuro"), Some("Home-Assist-Lux"), None, None)?;

    Ok(secrets)
}
