//! Cloud / folder sync: linking accounts, first-run "connect", background
//! auto-sync and conflict resolution. Network I/O never runs while the state
//! mutex is held; the validator re-acquires it only to decrypt a download.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kurogane_core::db::NewSyncRemote;
use kurogane_sync::engine::{select_transport, SyncEngine, SyncJob, SyncOutcome, TransportPreference};
use kurogane_sync::provision::Provisioner;
use kurogane_sync::rclone::{Provider, RemoteSection};
use kurogane_sync::sandbox::Sandbox;
use kurogane_sync::transport::{self, FolderTransport, Transport};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

use crate::commands::{err, CmdResult};
use crate::state::{AppState, ConflictInfo, PendingRemote};

pub const REMOTE_DIR: &str = "Kurogane";
const PERIODIC: Duration = Duration::from_secs(300);

pub fn provider_label(p: Provider) -> &'static str {
    match p {
        Provider::Drive => "Google Drive",
        Provider::OneDrive => "OneDrive",
        Provider::Mega => "MEGA",
        Provider::WebDav => "WebDAV",
        Provider::Local => "Synced folder",
    }
}

fn provider_from(s: &str) -> CmdResult<Provider> {
    match s {
        "drive" => Ok(Provider::Drive),
        "onedrive" => Ok(Provider::OneDrive),
        "mega" => Ok(Provider::Mega),
        "folder" | "local" => Ok(Provider::Local),
        other => Err(format!("unsupported provider {other}")),
    }
}

#[derive(Deserialize)]
pub struct MegaLogin {
    user: String,
    password: Zeroizing<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "step")]
