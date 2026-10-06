-- v2: a service can belong to a different company than the machine it runs on
-- (e.g. your own website hosted on your employer's VPS). NULL = same as host.
ALTER TABLE services ADD COLUMN owner_tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL;
CREATE INDEX idx_services_owner ON services(owner_tenant_id) WHERE owner_tenant_id IS NOT NULL;
