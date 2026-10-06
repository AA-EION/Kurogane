//! Vault lifecycle: create → (enrol TOTP) → save; unlock → work → save → lock.
//!
//! While unlocked, the SQLCipher database lives as a *working copy* in the app
//! sandbox (`<workroot>/<vault_id>/vault.db`, mode 0600). It is still encrypted
//! at rest by SQLCipher; the container is the portable, authenticated unit.
//! Dropping [`UnlockedVault`] closes the database, shreds the working copy
//! and zeroizes every key page.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use zeroize::Zeroizing;

use crate::container::{self, flags, Archive, Header, DB_ENTRY, ICON_PREFIX};
use crate::crypto;
use crate::db::models::{SecretField, Topology};
use crate::db::Database;
use crate::error::{Error, Result};
use crate::fsutil;
use crate::kdf::{derive_mek, KdfParams};
use crate::keys::KeyRing;
use crate::secure::Key256;
use crate::totp::{self, TotpConfig};

pub const TOTP_ISSUER: &str = "Kurogane";

#[derive(Clone, Debug)]
pub struct CreateOptions {
    pub display_name: String,
    pub kdf: KdfParams,
    /// Account label shown in the authenticator app.
    pub totp_account: String,
}

/// Shown once at creation; the user scans the QR and confirms with a code.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpEnrollment {
    pub secret_base32: String,
    pub otpauth_uri: String,
    pub qr_svg: String,
}

impl std::fmt::Debug for TotpEnrollment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TotpEnrollment([REDACTED])")
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn now_unix() -> u64 {
    (now_ms() / 1000) as u64
}

/// Read only the header (no password) — used by the unlock screen to decide
/// whether to show the TOTP field, and by sync to compare lineage.
pub fn peek(path: &Path) -> Result<Header> {
    let bytes = fs::read(path)?;
    container::read_header(&bytes)
}

fn totp_aad(vault_id: &[u8; 16]) -> Vec<u8> {
    let mut aad = b"vault_security:1:totp_secret_sealed:".to_vec();
    aad.extend_from_slice(vault_id);
    aad
}

pub struct UnlockedVault {
    path: PathBuf,
    header: Header,
    keys: KeyRing,
    db: Option<Database>,
    work_db: PathBuf,
    extra_entries: BTreeMap<String, Vec<u8>>,
    dirty: bool,
    pending_totp: Option<Zeroizing<Vec<u8>>>,
}

impl std::fmt::Debug for UnlockedVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnlockedVault").field("path", &self.path).field("generation", &self.header.generation).finish_non_exhaustive()
    }
}

fn prepare_workdir(workroot: &Path, vault_id: &[u8; 16]) -> Result<PathBuf> {
    let dir = workroot.join(uuid::Uuid::from_bytes(*vault_id).simple().to_string());
    fsutil::create_private_dir(&dir)?;
    let db = dir.join("vault.db");
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{suffix}", db.display()));
        if p.exists() {
            fsutil::shred(&p);
        }
    }
    Ok(db)
}

impl UnlockedVault {
    /// Create a new vault file. Fails if `path` already exists.
    pub fn create(path: &Path, workroot: &Path, password: &[u8], opts: &CreateOptions) -> Result<(Self, TotpEnrollment)> {
        if path.exists() {
            return Err(Error::invalid(format!("{} already exists", path.display())));
        }
        if password.len() < 12 {
            return Err(Error::invalid("master password must be at least 12 characters"));
        }
        opts.kdf.check_bounds()?;
        let salt = crypto::random_bytes();
        let vault_id = *uuid::Uuid::new_v4().as_bytes();
        let vdk = Key256::random();
        let mek = derive_mek(password, &salt, &opts.kdf)?;
        let header = Header::new(opts.kdf, salt, vault_id, &mek, &vdk)?;
        drop(mek);
        let keys = KeyRing::derive(vdk, vault_id);

        let work_db = prepare_workdir(workroot, &vault_id)?;
        let db = Database::open(&work_db, &keys.database)?;
        db.init_meta(&uuid::Uuid::from_bytes(vault_id).to_string(), &opts.display_name)?;

        let mut vault = UnlockedVault {
            path: path.to_path_buf(),
            header,
            keys,
            db: Some(db),
            work_db,
            extra_entries: BTreeMap::new(),
            dirty: false,
            pending_totp: None,
        };
        vault.save()?;
        // Offered right away; nothing is stored until the user confirms a code.
        let enrollment = vault.begin_totp_enrollment(&opts.totp_account)?;
        Ok((vault, enrollment))
    }