pub enum CloudStep {
    Provisioning { done: u64, total: Option<u64> },
    Consent { url: String },
    Listing,
    Downloading,
    Done { vault_path: String },
    Error { message: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRemote {
    id: String,
    provider: String,
    label: String,
    remote_path: String,
    transport: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    linked: Vec<LinkedRemote>,
    auto_sync: bool,
    busy: bool,
    transport: Option<String>,
    last_outcome: Option<String>,
    last_error: Option<String>,
    last_synced_at_ms: Option<i64>,
    conflict: Option<ConflictInfo>,
}

fn status(state: &AppState) -> SyncStatusDto {
    let inner = state.inner.lock().unwrap();
    let linked = inner
        .vault
        .as_ref()
        .and_then(|v| v.db().sync_remotes().ok())
        .unwrap_or_default()
        .into_iter()
        .map(|r| LinkedRemote { id: r.id, provider: r.provider, label: r.label, remote_path: r.remote_path, transport: r.transport })
        .collect();
    SyncStatusDto {
        linked,
        auto_sync: inner.config.auto_sync,
        busy: inner.sync.busy,
        transport: inner.sync.transport.clone(),
        last_outcome: inner.sync.last_outcome.clone(),
        last_error: inner.sync.last_error.clone(),
        last_synced_at_ms: inner.sync.last_synced_at_ms,
        conflict: inner.sync.conflict.clone(),
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("sync://status", status(&app.state::<AppState>()));
}

fn sandbox(app: &AppHandle) -> CmdResult<Sandbox> {
    Sandbox::open(app.state::<AppState>().paths.sandbox()).map_err(err)
}

/// rclone transport (container sidecar or sandboxed binary), chosen once.
fn cloud_transport(app: &AppHandle) -> CmdResult<Arc<dyn Transport>> {
    let state = app.state::<AppState>();
    if let Some(t) = state.cloud_transport.lock().unwrap().clone() {
        return Ok(t);
    }
    let t = select_transport(&sandbox(app)?, TransportPreference::Auto, |_, _| {}).map_err(err)?;
    state.inner.lock().unwrap().sync.transport = Some(format!("{:?}", t.kind()).to_lowercase());
    *state.cloud_transport.lock().unwrap() = Some(t.clone());
    Ok(t)
}

/// Transport + path for one remote. Folder remotes store an absolute path.
fn transport_for(app: &AppHandle, provider: &str, remote_path: &str) -> CmdResult<(Arc<dyn Transport>, String)> {
    if provider == "local" {
        let (t, rel) = FolderTransport::for_file(Path::new(remote_path)).map_err(err)?;
        Ok((Arc::new(t), rel))
    } else {
        Ok((cloud_transport(app)?, remote_path.to_string()))
    }
}

/// Provision the engine and link an account: browser consent for Drive /
/// OneDrive (rclone's built-in client, no developer registration), login for MEGA.
fn link_account(app: &AppHandle, provider: Provider, mega: Option<MegaLogin>, step: &Channel<CloudStep>) -> CmdResult<RemoteSection> {
    let sb = sandbox(app)?;
    sb.sweep_stale_runs();
    let bin = Provisioner::new(&sb)
        .map_err(err)?
        .ensure(|done, total| {
            let _ = step.send(CloudStep::Provisioning { done, total });
        })
        .map_err(err)?;
    match provider {
        Provider::Mega => {
            let m = mega.ok_or("Enter your MEGA e-mail and password")?;
            transport::mega_section(&bin, &sb, &m.user, &m.password).map_err(err)
        }
        _ => {
            let opener = app.clone();
            transport::authorize_oauth(
                &bin,
                &sb,
                provider,
                &mut |url| {
                    let _ = step.send(CloudStep::Consent { url: url.to_string() });
                    let _ = opener.opener().open_url(url, None::<&str>);
                },
                Duration::from_secs(300),
            )
            .map_err(err)
        }
    }
}

/// Download a remote vault into the app's vault folder (new local file).
fn first_download(
    app: &AppHandle,
    t: Arc<dyn Transport>,
    section: &RemoteSection,
    remote_path: &str,
    file_name: &str,
) -> CmdResult<PathBuf> {
    let vaults = app.state::<AppState>().paths.vaults();
    std::fs::create_dir_all(&vaults).map_err(err)?;
    let stem = Path::new(file_name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "vault".into());
    let mut local = vaults.join(format!("{stem}.kurogane"));
    let mut n = 1;
    while local.exists() {
        local = vaults.join(format!("{stem}-{n}.kurogane"));
        n += 1;
    }
    let engine = SyncEngine::new(sandbox(app)?, t);
    let job = SyncJob { remote_id: &format!("connect:{remote_path}"), section, remote_path, local_vault: &local };
    let report = engine.sync_once(&job, &|_| Ok(())).map_err(err)?;
    match report.outcome {
        SyncOutcome::Pulled { .. } => Ok(local),
        _ => Err(format!("No vault found at {remote_path}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnect {
    /// Vault files found in the account (cloud) — the user picks one.
    candidates: Vec<String>,
    /// Set when the vault was already downloaded (folder flow).
    vault_path: Option<String>,
}

/// First-run "Connect cloud vault", step 1: link the account and list vaults.
#[tauri::command]
pub async fn connect_cloud(
    provider: String,
    mega: Option<MegaLogin>,
    on_step: Channel<CloudStep>,
    app: AppHandle,
) -> CmdResult<Option<CloudConnect>> {
    let provider = provider_from(&provider)?;
    let a = app.clone();
    let step = on_step.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> CmdResult<Option<CloudConnect>> {
        if provider == Provider::Local {
            let Some(picked) = a
                .dialog()
                .file()
                .set_title("Pick the vault inside your synced folder")
                .add_filter("Kurogane vault", &["kurogane"])
                .blocking_pick_file()
            else {
                return Ok(None);
            };
            let remote = picked.into_path().map_err(err)?;
            let _ = step.send(CloudStep::Downloading);
            let (t, rel) = transport_for(&a, "local", &remote.display().to_string())?;
            let section = RemoteSection::new(Provider::Local);
            let local = first_download(&a, t, &section, &rel, &rel)?;
            let state = a.state::<AppState>();
            let mut inner = state.inner.lock().unwrap();
            state.lock_inner(&mut inner, kurogane_core::session::LockReason::Manual);
            inner.vault_path = Some(local.clone());
            inner.pending_remote = Some(PendingRemote { provider, section, remote_path: remote.display().to_string() });
            state.remember(&mut inner, &local);
            let _ = step.send(CloudStep::Done { vault_path: local.display().to_string() });
            return Ok(Some(CloudConnect { candidates: vec![], vault_path: Some(local.display().to_string()) }));
        }
        let section = link_account(&a, provider, mega, &step)?;
        let _ = step.send(CloudStep::Listing);
        let candidates = cloud_transport(&a)?.list_vaults(&section, REMOTE_DIR).map_err(err)?;
        a.state::<AppState>().inner.lock().unwrap().pending_cloud = Some((provider, section));
        Ok(Some(CloudConnect { candidates, vault_path: None }))
    })
    .await
    .map_err(err)?;
    if let Err(e) = &res {
        let _ = on_step.send(CloudStep::Error { message: e.clone() });
    }
    res
}

/// First-run "Connect cloud vault", step 2: download the chosen vault.
#[tauri::command]
pub async fn connect_cloud_finish(remote_path: String, on_step: Channel<CloudStep>, app: AppHandle) -> CmdResult<String> {
    let a = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> CmdResult<String> {
        let state = a.state::<AppState>();
        let (provider, section) = state.inner.lock().unwrap().pending_cloud.take().ok_or("Link an account first")?;
        let _ = on_step.send(CloudStep::Downloading);
        let name = remote_path.rsplit('/').next().unwrap_or("vault.kurogane").to_string();
        let local = first_download(&a, cloud_transport(&a)?, &section, &remote_path, &name)?;
        let mut inner = state.inner.lock().unwrap();
        state.lock_inner(&mut inner, kurogane_core::session::LockReason::Manual);
        inner.vault_path = Some(local.clone());
        inner.pending_remote = Some(PendingRemote { provider, section, remote_path });
        state.remember(&mut inner, &local);
        let _ = on_step.send(CloudStep::Done { vault_path: local.display().to_string() });
        Ok(local.display().to_string())
    })
    .await
    .map_err(err)?;
    res
}

fn store_remote(app: &AppHandle, provider: Provider, section: &RemoteSection, remote_path: &str) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let mut inner = state.inner.lock().unwrap();
    let v = inner.vault.as_mut().ok_or("Vault is locked")?;
    let body = section.to_body();
    let link = NewSyncRemote {
        id: None,
        provider: provider.rclone_type(),
        label: provider_label(provider),
        remote_path,
        rclone_section: &body,
        // The provider ("local") already selects the folder transport.
        transport: "auto",
    };
    v.db().upsert_sync_remote(&v.keys().sync, &link).map_err(err)?;
    v.save().map_err(err)?;
    inner.request_sync(Duration::from_secs(1));
    Ok(())
}

/// Refuse to link a location that holds a *different* vault.
fn check_remote_slot(t: &Arc<dyn Transport>, section: &RemoteSection, path: &str, vault_id: [u8; 16]) -> CmdResult<()> {
    if let Some(head) = t.read_head(section, path, kurogane_core::container::HEADER_LEN).map_err(err)? {
        match kurogane_core::container::Header::decode(&head) {
            Ok(h) if h.vault_id == vault_id => {}
            Ok(_) => return Err(format!("{path} already contains a different vault. Rename this vault file or pick another folder.")),
            Err(_) => return Err(format!("{path} exists and is not a Kurogane vault")),
        }
    }
    Ok(())
}

fn vault_file_and_id(app: &AppHandle) -> CmdResult<(String, [u8; 16])> {
    let state = app.state::<AppState>();
    let inner = state.inner.lock().unwrap();
    let v = inner.vault.as_ref().ok_or("Vault is locked")?;
    let name = v.path().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "vault.kurogane".into());
    Ok((name, v.header().vault_id))
}

/// Settings → Sync → add Google Drive / OneDrive / MEGA.
#[tauri::command]
pub async fn link_remote(
    provider: String,
    mega: Option<MegaLogin>,
    on_step: Channel<CloudStep>,
    app: AppHandle,
) -> CmdResult<SyncStatusDto> {
    let provider = provider_from(&provider)?;
    let a = app.clone();
    let step = on_step.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> CmdResult<()> {
        let (file, vault_id) = vault_file_and_id(&a)?;
        let section = link_account(&a, provider, mega, &step)?;
        let path = format!("{REMOTE_DIR}/{file}");
        check_remote_slot(&cloud_transport(&a)?, &section, &path, vault_id)?;
        store_remote(&a, provider, &section, &path)?;
        let _ = step.send(CloudStep::Done { vault_path: path });
        Ok(())
    })
    .await
    .map_err(err)?;
    if let Err(e) = &res {
        let _ = on_step.send(CloudStep::Error { message: e.clone() });
    }
    res?;
    Ok(status(&app.state::<AppState>()))
}

/// Settings → Sync → add a synced folder (Dropbox, Syncthing, NAS share…).
#[tauri::command]
pub async fn link_folder(app: AppHandle) -> CmdResult<Option<SyncStatusDto>> {
    let a = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> CmdResult<bool> {
        let Some(dir) = a.dialog().file().set_title("Choose the synced folder").blocking_pick_folder() else { return Ok(false) };
        let dir = dir.into_path().map_err(err)?;
        let (file, vault_id) = vault_file_and_id(&a)?;
        let path = dir.join(&file);
        let (t, rel) = transport_for(&a, "local", &path.display().to_string())?;
        let section = RemoteSection::new(Provider::Local);
        check_remote_slot(&t, &section, &rel, vault_id)?;
        store_remote(&a, Provider::Local, &section, &path.display().to_string())?;
        Ok(true)
    })
    .await
    .map_err(err)??;
    Ok(res.then(|| status(&app.state::<AppState>())))
}

