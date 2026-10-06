-- ===========================================================================
-- KUROGANE vault schema, version 1
--
-- Runs inside SQLCipher (AES-256-CBC + HMAC-SHA512 per page, raw 256-bit key
-- derived from the VDK). Secret columns are additionally sealed at field level
-- (`*_sealed` BLOBs, AES-256-GCM, AAD = "<table>:<id>:<column>") so that the
-- topology API can never leak them by accident.
--
-- Conventions
--   * Primary keys are UUIDv4 TEXT: stable across devices and merge-friendly.
--   * Timestamps are ISO-8601 UTC TEXT (strftime('%Y-%m-%dT%H:%M:%fZ')).
--   * Enumerations are TEXT + CHECK so the file stays self-describing.
--   * Ownership cascades downward (tenant → host → service → port); cross
--     links (route → service, route → target host) SET NULL so deleting a
--     container never deletes the proxy rule that pointed at it.
-- ===========================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE vault_meta (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    vault_id              TEXT    NOT NULL,
    display_name          TEXT    NOT NULL,
    created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    lock_timeout_secs     INTEGER NOT NULL DEFAULT 900 CHECK (lock_timeout_secs BETWEEN 60 AND 86400),
    clipboard_clear_secs  INTEGER NOT NULL DEFAULT 30  CHECK (clipboard_clear_secs BETWEEN 5 AND 600),
    lock_on_suspend       INTEGER NOT NULL DEFAULT 1   CHECK (lock_on_suspend IN (0, 1))
);

