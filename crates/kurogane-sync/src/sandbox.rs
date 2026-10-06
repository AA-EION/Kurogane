//! Kurogane's private sync sandbox (inside the OS app-data directory):
//!
//! ```text
//! <app-data>/sandbox/
//!   engines/rclone/<version>/rclone[.exe]   pinned binary + .sha256 tamper record
//!   home/                                   fake $HOME / %USERPROFILE% for rclone
//!   cache/                                  rclone cache dir
//!   run/<uuid>/rclone.conf                  per-invocation config (shredded after)
//!   staging/                                downloads awaiting validation
//!   state/sync-state.json                   device-local sync lineage
//! ```
//! All directories are created 0700 on Unix.

use std::path::{Path, PathBuf};

use kurogane_core::fsutil;

use crate::error::Result;

#[derive(Clone, Debug)]
pub struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let s = Sandbox { root: root.into() };
        for d in [s.root.clone(), s.engines(), s.home(), s.cache(), s.run_root(), s.staging(), s.state()] {
            fsutil::create_private_dir(&d)?;
        }
        Ok(s)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn engines(&self) -> PathBuf {
        self.root.join("engines")
    }
    pub fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    pub fn cache(&self) -> PathBuf {
        self.root.join("cache")
    }
    pub fn run_root(&self) -> PathBuf {
        self.root.join("run")
    }
    pub fn staging(&self) -> PathBuf {
        self.root.join("staging")
    }
    pub fn state(&self) -> PathBuf {
        self.root.join("state")
    }

    pub fn new_run_dir(&self) -> Result<RunDir> {
        let path = self.run_root().join(uuid::Uuid::new_v4().simple().to_string());
        fsutil::create_private_dir(&path)?;
        Ok(RunDir { path })
    }

    /// Remove run directories left behind by a crash.
    pub fn sweep_stale_runs(&self) {
        if let Ok(rd) = std::fs::read_dir(self.run_root()) {
            for e in rd.flatten() {
                drop(RunDir { path: e.path() });
            }
        }
    }
}

/// A throw-away directory for one rclone invocation. Dropping it shreds its
/// files (the materialised `rclone.conf` holds OAuth tokens).
pub struct RunDir {
    path: PathBuf,
}

impl RunDir {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn config_path(&self) -> PathBuf {
        self.path.join("rclone.conf")
    }
}

impl Drop for RunDir {
    fn drop(&mut self) {
        if let Ok(rd) = std::fs::read_dir(&self.path) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    let _ = std::fs::remove_dir_all(&p);
                } else {
                    fsutil::shred(&p);
                }
            }
        }
        let _ = std::fs::remove_dir(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_dirs_are_shredded() {
        let tmp = tempfile::tempdir().unwrap();
        let sb = Sandbox::open(tmp.path().join("sb")).unwrap();
        let p;
        {
            let rd = sb.new_run_dir().unwrap();
            std::fs::write(rd.config_path(), "[kgremote]\ntoken = secret\n").unwrap();
            p = rd.path().to_path_buf();
            assert!(p.exists());
        }
        assert!(!p.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(sb.home()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
    }
}