#[tauri::command]
pub fn unlink_remote(id: String, state: State<'_, AppState>) -> CmdResult<SyncStatusDto> {
    {
        let mut inner = state.inner.lock().unwrap();
        let v = inner.vault.as_mut().ok_or("Vault is locked")?;
        v.db().delete_sync_remote(&id).map_err(err)?;
        v.save().map_err(err)?;
        if inner.sync.conflict.as_ref().is_some_and(|c| c.remote_id == id) {
            inner.sync.conflict = None;
        }
    }
    Ok(status(&state))
}

#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> SyncStatusDto {
    status(&state)
}

#[tauri::command]
pub fn set_auto_sync(enabled: bool, state: State<'_, AppState>) -> SyncStatusDto {
    {
        let mut inner = state.inner.lock().unwrap();
        inner.config.auto_sync = enabled;
        inner.config.save(&state.paths.config_file);
        if enabled {
            inner.request_sync(Duration::from_secs(1));
        }
    }
    status(&state)
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> CmdResult<SyncStatusDto> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_sync(&a, true)).await.map_err(err)??;
    Ok(status(&app.state::<AppState>()))
}

struct Job {
    id: String,
    provider: String,
    label: String,
    remote_path: String,
    transport: String,
    section: RemoteSection,
    local: PathBuf,
}