-- Portable second factor. The seed is sealed with HKDF(VDK, "kurogane/v1/totp").
CREATE TABLE vault_security (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    totp_secret_sealed  BLOB,
    totp_algorithm      TEXT    NOT NULL DEFAULT 'SHA1' CHECK (totp_algorithm IN ('SHA1', 'SHA256', 'SHA512')),
    totp_digits         INTEGER NOT NULL DEFAULT 6      CHECK (totp_digits IN (6, 8)),
    totp_period         INTEGER NOT NULL DEFAULT 30     CHECK (totp_period BETWEEN 15 AND 120),
    totp_enabled        INTEGER NOT NULL DEFAULT 0      CHECK (totp_enabled IN (0, 1)),
    totp_last_counter   INTEGER NOT NULL DEFAULT 0      CHECK (totp_last_counter >= 0),
    CHECK (totp_enabled = 0 OR totp_secret_sealed IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL COLLATE NOCASE UNIQUE,
    environment        TEXT NOT NULL CHECK (environment IN ('corporate', 'client', 'personal', 'lab', 'staging', 'production')),
    environment_label  TEXT,                       -- "Client Alpha", "Personal Homelab"
    color              TEXT CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')),
    sla_notes          TEXT,
    admin_notes        TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE networks (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'lan' CHECK (kind IN ('lan', 'dmz', 'wan', 'vpn', 'overlay', 'mgmt', 'iot')),
    cidr        TEXT NOT NULL,
    vlan_id     INTEGER CHECK (vlan_id IS NULL OR vlan_id BETWEEN 1 AND 4094),
    gateway     TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (tenant_id, cidr),
    UNIQUE (tenant_id, name)
);
CREATE INDEX idx_networks_tenant ON networks(tenant_id);

-- ---------------------------------------------------------------------------
-- Machines
-- ---------------------------------------------------------------------------
CREATE TABLE hosts (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    parent_host_id  TEXT REFERENCES hosts(id) ON DELETE SET NULL,   -- VM → hypervisor
    name            TEXT NOT NULL,
    category        TEXT NOT NULL CHECK (category IN ('vps', 'local_server', 'vm', 'switch', 'access_point', 'router', 'firewall', 'nvr', 'nas', 'edge_device', 'workstation')),
    os_family       TEXT CHECK (os_family IS NULL OR os_family IN ('linux', 'windows', 'macos', 'bsd', 'routeros', 'embedded', 'other')),
    fqdn            TEXT,
    ssh_port        INTEGER CHECK (ssh_port IS NULL OR ssh_port BETWEEN 1 AND 65535),
    rdp_port        INTEGER CHECK (rdp_port IS NULL OR rdp_port BETWEEN 1 AND 65535),
    winrm_port      INTEGER CHECK (winrm_port IS NULL OR winrm_port BETWEEN 1 AND 65535),
    web_admin_url   TEXT,
    provider        TEXT,                  -- "Hetzner", "OVH", "on-prem rack A"
    location        TEXT,
    icon            TEXT,                  -- archive path, e.g. icons/proxmox.svg
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (tenant_id, name),
    CHECK (parent_host_id IS NULL OR parent_host_id <> id)
);
CREATE INDEX idx_hosts_tenant   ON hosts(tenant_id);
CREATE INDEX idx_hosts_parent   ON hosts(parent_host_id) WHERE parent_host_id IS NOT NULL;
CREATE INDEX idx_hosts_category ON hosts(category);

CREATE TABLE network_interfaces (
    id           TEXT PRIMARY KEY,
    host_id      TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    network_id   TEXT REFERENCES networks(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,             -- eth0, ens18, wg0
    mac          TEXT,
    internal_ip  TEXT,
    gateway      TEXT,
    public_ip    TEXT,                      -- egress / directly attached public address
    is_primary   INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (host_id, name)
);
CREATE INDEX        idx_nic_host        ON network_interfaces(host_id);
CREATE INDEX        idx_nic_network     ON network_interfaces(network_id) WHERE network_id IS NOT NULL;
CREATE INDEX        idx_nic_internal_ip ON network_interfaces(internal_ip) WHERE internal_ip IS NOT NULL;
CREATE INDEX        idx_nic_public_ip   ON network_interfaces(public_ip)   WHERE public_ip IS NOT NULL;
CREATE UNIQUE INDEX ux_nic_one_primary  ON network_interfaces(host_id)     WHERE is_primary = 1;

-- ---------------------------------------------------------------------------
-- Workloads
-- ---------------------------------------------------------------------------
CREATE TABLE services (
    id           TEXT PRIMARY KEY,
    host_id      TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    runtime      TEXT NOT NULL CHECK (runtime IN ('docker', 'podman', 'systemd', 'smb', 'kubernetes', 'windows_service', 'lxc', 'other')),
    image        TEXT,                       -- OCI image ref for container runtimes
    scheme       TEXT NOT NULL DEFAULT 'http' CHECK (scheme IN ('http', 'https', 'tcp', 'udp', 'smb', 'rtsp', 'none')),
    health_path  TEXT,
    description  TEXT,
    icon         TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (host_id, name)
);
CREATE INDEX idx_services_host ON services(host_id);

CREATE TABLE service_ports (
    id              TEXT PRIMARY KEY,
    service_id      TEXT    NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    container_port  INTEGER NOT NULL CHECK (container_port BETWEEN 1 AND 65535),   -- internal binding
    host_port       INTEGER CHECK (host_port IS NULL OR host_port BETWEEN 1 AND 65535), -- NULL = not published
    bind_address    TEXT    NOT NULL DEFAULT '0.0.0.0',
    protocol        TEXT    NOT NULL DEFAULT 'tcp' CHECK (protocol IN ('tcp', 'udp')),
    is_primary      INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    UNIQUE (service_id, container_port, protocol)
);
CREATE INDEX        idx_ports_service      ON service_ports(service_id);
CREATE INDEX        idx_ports_host_port    ON service_ports(host_port) WHERE host_port IS NOT NULL;
CREATE UNIQUE INDEX ux_ports_one_primary   ON service_ports(service_id) WHERE is_primary = 1;

-- Two services on the same host cannot publish the same host port/protocol on
-- overlapping bind addresses. (Needs a trigger: host_id lives on `services`.)
CREATE TRIGGER trg_ports_no_host_collision_ins
BEFORE INSERT ON service_ports
WHEN NEW.host_port IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'host port already published on this host')
    WHERE EXISTS (
        SELECT 1
        FROM service_ports p
        JOIN services s  ON s.id  = p.service_id
        JOIN services sn ON sn.id = NEW.service_id
        WHERE s.host_id = sn.host_id
          AND p.host_port = NEW.host_port
          AND p.protocol  = NEW.protocol
          AND (p.bind_address = NEW.bind_address OR p.bind_address = '0.0.0.0' OR NEW.bind_address = '0.0.0.0')
    );
END;

CREATE TRIGGER trg_ports_no_host_collision_upd
BEFORE UPDATE OF host_port, protocol, bind_address, service_id ON service_ports
WHEN NEW.host_port IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'host port already published on this host')
    WHERE EXISTS (
        SELECT 1
        FROM service_ports p
        JOIN services s  ON s.id  = p.service_id
        JOIN services sn ON sn.id = NEW.service_id
        WHERE p.id <> NEW.id
          AND s.host_id = sn.host_id
          AND p.host_port = NEW.host_port
          AND p.protocol  = NEW.protocol
          AND (p.bind_address = NEW.bind_address OR p.bind_address = '0.0.0.0' OR NEW.bind_address = '0.0.0.0')
    );
END;

-- ---------------------------------------------------------------------------
-- Edge routing
-- ---------------------------------------------------------------------------
CREATE TABLE reverse_proxies (
    id          TEXT PRIMARY KEY,
    host_id     TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,       -- where it runs / tunnel connector
    service_id  TEXT REFERENCES services(id) ON DELETE SET NULL,            -- if the proxy is itself a container
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('nginx', 'traefik', 'npm', 'caddy', 'haproxy', 'cloudflare_tunnel', 'other')),
    admin_url   TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (host_id, name)
);
CREATE INDEX idx_proxies_host    ON reverse_proxies(host_id);
CREATE INDEX idx_proxies_service ON reverse_proxies(service_id) WHERE service_id IS NOT NULL;

