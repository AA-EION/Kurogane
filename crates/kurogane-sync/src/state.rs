//! Device-local sync state (outside the vault: it describes *this* device).

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::sandbox::Sandbox;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteState {
    pub vault_id: String,
    pub last_synced_save_id: Option<String>,
    pub last_synced_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncState {
    /// Keyed by sync-remote id.
    pub remotes: BTreeMap<String, RemoteState>,
}

impl DeviceSyncState {
    fn path(sandbox: &Sandbox) -> PathBuf {
        sandbox.state().join("sync-state.json")
    }

    pub fn load(sandbox: &Sandbox) -> Result<Self> {
        match std::fs::read(Self::path(sandbox)) {
            Ok(b) => Ok(serde_json::from_slice(&b)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, sandbox: &Sandbox) -> Result<()> {
        kurogane_core::fsutil::atomic_write(&Self::path(sandbox), &serde_json::to_vec_pretty(self)?, false)?;
        Ok(())
    }
}
