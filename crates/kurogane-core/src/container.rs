//! The `.kurogane` container: a fixed 256-byte binary header followed by one
//! AES-256-GCM ciphertext holding a small archive (database + icons + manifest).
//!
//! ```text
//! off  len  field                      notes
//! ---  ---  -------------------------  ------------------------------------------
//!   0    9  magic                      "KUROGANE\0"
//!   9    2  format_version (u16 LE)    = 1
//!  11    2  header_len     (u16 LE)    = 256
//!  13    1  kdf_id                     1 = Argon2id v1.3
//!  14    1  aead_id                    1 = AES-256-GCM
//!  15    1  argon2_lanes   (u8)
//!  16    4  argon2_m_cost  (u32 LE)    KiB
//!  20    4  argon2_t_cost  (u32 LE)
//!  24   32  kdf_salt
//!  56   16  vault_id                   random UUIDv4, stable for the vault's life
//!  ---- 72  end of key-binding region  (AAD for the VDK wrap)
//!  72   12  wrap_nonce
//!  84   48  wrapped_vdk                AES-256-GCM(MEK, VDK[32]) ‖ tag[16]
//! 132    4  flags          (u32 LE)    bit0 TOTP_REQUIRED, bit1 DB_SQLCIPHER
//! 136    8  generation     (u64 LE)    +1 on every save
//! 144   16  save_id                    random per save
//! 160   16  parent_save_id             save_id this save was derived from
//! 176    8  saved_at_ms    (i64 LE)    unix epoch milliseconds
//! 184   12  payload_nonce
//! 196    8  payload_len    (u64 LE)    ciphertext length incl. 16-byte tag
//! 204   52  reserved                   must be zero
//! 256    …  payload ciphertext         AES-256-GCM(K_payload, archive, AAD = header[0..256])
//! ```
//!
//! *Every* header byte is authenticated: bytes `0..72` by the VDK wrap (so a
//! swapped salt or KDF downgrade fails to unwrap) and all 256 bytes by the
//! payload AEAD (so lineage fields used by sync cannot be forged).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::crypto::{self, NONCE_LEN, TAG_LEN};
use crate::error::{Error, Result};
use crate::kdf::{derive_mek, KdfParams, SALT_LEN};
use crate::keys::KeyRing;
use crate::secure::Key256;

pub const MAGIC: &[u8; 9] = b"KUROGANE\0";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 256;
pub const KEY_BINDING_END: usize = 72;
pub const KDF_ARGON2ID: u8 = 1;
pub const AEAD_AES256GCM: u8 = 1;
/// Hard ceiling on payload size to bound memory use when opening untrusted files.
pub const MAX_PAYLOAD_LEN: u64 = 1 << 30;

pub mod flags {
    /// UI hint: prompt for a TOTP code together with the password. The source
    /// of truth for enforcement is the encrypted `vault_security` table.
    pub const TOTP_REQUIRED: u32 = 1 << 0;
    /// The archive's database entry is SQLCipher-encrypted.
    pub const DB_SQLCIPHER: u32 = 1 << 1;
    pub const KNOWN: u32 = TOTP_REQUIRED | DB_SQLCIPHER;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    pub kdf: KdfParams,
    pub salt: [u8; SALT_LEN],
    pub vault_id: [u8; 16],
    pub wrap_nonce: [u8; NONCE_LEN],
    pub wrapped_vdk: [u8; 32 + TAG_LEN],
    pub flags: u32,
    pub generation: u64,
    pub save_id: [u8; 16],
    pub parent_save_id: [u8; 16],
    pub saved_at_ms: i64,
    pub payload_nonce: [u8; NONCE_LEN],
    pub payload_len: u64,
}

/// Lineage summary used by the sync engine; readable without a password.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lineage {
    pub vault_id: String,
    pub generation: u64,
    pub save_id: String,
    pub parent_save_id: String,
    pub saved_at_ms: i64,
}