-- External domain → inbound port/protocol → target host IP:port → service.
CREATE TABLE proxy_routes (
    id                TEXT PRIMARY KEY,
    proxy_id          TEXT    NOT NULL REFERENCES reverse_proxies(id) ON DELETE CASCADE,
    domain            TEXT    NOT NULL COLLATE NOCASE,
    path_prefix       TEXT    NOT NULL DEFAULT '/',
    inbound_port      INTEGER NOT NULL DEFAULT 443 CHECK (inbound_port BETWEEN 1 AND 65535),
    inbound_protocol  TEXT    NOT NULL DEFAULT 'https' CHECK (inbound_protocol IN ('http', 'https', 'tcp', 'udp')),
    tls_mode          TEXT    NOT NULL DEFAULT 'letsencrypt' CHECK (tls_mode IN ('none', 'letsencrypt', 'custom', 'cloudflare', 'passthrough')),
    tls_expires_at    TEXT,
    target_host_id    TEXT    REFERENCES hosts(id) ON DELETE SET NULL,
    target_ip         TEXT    NOT NULL,
    target_port       INTEGER NOT NULL CHECK (target_port BETWEEN 1 AND 65535),
    target_scheme     TEXT    NOT NULL DEFAULT 'http' CHECK (target_scheme IN ('http', 'https', 'tcp', 'udp')),
    service_id        TEXT    REFERENCES services(id) ON DELETE SET NULL,
    enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (proxy_id, domain, path_prefix, inbound_port),
    CHECK (inbound_protocol <> 'https' OR tls_mode <> 'none')
);
CREATE INDEX idx_routes_proxy       ON proxy_routes(proxy_id);
CREATE INDEX idx_routes_domain      ON proxy_routes(domain);
CREATE INDEX idx_routes_service     ON proxy_routes(service_id)     WHERE service_id IS NOT NULL;
CREATE INDEX idx_routes_target_host ON proxy_routes(target_host_id) WHERE target_host_id IS NOT NULL;
CREATE INDEX idx_routes_tls_expiry  ON proxy_routes(tls_expires_at) WHERE tls_expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Credentials (exactly one owner)
-- ---------------------------------------------------------------------------
CREATE TABLE credentials (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT REFERENCES tenants(id)          ON DELETE CASCADE,
    host_id             TEXT REFERENCES hosts(id)            ON DELETE CASCADE,
    service_id          TEXT REFERENCES services(id)         ON DELETE CASCADE,
    proxy_id            TEXT REFERENCES reverse_proxies(id)  ON DELETE CASCADE,
    kind                TEXT NOT NULL CHECK (kind IN ('ssh_password', 'ssh_key', 'rdp', 'winrm', 'web_gui', 'admin_login', 'db_user', 'api_token', 'smb', 'snmp', 'other')),
    label               TEXT NOT NULL,
    username            TEXT,
    secret_sealed       BLOB,          -- password / token
    private_key_sealed  BLOB,          -- SSH private key (PEM/OpenSSH)
    public_key          TEXT,
    notes_sealed        BLOB,
    url                 TEXT,
    expires_at          TEXT,
    rotated_at          TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK ((tenant_id IS NOT NULL) + (host_id IS NOT NULL) + (service_id IS NOT NULL) + (proxy_id IS NOT NULL) = 1),
    CHECK (kind <> 'ssh_key' OR private_key_sealed IS NOT NULL)
);
CREATE INDEX idx_creds_tenant  ON credentials(tenant_id)  WHERE tenant_id  IS NOT NULL;
CREATE INDEX idx_creds_host    ON credentials(host_id)    WHERE host_id    IS NOT NULL;
CREATE INDEX idx_creds_service ON credentials(service_id) WHERE service_id IS NOT NULL;
CREATE INDEX idx_creds_proxy   ON credentials(proxy_id)   WHERE proxy_id   IS NOT NULL;
CREATE INDEX idx_creds_expiry  ON credentials(expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Cloud sync remotes (tokens sealed with HKDF(VDK, "kurogane/v1/sync")).
-- Device-local sync *state* (last synced save_id) deliberately lives outside
-- the vault, in the app sandbox, because it describes this device.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_remotes (
    id                     TEXT PRIMARY KEY,
    provider               TEXT NOT NULL CHECK (provider IN ('drive', 'onedrive', 'mega', 'webdav', 's3', 'local')),
    label                  TEXT NOT NULL,
    remote_path            TEXT NOT NULL,       -- e.g. "Kurogane/infra.kurogane"
    rclone_section_sealed  BLOB NOT NULL,       -- rclone.conf section body incl. OAuth token
    transport              TEXT NOT NULL DEFAULT 'auto' CHECK (transport IN ('auto', 'container', 'binary')),
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (provider, remote_path)
);

-- ---------------------------------------------------------------------------
-- Audit + merge support
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    action       TEXT NOT NULL,         -- unlock, reveal_secret, copy_secret, launch_ssh, sync_push …
    entity_type  TEXT,
    entity_id    TEXT,
    detail       TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);

