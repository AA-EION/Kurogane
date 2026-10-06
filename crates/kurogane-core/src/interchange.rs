//! Import / export.
//!
//! * **Excel workbook** (`.xlsx`): one sheet per kind of record, human column
//!   names, dropdowns for every fixed list, and references by *name* (company →
//!   machine → service) so nobody has to deal with ids. The same layout is used
//!   for the blank template, for exports, and for imports. Re-importing an
//!   edited export updates existing records instead of duplicating them.
//! * **JSON**: lossless dump of the topology (optionally with secrets) for
//!   backups and scripting; re-import upserts by id.

use std::collections::{BTreeMap, HashMap};
use std::io::Cursor;

use calamine::{open_workbook_from_rs, Data, Reader, Xlsx};
use rust_xlsxwriter::{Color, DataValidation, Format, FormatBorder, Formula, Note, Workbook, Worksheet};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::db::models::*;
use crate::db::{CredentialInput, Database, SecretUpdate};
use crate::error::{Error, Result};
use crate::secure::Key256;

// ------------------------------------------------------------------ choices

type Choices = &'static [(&'static str, &'static str)];

pub const ENVIRONMENTS: Choices = &[
    ("corporate", "Corporate"),
    ("client", "Client"),
    ("personal", "Personal"),
    ("lab", "Lab"),
    ("staging", "Staging"),
    ("production", "Production"),
];
pub const CATEGORIES: Choices = &[
    ("vps", "VPS"),
    ("local_server", "Local server"),
    ("vm", "Virtual machine"),
    ("switch", "Switch"),
    ("access_point", "Access point"),
    ("router", "Router"),
    ("firewall", "Firewall"),
    ("nvr", "NVR"),
    ("nas", "NAS"),
    ("edge_device", "Edge device"),
    ("workstation", "Workstation"),
];
pub const OS_FAMILIES: Choices = &[
    ("linux", "Linux"),
    ("windows", "Windows"),
    ("macos", "macOS"),
    ("bsd", "BSD"),
    ("routeros", "RouterOS"),
    ("embedded", "Firmware"),
    ("other", "Other"),
];
pub const RUNTIMES: Choices = &[
    ("docker", "Docker"),
    ("podman", "Podman"),
    ("systemd", "Native"),
    ("smb", "SMB share"),
    ("kubernetes", "Kubernetes"),
    ("windows_service", "Windows service"),
    ("lxc", "LXC"),
    ("other", "Other"),
];
pub const SCHEMES: Choices =
    &[("http", "HTTP"), ("https", "HTTPS"), ("tcp", "TCP"), ("udp", "UDP"), ("smb", "SMB"), ("rtsp", "RTSP"), ("none", "None")];
pub const PROXY_KINDS: Choices = &[
    ("nginx", "Nginx"),
    ("npm", "Nginx Proxy Manager"),
    ("traefik", "Traefik"),
    ("caddy", "Caddy"),
    ("haproxy", "HAProxy"),
    ("cloudflare_tunnel", "Cloudflare Tunnel"),
    ("other", "Other"),
];
pub const INBOUND: Choices = &[("https", "HTTPS"), ("http", "HTTP"), ("tcp", "TCP"), ("udp", "UDP")];
pub const TLS_MODES: Choices = &[
    ("letsencrypt", "Let's Encrypt"),
    ("custom", "Custom certificate"),
    ("cloudflare", "Cloudflare"),
    ("passthrough", "Passthrough"),
    ("none", "None"),
];
pub const TARGET_SCHEMES: Choices = &[("http", "HTTP"), ("https", "HTTPS"), ("tcp", "TCP"), ("udp", "UDP")];
pub const PROTOCOLS: Choices = &[("tcp", "TCP"), ("udp", "UDP")];
pub const NETWORK_KINDS: Choices =
    &[("lan", "LAN"), ("dmz", "DMZ"), ("wan", "WAN"), ("vpn", "VPN"), ("overlay", "Overlay"), ("mgmt", "Management"), ("iot", "IoT")];
pub const CREDENTIAL_KINDS: Choices = &[
    ("ssh_password", "SSH password"),
    ("ssh_key", "SSH key"),
    ("rdp", "RDP"),
    ("winrm", "WinRM"),
    ("web_gui", "Web login"),
    ("admin_login", "Admin login"),
    ("db_user", "Database user"),
    ("api_token", "API token"),
    ("smb", "SMB"),
    ("snmp", "SNMP"),
    ("other", "Other"),
];
const OWNER_TYPES: Choices = &[("tenant", "Company"), ("host", "Machine"), ("service", "Service"), ("proxy", "Proxy")];
const YES_NO: Choices = &[("yes", "Yes"), ("no", "No")];

fn choice(list: Choices, v: &str) -> Option<&'static str> {
    let v = v.trim();
    list.iter().find(|(code, label)| code.eq_ignore_ascii_case(v) || label.eq_ignore_ascii_case(v)).map(|(c, _)| *c)
}

fn label(list: Choices, code: &str) -> String {
    list.iter().find(|(c, _)| *c == code).map(|(_, l)| l.to_string()).unwrap_or_else(|| code.to_string())
}

// ------------------------------------------------------------------ layout

struct Col {
    header: &'static str,
    required: bool,
    width: f64,
    choices: Option<Choices>,
    /// Dropdown fed from another sheet's first column (e.g. company names).
    list_from: Option<&'static str>,
    note: &'static str,
}

const fn col(header: &'static str, width: f64) -> Col {
    Col { header, required: false, width, choices: None, list_from: None, note: "" }
}
const fn req(header: &'static str, width: f64) -> Col {
    Col { header, required: true, width, choices: None, list_from: None, note: "" }
}
const fn pick(mut c: Col, choices: Choices) -> Col {
    c.choices = Some(choices);
    c
}
const fn from(mut c: Col, sheet: &'static str) -> Col {
    c.list_from = Some(sheet);
    c
}
const fn note(mut c: Col, n: &'static str) -> Col {
    c.note = n;
    c
}

struct Sheet {
    name: &'static str,
    color: u32,
    cols: &'static [Col],
}

const S_COMPANIES: &str = "Companies";
const S_NETWORKS: &str = "Networks";
const S_MACHINES: &str = "Machines";
const S_CARDS: &str = "Network cards";
const S_SERVICES: &str = "Services";
const S_PORTS: &str = "Ports";
const S_PROXIES: &str = "Proxies";
const S_ROUTES: &str = "Routes";
const S_ACCOUNTS: &str = "Accounts";