impl Header {
    /// Create a header for a brand-new vault, wrapping `vdk` under `mek`.
    pub fn new(kdf: KdfParams, salt: [u8; SALT_LEN], vault_id: [u8; 16], mek: &Key256, vdk: &Key256) -> Result<Self> {
        let mut h = Header {
            kdf,
            salt,
            vault_id,
            wrap_nonce: [0; NONCE_LEN],
            wrapped_vdk: [0; 32 + TAG_LEN],
            flags: flags::DB_SQLCIPHER,
            generation: 0,
            save_id: [0; 16],
            parent_save_id: [0; 16],
            saved_at_ms: 0,
            payload_nonce: [0; NONCE_LEN],
            payload_len: 0,
        };
        h.wrap(mek, vdk)?;
        Ok(h)
    }

    /// (Re-)wrap the VDK under a MEK. Called on create and password change.
    pub fn wrap(&mut self, mek: &Key256, vdk: &Key256) -> Result<()> {
        self.wrap_nonce = crypto::random_nonce();
        let aad = self.encode();
        let ct = crypto::encrypt(mek, &self.wrap_nonce, &aad[..KEY_BINDING_END], vdk.expose())?;
        self.wrapped_vdk.copy_from_slice(&ct);
        Ok(())
    }

    pub fn unwrap_vdk(&self, mek: &Key256) -> Result<Key256> {
        let aad = self.encode();
        let pt = crypto::decrypt(mek, &self.wrap_nonce, &aad[..KEY_BINDING_END], &self.wrapped_vdk)?;
        if pt.len() != 32 {
            return Err(Error::AuthFailed);
        }
        Ok(Key256::from_slice(&pt))
    }

    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut b = [0u8; HEADER_LEN];
        b[0..9].copy_from_slice(MAGIC);
        b[9..11].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
        b[11..13].copy_from_slice(&(HEADER_LEN as u16).to_le_bytes());
        b[13] = KDF_ARGON2ID;
        b[14] = AEAD_AES256GCM;
        b[15] = self.kdf.parallelism;
        b[16..20].copy_from_slice(&self.kdf.m_cost_kib.to_le_bytes());
        b[20..24].copy_from_slice(&self.kdf.t_cost.to_le_bytes());
        b[24..56].copy_from_slice(&self.salt);
        b[56..72].copy_from_slice(&self.vault_id);
        b[72..84].copy_from_slice(&self.wrap_nonce);
        b[84..132].copy_from_slice(&self.wrapped_vdk);
        b[132..136].copy_from_slice(&self.flags.to_le_bytes());
        b[136..144].copy_from_slice(&self.generation.to_le_bytes());
        b[144..160].copy_from_slice(&self.save_id);
        b[160..176].copy_from_slice(&self.parent_save_id);
        b[176..184].copy_from_slice(&self.saved_at_ms.to_le_bytes());
        b[184..196].copy_from_slice(&self.payload_nonce);
        b[196..204].copy_from_slice(&self.payload_len.to_le_bytes());
        b
    }

    pub fn decode(buf: &[u8]) -> Result<Self> {
        if buf.len() < HEADER_LEN {
            return Err(if buf.len() >= 9 && &buf[..9] != MAGIC { Error::BadMagic } else { Error::malformed("file shorter than header") });
        }
        if &buf[0..9] != MAGIC {
            return Err(Error::BadMagic);
        }
        let version = u16::from_le_bytes([buf[9], buf[10]]);
        if version != FORMAT_VERSION {
            return Err(Error::UnsupportedVersion(version));
        }
        if u16::from_le_bytes([buf[11], buf[12]]) as usize != HEADER_LEN {
            return Err(Error::malformed("unexpected header length"));
        }
        if buf[13] != KDF_ARGON2ID {
            return Err(Error::malformed(format!("unknown KDF id {}", buf[13])));
        }
        if buf[14] != AEAD_AES256GCM {
            return Err(Error::malformed(format!("unknown AEAD id {}", buf[14])));
        }
        if buf[204..HEADER_LEN].iter().any(|&x| x != 0) {
            return Err(Error::malformed("reserved header bytes are not zero"));
        }
        let u32_at = |o: usize| u32::from_le_bytes(buf[o..o + 4].try_into().unwrap());
        let u64_at = |o: usize| u64::from_le_bytes(buf[o..o + 8].try_into().unwrap());
        let kdf = KdfParams { parallelism: buf[15], m_cost_kib: u32_at(16), t_cost: u32_at(20) };
        kdf.check_bounds()?;
        let flags = u32_at(132);
        if flags & !flags::KNOWN != 0 {
            return Err(Error::malformed("unknown flag bits set (file written by a newer Kurogane?)"));
        }
        let payload_len = u64_at(196);
        if payload_len > MAX_PAYLOAD_LEN {
            return Err(Error::malformed("payload exceeds size limit"));
        }
        Ok(Header {
            kdf,
            salt: buf[24..56].try_into().unwrap(),
            vault_id: buf[56..72].try_into().unwrap(),
            wrap_nonce: buf[72..84].try_into().unwrap(),
            wrapped_vdk: buf[84..132].try_into().unwrap(),
            flags,
            generation: u64_at(136),
            save_id: buf[144..160].try_into().unwrap(),
            parent_save_id: buf[160..176].try_into().unwrap(),
            saved_at_ms: i64::from_le_bytes(buf[176..184].try_into().unwrap()),
            payload_nonce: buf[184..196].try_into().unwrap(),
            payload_len,
        })
    }

    pub fn totp_required(&self) -> bool {
        self.flags & flags::TOTP_REQUIRED != 0
    }

    pub fn lineage(&self) -> Lineage {
        Lineage {
            vault_id: uuid::Uuid::from_bytes(self.vault_id).to_string(),
            generation: self.generation,
            save_id: crypto::hex(&self.save_id),
            parent_save_id: crypto::hex(&self.parent_save_id),
            saved_at_ms: self.saved_at_ms,
        }
    }
}

