use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("vault error: {0}")]
    Vault(#[from] kurogane_core::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("download failed: {0}")]
    Download(String),
    #[error("checksum mismatch for {what}: expected {expected}, got {actual}")]
    Checksum { what: String, expected: String, actual: String },
    #[error("no pinned rclone build for this platform ({0})")]
    UnsupportedPlatform(String),
    #[error("rclone failed (exit {code:?}): {stderr}")]
    Rclone { code: Option<i32>, stderr: String },
    #[error("timed out after {0:?}")]
    Timeout(std::time::Duration),
    #[error("no container runtime available")]
    NoContainerRuntime,
    #[error("sync engine not provisioned; download it first")]
    NotProvisioned,
    #[error("authorization failed: {0}")]
    Auth(String),
    #[error("the remote file belongs to a different vault ({remote}) than the local one ({local})")]
    ForeignVault { local: String, remote: String },
    #[error("another sync is already running for this vault")]
    Busy,
    #[error("remote file is not a Kurogane vault: {0}")]
    NotAVault(String),
    #[error("invalid configuration: {0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, SyncError>;