const SHEETS: &[Sheet] = &[
    Sheet {
        name: S_COMPANIES,
        color: 0xE8590C,
        cols: &[
            note(req("Company", 28.0), "Who owns these resources. Must be unique."),
            pick(req("Type", 14.0), ENVIRONMENTS),
            note(col("Label", 20.0), "Optional tag, e.g. \"Client Alpha\" or \"Homelab\"."),
            note(col("Color", 10.0), "Optional hex colour for the map, e.g. #4C8DFF."),
            col("SLA notes", 30.0),
            col("Admin notes", 30.0),
        ],
    },
    Sheet {
        name: S_NETWORKS,
        color: 0x868E96,
        cols: &[
            from(req("Company", 24.0), S_COMPANIES),
            req("Network", 20.0),
            pick(col("Kind", 12.0), NETWORK_KINDS),
            note(req("CIDR", 18.0), "e.g. 192.168.1.0/24"),
            col("VLAN", 8.0),
            col("Gateway", 16.0),
        ],
    },
    Sheet {
        name: S_MACHINES,
        color: 0x4C8DFF,
        cols: &[
            from(req("Company", 24.0), S_COMPANIES),
            note(req("Machine", 22.0), "Hostname / device name. Unique within the company."),
            pick(req("Category", 16.0), CATEGORIES),
            pick(col("OS", 12.0), OS_FAMILIES),
            note(col("Runs on", 18.0), "For VMs: the hypervisor machine's name (same company)."),
            col("FQDN", 24.0),
            col("SSH port", 10.0),
            col("RDP port", 10.0),
            note(col("Web admin URL", 28.0), "Management UI, e.g. https://192.168.1.1"),
            note(col("Provider", 18.0), "e.g. Hetzner, OVH, Office rack"),
            col("Location", 16.0),
            col("Notes", 30.0),
        ],
    },
    Sheet {
        name: S_CARDS,
        color: 0x4C8DFF,
        cols: &[
            from(req("Company", 24.0), S_COMPANIES),
            from(req("Machine", 22.0), S_MACHINES),
            note(req("Card", 12.0), "Interface name, e.g. eth0, ens18, vmbr0."),
            note(col("Network", 18.0), "Optional: a network name from the Networks sheet."),
            col("Private IP", 16.0),
            col("Gateway", 16.0),
            note(col("Public IP", 16.0), "Public / egress address attached to this card."),
            col("MAC", 18.0),
            pick(col("Primary", 9.0), YES_NO),
        ],
    },
    Sheet {
        name: S_SERVICES,
        color: 0x6EA8FE,
        cols: &[
            from(req("Company", 24.0), S_COMPANIES),
            from(req("Machine", 22.0), S_MACHINES),
            req("Service", 22.0),
            pick(req("Runtime", 16.0), RUNTIMES),
            note(col("Image", 28.0), "Container image, e.g. nginx:1.27"),
            pick(col("Scheme", 10.0), SCHEMES),
            col("Description", 30.0),
            from(note(col("Owner company", 22.0), "Only if someone else owns it, e.g. your own site on your employer's VPS."), S_COMPANIES),
        ],
    },
    Sheet {
        name: S_PORTS,
        color: 0x6EA8FE,
        cols: &[
            from(req("Company", 24.0), S_COMPANIES),
            from(req("Machine", 22.0), S_MACHINES),
            from(req("Service", 22.0), S_SERVICES),
            note(req("Internal port", 14.0), "Port the service listens on (inside the container)."),
            note(col("Published port", 15.0), "Port exposed on the machine. Leave empty if not published."),
            note(col("Bind address", 14.0), "Default 0.0.0.0"),
            pick(col("Protocol", 10.0), PROTOCOLS),
            pick(col("Primary", 9.0), YES_NO),
        ],
    },
    Sheet {
        name: S_PROXIES,
        color: 0xFF7A45,
        cols: &[
            from(req("Company", 24.0), S_COMPANIES),
            from(req("Machine", 22.0), S_MACHINES),
            req("Proxy", 20.0),
            pick(req("Kind", 20.0), PROXY_KINDS),
            note(col("Runs as service", 20.0), "Optional: the service (same machine) that is the proxy, e.g. its container."),
            col("Admin URL", 28.0),
        ],
    },
    Sheet {
        name: S_ROUTES,
        color: 0xFF7A45,
        cols: &[
            from(req("Company", 24.0), S_COMPANIES),
            from(note(req("Proxy machine", 20.0), "Machine where the proxy runs."), S_MACHINES),
            from(req("Proxy", 18.0), S_PROXIES),
            note(req("Domain", 26.0), "Public domain, e.g. app.example.com"),
            note(col("Path", 10.0), "Default /"),
            note(col("Inbound port", 12.0), "Default 443"),
            pick(col("Inbound protocol", 14.0), INBOUND),
            pick(col("TLS", 16.0), TLS_MODES),
            note(col("TLS expires", 14.0), "Certificate expiry date (YYYY-MM-DD). Empty = auto-renewed / unknown."),
            note(col("Target company", 20.0), "Default: same company."),
            from(note(col("Target machine", 20.0), "Machine that runs the service."), S_MACHINES),
            from(note(col("Target service", 20.0), "If set, IP and port below are filled in automatically."), S_SERVICES),
            note(col("Target IP", 16.0), "Default: target machine's private IP."),
            note(col("Target port", 12.0), "Default: target service's published port."),
            pick(col("Target scheme", 13.0), TARGET_SCHEMES),
        ],
    },
    Sheet {
        name: S_ACCOUNTS,
        color: 0xFFC247,
        cols: &[
            from(req("Company", 24.0), S_COMPANIES),
            pick(
                note(req("Belongs to", 12.0), "What the account is for: the company itself, a machine, a service or a proxy."),
                OWNER_TYPES,
            ),
            from(note(col("Machine", 20.0), "Required for Machine, Service and Proxy accounts."), S_MACHINES),
            note(col("Service or proxy", 20.0), "Required for Service and Proxy accounts."),
            pick(req("Account type", 16.0), CREDENTIAL_KINDS),
            note(req("Label", 22.0), "e.g. \"root\", \"WordPress admin\". Unique per owner."),
            col("Username", 20.0),
            note(col("Password", 20.0), "Leave empty on re-import to keep the stored password."),
            col("URL", 26.0),
            col("Notes", 26.0),
            note(col("SSH private key", 26.0), "Paste the full key including BEGIN/END lines."),
            col("Public key", 26.0),
        ],
    },
];

/// Rows whose Company cell equals this are examples and are skipped on import.
pub const EXAMPLE_COMPANY: &str = "Example Co (delete me)";

const README: &[&str] = &[
    "KUROGANE import template",
    "",
    "Fill one sheet per kind of record. Columns marked * are required. Most cells have dropdowns.",
    "Records reference each other by NAME: a machine belongs to a Company, a service to a Company + Machine, and so on.",
    "Rows whose Company is \"Example Co (delete me)\" are examples and are ignored.",
    "",
    "Order of sheets = order of import: Companies → Networks → Machines → Network cards → Services → Ports → Proxies → Routes → Accounts.",
    "",
    "Re-importing updates existing records that match by name (company / machine / service / proxy / domain / account label).",
    "Empty cells on an existing record keep the stored value. An empty Password keeps the stored password.",
    "",
    "Routes: set \"Target service\" and Kurogane fills in the target IP (machine's private IP) and port (service's published port).",
    "",
    "SECURITY: this file is NOT encrypted. If it contains passwords, delete it after importing.",
];

// ------------------------------------------------------------------- write

fn norm(h: &str) -> String {
    h.trim().trim_end_matches('*').trim().to_ascii_lowercase()
}

fn xerr(e: rust_xlsxwriter::XlsxError) -> Error {
    Error::invalid(format!("spreadsheet: {e}"))
}

/// Column holding the record name on a referenced sheet.
fn name_column(sheet: &str) -> &'static str {
    match sheet {
        S_COMPANIES => "A",
        S_SERVICES | S_PROXIES => "C",
        _ => "B",
    }
}

fn write_sheet(wb: &mut Workbook, def: &Sheet, rows: &[Vec<String>], example: Option<&[&str]>) -> Result<()> {
    let header = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x1A1F27))
        .set_border_bottom(FormatBorder::Medium)
        .set_border_bottom_color(Color::RGB(def.color));
    let ex_fmt = Format::new().set_italic().set_font_color(Color::RGB(0x868E96));
    let ws: &mut Worksheet = wb.add_worksheet();
    ws.set_name(def.name).map_err(xerr)?;
    ws.set_tab_color(Color::RGB(def.color));
    for (c, col) in def.cols.iter().enumerate() {
        let c = c as u16;
        let title = if col.required { format!("{} *", col.header) } else { col.header.to_string() };
        ws.write_string_with_format(0, c, &title, &header).map_err(xerr)?;
        ws.set_column_width(c, col.width).map_err(xerr)?;
        if !col.note.is_empty() {
            ws.insert_note(0, c, &Note::new(col.note).set_author("Kurogane").set_width(260)).map_err(xerr)?;
        }
        let dv = if let Some(choices) = col.choices {
            let labels: Vec<&str> = choices.iter().map(|(_, l)| *l).collect();
            Some(DataValidation::new().allow_list_strings(&labels).map_err(xerr)?)
        } else {
            // Names typed on another sheet: suggest them, but allow any value.
            col.list_from.map(|sheet| {
                let c = name_column(sheet);
                DataValidation::new()
                    .allow_list_formula(Formula::new(format!("='{sheet}'!${c}$2:${c}$2000")))
                    .set_error_style(rust_xlsxwriter::DataValidationErrorStyle::Information)
            })
        };
        if let Some(dv) = dv {
            ws.add_data_validation(1, c, 2000, c, &dv).map_err(xerr)?;
        }
    }
    let mut r = 1u32;
    if let Some(ex) = example {
        for (c, v) in ex.iter().enumerate() {
            ws.write_string_with_format(r, c as u16, *v, &ex_fmt).map_err(xerr)?;
        }
        r += 1;
    }
    for row in rows {
        for (c, v) in row.iter().enumerate() {
            if !v.is_empty() {
                ws.write_string(r, c as u16, v).map_err(xerr)?;
            }
        }
        r += 1;
    }
    ws.set_freeze_panes(1, 0).map_err(xerr)?;
    ws.autofilter(0, 0, r.max(1), def.cols.len() as u16 - 1).map_err(xerr)?;
    Ok(())
}