/// Encode + encrypt `archive` and return the complete file image. Advances the
/// lineage (generation, save_id, parent_save_id) before sealing. On error the
/// header is left untouched.
pub fn seal(header: &mut Header, keys: &KeyRing, archive: &Archive, now_ms: i64) -> Result<Vec<u8>> {
    if keys.vault_id != header.vault_id {
        return Err(Error::invalid("key ring does not belong to this vault"));
    }
    let archive_plain = archive.encode(&header.vault_id, header.generation + 1)?;
    let previous = header.clone();
    let out = seal_plain(header, keys, &archive_plain, now_ms);
    if out.is_err() {
        *header = previous;
    }
    out
}

fn seal_plain(header: &mut Header, keys: &KeyRing, archive_plain: &[u8], now_ms: i64) -> Result<Vec<u8>> {
    header.generation += 1;
    header.parent_save_id = header.save_id;
    header.save_id = crypto::random_bytes();
    header.saved_at_ms = now_ms;
    header.payload_nonce = crypto::random_nonce();
    header.payload_len = (archive_plain.len() + TAG_LEN) as u64;
    if header.payload_len > MAX_PAYLOAD_LEN {
        return Err(Error::invalid("vault payload exceeds 1 GiB"));
    }
    let hdr = header.encode();
    let ct = crypto::encrypt(&keys.payload, &header.payload_nonce, &hdr, archive_plain)?;
    let mut out = Vec::with_capacity(HEADER_LEN + ct.len());
    out.extend_from_slice(&hdr);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Parse the header and check the file length matches it exactly.
pub fn read_header(file: &[u8]) -> Result<Header> {
    let header = Header::decode(file)?;
    if (file.len() - HEADER_LEN) as u64 != header.payload_len {
        return Err(Error::malformed("file length does not match header (truncated or trailing data)"));
    }
    Ok(header)
}

/// Full open: Argon2id → unwrap VDK → derive key ring → decrypt payload.
pub fn open(file: &[u8], password: &[u8]) -> Result<(Header, KeyRing, Zeroizing<Vec<u8>>)> {
    let header = read_header(file)?;
    let mek = derive_mek(password, &header.salt, &header.kdf)?;
    let vdk = header.unwrap_vdk(&mek)?;
    drop(mek); // zeroized + unlocked immediately; only the VDK-derived ring survives
    let keys = KeyRing::derive(vdk, header.vault_id);
    let plain = open_payload(file, &header, &keys)?;
    Ok((header, keys, plain))
}

/// Decrypt the payload with an already-unlocked key ring (used to validate a
/// downloaded remote copy of the same vault before swapping it in).
pub fn open_payload(file: &[u8], header: &Header, keys: &KeyRing) -> Result<Zeroizing<Vec<u8>>> {
    if keys.vault_id != header.vault_id {
        return Err(Error::Integrity("vault id mismatch".into()));
    }
    crypto::decrypt(&keys.payload, &header.payload_nonce, &file[..HEADER_LEN], &file[HEADER_LEN..])
}

// ---------------------------------------------------------------------------
// Archive ("KGPK") — the plaintext inside the payload.
//
//   0   4  magic "KGPK"
//   4   2  version (u16 LE) = 1
//   6   4  entry_count (u32 LE)
//  10   …  entries: path_len u16 ‖ path (UTF-8) ‖ data_len u64 ‖ data
//
// The first entry is always MANIFEST.json, listing every other entry with its
// size and SHA-256. Decoding rejects unlisted, missing or mismatching entries.
// ---------------------------------------------------------------------------

pub const ARCHIVE_MAGIC: &[u8; 4] = b"KGPK";
pub const ARCHIVE_VERSION: u16 = 1;
pub const MANIFEST_ENTRY: &str = "MANIFEST.json";
pub const DB_ENTRY: &str = "db/vault.db";
pub const ICON_PREFIX: &str = "icons/";
const MAX_ENTRIES: u32 = 4096;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub vault_id: String,
    pub generation: u64,
    pub entries: Vec<ManifestEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Default)]
