//! Argon2id master-key derivation (RFC 9106).

use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::secure::Key256;

pub const SALT_LEN: usize = 32;

/// Argon2id cost parameters, stored in clear in the vault header so any
/// machine can re-derive the MEK.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_cost_kib: u32,
    /// Number of passes.
    pub t_cost: u32,
    /// Lanes / degree of parallelism.
    pub parallelism: u8,
}

impl KdfParams {
    /// Default for new vaults: 256 MiB, 3 passes, 4 lanes. Roughly 0.5–1.5 s
    /// on a 2020+ laptop and well above OWASP's Argon2id floor (19 MiB, t=2)
    /// and RFC 9106's memory-constrained option (64 MiB, t=3).
    pub const STANDARD: Self = Self { m_cost_kib: 256 * 1024, t_cost: 3, parallelism: 4 };
    /// 1 GiB, 4 passes. For vaults that also leave the device via cloud sync.
    pub const HARDENED: Self = Self { m_cost_kib: 1024 * 1024, t_cost: 4, parallelism: 4 };
    /// Below this we show a "weak KDF" warning and offer to re-key.
    pub const RECOMMENDED_FLOOR: Self = Self { m_cost_kib: 64 * 1024, t_cost: 3, parallelism: 1 };

    /// Upper bounds accepted when *opening* a file: a hostile header must not
    /// be able to make us allocate unbounded memory or spin forever.
    pub const MAX_M_COST_KIB: u32 = 4 * 1024 * 1024;
    pub const MAX_T_COST: u32 = 64;
    pub const MAX_PARALLELISM: u8 = 64;

    /// Cheap parameters for unit tests only. Never reachable from the UI.
    #[doc(hidden)]
    pub const fn insecure_for_tests() -> Self {
        Self { m_cost_kib: 64, t_cost: 1, parallelism: 1 }
    }

    pub fn check_bounds(&self) -> Result<()> {
        if self.parallelism == 0 || self.parallelism > Self::MAX_PARALLELISM {
            return Err(Error::KdfParams(format!("parallelism {} out of range", self.parallelism)));
        }
        if self.t_cost == 0 || self.t_cost > Self::MAX_T_COST {
            return Err(Error::KdfParams(format!("t_cost {} out of range", self.t_cost)));
        }
        if self.m_cost_kib < 8 * self.parallelism as u32 || self.m_cost_kib > Self::MAX_M_COST_KIB {
            return Err(Error::KdfParams(format!("m_cost {} KiB out of range", self.m_cost_kib)));
        }
        Ok(())
    }

    pub fn meets_recommended_floor(&self) -> bool {
        self.m_cost_kib >= Self::RECOMMENDED_FLOOR.m_cost_kib && self.t_cost >= Self::RECOMMENDED_FLOOR.t_cost
    }
}

impl Default for KdfParams {
    fn default() -> Self {
        Self::STANDARD
    }
}

/// Derive the 256-bit Master Encryption Key. The Argon2 working memory is
/// zeroized by the `argon2` crate (`zeroize` feature) when hashing completes.
pub fn derive_mek(password: &[u8], salt: &[u8; SALT_LEN], params: &KdfParams) -> Result<Key256> {
    params.check_bounds()?;
    if password.is_empty() {
        return Err(Error::invalid("master password must not be empty"));
    }
    let p =
        Params::new(params.m_cost_kib, params.t_cost, params.parallelism as u32, Some(32)).map_err(|e| Error::KdfParams(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    let mut mek = Key256::new_zeroed();
    argon.hash_password_into(password, salt, mek.expose_mut()).map_err(|e| Error::KdfParams(e.to_string()))?;
    Ok(mek)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_salt_sensitive() {
        let p = KdfParams::insecure_for_tests();
        let a = derive_mek(b"pw", &[1; 32], &p).unwrap();
        let b = derive_mek(b"pw", &[1; 32], &p).unwrap();
        let c = derive_mek(b"pw", &[2; 32], &p).unwrap();
        assert_eq!(a.expose(), b.expose());
        assert_ne!(a.expose(), c.expose());
    }

    #[test]
    fn rejects_hostile_params() {
        let mut p = KdfParams::STANDARD;
        p.m_cost_kib = u32::MAX;
        assert!(p.check_bounds().is_err());
        p = KdfParams::STANDARD;
        p.parallelism = 0;
        assert!(p.check_bounds().is_err());
        assert!(KdfParams::STANDARD.meets_recommended_floor());
        assert!(!KdfParams::insecure_for_tests().meets_recommended_floor());
    }

    /// RFC 9106 §5.3 Argon2id test vector: proves we are wired to the exact
    /// primitive (version 0x13, Argon2id) the spec describes.
    #[test]
    fn argon2id_rfc9106_vector() {
        let params = argon2::ParamsBuilder::new()
            .m_cost(32)
            .t_cost(3)
            .p_cost(4)
            .output_len(32)
            .data(argon2::AssociatedData::new(&[4u8; 12]).unwrap())
            .build()
            .unwrap();
        let a = Argon2::new_with_secret(&[3u8; 8], Algorithm::Argon2id, Version::V0x13, params).unwrap();
        let mut out = [0u8; 32];
        a.hash_password_into(&[1u8; 32], &[2u8; 16], &mut out).unwrap();
        assert_eq!(crate::crypto::hex(&out), "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
    }
}