fn examples(sheet: &str) -> &'static [&'static str] {
    const E: &str = EXAMPLE_COMPANY;
    match sheet {
        S_COMPANIES => &[E, "Corporate", "Main office", "#4C8DFF", "Business hours", ""],
        S_NETWORKS => &[E, "Office LAN", "LAN", "192.168.10.0/24", "10", "192.168.10.1"],
        S_MACHINES => &[E, "vps-01", "VPS", "Linux", "", "vps-01.example.com", "22", "", "", "Hetzner", "Falkenstein", ""],
        S_CARDS => &[E, "vps-01", "eth0", "", "10.0.0.5", "10.0.0.1", "203.0.113.10", "", "Yes"],
        S_SERVICES => &[E, "vps-01", "website", "Docker", "wordpress:6", "HTTP", "Company website", ""],
        S_PORTS => &[E, "vps-01", "website", "80", "8080", "", "TCP", "Yes"],
        S_PROXIES => &[E, "vps-01", "nginx", "Nginx", "", ""],
        S_ROUTES => &[
            E,
            "vps-01",
            "nginx",
            "www.example.com",
            "/",
            "443",
            "HTTPS",
            "Let's Encrypt",
            "2027-01-31",
            "",
            "vps-01",
            "website",
            "",
            "",
            "HTTP",
        ],
        S_ACCOUNTS => &[
            E,
            "Service",
            "vps-01",
            "website",
            "Admin login",
            "WordPress admin",
            "admin",
            "change-me",
            "https://www.example.com/wp-admin",
            "",
            "",
            "",
        ],
        _ => &[],
    }
}

fn readme(wb: &mut Workbook, extra: &[String]) -> Result<()> {
    let ws = wb.add_worksheet();
    ws.set_name("Read me").map_err(xerr)?;
    ws.set_column_width(0, 120).map_err(xerr)?;
    let title = Format::new().set_bold().set_font_size(16).set_font_color(Color::RGB(0xE8590C));
    let warn = Format::new().set_bold().set_font_color(Color::RGB(0xC92A2A));
    for (i, line) in README.iter().map(|s| s.to_string()).chain(extra.iter().cloned()).enumerate() {
        let fmt = if i == 0 {
            Some(&title)
        } else if line.starts_with("SECURITY") {
            Some(&warn)
        } else {
            None
        };
        let r = i as u32;
        match fmt {
            Some(f) => ws.write_string_with_format(r, 0, &line, f).map_err(xerr)?,
            None => ws.write_string(r, 0, &line).map_err(xerr)?,
        };
    }
    Ok(())
}

/// Blank, fillable template with one example row per sheet.
pub fn template_xlsx() -> Result<Vec<u8>> {
    let mut wb = Workbook::new();
    readme(&mut wb, &[])?;
    for def in SHEETS {
        write_sheet(&mut wb, def, &[], Some(examples(def.name)))?;
    }
    wb.save_to_buffer().map_err(xerr)
}

fn opt(s: &Option<String>) -> String {
    s.clone().unwrap_or_default()
}
fn num<T: ToString>(v: Option<T>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}

/// Export the vault in the template layout. Passwords and keys are included
/// only when `field_key` is given.
pub fn export_xlsx(db: &Database, field_key: Option<&Key256>) -> Result<Vec<u8>> {
    let t = db.load_topology()?;
    let tenant = |id: &str| t.tenants.iter().find(|x| x.id == id).map(|x| x.name.clone()).unwrap_or_default();
    let host = |id: &str| t.hosts.iter().find(|x| x.id == id);
    let host_name = |id: &str| host(id).map(|h| h.name.clone()).unwrap_or_default();
    let service = |id: &str| t.services.iter().find(|x| x.id == id);
    let network_name =
        |id: &Option<String>| id.as_ref().and_then(|i| t.networks.iter().find(|n| &n.id == i)).map(|n| n.name.clone()).unwrap_or_default();
    let yes = |b: bool| if b { "Yes".to_string() } else { "No".to_string() };
    let mut sheets: HashMap<&str, Vec<Vec<String>>> = HashMap::new();

    for x in &t.tenants {
        sheets.entry(S_COMPANIES).or_default().push(vec![
            x.name.clone(),
            label(ENVIRONMENTS, &x.environment),
            opt(&x.environment_label),
            opt(&x.color),
            opt(&x.sla_notes),
            opt(&x.admin_notes),
        ]);
    }
    for n in &t.networks {
        sheets.entry(S_NETWORKS).or_default().push(vec![
            tenant(&n.tenant_id),
            n.name.clone(),
            label(NETWORK_KINDS, &n.kind),
            n.cidr.clone(),
            num(n.vlan_id),
            opt(&n.gateway),
        ]);
    }
    for h in &t.hosts {
        let company = tenant(&h.tenant_id);
        sheets.entry(S_MACHINES).or_default().push(vec![
            company.clone(),
            h.name.clone(),
            label(CATEGORIES, &h.category),
            h.os_family.as_deref().map(|o| label(OS_FAMILIES, o)).unwrap_or_default(),
            h.parent_host_id.as_deref().map(&host_name).unwrap_or_default(),
            opt(&h.fqdn),
            num(h.ssh_port),
            num(h.rdp_port),
            opt(&h.web_admin_url),
            opt(&h.provider),
            opt(&h.location),
            opt(&h.notes),
        ]);
        for n in &h.interfaces {
            sheets.entry(S_CARDS).or_default().push(vec![
                company.clone(),
                h.name.clone(),
                n.name.clone(),
                network_name(&n.network_id),
                opt(&n.internal_ip),
                opt(&n.gateway),
                opt(&n.public_ip),
                opt(&n.mac),
                yes(n.is_primary),
            ]);
        }
    }
    for s in &t.services {
        let Some(h) = host(&s.host_id) else { continue };
        let company = tenant(&h.tenant_id);
        sheets.entry(S_SERVICES).or_default().push(vec![
            company.clone(),
            h.name.clone(),
            s.name.clone(),
            label(RUNTIMES, &s.runtime),
            opt(&s.image),
            label(SCHEMES, &s.scheme),
            opt(&s.description),
            s.owner_tenant_id.as_deref().map(&tenant).filter(|o| o != &company).unwrap_or_default(),
        ]);
        for p in &s.ports {
            sheets.entry(S_PORTS).or_default().push(vec![
                company.clone(),
                h.name.clone(),
                s.name.clone(),
                p.container_port.to_string(),
                num(p.host_port),
                if p.bind_address == "0.0.0.0" { String::new() } else { p.bind_address.clone() },
                label(PROTOCOLS, &p.protocol),
                yes(p.is_primary),
            ]);
        }
    }
    for p in &t.proxies {
        let Some(h) = host(&p.host_id) else { continue };
        let company = tenant(&h.tenant_id);
        sheets.entry(S_PROXIES).or_default().push(vec![
            company.clone(),
            h.name.clone(),
            p.name.clone(),
            label(PROXY_KINDS, &p.kind),
            p.service_id.as_deref().and_then(service).map(|s| s.name.clone()).unwrap_or_default(),
            opt(&p.admin_url),
        ]);
        for r in &p.routes {
            let th = r.target_host_id.as_deref().and_then(host);
            let tcompany = th.map(|x| tenant(&x.tenant_id)).filter(|c| c != &company).unwrap_or_default();
            sheets.entry(S_ROUTES).or_default().push(vec![
                company.clone(),
                h.name.clone(),
                p.name.clone(),
                r.domain.clone(),
                r.path_prefix.clone(),
                r.inbound_port.to_string(),
                label(INBOUND, &r.inbound_protocol),
                label(TLS_MODES, &r.tls_mode),
                r.tls_expires_at.as_deref().map(|d| d.chars().take(10).collect()).unwrap_or_default(),
                tcompany,
                th.map(|x| x.name.clone()).unwrap_or_default(),
                r.service_id.as_deref().and_then(service).map(|s| s.name.clone()).unwrap_or_default(),
                r.target_ip.clone(),
                r.target_port.to_string(),
                label(TARGET_SCHEMES, &r.target_scheme),
            ]);
        }
    }
    for c in &t.credentials {
        let (company, owner_type, machine, sub) = match c.owner.kind {
            OwnerKind::Tenant => (tenant(&c.owner.id), "Company", String::new(), String::new()),
            OwnerKind::Host => {
                let h = host(&c.owner.id);
                (
                    h.map(|h| tenant(&h.tenant_id)).unwrap_or_default(),
                    "Machine",
                    h.map(|h| h.name.clone()).unwrap_or_default(),
                    String::new(),
                )
            }
            OwnerKind::Service => {
                let s = service(&c.owner.id);
                let h = s.and_then(|s| host(&s.host_id));
                (
                    h.map(|h| tenant(&h.tenant_id)).unwrap_or_default(),
                    "Service",
                    h.map(|h| h.name.clone()).unwrap_or_default(),
                    s.map(|s| s.name.clone()).unwrap_or_default(),
                )
            }
            OwnerKind::Proxy => {
                let p = t.proxies.iter().find(|p| p.id == c.owner.id);
                let h = p.and_then(|p| host(&p.host_id));
                (
                    h.map(|h| tenant(&h.tenant_id)).unwrap_or_default(),
                    "Proxy",
                    h.map(|h| h.name.clone()).unwrap_or_default(),
                    p.map(|p| p.name.clone()).unwrap_or_default(),
                )
            }
        };
        let secret = |f: SecretField, has: bool| -> Result<String> {
            match (field_key, has) {
                (Some(k), true) => Ok(db.credential_secret(k, &c.id, f)?.to_string()),
                _ => Ok(String::new()),
            }
        };
        sheets.entry(S_ACCOUNTS).or_default().push(vec![
            company,
            owner_type.to_string(),
            machine,
            sub,
            label(CREDENTIAL_KINDS, &c.kind),
            c.label.clone(),
            opt(&c.username),
            secret(SecretField::Secret, c.has_secret)?,
            opt(&c.url),
            secret(SecretField::Notes, c.has_notes)?,
            secret(SecretField::PrivateKey, c.has_private_key)?,
            opt(&c.public_key),
        ]);
    }

    let mut wb = Workbook::new();
    let note = if field_key.is_some() {
        "SECURITY: this export CONTAINS PASSWORDS AND KEYS in clear text. Store it encrypted or delete it."
    } else {
        "This export does not contain passwords or keys (re-importing keeps the passwords already stored)."
    };
    readme(&mut wb, &[String::new(), format!("Exported from \"{}\".", t.vault_name), note.to_string()])?;
    for def in SHEETS {
        write_sheet(&mut wb, def, sheets.get(def.name).map(|v| v.as_slice()).unwrap_or(&[]), None)?;
    }
    wb.save_to_buffer().map_err(xerr)
}