pub struct Archive {
    entries: BTreeMap<String, Zeroizing<Vec<u8>>>,
}

impl std::fmt::Debug for Archive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Archive").field("entries", &self.entries.keys().collect::<Vec<_>>()).finish()
    }
}

/// Paths are relative, `/`-separated, ASCII `[A-Za-z0-9._-]` segments. This
/// prevents path traversal ("zip-slip") if icons are ever extracted to disk.
pub fn validate_entry_path(path: &str) -> Result<()> {
    let ok = !path.is_empty()
        && path.len() <= 255
        && path.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        });
    if ok {
        Ok(())
    } else {
        Err(Error::invalid(format!("illegal archive path {path:?}")))
    }
}

impl Archive {
    pub fn insert(&mut self, path: &str, data: Vec<u8>) -> Result<()> {
        validate_entry_path(path)?;
        if path == MANIFEST_ENTRY {
            return Err(Error::invalid("manifest is generated automatically"));
        }
        self.entries.insert(path.to_string(), Zeroizing::new(data));
        Ok(())
    }

    pub fn get(&self, path: &str) -> Option<&[u8]> {
        self.entries.get(path).map(|v| v.as_slice())
    }

    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.entries.keys().map(|s| s.as_str())
    }

    pub fn encode(&self, vault_id: &[u8; 16], generation: u64) -> Result<Zeroizing<Vec<u8>>> {
        let manifest = Manifest {
            format: "kurogane-archive/1".into(),
            vault_id: uuid::Uuid::from_bytes(*vault_id).to_string(),
            generation,
            entries: self
                .entries
                .iter()
                .map(|(p, d)| ManifestEntry { path: p.clone(), size: d.len() as u64, sha256: crypto::hex(&crypto::sha256(d)) })
                .collect(),
        };
        let manifest_json = serde_json::to_vec(&manifest)?;
        let total: usize =
            10 + self.entries.iter().map(|(p, d)| 10 + p.len() + d.len()).sum::<usize>() + 10 + MANIFEST_ENTRY.len() + manifest_json.len();
        let mut out = Zeroizing::new(Vec::with_capacity(total));
        out.extend_from_slice(ARCHIVE_MAGIC);
        out.extend_from_slice(&ARCHIVE_VERSION.to_le_bytes());
        out.extend_from_slice(&((self.entries.len() + 1) as u32).to_le_bytes());
        let mut put = |path: &str, data: &[u8]| {
            out.extend_from_slice(&(path.len() as u16).to_le_bytes());
            out.extend_from_slice(path.as_bytes());
            out.extend_from_slice(&(data.len() as u64).to_le_bytes());
            out.extend_from_slice(data);
        };
        put(MANIFEST_ENTRY, &manifest_json);
        for (p, d) in &self.entries {
            put(p, d);
        }
        Ok(out)
    }

    /// Decode and verify against the manifest. `expect` binds the manifest to
    /// the header that carried it.
    pub fn decode(buf: &[u8], expect_vault_id: &[u8; 16], expect_generation: u64) -> Result<Self> {
        let mut r = Reader { buf, pos: 0 };
        if r.take(4)? != ARCHIVE_MAGIC {
            return Err(Error::Integrity("archive magic".into()));
        }
        if u16::from_le_bytes(r.take(2)?.try_into().unwrap()) != ARCHIVE_VERSION {
            return Err(Error::Integrity("archive version".into()));
        }
        let count = u32::from_le_bytes(r.take(4)?.try_into().unwrap());
        if count == 0 || count > MAX_ENTRIES {
            return Err(Error::Integrity("archive entry count".into()));
        }
        let mut raw: Vec<(String, &[u8])> = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let plen = u16::from_le_bytes(r.take(2)?.try_into().unwrap()) as usize;
            let path = std::str::from_utf8(r.take(plen)?).map_err(|_| Error::Integrity("non-UTF-8 path".into()))?.to_string();
            let dlen = u64::from_le_bytes(r.take(8)?.try_into().unwrap());
            let data = r.take(usize::try_from(dlen).map_err(|_| Error::Integrity("entry too large".into()))?)?;
            raw.push((path, data));
        }
        if r.pos != buf.len() {
            return Err(Error::Integrity("trailing bytes after archive".into()));
        }
        let (first_path, manifest_bytes) = &raw[0];
        if first_path != MANIFEST_ENTRY {
            return Err(Error::Integrity("manifest must be the first entry".into()));
        }
        let manifest: Manifest = serde_json::from_slice(manifest_bytes)?;
        if manifest.format != "kurogane-archive/1"
            || manifest.vault_id != uuid::Uuid::from_bytes(*expect_vault_id).to_string()
            || manifest.generation != expect_generation
        {
            return Err(Error::Integrity("manifest does not match header".into()));
        }
        if manifest.entries.len() != raw.len() - 1 {
            return Err(Error::Integrity("manifest entry count mismatch".into()));
        }
        let mut entries = BTreeMap::new();
        for ((path, data), m) in raw.iter().skip(1).zip(manifest.entries.iter()) {
            validate_entry_path(path).map_err(|_| Error::Integrity(format!("bad path {path:?}")))?;
            if &m.path != path || m.size != data.len() as u64 || m.sha256 != crypto::hex(&crypto::sha256(data)) {
                return Err(Error::Integrity(format!("entry {path:?} does not match manifest")));
            }
            if entries.insert(path.clone(), Zeroizing::new(data.to_vec())).is_some() {
                return Err(Error::Integrity(format!("duplicate entry {path:?}")));
            }
        }
        Ok(Archive { entries })
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.buf.len()).ok_or_else(|| Error::Integrity("archive truncated".into()))?;
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Header, KeyRing) {
        let kdf = KdfParams::insecure_for_tests();
        let salt = crypto::random_bytes();
        let mek = derive_mek(b"correct horse", &salt, &kdf).unwrap();
        let vdk = Key256::random();
        let vault_id = *uuid::Uuid::new_v4().as_bytes();
        let header = Header::new(kdf, salt, vault_id, &mek, &vdk).unwrap();
        (header, KeyRing::derive(vdk, vault_id))
    }

    fn sample_archive() -> Archive {
        let mut a = Archive::default();
        a.insert(DB_ENTRY, b"sqlcipher-bytes".to_vec()).unwrap();
        a.insert("icons/proxmox.svg", b"<svg/>".to_vec()).unwrap();
        a
    }

    #[test]
    fn header_roundtrip_is_byte_exact() {
        let (h, _) = fixture();
        let enc = h.encode();
        assert_eq!(&enc[..9], MAGIC);
        let dec = Header::decode(&enc).unwrap();
        assert_eq!(dec, h);
        assert_eq!(dec.encode(), enc);
    }

    #[test]
    fn seal_open_roundtrip_with_password() {
        let (mut h, keys) = fixture();
        let file = seal(&mut h, &keys, &sample_archive(), 1_700_000_000_000).unwrap();
        assert_eq!(h.generation, 1);
        let (h2, _keys2, out) = open(&file, b"correct horse").unwrap();
        assert_eq!(h2, h);
        let archive = Archive::decode(&out, &h2.vault_id, h2.generation).unwrap();
        assert_eq!(archive.get(DB_ENTRY).unwrap(), b"sqlcipher-bytes");
        assert_eq!(archive.get("icons/proxmox.svg").unwrap(), b"<svg/>");
    }

    #[test]
    fn wrong_password_and_tampering_fail_closed() {
        let (mut h, keys) = fixture();
        let file = seal(&mut h, &keys, &sample_archive(), 0).unwrap();
        assert!(matches!(open(&file, b"wrong"), Err(Error::AuthFailed)));

        // Lineage forgery (outside the wrap AAD) is caught by the payload AAD.
        let mut forged = file.clone();
        forged[136] ^= 0x01; // generation
        assert!(matches!(open(&forged, b"correct horse"), Err(Error::AuthFailed)));

        // Salt swap is caught by the VDK wrap.
        let mut forged = file.clone();
        forged[30] ^= 0x01;
        assert!(matches!(open(&forged, b"correct horse"), Err(Error::AuthFailed)));

        // Truncation is caught before any crypto runs.
        assert!(matches!(open(&file[..file.len() - 1], b"correct horse"), Err(Error::Malformed(_))));

        let mut bad_magic = file.clone();
        bad_magic[0] = b'X';
        assert!(matches!(read_header(&bad_magic), Err(Error::BadMagic)));
    }

    #[test]
    fn lineage_advances_per_save() {
        let (mut h, keys) = fixture();
        seal(&mut h, &keys, &sample_archive(), 0).unwrap();
        let first = h.save_id;
        seal(&mut h, &keys, &Archive::default(), 1).unwrap();
        assert_eq!(h.generation, 2);
        assert_eq!(h.parent_save_id, first);
        assert_ne!(h.save_id, first);
    }

    #[test]
    fn archive_rejects_traversal_and_manifest_mismatch() {
        let mut a = Archive::default();
        assert!(a.insert("../etc/passwd", vec![]).is_err());
        assert!(a.insert("/abs", vec![]).is_err());
        assert!(a.insert("icons//x", vec![]).is_err());
        a.insert("icons/a.png", vec![1, 2, 3]).unwrap();
        let id = [9u8; 16];
        let enc = a.encode(&id, 4).unwrap();
        assert!(Archive::decode(&enc, &id, 4).is_ok());
        assert!(Archive::decode(&enc, &id, 5).is_err());
        let mut corrupt = enc.to_vec();
        *corrupt.last_mut().unwrap() ^= 0xff;
        assert!(matches!(Archive::decode(&corrupt, &id, 4), Err(Error::Integrity(_))));
    }
}
