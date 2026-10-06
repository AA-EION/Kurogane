//! # kurogane-core
//!
//! The security kernel of KUROGANE (黒鉄). Everything that touches key material
//! or the vault file lives here so it can be audited and tested without the
//! desktop shell.
//!
//! Key hierarchy (see `docs/CRYPTO.md` for the byte-level specification):
//!
//! ```text
//! master password ──Argon2id(salt, m, t, p)──► MEK (never stored, zeroized after unwrap)
//!                                               │ AES-256-GCM unwrap (AAD = header[0..72])
//!                                               ▼
//!                                              VDK  (random 256-bit vault data key, mlocked)
//!                                               │ HKDF-SHA256(salt = vault_id, info = purpose)
//!          ┌──────────────┬──────────────┬──────┴───────┬──────────────┐
//!       payload        database        field          totp           sync
//!   (container AEAD)  (SQLCipher)  (secret columns) (TOTP seed)  (rclone tokens)
//! ```

pub mod container;
pub mod crypto;
pub mod db;
pub mod error;
pub mod fsutil;
pub mod kdf;
pub mod keys;
pub mod launch;
pub mod secure;
pub mod session;
pub mod totp;
pub mod vault;

pub use error::{Error, Result};
