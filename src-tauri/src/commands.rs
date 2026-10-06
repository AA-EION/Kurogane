//! IPC surface consumed by `ui/src/api/tauri.ts`. Every command that needs
//! vault contents goes through `with_vault`, which also counts as activity
//! for the inactivity lock.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use kurogane_core::db::models::{OwnerKind, SecretField, Topology};
use kurogane_core::db::NewSyncRemote;
use kurogane_core::kdf::KdfParams;
use kurogane_core::launch::{self, RdpTarget, SshTarget};
use kurogane_core::session::{LockReason, SessionClock};
use kurogane_core::vault::{self, CreateOptions, TotpEnrollment, UnlockedVault};
use kurogane_sync::engine::{select_transport, SyncEngine, SyncJob, SyncOutcome, TransportPreference};
use kurogane_sync::provision::Provisioner;
use kurogane_sync::rclone::{Provider, RemoteSection};
use kurogane_sync::sandbox::Sandbox;
use kurogane_sync::transport;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

use crate::state::{AppConfig, AppState, Inner, PendingRemote};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const DEFAULT_REMOTE_PATH: &str = "Kurogane/vault.kurogane";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    stage: &'static str,
    vault_path: Option<String>,
    vault_name: Option<String>,
    totp_required: bool,
    lock_timeout_secs: u64,
    remaining_secs: u64,
    memory_locked: bool,
    demo: bool,
    last_lock_reason: Option<LockReason>,
}

fn status_of(inner: &Inner) -> AppStatus {
    let header = inner.vault_path.as_deref().and_then(|p| vault::peek(p).ok());
    let (timeout, remaining) = inner.session.as_ref().map(|s| (s.timeout().as_secs(), s.remaining().as_secs())).unwrap_or((900, 0));
    AppStatus {
        stage: if inner.vault.is_some() {
            "unlocked"
        } else if inner.vault_path.is_some() {
            "locked"
        } else {
            "wizard"
        },
        vault_path: inner.vault_path.as_ref().map(|p| p.display().to_string()),
        vault_name: inner.vault.as_ref().and_then(|v| v.db().settings().ok()).map(|s| s.display_name),
        totp_required: header.map(|h| h.totp_required()).unwrap_or(false),
        lock_timeout_secs: timeout,
        remaining_secs: remaining,
        memory_locked: inner.vault.as_ref().map_or(true, |v| v.keys().all_memory_locked())
            && !kurogane_core::secure::memory_lock_degraded(),
        demo: false,
        last_lock_reason: inner.last_lock_reason,
    }
}

fn start_session(inner: &mut Inner) {
    let timeout = inner.vault.as_ref().and_then(|v| v.db().settings().ok()).map(|s| s.lock_timeout_secs as u64).unwrap_or(900);
    inner.session = Some(SessionClock::new(Duration::from_secs(timeout)));
    inner.last_lock_reason = None;
}

fn with_vault<T>(state: &State<'_, AppState>, f: impl FnOnce(&mut UnlockedVault) -> kurogane_core::Result<T>) -> CmdResult<T> {
    let mut inner = state.inner.lock().unwrap();
    if let Some(s) = inner.session.as_mut() {
        s.touch();
    }
    let v = inner.vault.as_mut().ok_or("Vault is locked")?;
    f(v).map_err(err)
}

fn remember(state: &AppState, path: &std::path::Path) {
    AppConfig { last_vault_path: Some(path.to_path_buf()) }.save(&state.paths.config_file);
}

// ------------------------------------------------------------------ lifecycle