    pub fn unlock(path: &Path, workroot: &Path, password: &[u8], totp_code: Option<&str>) -> Result<Self> {
        Self::unlock_at(path, workroot, password, totp_code, now_unix())
    }

    /// Unlock with an explicit clock (tests, and to honour a user-confirmed
    /// time source on machines with a broken RTC).
    pub fn unlock_at(path: &Path, workroot: &Path, password: &[u8], totp_code: Option<&str>, now: u64) -> Result<Self> {
        let bytes = fs::read(path)?;
        let (header, keys, plain) = container::open(&bytes, password)?;
        let archive = Archive::decode(&plain, &header.vault_id, header.generation)?;
        drop(plain);
        let db_bytes = archive.get(DB_ENTRY).ok_or_else(|| Error::Integrity("archive has no database".into()))?;

        let work_db = prepare_workdir(workroot, &header.vault_id)?;
        {
            use std::io::Write;
            let mut f = fsutil::create_private(&work_db)?;
            f.write_all(db_bytes)?;
            f.sync_all()?;
        }
        let extra_entries =
            archive.paths().filter(|p| *p != DB_ENTRY).map(|p| (p.to_string(), archive.get(p).unwrap_or_default().to_vec())).collect();

        // Construct first so that any failure below drops (and shreds) it.
        let vault = UnlockedVault {
            path: path.to_path_buf(),
            db: Some(Database::open(&work_db, &keys.database)?),
            header,
            keys,
            work_db,
            extra_entries,
            dirty: false,
            pending_totp: None,
        };

        let rec = vault.db().totp_record()?;
        if rec.enabled {
            let code = totp_code.filter(|c| !c.trim().is_empty()).ok_or(Error::TotpRequired)?;
            let sealed = rec.sealed_secret.as_deref().ok_or_else(|| Error::Integrity("TOTP enabled without a seed".into()))?;
            let secret = crypto::unseal(&vault.keys.totp, &totp_aad(&vault.header.vault_id), sealed)?;
            let counter = totp::verify(&secret, &rec.config, code, now, 1, rec.last_counter).ok_or(Error::TotpInvalid)?;
            // Persisted with the next real save; see docs/CRYPTO.md on replay.
            vault.db().set_totp_last_counter(counter)?;
        }
        Ok(vault)
    }

    /// Generate a fresh TOTP seed for pairing. It lives only in memory until
    /// [`confirm_totp`](Self::confirm_totp) succeeds, so an abandoned re-pair
    /// never weakens or breaks an existing 2FA setup.
    pub fn begin_totp_enrollment(&mut self, account: &str) -> Result<TotpEnrollment> {
        let secret = totp::generate_secret();
        let cfg = TotpConfig::default();
        let account = if account.trim().is_empty() { "admin" } else { account.trim() };
        let uri = totp::otpauth_uri(&secret, &cfg, TOTP_ISSUER, account);
        let enrollment = TotpEnrollment { secret_base32: totp::secret_to_base32(&secret), qr_svg: totp::qr_svg(&uri)?, otpauth_uri: uri };
        self.pending_totp = Some(secret);
        Ok(enrollment)
    }

    /// Finish pairing: verify a code against the pending seed, then require
    /// TOTP on every future unlock.
    pub fn confirm_totp(&mut self, code: &str) -> Result<()> {
        self.confirm_totp_at(code, now_unix())
    }

    pub fn confirm_totp_at(&mut self, code: &str, now: u64) -> Result<()> {
        let secret = self.pending_totp.as_ref().ok_or_else(|| Error::invalid("start pairing first"))?;
        let cfg = TotpConfig::default();
        let counter = totp::verify(secret, &cfg, code, now, 1, 0).ok_or(Error::TotpInvalid)?;
        let sealed = crypto::seal(&self.keys.totp, &totp_aad(&self.header.vault_id), secret)?;
        self.db().store_totp_secret(&sealed, &cfg)?;
        self.db().set_totp_enabled(true, counter)?;
        self.pending_totp = None;
        self.header.flags |= flags::TOTP_REQUIRED;
        self.save()
    }