// -------------------------------------------------------------------- read

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub companies: u32,
    pub networks: u32,
    pub machines: u32,
    pub cards: u32,
    pub services: u32,
    pub ports: u32,
    pub proxies: u32,
    pub routes: u32,
    pub accounts: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowIssue {
    pub sheet: String,
    pub row: u32,
    pub message: String,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub created: Counts,
    pub updated: Counts,
    pub errors: Vec<RowIssue>,
    pub warnings: Vec<RowIssue>,
    /// True if the changes were written (only when there were no errors).
    pub applied: bool,
}

struct Row {
    n: u32,
    cells: HashMap<String, String>,
}

impl Row {
    fn get(&self, h: &str) -> Option<&str> {
        self.cells.get(&norm(h)).map(|s| s.as_str()).filter(|s| !s.is_empty())
    }
}

/// `YYYY-MM-DD` for a Unix timestamp in milliseconds (used in file names).
pub fn date_from_unix_ms(ms: i64) -> String {
    serial_to_date((ms.div_euclid(86_400_000) + 25569) as f64)
}

/// Excel serial date → YYYY-MM-DD (days since 1899-12-30).
fn serial_to_date(serial: f64) -> String {
    let days = serial.floor() as i64 - 25569; // → days since 1970-01-01
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

fn cell(d: &Data) -> String {
    match d {
        Data::Empty | Data::Error(_) => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) if f.fract() == 0.0 => format!("{}", *f as i64),
        Data::Float(f) => f.to_string(),
        Data::Bool(b) => if *b { "Yes" } else { "No" }.to_string(),
        Data::DateTime(dt) => serial_to_date(dt.as_f64()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.chars().take(10).collect(),
    }
}

fn read_sheet(wb: &mut Xlsx<Cursor<&[u8]>>, name: &str) -> Vec<Row> {
    let Ok(range) = wb.worksheet_range(name) else { return Vec::new() };
    let mut rows = range.rows();
    let Some(header) = rows.next() else { return Vec::new() };
    let headers: Vec<String> = header.iter().map(|h| norm(&cell(h))).collect();
    let start = range.start().map(|(r, _)| r).unwrap_or(0);
    rows.enumerate()
        .filter_map(|(i, r)| {
            let cells: HashMap<String, String> = headers.iter().cloned().zip(r.iter().map(cell)).collect();
            if cells.values().all(|v| v.is_empty()) || cells.get("company").map(|c| c == EXAMPLE_COMPANY).unwrap_or(false) {
                return None;
            }
            Some(Row { n: start + i as u32 + 2, cells })
        })
        .collect()
}

fn eqi(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// In-memory copy of the vault the import is applied to.
struct Model {
    t: Topology,
    dirty: std::collections::HashSet<String>,
    creds: Vec<CredentialInput>,
    report: ImportReport,
}

impl Model {
    fn err(&mut self, sheet: &str, row: u32, msg: impl Into<String>) {
        self.report.errors.push(RowIssue { sheet: sheet.into(), row, message: msg.into() });
    }
    fn tenant_id(&self, name: &str) -> Option<String> {
        self.t.tenants.iter().find(|t| eqi(&t.name, name)).map(|t| t.id.clone())
    }
    fn host_idx(&self, tenant: &str, name: &str) -> Option<usize> {
        self.t.hosts.iter().position(|h| h.tenant_id == tenant && eqi(&h.name, name))
    }
    fn service_idx(&self, host: &str, name: &str) -> Option<usize> {
        self.t.services.iter().position(|s| s.host_id == host && eqi(&s.name, name))
    }
    fn proxy_idx(&self, host: &str, name: &str) -> Option<usize> {
        self.t.proxies.iter().position(|p| p.host_id == host && eqi(&p.name, name))
    }
    /// Resolve Company + Machine columns; records an error and returns None on failure.
    fn company_machine(&mut self, sheet: &str, r: &Row, machine_col: &str) -> Option<(String, usize)> {
        let company = r.get("Company")?.to_string();
        let Some(tid) = self.tenant_id(&company) else {
            self.err(sheet, r.n, format!("Unknown company \"{company}\" (add it to the Companies sheet)"));
            return None;
        };
        let Some(machine) = r.get(machine_col) else {
            self.err(sheet, r.n, format!("{machine_col} is required"));
            return None;
        };
        match self.host_idx(&tid, machine) {
            Some(i) => Some((tid, i)),
            None => {
                self.err(sheet, r.n, format!("Unknown machine \"{machine}\" in {company}"));
                None
            }
        }
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn set_opt(target: &mut Option<String>, v: Option<&str>) {
    if let Some(v) = v {
        *target = Some(v.to_string());
    }
}

fn parse_port(m: &mut Model, sheet: &str, r: &Row, col: &str) -> Option<Option<u16>> {
    match r.get(col) {
        None => Some(None),
        Some(v) => match v.parse::<u16>() {
            Ok(p) if p > 0 => Some(Some(p)),
            _ => {
                m.err(sheet, r.n, format!("{col} \"{v}\" must be a number between 1 and 65535"));
                None
            }
        },
    }
}

fn parse_choice(m: &mut Model, sheet: &str, r: &Row, col: &str, list: Choices) -> Option<Option<&'static str>> {
    match r.get(col) {
        None => Some(None),
        Some(v) => match choice(list, v) {
            Some(c) => Some(Some(c)),
            None => {
                let allowed: Vec<&str> = list.iter().map(|(_, l)| *l).collect();
                m.err(sheet, r.n, format!("{col} \"{v}\" is not one of: {}", allowed.join(", ")));
                None
            }
        },
    }
}

fn require(m: &mut Model, sheet: &str, r: &Row, col: &str) -> Option<String> {
    match r.get(col) {
        Some(v) => Some(v.to_string()),
        None => {
            m.err(sheet, r.n, format!("{col} is required"));
            None
        }
    }
}

/// Parse a workbook, merge it into the vault's current data and — if
/// `apply` and there are no errors — write the changes.
pub fn import_xlsx(db: &Database, field_key: &Key256, bytes: &[u8], apply: bool) -> Result<ImportReport> {
    let mut wb: Xlsx<_> = open_workbook_from_rs(Cursor::new(bytes)).map_err(|e| Error::invalid(format!("Not a valid .xlsx file: {e}")))?;
    let known: Vec<&str> = SHEETS.iter().map(|s| s.name).collect();
    if !wb.sheet_names().iter().any(|n| known.contains(&n.as_str())) {
        return Err(Error::invalid("This workbook has none of the expected sheets. Start from the downloadable template."));
    }
    let mut m = Model { t: db.load_topology()?, dirty: Default::default(), creds: Vec::new(), report: ImportReport::default() };

    // Companies
    for r in read_sheet(&mut wb, S_COMPANIES) {
        let Some(name) = require(&mut m, S_COMPANIES, &r, "Company") else { continue };
        let Some(env) = parse_choice(&mut m, S_COMPANIES, &r, "Type", ENVIRONMENTS) else { continue };
        let existing = m.t.tenants.iter().position(|t| eqi(&t.name, &name));
        let idx = match existing {
            Some(i) => {
                m.report.updated.companies += 1;
                i
            }
            None => {
                let Some(env) = env else {
                    m.err(S_COMPANIES, r.n, "Type is required");
                    continue;
                };
                m.t.tenants.push(Tenant { id: new_id(), name: name.clone(), environment: env.into(), ..Default::default() });
                m.report.created.companies += 1;
                m.t.tenants.len() - 1
            }
        };
        let t = &mut m.t.tenants[idx];
        if let Some(e) = env {
            t.environment = e.into();
        }
        set_opt(&mut t.environment_label, r.get("Label"));
        set_opt(&mut t.color, r.get("Color"));
        set_opt(&mut t.sla_notes, r.get("SLA notes"));
        set_opt(&mut t.admin_notes, r.get("Admin notes"));
        m.dirty.insert(t.id.clone());
    }

    // Networks
    for r in read_sheet(&mut wb, S_NETWORKS) {
        let Some(company) = require(&mut m, S_NETWORKS, &r, "Company") else { continue };
        let Some(tid) = m.tenant_id(&company) else {
            m.err(S_NETWORKS, r.n, format!("Unknown company \"{company}\""));
            continue;
        };
        let Some(name) = require(&mut m, S_NETWORKS, &r, "Network") else { continue };
        let Some(kind) = parse_choice(&mut m, S_NETWORKS, &r, "Kind", NETWORK_KINDS) else { continue };
        let vlan = r.get("VLAN").and_then(|v| v.parse::<u16>().ok());
        let idx = match m.t.networks.iter().position(|n| n.tenant_id == tid && eqi(&n.name, &name)) {
            Some(i) => {
                m.report.updated.networks += 1;
                i
            }
            None => {
                let Some(cidr) = require(&mut m, S_NETWORKS, &r, "CIDR") else { continue };
                m.t.networks.push(Network {
                    id: new_id(),
                    tenant_id: tid.clone(),
                    name: name.clone(),
                    kind: "lan".into(),
                    cidr,
                    ..Default::default()
                });
                m.report.created.networks += 1;
                m.t.networks.len() - 1
            }
        };
        let n = &mut m.t.networks[idx];
        if let Some(k) = kind {
            n.kind = k.into();
        }
        if let Some(c) = r.get("CIDR") {
            n.cidr = c.into();
        }
        if vlan.is_some() {
            n.vlan_id = vlan;
        }
        set_opt(&mut n.gateway, r.get("Gateway"));
        m.dirty.insert(n.id.clone());
    }

    // Machines (parents resolved after all machines exist)
    let mut parents: Vec<(usize, String, u32)> = Vec::new();
    for r in read_sheet(&mut wb, S_MACHINES) {
        let Some(company) = require(&mut m, S_MACHINES, &r, "Company") else { continue };
        let Some(tid) = m.tenant_id(&company) else {
            m.err(S_MACHINES, r.n, format!("Unknown company \"{company}\""));
            continue;
        };
        let Some(name) = require(&mut m, S_MACHINES, &r, "Machine") else { continue };
        let Some(cat) = parse_choice(&mut m, S_MACHINES, &r, "Category", CATEGORIES) else { continue };
        let Some(os) = parse_choice(&mut m, S_MACHINES, &r, "OS", OS_FAMILIES) else { continue };
        let Some(ssh) = parse_port(&mut m, S_MACHINES, &r, "SSH port") else { continue };
        let Some(rdp) = parse_port(&mut m, S_MACHINES, &r, "RDP port") else { continue };
        let idx = match m.host_idx(&tid, &name) {
            Some(i) => {
                m.report.updated.machines += 1;
                i
            }
            None => {
                let Some(cat) = cat else {
                    m.err(S_MACHINES, r.n, "Category is required");
                    continue;
                };
                m.t.hosts.push(Host {
                    id: new_id(),
                    tenant_id: tid.clone(),
                    name: name.clone(),
                    category: cat.into(),
                    ..Default::default()
                });
                m.report.created.machines += 1;
                m.t.hosts.len() - 1
            }
        };
        let h = &mut m.t.hosts[idx];
        if let Some(c) = cat {
            h.category = c.into();
        }
        if let Some(o) = os {
            h.os_family = Some(o.into());
        }
        if ssh.is_some() {
            h.ssh_port = ssh;
        }
        if rdp.is_some() {
            h.rdp_port = rdp;
        }
        set_opt(&mut h.fqdn, r.get("FQDN"));
        set_opt(&mut h.web_admin_url, r.get("Web admin URL"));
        set_opt(&mut h.provider, r.get("Provider"));
        set_opt(&mut h.location, r.get("Location"));
        set_opt(&mut h.notes, r.get("Notes"));
        m.dirty.insert(h.id.clone());
        if let Some(p) = r.get("Runs on") {
            parents.push((idx, p.to_string(), r.n));
        }
    }
    for (idx, parent, row) in parents {
        let tid = m.t.hosts[idx].tenant_id.clone();
        match m.host_idx(&tid, &parent) {
            Some(p) if p != idx => {
                let pid = m.t.hosts[p].id.clone();
                m.t.hosts[idx].parent_host_id = Some(pid);
            }
            _ => m.err(S_MACHINES, row, format!("\"Runs on\" machine \"{parent}\" not found in the same company")),
        }
    }

    // Network cards
    for r in read_sheet(&mut wb, S_CARDS) {
        let Some((tid, hi)) = m.company_machine(S_CARDS, &r, "Machine") else { continue };
        let Some(card) = require(&mut m, S_CARDS, &r, "Card") else { continue };
        let net = match r.get("Network") {
            None => None,
            Some(n) => match m.t.networks.iter().find(|x| x.tenant_id == tid && eqi(&x.name, n)) {
                Some(x) => Some(x.id.clone()),
                None => {
                    m.err(S_CARDS, r.n, format!("Unknown network \"{n}\""));
                    continue;
                }
            },
        };
        let primary = r.get("Primary").map(|v| choice(YES_NO, v) == Some("yes"));
        let h = &mut m.t.hosts[hi];
        let ci = match h.interfaces.iter().position(|n| eqi(&n.name, &card)) {
            Some(i) => {
                m.report.updated.cards += 1;
                i
            }
            None => {
                h.interfaces.push(NetworkInterface {
                    id: new_id(),
                    host_id: h.id.clone(),
                    name: card.clone(),
                    is_primary: h.interfaces.is_empty(),
                    ..Default::default()
                });
                m.report.created.cards += 1;
                h.interfaces.len() - 1
            }
        };
        if primary == Some(true) {
            h.interfaces.iter_mut().for_each(|n| n.is_primary = false);
        }
        let n = &mut h.interfaces[ci];
        if let Some(p) = primary {
            n.is_primary = p;
        }
        if net.is_some() {
            n.network_id = net;
        }
        set_opt(&mut n.internal_ip, r.get("Private IP"));
        set_opt(&mut n.gateway, r.get("Gateway"));
        set_opt(&mut n.public_ip, r.get("Public IP"));
        set_opt(&mut n.mac, r.get("MAC"));
        m.dirty.insert(h.id.clone());
    }

    // Services
    for r in read_sheet(&mut wb, S_SERVICES) {
        let Some((_, hi)) = m.company_machine(S_SERVICES, &r, "Machine") else { continue };
        let Some(name) = require(&mut m, S_SERVICES, &r, "Service") else { continue };
        let Some(rt) = parse_choice(&mut m, S_SERVICES, &r, "Runtime", RUNTIMES) else { continue };
        let Some(scheme) = parse_choice(&mut m, S_SERVICES, &r, "Scheme", SCHEMES) else { continue };
        let owner = match r.get("Owner company") {
            None => None,
            Some(o) => match m.tenant_id(o) {
                Some(id) => Some(id),
                None => {
                    m.err(S_SERVICES, r.n, format!("Unknown owner company \"{o}\""));
                    continue;
                }
            },
        };
        let hid = m.t.hosts[hi].id.clone();
        let si = match m.service_idx(&hid, &name) {
            Some(i) => {
                m.report.updated.services += 1;
                i
            }
            None => {
                let Some(rt) = rt else {
                    m.err(S_SERVICES, r.n, "Runtime is required");
                    continue;
                };
                m.t.services.push(Service {
                    id: new_id(),
                    host_id: hid,
                    name: name.clone(),
                    runtime: rt.into(),
                    scheme: "http".into(),
                    ..Default::default()
                });
                m.report.created.services += 1;
                m.t.services.len() - 1
            }
        };
        let s = &mut m.t.services[si];
        if let Some(v) = rt {
            s.runtime = v.into();
        }
        if let Some(v) = scheme {
            s.scheme = v.into();
        }
        set_opt(&mut s.image, r.get("Image"));
        set_opt(&mut s.description, r.get("Description"));
        if owner.is_some() {
            s.owner_tenant_id = owner;
        }
        m.dirty.insert(s.id.clone());
    }

    // Ports
    for r in read_sheet(&mut wb, S_PORTS) {
        let Some((_, hi)) = m.company_machine(S_PORTS, &r, "Machine") else { continue };
        let Some(svc) = require(&mut m, S_PORTS, &r, "Service") else { continue };
        let hid = m.t.hosts[hi].id.clone();
        let Some(si) = m.service_idx(&hid, &svc) else {
            m.err(S_PORTS, r.n, format!("Unknown service \"{svc}\" on that machine"));
            continue;
        };
        let Some(Some(internal)) = parse_port(&mut m, S_PORTS, &r, "Internal port") else {
            if r.get("Internal port").is_none() {
                m.err(S_PORTS, r.n, "Internal port is required");
            }
            continue;
        };
        let Some(published) = parse_port(&mut m, S_PORTS, &r, "Published port") else { continue };
        let Some(proto) = parse_choice(&mut m, S_PORTS, &r, "Protocol", PROTOCOLS) else { continue };
        let proto = proto.unwrap_or("tcp");
        let primary = r.get("Primary").map(|v| choice(YES_NO, v) == Some("yes"));
        let s = &mut m.t.services[si];
        let pi = match s.ports.iter().position(|p| p.container_port == internal && p.protocol == proto) {
            Some(i) => {
                m.report.updated.ports += 1;
                i
            }
            None => {
                s.ports.push(ServicePort {
                    id: new_id(),
                    service_id: s.id.clone(),
                    container_port: internal,
                    protocol: proto.into(),
                    bind_address: "0.0.0.0".into(),
                    is_primary: s.ports.is_empty(),
                    ..Default::default()
                });
                m.report.created.ports += 1;
                s.ports.len() - 1
            }
        };
        if primary == Some(true) {
            s.ports.iter_mut().for_each(|p| p.is_primary = false);
        }
        let p = &mut s.ports[pi];
        if published.is_some() {
            p.host_port = published;
        }
        if let Some(b) = r.get("Bind address") {
            p.bind_address = b.into();
        }
        if let Some(v) = primary {
            p.is_primary = v;
        }
        m.dirty.insert(s.id.clone());
    }

    // Proxies
    for r in read_sheet(&mut wb, S_PROXIES) {
        let Some((_, hi)) = m.company_machine(S_PROXIES, &r, "Machine") else { continue };
        let Some(name) = require(&mut m, S_PROXIES, &r, "Proxy") else { continue };
        let Some(kind) = parse_choice(&mut m, S_PROXIES, &r, "Kind", PROXY_KINDS) else { continue };
        let hid = m.t.hosts[hi].id.clone();
        let svc = match r.get("Runs as service") {
            None => None,
            Some(s) => match m.service_idx(&hid, s) {
                Some(i) => Some(m.t.services[i].id.clone()),
                None => {
                    m.err(S_PROXIES, r.n, format!("Unknown service \"{s}\" on that machine"));
                    continue;
                }
            },
        };
        let pi = match m.proxy_idx(&hid, &name) {
            Some(i) => {
                m.report.updated.proxies += 1;
                i
            }
            None => {
                let Some(kind) = kind else {
                    m.err(S_PROXIES, r.n, "Kind is required");
                    continue;
                };
                m.t.proxies.push(ReverseProxy { id: new_id(), host_id: hid, name: name.clone(), kind: kind.into(), ..Default::default() });
                m.report.created.proxies += 1;
                m.t.proxies.len() - 1
            }
        };
        let p = &mut m.t.proxies[pi];
        if let Some(k) = kind {
            p.kind = k.into();
        }
        if svc.is_some() {
            p.service_id = svc;
        }
        set_opt(&mut p.admin_url, r.get("Admin URL"));
        m.dirty.insert(p.id.clone());
    }

    // Routes
    for r in read_sheet(&mut wb, S_ROUTES) {
        let Some((tid, hi)) = m.company_machine(S_ROUTES, &r, "Proxy machine") else { continue };
        let Some(pname) = require(&mut m, S_ROUTES, &r, "Proxy") else { continue };
        let hid = m.t.hosts[hi].id.clone();
        let Some(pi) = m.proxy_idx(&hid, &pname) else {
            m.err(S_ROUTES, r.n, format!("Unknown proxy \"{pname}\" on that machine"));
            continue;
        };
        let Some(domain) = require(&mut m, S_ROUTES, &r, "Domain") else { continue };
        let path = r.get("Path").unwrap_or("/").to_string();
        let Some(inport) = parse_port(&mut m, S_ROUTES, &r, "Inbound port") else { continue };
        let inport = inport.unwrap_or(443);
        let Some(inproto) = parse_choice(&mut m, S_ROUTES, &r, "Inbound protocol", INBOUND) else { continue };
        let inproto = inproto.unwrap_or(if inport == 80 { "http" } else { "https" });
        let Some(tls) = parse_choice(&mut m, S_ROUTES, &r, "TLS", TLS_MODES) else { continue };
        let tls = tls.unwrap_or(if inproto == "https" { "letsencrypt" } else { "none" });
        let expires = match r.get("TLS expires") {
            None => None,
            Some(d) if d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-' => Some(format!("{d}T00:00:00Z")),
            Some(d) => {
                m.err(S_ROUTES, r.n, format!("TLS expires \"{d}\" must be a date like 2027-01-31"));
                continue;
            }
        };
        // Target resolution: company → machine → service, with smart defaults.
        let ttid = match r.get("Target company") {
            None => tid.clone(),
            Some(c) => match m.tenant_id(c) {
                Some(t) => t,
                None => {
                    m.err(S_ROUTES, r.n, format!("Unknown target company \"{c}\""));
                    continue;
                }
            },
        };
        let mut thi = match r.get("Target machine") {
            None => None,
            Some(name) => match m.host_idx(&ttid, name) {
                Some(i) => Some(i),
                None => {
                    m.err(S_ROUTES, r.n, format!("Unknown target machine \"{name}\""));
                    continue;
                }
            },
        };
        let mut tsi = None;
        if let Some(sname) = r.get("Target service") {
            let candidates: Vec<usize> =
                m.t.services
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| eqi(&s.name, sname))
                    .filter(|(_, s)| match thi {
                        Some(h) => s.host_id == m.t.hosts[h].id,
                        None => m.t.hosts.iter().any(|h| h.id == s.host_id && h.tenant_id == ttid),
                    })
                    .map(|(i, _)| i)
                    .collect();
            match candidates.as_slice() {
                [one] => {
                    tsi = Some(*one);
                    if thi.is_none() {
                        thi = m.t.hosts.iter().position(|h| h.id == m.t.services[*one].host_id);
                    }
                }
                [] => {
                    m.err(S_ROUTES, r.n, format!("Unknown target service \"{sname}\""));
                    continue;
                }
                _ => {
                    m.err(S_ROUTES, r.n, format!("Several services are named \"{sname}\"; set Target machine"));
                    continue;
                }
            }
        }
        let svc = tsi.map(|i| m.t.services[i].clone());
        let th = thi.map(|i| m.t.hosts[i].clone());
        let default_ip = th
            .as_ref()
            .and_then(|h| h.interfaces.iter().find(|n| n.is_primary).or(h.interfaces.first()))
            .and_then(|n| n.internal_ip.clone());
        let default_port = svc
            .as_ref()
            .and_then(|s| s.ports.iter().find(|p| p.is_primary).or(s.ports.first()))
            .map(|p| p.host_port.unwrap_or(p.container_port));
        let Some(tport) = parse_port(&mut m, S_ROUTES, &r, "Target port") else { continue };
        let Some(tport) = tport.or(default_port) else {
            m.err(S_ROUTES, r.n, "Target port is required (or set a Target service that has a port)");
            continue;
        };
        let Some(tip) = r.get("Target IP").map(str::to_string).or(default_ip) else {
            m.err(S_ROUTES, r.n, "Target IP is required (or set a Target machine that has a private IP)");
            continue;
        };
        let Some(tscheme) = parse_choice(&mut m, S_ROUTES, &r, "Target scheme", TARGET_SCHEMES) else { continue };
        let tscheme = tscheme.unwrap_or_else(|| if svc.as_ref().map(|s| s.scheme.as_str()) == Some("https") { "https" } else { "http" });
        let p = &mut m.t.proxies[pi];
        let route = ProxyRoute {
            id: String::new(),
            proxy_id: p.id.clone(),
            domain: domain.to_ascii_lowercase(),
            path_prefix: path,
            inbound_port: inport,
            inbound_protocol: inproto.into(),
            tls_mode: tls.into(),
            tls_expires_at: expires,
            target_host_id: th.map(|h| h.id),
            target_ip: tip,
            target_port: tport,
            target_scheme: tscheme.into(),
            service_id: svc.map(|s| s.id),
            enabled: true,
        };
        match p
            .routes
            .iter()
            .position(|x| eqi(&x.domain, &route.domain) && x.path_prefix == route.path_prefix && x.inbound_port == route.inbound_port)
        {
            Some(i) => {
                let id = p.routes[i].id.clone();
                p.routes[i] = ProxyRoute { id, ..route };
                m.report.updated.routes += 1;
            }
            None => {
                p.routes.push(ProxyRoute { id: new_id(), ..route });
                m.report.created.routes += 1;
            }
        }
        m.dirty.insert(p.id.clone());
    }

    // Accounts
    for r in read_sheet(&mut wb, S_ACCOUNTS) {
        let Some(company) = require(&mut m, S_ACCOUNTS, &r, "Company") else { continue };
        let Some(tid) = m.tenant_id(&company) else {
            m.err(S_ACCOUNTS, r.n, format!("Unknown company \"{company}\""));
            continue;
        };
        let Some(Some(owner_type)) = parse_choice(&mut m, S_ACCOUNTS, &r, "Belongs to", OWNER_TYPES) else {
            if r.get("Belongs to").is_none() {
                m.err(S_ACCOUNTS, r.n, "Belongs to is required");
            }
            continue;
        };
        let owner = match owner_type {
            "tenant" => CredentialOwner { kind: OwnerKind::Tenant, id: tid.clone() },
            _ => {
                let Some((_, hi)) = m.company_machine(S_ACCOUNTS, &r, "Machine") else { continue };
                let hid = m.t.hosts[hi].id.clone();
                match owner_type {
                    "host" => CredentialOwner { kind: OwnerKind::Host, id: hid },
                    "service" => {
                        let Some(s) = require(&mut m, S_ACCOUNTS, &r, "Service or proxy") else { continue };
                        match m.service_idx(&hid, &s) {
                            Some(i) => CredentialOwner { kind: OwnerKind::Service, id: m.t.services[i].id.clone() },
                            None => {
                                m.err(S_ACCOUNTS, r.n, format!("Unknown service \"{s}\" on that machine"));
                                continue;
                            }
                        }
                    }
                    _ => {
                        let Some(p) = require(&mut m, S_ACCOUNTS, &r, "Service or proxy") else { continue };
                        match m.proxy_idx(&hid, &p) {
                            Some(i) => CredentialOwner { kind: OwnerKind::Proxy, id: m.t.proxies[i].id.clone() },
                            None => {
                                m.err(S_ACCOUNTS, r.n, format!("Unknown proxy \"{p}\" on that machine"));
                                continue;
                            }
                        }
                    }
                }
            }
        };
        let Some(kind) = parse_choice(&mut m, S_ACCOUNTS, &r, "Account type", CREDENTIAL_KINDS) else { continue };
        let Some(lbl) = require(&mut m, S_ACCOUNTS, &r, "Label") else { continue };
        let existing = m.t.credentials.iter().find(|c| c.owner == owner && eqi(&c.label, &lbl)).cloned();
        let set = |v: Option<&str>| v.map(|s| SecretUpdate::Set(Zeroizing::new(s.to_string()))).unwrap_or_default();
        let kind = match (kind, &existing) {
            (Some(k), _) => k.to_string(),
            (None, Some(e)) => e.kind.clone(),
            (None, None) => {
                m.err(S_ACCOUNTS, r.n, "Account type is required");
                continue;
            }
        };
        if kind == "ssh_key" && r.get("SSH private key").is_none() && !existing.as_ref().is_some_and(|e| e.has_private_key) {
            m.err(S_ACCOUNTS, r.n, "SSH key accounts need the SSH private key column");
            continue;
        }
        let pick = |v: Option<&str>, old: Option<&String>| v.map(str::to_string).or_else(|| old.cloned());
        let input = CredentialInput {
            id: existing.as_ref().map(|e| e.id.clone()),
            owner,
            kind,
            label: lbl,
            username: pick(r.get("Username"), existing.as_ref().and_then(|e| e.username.as_ref())),
            url: pick(r.get("URL"), existing.as_ref().and_then(|e| e.url.as_ref())),
            public_key: pick(r.get("Public key"), existing.as_ref().and_then(|e| e.public_key.as_ref())),
            expires_at: existing.as_ref().and_then(|e| e.expires_at.clone()),
            secret: set(r.get("Password")),
            private_key: set(r.get("SSH private key")),
            notes: set(r.get("Notes")),
        };
        if existing.is_some() {
            m.report.updated.accounts += 1;
        } else {
            m.report.created.accounts += 1;
        }
        m.creds.push(input);
    }

    if apply && m.report.errors.is_empty() {
        write_model(db, field_key, &m)?;
        m.report.applied = true;
    }
    Ok(m.report)
}

fn write_model(db: &Database, field_key: &Key256, m: &Model) -> Result<()> {
    for t in m.t.tenants.iter().filter(|t| m.dirty.contains(&t.id)) {
        db.save_tenant(t)?;
    }
    for n in m.t.networks.iter().filter(|n| m.dirty.contains(&n.id)) {
        db.save_network(n)?;
    }
    // Parents before children (VM → hypervisor).
    let mut pending: Vec<&Host> = m.t.hosts.iter().filter(|h| m.dirty.contains(&h.id)).collect();
    let mut saved: std::collections::HashSet<String> =
        m.t.hosts.iter().filter(|h| !m.dirty.contains(&h.id)).map(|h| h.id.clone()).collect();
    while !pending.is_empty() {
        let before = pending.len();
        let mut rest = Vec::new();
        for h in pending {
            if h.parent_host_id.as_ref().is_none_or(|p| saved.contains(p)) {
                db.save_host(h)?;
                saved.insert(h.id.clone());
            } else {
                rest.push(h);
            }
        }
        if rest.len() == before {
            return Err(Error::invalid("Circular \"Runs on\" between machines"));
        }
        pending = rest;
    }
    for s in m.t.services.iter().filter(|s| m.dirty.contains(&s.id)) {
        db.save_service(s)?;
    }
    for p in m.t.proxies.iter().filter(|p| m.dirty.contains(&p.id)) {
        db.save_proxy(p)?;
    }
    for c in &m.creds {
        db.save_credential(field_key, c)?;
    }
    Ok(())
}

// --------------------------------------------------------------------- JSON

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JsonSecrets {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonExport {
    pub format: String,
    pub exported_at_ms: i64,
    pub topology: Topology,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<BTreeMap<String, JsonSecrets>>,
}

pub const JSON_FORMAT: &str = "kurogane-export/1";

pub fn export_json(db: &Database, field_key: Option<&Key256>) -> Result<Vec<u8>> {
    let topology = db.load_topology()?;
    let secrets = match field_key {
        None => None,
        Some(k) => {
            let mut map = BTreeMap::new();
            for c in &topology.credentials {
                let get = |f, has: bool| -> Result<Option<String>> {
                    if has {
                        Ok(Some(db.credential_secret(k, &c.id, f)?.to_string()))
                    } else {
                        Ok(None)
                    }
                };
                map.insert(
                    c.id.clone(),
                    JsonSecrets {
                        secret: get(SecretField::Secret, c.has_secret)?,
                        private_key: get(SecretField::PrivateKey, c.has_private_key)?,
                        notes: get(SecretField::Notes, c.has_notes)?,
                    },
                );
            }
            Some(map)
        }
    };
    let doc = JsonExport { format: JSON_FORMAT.into(), exported_at_ms: crate::vault::now_ms(), topology, secrets };
    Ok(serde_json::to_vec_pretty(&doc)?)
}

/// Upsert everything in a JSON export by id. Secrets missing from the file
/// keep their stored values. With `apply = false` only the counts are computed.
pub fn import_json(db: &Database, field_key: &Key256, bytes: &[u8], apply: bool) -> Result<ImportReport> {
    let doc: JsonExport = serde_json::from_slice(bytes).map_err(|e| Error::invalid(format!("Not a Kurogane JSON export: {e}")))?;
    if doc.format != JSON_FORMAT {
        return Err(Error::invalid(format!("Unsupported export format \"{}\"", doc.format)));
    }
    let current = db.load_topology()?;
    let exists = |list: &[String], id: &str| list.iter().any(|x| x == id);
    let ids = |v: Vec<String>| v;
    let (tids, nids, hids, sids, pids, cids) = (
        ids(current.tenants.iter().map(|x| x.id.clone()).collect()),
        ids(current.networks.iter().map(|x| x.id.clone()).collect()),
        ids(current.hosts.iter().map(|x| x.id.clone()).collect()),
        ids(current.services.iter().map(|x| x.id.clone()).collect()),
        ids(current.proxies.iter().map(|x| x.id.clone()).collect()),
        ids(current.credentials.iter().map(|x| x.id.clone()).collect()),
    );
    let mut rep = ImportReport::default();
    let t = &doc.topology;
    for x in &t.tenants {
        if apply {
            db.save_tenant(x)?;
        }
        if exists(&tids, &x.id) {
            rep.updated.companies += 1
        } else {
            rep.created.companies += 1
        }
    }
    for x in &t.networks {
        if apply {
            db.save_network(x)?;
        }
        if exists(&nids, &x.id) {
            rep.updated.networks += 1
        } else {
            rep.created.networks += 1
        }
    }
    let mut hosts: Vec<&Host> = t.hosts.iter().collect();
    hosts.sort_by_key(|h| h.parent_host_id.is_some());
    for x in hosts {
        if apply {
            db.save_host(x)?;
        }
        if exists(&hids, &x.id) {
            rep.updated.machines += 1
        } else {
            rep.created.machines += 1
        }
    }
    for x in &t.services {
        if apply {
            db.save_service(x)?;
        }
        if exists(&sids, &x.id) {
            rep.updated.services += 1
        } else {
            rep.created.services += 1
        }
    }
    for x in &t.proxies {
        if apply {
            db.save_proxy(x)?;
        }
        if exists(&pids, &x.id) {
            rep.updated.proxies += 1
        } else {
            rep.created.proxies += 1
        }
        rep.created.routes += x.routes.len() as u32;
    }
    for c in &t.credentials {
        let s = doc.secrets.as_ref().and_then(|m| m.get(&c.id));
        let upd = |v: Option<&String>| v.map(|v| SecretUpdate::Set(Zeroizing::new(v.clone()))).unwrap_or_default();
        if apply {
            db.save_credential(
                field_key,
                &CredentialInput {
                    id: Some(c.id.clone()),
                    owner: c.owner.clone(),
                    kind: c.kind.clone(),
                    label: c.label.clone(),
                    username: c.username.clone(),
                    url: c.url.clone(),
                    public_key: c.public_key.clone(),
                    expires_at: c.expires_at.clone(),
                    secret: upd(s.and_then(|s| s.secret.as_ref())),
                    private_key: upd(s.and_then(|s| s.private_key.as_ref())),
                    notes: upd(s.and_then(|s| s.notes.as_ref())),
                },
            )?;
        }
        if exists(&cids, &c.id) {
            rep.updated.accounts += 1
        } else {
            rep.created.accounts += 1
        }
    }
    rep.applied = apply;
    Ok(rep)
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
    fn template_round_trips_and_skips_examples() {
        let bytes = template_xlsx().unwrap();
        assert!(bytes.starts_with(b"PK"));
        let (db, fk) = db();
        let rep = import_xlsx(&db, &fk, &bytes, true).unwrap();
        assert!(rep.errors.is_empty(), "{:?}", rep.errors);
        assert_eq!(rep.created.companies, 0, "example rows must be ignored");
    }

    /// Seeded vault → export with secrets → import into an empty vault →
    /// identical topology (names) and secrets.
    #[test]
    fn export_import_preserves_everything() {
        let (src, fk) = db();
        crate::db::seed::seed_demo(&src, &fk).unwrap();
        let bytes = export_xlsx(&src, Some(&fk)).unwrap();

        let (dst, fk2) = db();
        let preview = import_xlsx(&dst, &fk2, &bytes, false).unwrap();
        assert!(preview.errors.is_empty(), "{:?}", preview.errors);
        assert!(!preview.applied);
        assert!(dst.load_topology().unwrap().hosts.is_empty(), "preview writes nothing");
        let rep = import_xlsx(&dst, &fk2, &bytes, true).unwrap();
        assert!(rep.applied);
        let (a, b) = (src.load_topology().unwrap(), dst.load_topology().unwrap());
        assert_eq!(a.tenants.len(), b.tenants.len());
        assert_eq!(a.hosts.len(), b.hosts.len());
        assert_eq!(a.services.len(), b.services.len());
        assert_eq!(a.proxies.iter().map(|p| p.routes.len()).sum::<usize>(), b.proxies.iter().map(|p| p.routes.len()).sum::<usize>());
        assert_eq!(a.credentials.len(), b.credentials.len());
        let gitea_admin = b.credentials.iter().find(|c| c.label == "gitea admin").unwrap();
        assert_eq!(dst.credential_secret(&fk2, &gitea_admin.id, SecretField::Secret).unwrap().as_str(), "g1tea-Forge-2026");
        let vm = b.hosts.iter().find(|h| h.name == "docker-vm").unwrap();
        assert!(vm.parent_host_id.is_some(), "Runs on resolved");

        // Re-import without passwords: updates, no duplicates, secrets kept.
        let again = export_xlsx(&dst, None).unwrap();
        let rep = import_xlsx(&dst, &fk2, &again, true).unwrap();
        assert!(rep.errors.is_empty(), "{:?}", rep.errors);
        assert_eq!(rep.created.machines + rep.created.accounts + rep.created.routes, 0);
        assert_eq!(dst.load_topology().unwrap().hosts.len(), a.hosts.len());
        assert_eq!(dst.credential_secret(&fk2, &gitea_admin.id, SecretField::Secret).unwrap().as_str(), "g1tea-Forge-2026");
    }

    #[test]
    fn row_errors_are_reported_with_sheet_and_row() {
        let mut wb = Workbook::new();
        let defs = |name: &str| SHEETS.iter().find(|s| s.name == name).unwrap();
        write_sheet(&mut wb, defs(S_COMPANIES), &[vec!["ACME".into(), "Corporate".into()]], None).unwrap();
        write_sheet(
            &mut wb,
            defs(S_MACHINES),
            &[vec!["ACME".into(), "srv".into(), "Toaster".into()], vec!["Nope".into(), "x".into(), "VPS".into()]],
            None,
        )
        .unwrap();
        let bytes = wb.save_to_buffer().unwrap();
        let (db, fk) = db();
        let rep = import_xlsx(&db, &fk, &bytes, true).unwrap();
        assert!(!rep.applied);
        assert_eq!(rep.errors.len(), 2);
        assert_eq!((rep.errors[0].sheet.as_str(), rep.errors[0].row), (S_MACHINES, 2));
        assert!(rep.errors[0].message.contains("Category"));
        assert!(rep.errors[1].message.contains("Unknown company"));
        assert!(db.load_topology().unwrap().tenants.is_empty(), "nothing written when there are errors");
    }

    #[test]
    fn route_targets_are_inferred_from_service() {
        let mut wb = Workbook::new();
        let d = |name: &str| SHEETS.iter().find(|s| s.name == name).unwrap();
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        write_sheet(&mut wb, d(S_COMPANIES), &[s(&["Work", "Corporate"])], None).unwrap();
        write_sheet(&mut wb, d(S_MACHINES), &[s(&["Work", "vps", "VPS"])], None).unwrap();
        write_sheet(&mut wb, d(S_CARDS), &[s(&["Work", "vps", "eth0", "", "10.0.0.5", "", "203.0.113.10"])], None).unwrap();
        write_sheet(&mut wb, d(S_SERVICES), &[s(&["Work", "vps", "site", "Docker"])], None).unwrap();
        write_sheet(&mut wb, d(S_PORTS), &[s(&["Work", "vps", "site", "80", "8080"])], None).unwrap();
        write_sheet(&mut wb, d(S_PROXIES), &[s(&["Work", "vps", "nginx", "Nginx"])], None).unwrap();
        write_sheet(&mut wb, d(S_ROUTES), &[s(&["Work", "vps", "nginx", "me.example.com", "", "", "", "", "", "", "", "site"])], None)
            .unwrap();
        let (db, fk) = db();
        let rep = import_xlsx(&db, &fk, &wb.save_to_buffer().unwrap(), true).unwrap();
        assert!(rep.errors.is_empty(), "{:?}", rep.errors);
        let r = &db.load_topology().unwrap().proxies[0].routes[0];
        assert_eq!((r.target_ip.as_str(), r.target_port, r.inbound_port, r.inbound_protocol.as_str()), ("10.0.0.5", 8080, 443, "https"));
        assert!(r.service_id.is_some());
    }

    #[test]
    fn json_round_trip_with_secrets() {
        let (src, fk) = db();
        crate::db::seed::seed_demo(&src, &fk).unwrap();
        let bytes = export_json(&src, Some(&fk)).unwrap();
        let (dst, fk2) = db();
        assert!(import_json(&dst, &fk2, &bytes, false).unwrap().created.accounts > 0);
        assert!(dst.load_topology().unwrap().credentials.is_empty());
        import_json(&dst, &fk2, &bytes, true).unwrap();
        assert_eq!(src.load_topology().unwrap().credentials.len(), dst.load_topology().unwrap().credentials.len());
        let id = crate::db::seed::demo_id("c-app-ssh");
        assert_eq!(dst.credential_secret(&fk2, &id, SecretField::Secret).unwrap().as_str(), "Tama-hagane!42");
        assert!(!String::from_utf8(export_json(&src, None).unwrap()).unwrap().contains("Tama-hagane"));
    }

    #[test]
    fn excel_dates() {
        assert_eq!(serial_to_date(46053.0), "2026-01-31");
        assert_eq!(serial_to_date(25569.0), "1970-01-01");
    }
}