fn collect_jobs(state: &AppState, only: Option<&str>) -> CmdResult<Vec<Job>> {
    let mut inner = state.inner.lock().unwrap();
    let v = inner.vault.as_mut().ok_or("Vault is locked")?;
    v.save_if_dirty().map_err(err)?;
    let local = v.path().to_path_buf();
    let mut jobs = Vec::new();
    for r in v.db().sync_remotes().map_err(err)? {
        if only.is_some_and(|o| o != r.id) {
            continue;
        }
        let section = RemoteSection::parse(&v.db().sync_remote_section(&v.keys().sync, &r.id).map_err(err)?).map_err(err)?;
        jobs.push(Job {
            id: r.id,
            provider: r.provider,
            label: r.label,
            remote_path: r.remote_path,
            transport: r.transport,
            section,
            local: local.clone(),
        });
    }
    Ok(jobs)
}

/// After `sync_once` / conflict resolution changed the local file.
fn after_round(app: &AppHandle, job: &Job, outcome: &SyncOutcome, refreshed: Option<RemoteSection>) -> CmdResult<bool> {
    let state = app.state::<AppState>();
    let mut inner = state.inner.lock().unwrap();
    let mut changed = false;
    if let Some(v) = inner.vault.as_mut() {
        if matches!(outcome, SyncOutcome::Pulled { .. }) {
            v.reload().map_err(err)?;
            changed = true;
        }
        if let Some(fresh) = refreshed {
            let body = fresh.to_body();
            let link = NewSyncRemote {
                id: Some(&job.id),
                provider: &job.provider,
                label: &job.label,
                remote_path: &job.remote_path,
                rclone_section: &body,
                transport: &job.transport,
            };
            v.db().upsert_sync_remote(&v.keys().sync, &link).map_err(err)?;
            v.save().map_err(err)?;
        }
    }
    if let SyncOutcome::Conflict { conflict_copy, local, remote } = outcome {
        inner.sync.conflict = Some(ConflictInfo {
            remote_id: job.id.clone(),
            label: job.label.clone(),
            conflict_copy: conflict_copy.clone(),
            local_saved_at_ms: local.saved_at_ms,
            remote_saved_at_ms: remote.saved_at_ms,
        });
    }
    Ok(changed)
}

