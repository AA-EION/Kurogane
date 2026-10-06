//! Subkey derivation from the Vault Data Key (VDK).

use hkdf::Hkdf;
use sha2::Sha256;

use crate::secure::Key256;

/// Domain-separated purposes. The `info` strings are part of the on-disk
/// format: changing one makes existing vaults unreadable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyPurpose {
    /// AES-256-GCM key for the container payload.
    Payload,
    /// Raw 256-bit SQLCipher key for the embedded database.
    Database,
    /// Column-level sealing of credential secrets.
    FieldSeal,
    /// Sealing of the portable TOTP seed.
    Totp,
    /// Sealing of cloud-sync remote configuration (OAuth tokens).
    Sync,
}

impl KeyPurpose {
    pub fn info(self) -> &'static [u8] {
        match self {
            KeyPurpose::Payload => b"kurogane/v1/payload",
            KeyPurpose::Database => b"kurogane/v1/sqlcipher",
            KeyPurpose::FieldSeal => b"kurogane/v1/field",
            KeyPurpose::Totp => b"kurogane/v1/totp",
            KeyPurpose::Sync => b"kurogane/v1/sync",
        }
    }
}

pub fn derive_subkey(vdk: &Key256, vault_id: &[u8; 16], purpose: KeyPurpose) -> Key256 {
    let hk = Hkdf::<Sha256>::new(Some(vault_id), vdk.expose());
    let mut out = Key256::new_zeroed();
    hk.expand(purpose.info(), out.expose_mut()).expect("32 bytes is a valid HKDF-SHA256 length");
    out
}

/// All keys an unlocked session needs, each in its own locked page.
#[derive(Debug)]
pub struct KeyRing {
    pub vault_id: [u8; 16],
    vdk: Key256,
    pub payload: Key256,
    pub database: Key256,
    pub field: Key256,
    pub totp: Key256,
    pub sync: Key256,
}

impl KeyRing {
    pub fn derive(vdk: Key256, vault_id: [u8; 16]) -> Self {
        Self {
            payload: derive_subkey(&vdk, &vault_id, KeyPurpose::Payload),
            database: derive_subkey(&vdk, &vault_id, KeyPurpose::Database),
            field: derive_subkey(&vdk, &vault_id, KeyPurpose::FieldSeal),
            totp: derive_subkey(&vdk, &vault_id, KeyPurpose::Totp),
            sync: derive_subkey(&vdk, &vault_id, KeyPurpose::Sync),
            vault_id,
            vdk,
        }
    }

    /// The VDK is only needed to re-wrap under a new master password.
    pub(crate) fn vdk(&self) -> &Key256 {
        &self.vdk
    }

    pub fn all_memory_locked(&self) -> bool {
        [&self.vdk, &self.payload, &self.database, &self.field, &self.totp, &self.sync].iter().all(|k| k.is_memory_locked())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purposes_are_separated() {
        let vdk = Key256::random();
        let id = [7u8; 16];
        let ring = KeyRing::derive(vdk, id);
        let keys = [&ring.payload, &ring.database, &ring.field, &ring.totp, &ring.sync];
        for (i, a) in keys.iter().enumerate() {
            for b in keys.iter().skip(i + 1) {
                assert_ne!(a.expose(), b.expose());
            }
        }
    }
}
