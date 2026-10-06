//! One sync round: peek → decide → act, with local and remote backups and
//! validation before anything is replaced.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kurogane_core::container::{self, Header, Lineage, HEADER_LEN};
use kurogane_core::fsutil;
use serde::Serialize;

use crate::error::{Result, SyncError};
use crate::platform::RCLONE_IMAGE;
use crate::provision::Provisioner;
use crate::rclone::RemoteSection;
use crate::reconcile::{decide, Decision};
use crate::sandbox::Sandbox;
use crate::state::{DeviceSyncState, RemoteState};
use crate::transport::{BinaryRunner, ContainerRunner, ContainerRuntime, RcloneTransport, Transport};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransportPreference {
    /// Container sidecar when Docker/Podman is healthy, else sandboxed binary.
    Auto,
    Container,
    Binary,
}

/// Pick and prepare a transport. `progress` reports binary download bytes.
pub fn select_transport(
    sandbox: &Sandbox,
    pref: TransportPreference,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<Arc<dyn Transport>> {
    if pref != TransportPreference::Binary {
        match ContainerRuntime::detect() {
            Some(rt) => match rt.ensure_image(RCLONE_IMAGE) {
                Ok(()) => {
                    let runner = ContainerRunner { runtime: rt, image: RCLONE_IMAGE.into() };
                    return Ok(Arc::new(RcloneTransport::new(Box::new(runner), sandbox.clone())));
                }
                Err(e) if pref == TransportPreference::Container => return Err(e),
                Err(_) => {}
            },
            None if pref == TransportPreference::Container => return Err(SyncError::NoContainerRuntime),
            None => {}
        }
    }
    let binary = Provisioner::new(sandbox)?.ensure(progress)?;
    Ok(Arc::new(RcloneTransport::new(Box::new(BinaryRunner { binary, sandbox: sandbox.clone() }), sandbox.clone())))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SyncOutcome {
    Nothing,
    InSync,
    Pushed { save_id: String },
    Pulled { save_id: String, local_backup: Option<PathBuf> },
    Conflict { conflict_copy: PathBuf, local: Lineage, remote: Lineage },
}

pub struct SyncReport {
    pub decision: Decision,
    pub outcome: SyncOutcome,
    /// OAuth tokens refreshed during the round — re-seal into the vault.
    pub refreshed_section: Option<RemoteSection>,
}

pub struct SyncJob<'a> {
    /// `sync_remotes.id` (keys the device-local state).
    pub remote_id: &'a str,
    pub section: &'a RemoteSection,
    pub remote_path: &'a str,
    pub local_vault: &'a Path,
}

/// Full validation of a downloaded candidate (decrypt + manifest) — supplied
/// by the caller when the vault is unlocked; header-only checks otherwise.
pub type Validator<'a> = &'a dyn Fn(&[u8]) -> kurogane_core::Result<()>;

pub struct SyncEngine {
    pub sandbox: Sandbox,
    pub transport: Arc<dyn Transport>,
}

fn conflict_path(local: &Path, remote: &Lineage) -> PathBuf {
    let stem = local.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "vault".into());
    let short = &remote.save_id[..remote.save_id.len().min(8)];
    local.with_file_name(format!("{stem}.conflict-{short}.kurogane"))
}

impl SyncEngine {
    pub fn new(sandbox: Sandbox, transport: Arc<dyn Transport>) -> Self {
        Self { sandbox, transport }
    }

    fn remote_lineage(&self, job: &SyncJob<'_>) -> Result<Option<Lineage>> {
        match self.transport.read_head(job.section, job.remote_path, HEADER_LEN)? {
            None => Ok(None),
            Some(head) => {
                let h = Header::decode(&head).map_err(|e| SyncError::NotAVault(e.to_string()))?;
                Ok(Some(h.lineage()))
            }
        }
    }