-- Deletions are recorded so a future three-way merge can tell "deleted here"
-- from "never existed there".
CREATE TABLE tombstones (
    entity_type  TEXT NOT NULL,
    entity_id    TEXT NOT NULL,
    deleted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (entity_type, entity_id)
);

-- updated_at maintenance (recursive_triggers is off, so the inner UPDATE does
-- not re-fire the trigger).
CREATE TRIGGER trg_tenants_touch     AFTER UPDATE ON tenants            BEGIN UPDATE tenants            SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_networks_touch    AFTER UPDATE ON networks           BEGIN UPDATE networks           SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_hosts_touch       AFTER UPDATE ON hosts              BEGIN UPDATE hosts              SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_nics_touch        AFTER UPDATE ON network_interfaces BEGIN UPDATE network_interfaces SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_services_touch    AFTER UPDATE ON services           BEGIN UPDATE services           SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_proxies_touch     AFTER UPDATE ON reverse_proxies    BEGIN UPDATE reverse_proxies    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_routes_touch      AFTER UPDATE ON proxy_routes       BEGIN UPDATE proxy_routes       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER trg_creds_touch       AFTER UPDATE ON credentials        BEGIN UPDATE credentials        SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_tenants_tomb  AFTER DELETE ON tenants         BEGIN INSERT OR REPLACE INTO tombstones(entity_type, entity_id) VALUES ('tenant',  OLD.id); END;
CREATE TRIGGER trg_hosts_tomb    AFTER DELETE ON hosts           BEGIN INSERT OR REPLACE INTO tombstones(entity_type, entity_id) VALUES ('host',    OLD.id); END;
CREATE TRIGGER trg_services_tomb AFTER DELETE ON services        BEGIN INSERT OR REPLACE INTO tombstones(entity_type, entity_id) VALUES ('service', OLD.id); END;
CREATE TRIGGER trg_proxies_tomb  AFTER DELETE ON reverse_proxies BEGIN INSERT OR REPLACE INTO tombstones(entity_type, entity_id) VALUES ('proxy',   OLD.id); END;
CREATE TRIGGER trg_routes_tomb   AFTER DELETE ON proxy_routes    BEGIN INSERT OR REPLACE INTO tombstones(entity_type, entity_id) VALUES ('route',   OLD.id); END;
CREATE TRIGGER trg_creds_tomb    AFTER DELETE ON credentials     BEGIN INSERT OR REPLACE INTO tombstones(entity_type, entity_id) VALUES ('credential', OLD.id); END;

-- ---------------------------------------------------------------------------
-- Route trace view: Internet → public IP → proxy:inbound → target IP:port → service
-- Feeds the canvas trace lines and the "Launch" action.
-- ---------------------------------------------------------------------------
CREATE VIEW v_route_traces AS
SELECT
    r.id                AS route_id,
    r.domain            AS domain,
    r.path_prefix       AS path_prefix,
    r.inbound_protocol  AS inbound_protocol,
    r.inbound_port      AS inbound_port,
    r.tls_mode          AS tls_mode,
    r.tls_expires_at    AS tls_expires_at,
    p.id                AS proxy_id,
    p.kind              AS proxy_kind,
    ph.id               AS proxy_host_id,
    (SELECT n.public_ip FROM network_interfaces n
      WHERE n.host_id = ph.id AND n.public_ip IS NOT NULL
      ORDER BY n.is_primary DESC LIMIT 1)          AS edge_public_ip,
    r.target_host_id    AS target_host_id,
    r.target_ip         AS target_ip,
    r.target_port       AS target_port,
    r.target_scheme     AS target_scheme,
    s.id                AS service_id,
    s.name              AS service_name,
    (SELECT sp.container_port FROM service_ports sp
      WHERE sp.service_id = s.id AND sp.host_port = r.target_port LIMIT 1) AS container_port,
    ph.tenant_id        AS tenant_id
FROM proxy_routes r
JOIN reverse_proxies p ON p.id = r.proxy_id
JOIN hosts ph          ON ph.id = p.host_id
LEFT JOIN services s   ON s.id = r.service_id
WHERE r.enabled = 1;