    /// Turn 2FA off. Requires a current code so a borrowed unlocked session
    /// cannot silently remove the second factor.
    pub fn disable_totp(&mut self, code: &str) -> Result<()> {
        self.disable_totp_at(code, now_unix())
    }

    pub fn disable_totp_at(&mut self, code: &str, now: u64) -> Result<()> {
        let rec = self.db().totp_record()?;
        if !rec.enabled {
            return Ok(());
        }
        let sealed = rec.sealed_secret.ok_or_else(|| Error::Integrity("TOTP enabled without a seed".into()))?;
        let secret = crypto::unseal(&self.keys.totp, &totp_aad(&self.header.vault_id), &sealed)?;
        totp::verify(&secret, &rec.config, code, now, 1, 0).ok_or(Error::TotpInvalid)?;
        self.db().clear_totp()?;
        self.header.flags &= !flags::TOTP_REQUIRED;
        self.save()
    }

    pub fn totp_enabled(&self) -> Result<bool> {
        Ok(self.db().totp_record()?.enabled)
    }

    /// Seal the working database (+ icons) into the container and atomically
    /// replace the vault file, keeping the previous version as `.bak`.
    pub fn save(&mut self) -> Result<()> {
        self.db().checkpoint()?;
        let mut archive = Archive::default();
        archive.insert(DB_ENTRY, fs::read(&self.work_db)?)?;
        for (p, d) in &self.extra_entries {
            archive.insert(p, d.clone())?;
        }
        let file = container::seal(&mut self.header, &self.keys, &archive, now_ms())?;
        fsutil::atomic_write(&self.path, &file, true)?;
        self.dirty = false;
        Ok(())
    }