    fn fetch_validated(&self, job: &SyncJob<'_>, expect_vault: Option<&str>, validate: Validator<'_>) -> Result<(Vec<u8>, Header)> {
        let staged = self.sandbox.staging().join(format!("{}.kurogane", uuid::Uuid::new_v4().simple()));
        let res = (|| {
            self.transport.download(job.section, job.remote_path, &staged)?;
            let bytes = std::fs::read(&staged)?;
            let header = container::read_header(&bytes)?;
            if let Some(v) = expect_vault {
                let got = header.lineage().vault_id;
                if got != v {
                    return Err(SyncError::ForeignVault { local: v.into(), remote: got });
                }
            }
            validate(&bytes)?;
            Ok((bytes, header))
        })();
        let _ = std::fs::remove_file(&staged);
        res
    }

    fn lock_file(job: &SyncJob<'_>) -> Result<fd_lock::RwLock<std::fs::File>> {
        let mut s = job.local_vault.as_os_str().to_owned();
        s.push(".sync.lock");
        let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(PathBuf::from(s))?;
        Ok(fd_lock::RwLock::new(f))
    }

    fn record(&self, job: &SyncJob<'_>, vault_id: String, save_id: String) -> Result<()> {
        let mut state = DeviceSyncState::load(&self.sandbox)?;
        state.remotes.insert(
            job.remote_id.to_string(),
            RemoteState { vault_id, last_synced_save_id: Some(save_id), last_synced_at_ms: Some(kurogane_core::vault::now_ms()) },
        );
        state.save(&self.sandbox)
    }

    /// Conflict resolution "keep this device": overwrite the remote with the
    /// local vault (the previous remote copy is kept as `<path>.bak`).
    pub fn force_push(&self, job: &SyncJob<'_>) -> Result<SyncOutcome> {
        let mut lock = Self::lock_file(job)?;
        let _guard = lock.try_write().map_err(|_| SyncError::Busy)?;
        let l = kurogane_core::vault::peek(job.local_vault)?.lineage();
        self.transport.upload(job.local_vault, job.section, job.remote_path)?;
        let after = self.remote_lineage(job)?.ok_or_else(|| SyncError::Download("upload vanished".into()))?;
        if after.save_id != l.save_id {
            return Err(SyncError::Download("remote does not match the uploaded save".into()));
        }
        self.record(job, l.vault_id, l.save_id.clone())?;
        Ok(SyncOutcome::Pushed { save_id: l.save_id })
    }

    /// Conflict resolution "use the other copy": validate `candidate` (e.g.
    /// the conflict copy), back up the local vault and swap the candidate in.
    pub fn adopt_file(&self, job: &SyncJob<'_>, candidate: &Path, validate: Validator<'_>) -> Result<SyncOutcome> {
        let mut lock = Self::lock_file(job)?;
        let _guard = lock.try_write().map_err(|_| SyncError::Busy)?;
        let bytes = std::fs::read(candidate)?;
        let header = container::read_header(&bytes)?;
        if job.local_vault.exists() {
            let local = kurogane_core::vault::peek(job.local_vault)?;
            if local.vault_id != header.vault_id {
                return Err(SyncError::ForeignVault { local: local.lineage().vault_id, remote: header.lineage().vault_id });
            }
        }
        validate(&bytes)?;
        fsutil::atomic_write(job.local_vault, &bytes, true)?;
        let lin = header.lineage();
        self.record(job, lin.vault_id, lin.save_id.clone())?;
        Ok(SyncOutcome::Pulled { save_id: lin.save_id, local_backup: Some(fsutil::backup_path(job.local_vault)) })
    }

