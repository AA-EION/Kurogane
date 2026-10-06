import { useMemo, useState } from 'react';
import type { CredentialMeta, OwnerKind, SecretUpdate } from '../api/types';
import { Button, Field, FormError, GroupedSelect, Modal, SecretInput, Select, Text, TextArea } from '../components/ui';
import { CREDENTIAL_KINDS } from '../options';
import { useStore } from '../store';
import { blank, useSubmit } from './common';

const DEFAULT_KIND: Record<OwnerKind, string> = { tenant: 'web_gui', host: 'ssh_password', service: 'admin_login', proxy: 'admin_login' };

export function CredentialForm({ value, owner }: { value?: CredentialMeta; owner?: { kind: OwnerKind; id: string } }) {
  const { backend, closeModal, topo, lookup } = useStore();
  const initialOwner = value?.owner ?? owner ?? (topo.tenants[0] ? { kind: 'tenant' as OwnerKind, id: topo.tenants[0].id } : { kind: 'tenant' as OwnerKind, id: '' });
  const [ownerKey, setOwnerKey] = useState(`${initialOwner.kind}:${initialOwner.id}`);
  const defaultKind = (okind: OwnerKind, oid: string) => (okind === 'host' && lookup.host.get(oid)?.osFamily === 'windows' ? 'rdp' : DEFAULT_KIND[okind]);
  const [kind, setKind] = useState(value?.kind ?? defaultKind(initialOwner.kind, initialOwner.id));
  const [kindTouched, setKindTouched] = useState(!!value);
  const changeOwner = (key: string) => {
    setOwnerKey(key);
    const [okind, oid] = key.split(':') as [OwnerKind, string];
    if (!kindTouched && okind) setKind(defaultKind(okind, oid));
  };
  const [label, setLabel] = useState(value?.label ?? '');
  const [username, setUsername] = useState(value?.username ?? '');
  const [url, setUrl] = useState(value?.url ?? '');
  const [secret, setSecret] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [publicKey, setPublicKey] = useState(value?.publicKey ?? '');
  const [notes, setNotes] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const { busy, error, submit } = useSubmit();

  const groups = useMemo(() => {
    const tName = (id: string) => lookup.tenant.get(id)?.name ?? '';
    return [
      { label: 'Companies', options: topo.tenants.map((t) => ({ value: `tenant:${t.id}`, label: t.name })) },
      { label: 'Machines', options: topo.hosts.map((h) => ({ value: `host:${h.id}`, label: `${tName(h.tenantId)} / ${h.name}` })) },
      {
        label: 'Services',
        options: topo.services.map((s) => {
          const h = lookup.host.get(s.hostId);
          return { value: `service:${s.id}`, label: `${tName(h?.tenantId ?? '')} / ${h?.name} / ${s.name}` };
        }),
      },
      {
        label: 'Proxies',
        options: topo.proxies.map((p) => {
          const h = lookup.host.get(p.hostId);
          return { value: `proxy:${p.id}`, label: `${tName(h?.tenantId ?? '')} / ${h?.name} / ${p.name}` };
        }),
      },
    ];
  }, [topo, lookup]);

  const isKey = kind === 'ssh_key';
  const upd = (v: string, has: boolean | undefined, clear = false): SecretUpdate => (v ? { set: v } : clear && has ? 'clear' : 'keep');
  const save = () => {
    const [okind, oid] = ownerKey.split(':') as [OwnerKind, string];
    return submit(
      () =>
        backend.saveCredential({
          id: value?.id ?? null,
          owner: { kind: okind, id: oid },
          kind,
          label: label.trim() || (username ? username : kind),
          username: blank(username),
          url: blank(url),
          publicKey: blank(publicKey),
          expiresAt: value?.expiresAt ?? null,
          secret: upd(secret, value?.hasSecret, clearSecret),
          privateKey: upd(privateKey, value?.hasPrivateKey),
          notes: upd(notes, value?.hasNotes),
        }),
      value ? 'Account saved' : 'Account added',
    );
  };

  return (
    <form onSubmit={(e) => (e.preventDefault(), save())}>
      <Modal
        title={value ? `Edit ${value.label}` : 'Add account'}
        subtitle="Logins, SSH keys, tokens. Secrets are encrypted inside the vault."
        icon="key"
        onClose={closeModal}
        footer={<><Button onClick={closeModal}>Cancel</Button><Button kind="primary" type="submit" busy={busy} disabled={!ownerKey.split(':')[1]}>{value ? 'Save' : 'Add account'}</Button></>}
      >
        <div className="f-grid">
          <Field label="Belongs to" required span={2}>
            <GroupedSelect value={ownerKey} onChange={changeOwner} groups={groups} placeholder="Choose a company, machine, service or proxy" />
          </Field>
          <Field label="Type">
            <Select value={kind} onChange={(k) => (setKind(k), setKindTouched(true))} options={CREDENTIAL_KINDS} />
          </Field>
          <Field label="Label" hint="e.g. root, WordPress admin, DB user">
            <Text value={label} onChange={setLabel} placeholder={username || 'admin'} autoFocus />
          </Field>
          <Field label="Username">
            <Text value={username} onChange={setUsername} mono />
          </Field>
          {!isKey && (
            <Field
              label={kind === 'api_token' ? 'Token' : 'Password'}
              hint={value?.hasSecret ? (clearSecret ? 'Will be removed on save.' : <>Stored. Leave empty to keep it · <button type="button" className="link-btn" onClick={() => setClearSecret(true)}>remove</button></>) : undefined}
            >
              <SecretInput value={secret} onChange={(v) => (setSecret(v), setClearSecret(false))} placeholder={value?.hasSecret ? '••••••••  (unchanged)' : ''} />
            </Field>
          )}
          {isKey && (
            <>
              <Field label="Passphrase (optional)">
                <SecretInput value={secret} onChange={setSecret} generate={false} placeholder={value?.hasSecret ? '(unchanged)' : ''} />
              </Field>
              <Field label="Private key" span={2} hint={value?.hasPrivateKey ? 'Stored. Paste a new key to replace it.' : 'Paste the full key, including the BEGIN/END lines.'}>
                <TextArea value={privateKey} onChange={setPrivateKey} rows={4} mono placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
              </Field>
              <Field label="Public key" span={2}>
                <Text value={publicKey} onChange={setPublicKey} mono placeholder="ssh-ed25519 AAAA…" />
              </Field>
            </>
          )}
          <Field label="URL" span={2} hint="Login page, if any — used by the Open button.">
            <Text value={url} onChange={setUrl} mono placeholder="https://app.example.com/login" />
          </Field>
          <Field label="Secure notes" span={2} hint={value?.hasNotes ? 'Stored (encrypted). Type to replace.' : 'Recovery codes, security questions… stored encrypted.'}>
            <TextArea value={notes} onChange={setNotes} rows={2} />
          </Field>
        </div>
        <FormError error={error} />
      </Modal>
    </form>
  );
}