    pub fn save_if_dirty(&mut self) -> Result<()> {
        if self.dirty {
            self.save()
        } else {
            Ok(())
        }
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// Re-check the master password (sensitive settings ask for it again).
    pub fn verify_password(&self, password: &[u8]) -> Result<()> {
        let mek = derive_mek(password, &self.header.salt, &self.header.kdf)?;
        self.header.unwrap_vdk(&mek).map(|_| ())
    }

    /// Re-wrap the VDK under a new password (and optionally new KDF costs).
    /// Data is not re-encrypted: only the 48-byte wrapped key changes.
    pub fn change_password(&mut self, new_password: &[u8], kdf: Option<KdfParams>) -> Result<()> {
        if new_password.len() < 12 {
            return Err(Error::invalid("master password must be at least 12 characters"));
        }
        let kdf = kdf.unwrap_or(self.header.kdf);
        kdf.check_bounds()?;
        let salt = crypto::random_bytes();
        let mek = derive_mek(new_password, &salt, &kdf)?;
        self.header.salt = salt;
        self.header.kdf = kdf;
        self.header.wrap(&mek, self.keys.vdk())?;
        self.save()
    }

    pub fn add_icon(&mut self, name: &str, bytes: Vec<u8>) -> Result<String> {
        let path = format!("{ICON_PREFIX}{name}");
        container::validate_entry_path(&path)?;
        self.extra_entries.insert(path.clone(), bytes);
        self.dirty = true;
        Ok(path)
    }

    pub fn icon(&self, path: &str) -> Option<&[u8]> {
        self.extra_entries.get(path).map(|v| v.as_slice())
    }

    pub fn topology(&self) -> Result<Topology> {
        self.db().load_topology()
    }

    /// Decrypt one secret and record the access in the vault's audit log.
    pub fn reveal(&mut self, credential_id: &str, field: SecretField, action: &str) -> Result<Zeroizing<String>> {
        let secret = self.db().credential_secret(&self.keys.field, credential_id, field)?;
        self.db().audit(action, Some("credential"), Some(credential_id), Some(&format!("{field:?}")))?;
        self.dirty = true;
        Ok(secret)
    }

    pub fn audit(&mut self, action: &str, entity_type: &str, entity_id: &str) -> Result<()> {
        self.db().audit(action, Some(entity_type), Some(entity_id), None)?;
        self.dirty = true;
        Ok(())
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    pub fn keys(&self) -> &KeyRing {
        &self.keys
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn db(&self) -> &Database {
        self.db.as_ref().expect("database is open while the vault is unlocked")
    }

    /// Re-read the vault file after sync replaced it with a newer copy of the
    /// same vault. Works even if another device changed the master password:
    /// a password change only re-wraps the VDK, so the key ring stays valid.
    pub fn reload(&mut self) -> Result<()> {
        let bytes = fs::read(&self.path)?;
        let header = self.validate_candidate(&bytes)?;
        let plain = container::open_payload(&bytes, &header, &self.keys)?;
        let archive = Archive::decode(&plain, &header.vault_id, header.generation)?;
        let db_bytes = archive.get(DB_ENTRY).ok_or_else(|| Error::Integrity("archive has no database".into()))?;
        drop(self.db.take());
        {
            use std::io::Write;
            let mut f = fsutil::create_private(&self.work_db)?;
            f.write_all(db_bytes)?;
            f.sync_all()?;
        }
        self.db = Some(Database::open(&self.work_db, &self.keys.database)?);
        self.extra_entries =
            archive.paths().filter(|p| *p != DB_ENTRY).map(|p| (p.to_string(), archive.get(p).unwrap_or_default().to_vec())).collect();
        self.header = header;
        self.dirty = false;
        Ok(())
    }

    /// Check that `file` is a newer copy of the *same* vault and decrypts
    /// under the current key ring (used before sync swaps a download in).
    pub fn validate_candidate(&self, file: &[u8]) -> Result<Header> {
        let header = container::read_header(file)?;
        if header.vault_id != self.header.vault_id {
            return Err(Error::Integrity("downloaded file belongs to a different vault".into()));
        }
        let plain = container::open_payload(file, &header, &self.keys)?;
        Archive::decode(&plain, &header.vault_id, header.generation)?;
        Ok(header)
    }
}

impl Drop for UnlockedVault {
    fn drop(&mut self) {
        drop(self.db.take());
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let p = PathBuf::from(format!("{}{suffix}", self.work_db.display()));
            if p.exists() {
                fsutil::shred(&p);
            }
        }
        if let Some(dir) = self.work_db.parent() {
            let _ = fs::remove_dir(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(_seed: bool) -> CreateOptions {
        CreateOptions { display_name: "Test Vault".into(), kdf: KdfParams::insecure_for_tests(), totp_account: "ops@test".into() }
    }

    fn create_seeded(path: &Path, work: &Path, pw: &[u8]) -> (UnlockedVault, TotpEnrollment) {
        let (mut v, e) = UnlockedVault::create(path, work, pw, &opts(true)).unwrap();
        crate::db::seed::seed_demo(v.db(), &v.keys().field).unwrap();
        v.save().unwrap();
        (v, e)
    }

    #[test]
    fn create_unlock_with_portable_totp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("infra.kurogane");
        let work_a = dir.path().join("machine-a");
        let pw = b"correct horse battery staple";

        let (mut v, enrol) = create_seeded(&path, &work_a, pw);
        assert!(enrol.otpauth_uri.starts_with("otpauth://totp/Kurogane:"));
        let secret = totp::secret_from_base32(&enrol.secret_base32).unwrap();
        let t0 = 1_800_000_000;
        v.confirm_totp_at(&totp::code_at(&secret, &TotpConfig::default(), t0), t0).unwrap();
        assert!(v.header().totp_required());
        let hosts_before = v.topology().unwrap().hosts.len();
        drop(v);

        // "Move" the vault file to another machine (different work root).
        let moved = dir.path().join("usb-stick.kurogane");
        fs::copy(&path, &moved).unwrap();
        let work_b = dir.path().join("machine-b");
        let t1 = t0 + 3600;
        assert!(matches!(UnlockedVault::unlock_at(&moved, &work_b, pw, None, t1), Err(Error::TotpRequired)));
        assert!(matches!(UnlockedVault::unlock_at(&moved, &work_b, pw, Some("000000"), t1), Err(Error::TotpInvalid)));
        assert!(matches!(UnlockedVault::unlock_at(&moved, &work_b, b"wrong password!", None, t1), Err(Error::AuthFailed)));
        let code = totp::code_at(&secret, &TotpConfig::default(), t1);
        let v2 = UnlockedVault::unlock_at(&moved, &work_b, pw, Some(&code), t1).unwrap();
        assert_eq!(v2.topology().unwrap().hosts.len(), hosts_before);
        // Working copy exists while unlocked, and is SQLCipher ciphertext.
        let work_file = v2.work_db.clone();
        assert!(!fs::read(&work_file).unwrap().starts_with(b"SQLite format 3"));
        drop(v2);
        assert!(!work_file.exists(), "working copy must be shredded on lock");
    }

    #[test]
    fn totp_is_optional_and_repairable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v.kurogane");
        let pw = b"0123456789abcdef";
        let (v, _skipped) = UnlockedVault::create(&path, dir.path(), pw, &opts(false)).unwrap();
        // Skipping pairing stores nothing: unlock needs only the password.
        assert!(!v.totp_enabled().unwrap());
        drop(v);
        let mut v = UnlockedVault::unlock(&path, dir.path(), pw, None).unwrap();
        // Pair later from Settings.
        let e = v.begin_totp_enrollment("me").unwrap();
        let s = totp::secret_from_base32(&e.secret_base32).unwrap();
        let t = 1_900_000_000;
        v.confirm_totp_at(&totp::code_at(&s, &TotpConfig::default(), t), t).unwrap();
        // An abandoned re-pair keeps the old seed working.
        let _ = v.begin_totp_enrollment("me").unwrap();
        drop(v);
        let t2 = t + 600;
        let mut v = UnlockedVault::unlock_at(&path, dir.path(), pw, Some(&totp::code_at(&s, &TotpConfig::default(), t2)), t2).unwrap();
        assert!(v.disable_totp_at("000000", t2).is_err());
        v.disable_totp_at(&totp::code_at(&s, &TotpConfig::default(), t2 + 30), t2 + 30).unwrap();
        assert!(!v.header().totp_required());
        drop(v);
        UnlockedVault::unlock(&path, dir.path(), pw, None).unwrap();
    }

    #[test]
    fn save_creates_backup_and_lineage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v.kurogane");
        let (mut v, _) = UnlockedVault::create(&path, dir.path(), b"0123456789abcdef", &opts(false)).unwrap();
        let g1 = v.header().generation;
        let s1 = v.header().save_id;
        v.add_icon("router.svg", b"<svg/>".to_vec()).unwrap();
        v.save_if_dirty().unwrap();
        assert_eq!(v.header().generation, g1 + 1);
        assert_eq!(v.header().parent_save_id, s1);
        assert!(fsutil::backup_path(&path).exists());
        assert_eq!(peek(&path).unwrap().save_id, v.header().save_id);
        drop(v);
        let v = UnlockedVault::unlock(&path, dir.path(), b"0123456789abcdef", None).unwrap();
        assert_eq!(v.icon("icons/router.svg").unwrap(), b"<svg/>");
    }

    #[test]
    fn change_password_rewraps_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v.kurogane");
        let (mut v, _) = create_seeded(&path, dir.path(), b"old password 123");
        v.change_password(b"new password 456", None).unwrap();
        drop(v);
        assert!(UnlockedVault::unlock(&path, dir.path(), b"old password 123", None).is_err());
        let v = UnlockedVault::unlock(&path, dir.path(), b"new password 456", None).unwrap();
        assert_eq!(v.topology().unwrap().tenants.len(), 3);
    }

    #[test]
    fn reveal_is_audited() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v.kurogane");
        let (mut v, _) = create_seeded(&path, dir.path(), b"0123456789abcdef");
        let cred = crate::db::seed::demo_id("c-app-ssh");
        assert_eq!(v.reveal(&cred, SecretField::Secret, "reveal_secret").unwrap().as_str(), "Tama-hagane!42");
        assert_eq!(v.db().audit_count("reveal_secret").unwrap(), 1);
    }

    #[test]
    fn refuses_to_overwrite_and_weak_passwords() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v.kurogane");
        assert!(UnlockedVault::create(&path, dir.path(), b"short", &opts(false)).is_err());
        UnlockedVault::create(&path, dir.path(), b"0123456789abcdef", &opts(false)).unwrap();
        assert!(UnlockedVault::create(&path, dir.path(), b"0123456789abcdef", &opts(false)).is_err());
    }
}