    pub fn sync_once(&self, job: &SyncJob<'_>, validate: Validator<'_>) -> Result<SyncReport> {
        // One sync per vault at a time, across processes.
        let mut lock = Self::lock_file(job)?;
        let _guard = lock.try_write().map_err(|_| SyncError::Busy)?;

        let state = DeviceSyncState::load(&self.sandbox)?;
        let local = if job.local_vault.exists() { Some(kurogane_core::vault::peek(job.local_vault)?.lineage()) } else { None };
        let remote = self.remote_lineage(job)?;
        let base = state.remotes.get(job.remote_id).and_then(|s| s.last_synced_save_id.clone());
        let decision = decide(local.as_ref(), remote.as_ref(), base.as_deref());

        let outcome = match decision {
            Decision::Nothing => SyncOutcome::Nothing,
            Decision::InSync => SyncOutcome::InSync,
            Decision::ForeignVault => {
                return Err(SyncError::ForeignVault {
                    local: local.map(|l| l.vault_id).unwrap_or_default(),
                    remote: remote.map(|r| r.vault_id).unwrap_or_default(),
                })
            }
            Decision::Push | Decision::FirstUpload => {
                let l = local.clone().expect("local exists for push");
                self.transport.upload(job.local_vault, job.section, job.remote_path)?;
                // Read back and confirm the remote now carries our save.
                let after = self.remote_lineage(job)?.ok_or_else(|| SyncError::Download("upload vanished".into()))?;
                if after.save_id != l.save_id {
                    return Err(SyncError::Download("remote does not match the uploaded save".into()));
                }
                SyncOutcome::Pushed { save_id: l.save_id }
            }
            Decision::Pull | Decision::FirstDownload => {
                let expect = local.as_ref().map(|l| l.vault_id.as_str());
                let (bytes, header) = self.fetch_validated(job, expect, validate)?;
                let had_local = job.local_vault.exists();
                fsutil::atomic_write(job.local_vault, &bytes, true)?;
                SyncOutcome::Pulled {
                    save_id: header.lineage().save_id,
                    local_backup: had_local.then(|| fsutil::backup_path(job.local_vault)),
                }
            }
            Decision::Conflict => {
                let (l, r) = (local.clone().unwrap(), remote.clone().unwrap());
                let (bytes, _) = self.fetch_validated(job, Some(&l.vault_id), validate)?;
                let path = conflict_path(job.local_vault, &r);
                fsutil::atomic_write(&path, &bytes, false)?;
                SyncOutcome::Conflict { conflict_copy: path, local: l, remote: r }
            }
        };

        let synced = match &outcome {
            SyncOutcome::Pushed { save_id } | SyncOutcome::Pulled { save_id, .. } => Some(save_id.clone()),
            SyncOutcome::InSync => local.as_ref().map(|l| l.save_id.clone()),
            _ => None,
        };
        if let Some(save_id) = synced {
            self.record(job, local.or(remote).map(|l| l.vault_id).unwrap_or_default(), save_id)?;
        }
        Ok(SyncReport { decision, outcome, refreshed_section: self.transport.take_refreshed() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rclone::Provider;
    use crate::transport::FolderTransport;
    use kurogane_core::kdf::KdfParams;
    use kurogane_core::vault::{CreateOptions, UnlockedVault};

    const PW: &[u8] = b"sync test password";

    fn opts() -> CreateOptions {
        CreateOptions { display_name: "Sync".into(), kdf: KdfParams::insecure_for_tests(), totp_account: "t".into() }
    }

    fn header_only(_: &[u8]) -> kurogane_core::Result<()> {
        Ok(())
    }

    /// Two devices sharing one remote: upload, fast-forward pull, push back,
    /// then a fork that must produce a conflict copy instead of data loss.
    #[test]
    fn two_device_round_trip_and_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let remote_dir = tmp.path().join("cloud");
        let section = RemoteSection::new(Provider::Local);
        let mk = |name: &str| {
            let sb = Sandbox::open(tmp.path().join(name).join("sandbox")).unwrap();
            SyncEngine::new(sb, Arc::new(FolderTransport { root: remote_dir.clone() }))
        };
        let (dev_a, dev_b) = (mk("a"), mk("b"));
        let path_a = tmp.path().join("a").join("infra.kurogane");
        let path_b = tmp.path().join("b").join("infra.kurogane");
        let job = |p: &'static Path| SyncJob { remote_id: "r1", section: &section, remote_path: "Kurogane/infra.kurogane", local_vault: p };
        let path_a: &'static Path = Box::leak(path_a.into_boxed_path());
        let path_b: &'static Path = Box::leak(path_b.into_boxed_path());

        // Device A creates and uploads.
        let (mut va, _) = UnlockedVault::create(path_a, &tmp.path().join("a/work"), PW, &opts()).unwrap();
        let r = dev_a.sync_once(&job(path_a), &header_only).unwrap();
        assert_eq!(r.decision, Decision::FirstUpload);

        // Device B connects to the cloud vault (first download).
        let r = dev_b.sync_once(&job(path_b), &header_only).unwrap();
        assert_eq!(r.decision, Decision::FirstDownload);
        let mut vb = UnlockedVault::unlock(path_b, &tmp.path().join("b/work"), PW, None).unwrap();

        // A edits and pushes; B pulls with full cryptographic validation.
        va.add_icon("a.svg", b"<svg/>".to_vec()).unwrap();
        va.save().unwrap();
        assert_eq!(dev_a.sync_once(&job(path_a), &header_only).unwrap().decision, Decision::Push);
        let validate = |bytes: &[u8]| vb.validate_candidate(bytes).map(|_| ());
        let r = dev_b.sync_once(&job(path_b), &validate).unwrap();
        assert_eq!(r.decision, Decision::Pull);
        assert!(matches!(r.outcome, SyncOutcome::Pulled { local_backup: Some(_), .. }));
        vb.reload().unwrap();
        assert!(vb.icon("icons/a.svg").is_some());
        assert_eq!(dev_b.sync_once(&job(path_b), &header_only).unwrap().decision, Decision::InSync);

        // Both edit offline → conflict; neither side is overwritten.
        va.add_icon("only-a.svg", vec![1]).unwrap();
        va.save().unwrap();
        vb.add_icon("only-b.svg", vec![2]).unwrap();
        vb.save().unwrap();
        assert_eq!(dev_a.sync_once(&job(path_a), &header_only).unwrap().decision, Decision::Push);
        let before_b = std::fs::read(path_b).unwrap();
        let r = dev_b.sync_once(&job(path_b), &header_only).unwrap();
        assert_eq!(r.decision, Decision::Conflict);
        let SyncOutcome::Conflict { conflict_copy, .. } = r.outcome else { panic!() };
        assert!(conflict_copy.exists());
        assert_eq!(std::fs::read(path_b).unwrap(), before_b, "local vault untouched on conflict");

        // Resolve on B by adopting the cloud copy → back in sync.
        let validate = |bytes: &[u8]| vb.validate_candidate(bytes).map(|_| ());
        dev_b.adopt_file(&job(path_b), &conflict_copy, &validate).unwrap();
        vb.reload().unwrap();
        assert!(vb.icon("icons/only-a.svg").is_some());
        assert_eq!(dev_b.sync_once(&job(path_b), &header_only).unwrap().decision, Decision::InSync);

        // Fork again and resolve on B with "keep mine".
        va.add_icon("a2.svg", vec![3]).unwrap();
        va.save().unwrap();
        dev_a.sync_once(&job(path_a), &header_only).unwrap();
        vb.add_icon("b2.svg", vec![4]).unwrap();
        vb.save().unwrap();
        assert_eq!(dev_b.sync_once(&job(path_b), &header_only).unwrap().decision, Decision::Conflict);
        dev_b.force_push(&job(path_b)).unwrap();
        assert_eq!(dev_b.sync_once(&job(path_b), &header_only).unwrap().decision, Decision::InSync);
        assert_eq!(dev_a.sync_once(&job(path_a), &header_only).unwrap().decision, Decision::Pull);
    }

    #[test]
    fn refuses_foreign_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let section = RemoteSection::new(Provider::Local);
        let remote_dir = tmp.path().join("cloud");
        let p1 = tmp.path().join("one.kurogane");
        let p2 = tmp.path().join("two.kurogane");
        let (_v1, _) = UnlockedVault::create(&p1, &tmp.path().join("w1"), PW, &opts()).unwrap();
        let (_v2, _) = UnlockedVault::create(&p2, &tmp.path().join("w2"), PW, &opts()).unwrap();
        let eng = SyncEngine::new(Sandbox::open(tmp.path().join("sb")).unwrap(), Arc::new(FolderTransport { root: remote_dir }));
        let j1 = SyncJob { remote_id: "r", section: &section, remote_path: "v.kurogane", local_vault: &p1 };
        eng.sync_once(&j1, &header_only).unwrap();
        let j2 = SyncJob { remote_id: "r", section: &section, remote_path: "v.kurogane", local_vault: &p2 };
        assert!(matches!(eng.sync_once(&j2, &header_only), Err(SyncError::ForeignVault { .. })));
    }
}
