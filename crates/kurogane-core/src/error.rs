use thiserror::Error;

/// Errors surfaced by the vault kernel.
///
/// Authentication failures are deliberately coarse: a wrong password, a
/// tampered header and a corrupted payload all map to [`Error::AuthFailed`] so
/// the UI never becomes a decryption oracle.
#[derive(Debug, Error)]
pub enum Error {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not a Kurogane vault (bad magic bytes)")]
    BadMagic,
    #[error("unsupported vault format version {0}")]
    UnsupportedVersion(u16),
    #[error("malformed vault: {0}")]
    Malformed(String),
    #[error("wrong master password or corrupted vault")]
    AuthFailed,
    #[error("a two-factor code is required to unlock this vault")]
    TotpRequired,
    #[error("invalid or reused two-factor code")]
    TotpInvalid,
    #[error("integrity check failed: {0}")]
    Integrity(String),
    #[error("key-derivation parameters rejected: {0}")]
    KdfParams(String),
    #[error("cryptographic operation failed")]
    Crypto,
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("this build of SQLite does not include SQLCipher; refusing to store data unencrypted")]
    SqlCipherMissing,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("launch failed: {0}")]
    Launch(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub(crate) fn malformed(msg: impl Into<String>) -> Self {
        Error::Malformed(msg.into())
    }
    pub(crate) fn invalid(msg: impl Into<String>) -> Self {
        Error::Invalid(msg.into())
    }
}