fn validator(app: &AppHandle) -> impl Fn(&[u8]) -> kurogane_core::Result<()> + '_ {
    move |bytes: &[u8]| {
        let state = app.state::<AppState>();
        let inner = state.inner.lock().unwrap();
        let v = inner.vault.as_ref().ok_or(kurogane_core::Error::Invalid("vault locked during sync".into()))?;
        v.validate_candidate(bytes).map(|_| ())
    }
}

/// One round over every linked remote. Remotes waiting for a conflict
/// decision are skipped. `manual` rounds do not schedule an automatic retry.
pub fn run_sync(app: &AppHandle, manual: bool) -> CmdResult<()> {
    let state = app.state::<AppState>();
    {
        let mut inner = state.inner.lock().unwrap();
        if inner.sync.busy || inner.vault.is_none() {
            return Ok(());
        }
        inner.sync.busy = true;
        inner.sync.last_run = Some(Instant::now());
    }
    emit_status(app);
    let result = (|| -> CmdResult<(Vec<String>, bool, usize)> {
        let jobs = collect_jobs(&state, None)?;
        let conflict_remote = state.inner.lock().unwrap().sync.conflict.as_ref().map(|c| c.remote_id.clone());
        let mut lines = Vec::new();
        let mut changed = false;
        for job in &jobs {
            if conflict_remote.as_deref() == Some(job.id.as_str()) {
                lines.push(format!("{}: waiting for your conflict decision", job.label));
                continue;
            }
            let (t, path) = transport_for(app, &job.provider, &job.remote_path)?;
            let engine = SyncEngine::new(sandbox(app)?, t);
            let sj = SyncJob { remote_id: &job.id, section: &job.section, remote_path: &path, local_vault: &job.local };
            let report = engine.sync_once(&sj, &validator(app)).map_err(|e| format!("{}: {}", job.label, err(e)))?;
            changed |= after_round(app, job, &report.outcome, report.refreshed_section)?;
            lines.push(format!(
                "{}: {}",
                job.label,
                match report.outcome {
                    SyncOutcome::Nothing | SyncOutcome::InSync => "up to date",
                    SyncOutcome::Pushed { .. } => "uploaded",
                    SyncOutcome::Pulled { .. } => "downloaded newer version",
                    SyncOutcome::Conflict { .. } => "conflict — both copies changed",
                }
            ));
        }
        Ok((lines, changed, jobs.len()))
    })();
    let changed = {
        let mut inner = state.inner.lock().unwrap();
        inner.sync.busy = false;
        match &result {
            Ok((lines, changed, n)) => {
                if *n > 0 {
                    inner.sync.last_outcome = Some(lines.join(" · "));
                    inner.sync.last_error = None;
                    inner.sync.last_synced_at_ms = Some(kurogane_core::vault::now_ms());
                }
                *changed
            }
            Err(e) => {
                inner.sync.last_error = Some(e.clone());
                // Retry later, not in a tight loop.
                if !manual {
                    inner.sync.wanted_at = Some(Instant::now() + Duration::from_secs(120));
                }
                false
            }
        }
    };
    emit_status(app);
    if changed {
        let _ = app.emit("vault://changed", ());
    }
    result.map(|_| ())
}