#[tauri::command]
pub fn app_status(state: State<'_, AppState>) -> AppStatus {
    status_of(&state.inner.lock().unwrap())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVaultArgs {
    path: Option<String>,
    display_name: String,
    password: Zeroizing<String>,
    kdf: String,
    account: String,
    #[serde(default)]
    seed_demo: bool,
}

#[tauri::command]
pub async fn create_vault(args: CreateVaultArgs, state: State<'_, AppState>) -> CmdResult<TotpEnrollment> {
    let path = PathBuf::from(args.path.ok_or("Choose where to save the vault first")?);
    let opts = CreateOptions {
        display_name: args.display_name,
        kdf: if args.kdf == "hardened" { KdfParams::HARDENED } else { KdfParams::STANDARD },
        totp_account: if args.account.is_empty() { "admin".into() } else { args.account },
        seed_demo: args.seed_demo,
    };
    let work = state.paths.work();
    let pw = args.password;
    let p2 = path.clone();
    let (v, enrol) = tauri::async_runtime::spawn_blocking(move || UnlockedVault::create(&p2, &work, pw.as_bytes(), &opts))
        .await
        .map_err(err)?
        .map_err(err)?;
    let mut inner = state.inner.lock().unwrap();
    state.lock_inner(&mut inner, LockReason::Manual);
    inner.vault = Some(v);
    inner.vault_path = Some(path.clone());
    start_session(&mut inner);
    remember(&state, &path);
    Ok(enrol)
}

#[tauri::command]
pub fn confirm_totp(code: String, state: State<'_, AppState>) -> CmdResult<()> {
    with_vault(&state, |v| v.confirm_totp(&code))
}

#[tauri::command]
pub async fn pick_vault_save_path(app: AppHandle) -> CmdResult<Option<String>> {
    let picked = app
        .dialog()
        .file()
        .set_title("Create Kurogane vault")
        .set_file_name("infrastructure.kurogane")
        .add_filter("Kurogane vault", &["kurogane"])
        .blocking_save_file();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
}

#[tauri::command]
pub async fn open_vault(path: Option<String>, app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<AppStatus>> {
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => match app.dialog().file().set_title("Open Kurogane vault").add_filter("Kurogane vault", &["kurogane"]).blocking_pick_file()
        {
            Some(p) => p.into_path().map_err(err)?,
            None => return Ok(None),
        },
    };
    vault::peek(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut inner = state.inner.lock().unwrap();
    state.lock_inner(&mut inner, LockReason::Manual);
    inner.vault_path = Some(path.clone());
    inner.last_lock_reason = None;
    remember(&state, &path);
    Ok(Some(status_of(&inner)))
}

#[tauri::command]
pub async fn unlock(password: Zeroizing<String>, totp: Option<String>, state: State<'_, AppState>) -> CmdResult<AppStatus> {
    let path = {
        let inner = state.inner.lock().unwrap();
        if let Some(t) = inner.unlock_not_before {
            let now = Instant::now();
            if t > now {
                return Err(format!("Too many attempts — try again in {} s", (t - now).as_secs() + 1));
            }
        }
        inner.vault_path.clone().ok_or("No vault selected")?
    };
    let work = state.paths.work();
    let result = tauri::async_runtime::spawn_blocking(move || UnlockedVault::unlock(&path, &work, password.as_bytes(), totp.as_deref()))
        .await
        .map_err(err)?;
    let mut inner = state.inner.lock().unwrap();
    match result {
        Ok(mut v) => {
            if let Some(p) = inner.pending_remote.take() {
                let label = format!("{:?}", p.provider);
                let body = p.section.to_body();
                let link = NewSyncRemote {
                    id: None,
                    provider: p.provider.rclone_type(),
                    label: &label,
                    remote_path: &p.remote_path,
                    rclone_section: &body,
                    transport: "auto",
                };
                let res = v.db().upsert_sync_remote(&v.keys().sync, &link).and_then(|_| {
                    v.mark_dirty();
                    v.save()
                });
                if let Err(e) = res {
                    eprintln!("could not store cloud link: {e}");
                }
            }
            inner.vault = Some(v);
            inner.failed_unlocks = 0;
            inner.unlock_not_before = None;
            start_session(&mut inner);
            Ok(status_of(&inner))
        }
        Err(e) => {
            if !matches!(e, kurogane_core::Error::TotpRequired) {
                AppState::register_failure(&mut inner);
            }
            Err(err(e))
        }
    }
}

#[tauri::command]
pub fn lock(app: AppHandle, state: State<'_, AppState>) {
    let mut inner = state.inner.lock().unwrap();
    if state.lock_inner(&mut inner, LockReason::Manual) {
        use tauri::Emitter;
        let _ = app.emit("vault://locked", LockReason::Manual);
    }
}

#[tauri::command]
pub fn touch(state: State<'_, AppState>) {
    if let Some(s) = state.inner.lock().unwrap().session.as_mut() {
        s.touch();
    }
}

#[tauri::command]
pub fn topology(state: State<'_, AppState>) -> CmdResult<Topology> {
    with_vault(&state, |v| v.topology())
}

// ------------------------------------------------------------------- secrets

#[tauri::command]
pub fn reveal_secret(credential_id: String, field: SecretField, state: State<'_, AppState>) -> CmdResult<String> {
    // The plaintext necessarily crosses into the webview here; the UI hides
    // it again after 15 s. Prefer copy_secret, which never does.
    with_vault(&state, |v| v.reveal(&credential_id, field, "reveal_secret").map(|s| s.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    clears_in_secs: u32,
}

#[tauri::command]
pub fn copy_secret(credential_id: String, field: SecretField, state: State<'_, AppState>) -> CmdResult<CopyResult> {
    let (secret, secs) = with_vault(&state, |v| {
        let secs = v.db().settings()?.clipboard_clear_secs;
        Ok((v.reveal(&credential_id, field, "copy_secret")?, secs))
    })?;
    state.clipboard.copy_secret(secret, Duration::from_secs(secs as u64));
    Ok(CopyResult { clears_in_secs: secs })
}

#[tauri::command]
pub fn copy_text(text: String, state: State<'_, AppState>) {
    state.clipboard.copy_plain(text);
}

// ---------------------------------------------------------------- launchers

/// Load an SSH key into the running agent for 10 minutes (no file on disk).
fn ssh_agent_add(key: &str) -> bool {
    use std::io::Write;
    if std::env::var_os("SSH_AUTH_SOCK").is_none() && !cfg!(windows) {
        return false;
    }
    let Ok(mut child) = std::process::Command::new("ssh-add")
        .args(["-t", "600", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(key.as_bytes());
        let _ = stdin.write_all(b"\n");
    }
    child.wait().map(|s| s.success()).unwrap_or(false)
}

#[tauri::command]
pub fn launch_ssh(host_id: String, credential_id: Option<String>, state: State<'_, AppState>) -> CmdResult<String> {
    let scratch = state.paths.scratch();
    let _ = std::fs::create_dir_all(&scratch);
    let (target, note) = with_vault(&state, |v| {
        let host = v.db().host(&host_id)?;
        let addr = host.management_address().ok_or_else(|| kurogane_core::Error::Invalid("host has no address".into()))?.to_string();
        let mut user = None;
        let mut note = String::new();
        let mut identity_file = None;
        let cred_id = credential_id.clone().or_else(|| {
            v.db().load_topology().ok().and_then(|t| {
                t.credentials
                    .into_iter()
                    .find(|c| c.owner.kind == OwnerKind::Host && c.owner.id == host_id && (c.kind == "ssh_key" || c.kind == "ssh_password"))
                    .map(|c| c.id)
            })
        });
        if let Some(cid) = cred_id {
            let meta = v.db().credential_meta(&cid)?;
            user = meta.username.clone();
            if meta.kind == "ssh_key" && meta.has_private_key {
                let key = v.reveal(&cid, SecretField::PrivateKey, "launch_ssh_key")?;
                if ssh_agent_add(&key) {
                    note = "key loaded into ssh-agent for 10 min".into();
                } else {
                    // Fallback: 0600 temp file, removed shortly after ssh has read it.
                    let p = scratch.join(format!("id-{}", uuid::Uuid::new_v4().simple()));
                    {
                        use std::io::Write;
                        let mut f = kurogane_core::fsutil::create_private(&p)?;
                        f.write_all(key.as_bytes())?;
                        f.write_all(b"\n")?;
                    }
                    let cleanup = p.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(20));
                        kurogane_core::fsutil::shred(&cleanup);
                    });
                    identity_file = Some(p);
                    note = "temporary key file (auto-shredded in 20 s)".into();
                }
            } else if meta.has_secret {
                let pw = v.reveal(&cid, SecretField::Secret, "launch_ssh_password")?;
                state.clipboard.copy_secret(pw, Duration::from_secs(30));
                note = "password copied — clears in 30 s".into();
            }
        }
        v.audit("launch_ssh", "host", &host_id)?;
        Ok((SshTarget { user, host: addr, port: host.ssh_port.unwrap_or(22), identity_file }, note))
    })?;
    let how = launch::launch_ssh(&target, &scratch).map_err(err)?;
    Ok(format!("{} via {how}{}", target.argv().map_err(err)?.join(" "), if note.is_empty() { String::new() } else { format!(" · {note}") }))
}

#[tauri::command]
pub fn launch_rdp(host_id: String, credential_id: Option<String>, state: State<'_, AppState>) -> CmdResult<String> {
    let scratch = state.paths.scratch();
    let _ = std::fs::create_dir_all(&scratch);
    let (target, note) = with_vault(&state, |v| {
        let host = v.db().host(&host_id)?;
        let addr = host.management_address().ok_or_else(|| kurogane_core::Error::Invalid("host has no address".into()))?.to_string();
        let mut user = None;
        let mut note = String::new();
        let cred_id = credential_id.clone().or_else(|| {
            v.db()
                .load_topology()
                .ok()
                .and_then(|t| t.credentials.into_iter().find(|c| c.owner.id == host_id && c.kind == "rdp").map(|c| c.id))
        });
        if let Some(cid) = cred_id {
            let meta = v.db().credential_meta(&cid)?;
            user = meta.username.clone();
            if meta.has_secret {
                state.clipboard.copy_secret(v.reveal(&cid, SecretField::Secret, "launch_rdp_password")?, Duration::from_secs(30));
                note = " · password copied — clears in 30 s".into();
            }
        }
        v.audit("launch_rdp", "host", &host_id)?;
        Ok((RdpTarget { host: addr, port: host.rdp_port.unwrap_or(3389), user }, note))
    })?;
    let how = launch::launch_rdp(&target, &scratch).map_err(err)?;
    Ok(format!("{how}{note}"))
}

#[tauri::command]
pub fn launch_web(url: String, app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    launch::validate_web_url(&url).map_err(err)?;
    with_vault(&state, |_| Ok(()))?;
    app.opener().open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
pub async fn export_text(suggested_name: String, content: String, app: AppHandle) -> CmdResult<bool> {
    let Some(path) = app.dialog().file().set_file_name(&suggested_name).add_filter("JSON", &["json"]).blocking_save_file() else {
        return Ok(false);
    };
    std::fs::write(path.into_path().map_err(err)?, content).map_err(err)?;
    Ok(true)
}

// ---------------------------------------------------------------------- sync

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
    Downloading,
    Done { vault_path: String },
    Error { message: String },
}

/// First-run "Connect cloud vault": provision the engine, link the account,
/// download the vault. The link is sealed into the vault after unlock.
#[tauri::command]
pub async fn connect_cloud(
    provider: String,
    mega: Option<MegaLogin>,
    on_step: Channel<CloudStep>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let provider = match provider.as_str() {
        "drive" => Provider::Drive,
        "onedrive" => Provider::OneDrive,
        "mega" => Provider::Mega,
        other => return Err(format!("unsupported provider {other}")),
    };
    let sandbox_dir = state.paths.sandbox();
    let vaults = state.paths.vaults();
    let step = on_step.clone();
    let opener = app.clone();
    let run = tauri::async_runtime::spawn_blocking(move || -> Result<(RemoteSection, PathBuf), String> {
        let sb = Sandbox::open(&sandbox_dir).map_err(err)?;
        sb.sweep_stale_runs();
        let bin = Provisioner::new(&sb)
            .map_err(err)?
            .ensure(|done, total| {
                let _ = step.send(CloudStep::Provisioning { done, total });
            })
            .map_err(err)?;
        let section = match provider {
            Provider::Mega => {
                let m = mega.ok_or("MEGA login required")?;
                transport::mega_section(&bin, &sb, &m.user, &m.password).map_err(err)?
            }
            _ => transport::authorize_oauth(
                &bin,
                &sb,
                provider,
                &mut |url| {
                    let _ = step.send(CloudStep::Consent { url: url.to_string() });
                    let _ = opener.opener().open_url(url, None::<&str>);
                },
                Duration::from_secs(300),
            )
            .map_err(err)?,
        };
        let _ = step.send(CloudStep::Downloading);
        let transport = select_transport(&sb, TransportPreference::Auto, |_, _| {}).map_err(err)?;
        let engine = SyncEngine::new(sb, transport);
        std::fs::create_dir_all(&vaults).map_err(err)?;
        let local = vaults.join(format!("{}-vault.kurogane", provider.rclone_type()));
        let job = SyncJob {
            remote_id: &format!("pending:{}", provider.rclone_type()),
            section: &section,
            remote_path: DEFAULT_REMOTE_PATH,
            local_vault: &local,
        };
        let report = engine.sync_once(&job, &|_| Ok(())).map_err(err)?;
        match report.outcome {
            SyncOutcome::Pulled { .. } | SyncOutcome::InSync => Ok((report.refreshed_section.unwrap_or(section), local)),
            _ => Err(format!("No vault found at {DEFAULT_REMOTE_PATH} in this account")),
        }
    })
    .await
    .map_err(err)?;
    match run {
        Ok((section, local)) => {
            let mut inner = state.inner.lock().unwrap();
            state.lock_inner(&mut inner, LockReason::Manual);
            inner.vault_path = Some(local.clone());
            inner.pending_remote = Some(PendingRemote { provider, section, remote_path: DEFAULT_REMOTE_PATH.into() });
            remember(&state, &local);
            let _ = on_step.send(CloudStep::Done { vault_path: local.display().to_string() });
            Ok(())
        }
        Err(e) => {
            let _ = on_step.send(CloudStep::Error { message: e.clone() });
            Err(e)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRemote {
    id: String,
    provider: String,
    label: String,
    remote_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusDto {
    linked: Vec<LinkedRemote>,
    transport: Option<String>,
    last_outcome: Option<String>,
    last_synced_at_ms: Option<i64>,
    busy: bool,
}

#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> CmdResult<SyncStatusDto> {
    let inner = state.inner.lock().unwrap();
    let linked = inner
        .vault
        .as_ref()
        .ok_or("Vault is locked")?
        .db()
        .sync_remotes()
        .map_err(err)?
        .into_iter()
        .map(|r| LinkedRemote { id: r.id, provider: r.provider, label: r.label, remote_path: r.remote_path })
        .collect();
    Ok(SyncStatusDto {
        linked,
        transport: inner.sync.transport.clone(),
        last_outcome: inner.sync.last_outcome.clone(),
        last_synced_at_ms: inner.sync.last_synced_at_ms,
        busy: inner.sync.busy,
    })
}

/// One sync round for every linked remote. The state lock is *not* held
/// during network I/O; the validator re-acquires it only to decrypt.
#[tauri::command]
pub async fn sync_now(app: AppHandle) -> CmdResult<String> {
    let jobs = {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().unwrap();
        if inner.sync.busy {
            return Err("A sync is already running".into());
        }
        let v = inner.vault.as_mut().ok_or("Vault is locked")?;
        v.save_if_dirty().map_err(err)?;
        let path = v.path().to_path_buf();
        let mut jobs = Vec::new();
        for r in v.db().sync_remotes().map_err(err)? {
            let section = RemoteSection::parse(&v.db().sync_remote_section(&v.keys().sync, &r.id).map_err(err)?).map_err(err)?;
            jobs.push((r, section, path.clone()));
        }
        if jobs.is_empty() {
            return Err("No cloud remote linked to this vault".into());
        }
        inner.sync.busy = true;
        jobs
    };
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let state = handle.state::<AppState>();
        let sb = Sandbox::open(state.paths.sandbox()).map_err(err)?;
        let transport = select_transport(&sb, TransportPreference::Auto, |_, _| {}).map_err(err)?;
        state.inner.lock().unwrap().sync.transport = Some(format!("{:?}", transport.kind()).to_lowercase());
        let engine = SyncEngine::new(sb, transport);
        let mut lines = Vec::new();
        for (r, section, path) in jobs {
            let job = SyncJob { remote_id: &r.id, section: &section, remote_path: &r.remote_path, local_vault: &path };
            let validate = |bytes: &[u8]| -> kurogane_core::Result<()> {
                let inner = state.inner.lock().unwrap();
                let v = inner.vault.as_ref().ok_or(kurogane_core::Error::Invalid("vault locked during sync".into()))?;
                v.validate_candidate(bytes).map(|_| ())
            };
            let report = engine.sync_once(&job, &validate).map_err(err)?;
            let mut inner = state.inner.lock().unwrap();
            if let Some(v) = inner.vault.as_mut() {
                if matches!(report.outcome, SyncOutcome::Pulled { .. }) {
                    v.reload().map_err(err)?;
                }
                if let Some(fresh) = report.refreshed_section {
                    let body = fresh.to_body();
                    let link = NewSyncRemote {
                        id: Some(&r.id),
                        provider: &r.provider,
                        label: &r.label,
                        remote_path: &r.remote_path,
                        rclone_section: &body,
                        transport: &r.transport,
                    };
                    v.db().upsert_sync_remote(&v.keys().sync, &link).map_err(err)?;
                    v.mark_dirty();
                }
                let _ = v.audit("sync", "sync_remote", &r.id);
            }
            lines.push(format!("{}: {:?}", r.label, report.decision));
        }
        Ok(lines)
    })
    .await
    .map_err(err)?;
    let state = app.state::<AppState>();
    let mut inner = state.inner.lock().unwrap();
    inner.sync.busy = false;
    match result {
        Ok(lines) => {
            inner.sync.last_outcome = Some(lines.join(", "));
            inner.sync.last_synced_at_ms = Some(vault::now_ms());
            Ok(lines.join(", "))
        }
        Err(e) => {
            inner.sync.last_outcome = Some(format!("error: {e}"));
            Err(e)
        }
    }
}
