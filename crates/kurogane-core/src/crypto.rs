//! Thin, misuse-resistant wrappers over AES-256-GCM and the OS CSPRNG.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::secure::Key256;

pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;

/// Version byte prefixed to every sealed field blob.
const SEALED_V1: u8 = 0x01;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).expect("OS CSPRNG unavailable");
    b
}

/// 96-bit random nonce. Under one key we stay far below the 2^32-message
/// birthday bound recommended by NIST SP 800-38D for random nonces: a vault is
/// re-sealed once per save, and every password change rotates the wrap key.
pub fn random_nonce() -> [u8; NONCE_LEN] {
    random_bytes()
}

pub fn encrypt(key: &Key256, nonce: &[u8; NONCE_LEN], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key.expose()).map_err(|_| Error::Crypto)?;
    cipher.encrypt(Nonce::from_slice(nonce), Payload { msg: plaintext, aad }).map_err(|_| Error::Crypto)
}

pub fn decrypt(key: &Key256, nonce: &[u8; NONCE_LEN], aad: &[u8], ciphertext: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let cipher = Aes256Gcm::new_from_slice(key.expose()).map_err(|_| Error::Crypto)?;
    cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: ciphertext, aad }).map(Zeroizing::new).map_err(|_| Error::AuthFailed)
}

/// Field-level sealing used for secret columns, the TOTP seed and sync tokens.
///
/// Layout: `0x01 ‖ nonce[12] ‖ ciphertext ‖ tag[16]`. The AAD binds the blob to
/// its row and column (e.g. `cred:<uuid>:secret`) so ciphertexts cannot be
/// swapped between records inside the database.
pub fn seal(key: &Key256, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let nonce = random_nonce();
    let ct = encrypt(key, &nonce, aad, plaintext)?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + ct.len());
    out.push(SEALED_V1);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn unseal(key: &Key256, aad: &[u8], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if blob.len() < 1 + NONCE_LEN + TAG_LEN || blob[0] != SEALED_V1 {
        return Err(Error::malformed("sealed field has unknown version or is truncated"));
    }
    let nonce: [u8; NONCE_LEN] = blob[1..1 + NONCE_LEN].try_into().expect("length checked");
    decrypt(key, &nonce, aad, &blob[1 + NONCE_LEN..])
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn hex(data: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_roundtrip_and_aad_binding() {
        let k = Key256::random();
        let blob = seal(&k, b"cred:1:secret", b"hunter2").unwrap();
        assert_eq!(&*unseal(&k, b"cred:1:secret", &blob).unwrap(), b"hunter2");
        assert!(matches!(unseal(&k, b"cred:2:secret", &blob), Err(Error::AuthFailed)));
        let mut tampered = blob.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(unseal(&k, b"cred:1:secret", &tampered).is_err());
    }
}