/// "Keep this device's version" (`mine`) or "Use the other copy" (`theirs`).
#[tauri::command]
pub async fn resolve_conflict(choice: String, app: AppHandle) -> CmdResult<SyncStatusDto> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<()> {
        let state = a.state::<AppState>();
        let info = state.inner.lock().unwrap().sync.conflict.clone().ok_or("There is no conflict to resolve")?;
        let job = collect_jobs(&state, Some(&info.remote_id))?.pop().ok_or("That remote is no longer linked")?;
        let (t, path) = transport_for(&a, &job.provider, &job.remote_path)?;
        let engine = SyncEngine::new(sandbox(&a)?, t);
        let sj = SyncJob { remote_id: &job.id, section: &job.section, remote_path: &path, local_vault: &job.local };
        let outcome = match choice.as_str() {
            "mine" => engine.force_push(&sj).map_err(err)?,
            "theirs" => engine.adopt_file(&sj, &info.conflict_copy, &validator(&a)).map_err(err)?,
            _ => return Err("choose 'mine' or 'theirs'".into()),
        };
        state.inner.lock().unwrap().sync.conflict = None;
        let changed = after_round(&a, &job, &outcome, None)?;
        let _ = std::fs::remove_file(&info.conflict_copy);
        if changed {
            let _ = a.emit("vault://changed", ());
        }
        Ok(())
    })
    .await
    .map_err(err)??;
    emit_status(&app);
    Ok(status(&app.state::<AppState>()))
}

/// Background scheduler: runs after edits (debounced), after unlock and every
/// five minutes while unlocked, if auto-sync is on.
/// Push changes that are still waiting for the debounce before the vault is
/// locked or the app quits, so the other computers see them right away.
pub fn flush_pending(app: &AppHandle) {
    let pending = {
        let state = app.state::<AppState>();
        let inner = state.inner.lock().unwrap();
        let has_remotes = inner.vault.as_ref().and_then(|v| v.db().sync_remotes().ok()).is_some_and(|r| !r.is_empty());
        has_remotes && inner.config.auto_sync && inner.sync.wanted_at.is_some()
    };
    if pending {
        let _ = run_sync(app, false);
    }
}

pub fn spawn_scheduler(app: AppHandle) {
    std::thread::Builder::new()
        .name("kurogane-sync".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let due = {
                let state = app.state::<AppState>();
                let mut inner = state.inner.lock().unwrap();
                let has_remotes = inner.vault.as_ref().and_then(|v| v.db().sync_remotes().ok()).is_some_and(|r| !r.is_empty());
                let wanted = inner.sync.wanted_at.is_some_and(|w| w <= Instant::now());
                let periodic = inner.sync.last_run.is_none_or(|t| t.elapsed() > PERIODIC);
                let due = has_remotes && inner.config.auto_sync && !inner.sync.busy && (wanted || periodic);
                if due || !has_remotes {
                    inner.sync.wanted_at = None;
                }
                due
            };
            if due {
                let _ = run_sync(&app, false);
            }
        })
        .expect("spawn sync scheduler");
}
