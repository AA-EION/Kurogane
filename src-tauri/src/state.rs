//! Process-wide state. The only place an [`UnlockedVault`] lives; dropping it
//! (lock) zeroizes every key page and shreds the working database.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kurogane_core::session::{LockReason, SessionClock};
use kurogane_core::vault::UnlockedVault;
use kurogane_sync::rclone::{Provider, RemoteSection};
use serde::{Deserialize, Serialize};

use crate::clipboard::ClipboardWorker;

#[derive(Clone, Debug)]
pub struct Paths {
    pub data: PathBuf,
    pub config_file: PathBuf,
}

impl Paths {
    pub fn work(&self) -> PathBuf {
        self.data.join("work")
    }
    pub fn sandbox(&self) -> PathBuf {
        self.data.join("sandbox")
    }
    pub fn vaults(&self) -> PathBuf {
        self.data.join("vaults")
    }
    pub fn scratch(&self) -> PathBuf {
        self.data.join("tmp")
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub last_vault_path: Option<PathBuf>,
}

impl AppConfig {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn save(&self, path: &Path) {
        if let Some(p) = path.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        if let Ok(json) = serde_json::to_vec_pretty(self) {
            let _ = kurogane_core::fsutil::atomic_write(path, &json, false);
        }
    }
}

/// A cloud link established before the vault was unlocked (first-run
/// "Connect cloud vault"); sealed into the vault right after unlock.
pub struct PendingRemote {
    pub provider: Provider,
    pub section: RemoteSection,
    pub remote_path: String,
}

#[derive(Default)]
pub struct SyncRuntime {
    pub busy: bool,
    pub transport: Option<String>,
    pub last_outcome: Option<String>,
    pub last_synced_at_ms: Option<i64>,
}

#[derive(Default)]
pub struct Inner {
    pub vault_path: Option<PathBuf>,
    pub vault: Option<UnlockedVault>,
    pub session: Option<SessionClock>,
    pub last_lock_reason: Option<LockReason>,
    pub failed_unlocks: u32,
    pub unlock_not_before: Option<Instant>,
    pub pending_remote: Option<PendingRemote>,
    pub sync: SyncRuntime,
}

pub struct AppState {
    pub inner: Mutex<Inner>,
    pub paths: Paths,
    pub clipboard: ClipboardWorker,
}

impl AppState {
    /// Lock: persist pending audit entries, then drop all key material.
    pub fn lock_inner(&self, inner: &mut Inner, reason: LockReason) -> bool {
        let Some(mut v) = inner.vault.take() else { return false };
        if let Err(e) = v.save_if_dirty() {
            eprintln!("save on lock failed: {e}");
        }
        drop(v);
        inner.session = None;
        inner.last_lock_reason = Some(reason);
        self.clipboard.clear_if_ours();
        true
    }

    /// Exponential back-off after repeated failures (3 free attempts, then
    /// 2 s, 4 s, … capped at 60 s). Argon2id already makes each guess slow.
    pub fn register_failure(inner: &mut Inner) {
        inner.failed_unlocks += 1;
        if inner.failed_unlocks >= 3 {
            let secs = 2u64.saturating_pow(inner.failed_unlocks - 2).min(60);
            inner.unlock_not_before = Some(Instant::now() + Duration::from_secs(secs));
        }
    }
}
