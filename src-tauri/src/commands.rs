//! IPC surface consumed by `ui/src/api/tauri.ts`: vault lifecycle, editing,
//! secrets, launchers and settings. Import/export lives in `io.rs`, sync in
//! `sync.rs`. Every command that touches the vault counts as activity for the
//! inactivity lock.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use kurogane_core::db::models::{Host, Network, OwnerKind, ReverseProxy, SecretField, Service, Tenant, Topology};
use kurogane_core::db::{CredentialInput, DeleteImpact, EntityKind, NewSyncRemote, SettingsUpdate};
use kurogane_core::kdf::KdfParams;
use kurogane_core::launch::{self, RdpTarget, SshTarget};
use kurogane_core::session::{LockReason, SessionClock};
use kurogane_core::vault::{self, CreateOptions, TotpEnrollment, UnlockedVault};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroizing;

use crate::state::{AppState, Inner};

pub type CmdResult<T> = Result<T, String>;

pub fn err(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    // Core errors are prefixed for logs; the UI wants the sentence.
    s.strip_prefix("invalid input: ").map(str::to_string).unwrap_or(s)
}

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
    recent_vaults: Vec<String>,
}

pub fn status_of(inner: &Inner) -> AppStatus {
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
        memory_locked: inner.vault.as_ref().is_none_or(|v| v.keys().all_memory_locked()) && !kurogane_core::secure::memory_lock_degraded(),
        demo: false,
        last_lock_reason: inner.last_lock_reason,
        recent_vaults: inner.config.recent_vaults.iter().filter(|p| p.exists()).map(|p| p.display().to_string()).collect(),
    }
}

fn start_session(inner: &mut Inner) {
    let timeout = inner.vault.as_ref().and_then(|v| v.db().settings().ok()).map(|s| s.lock_timeout_secs as u64).unwrap_or(900);
    inner.session = Some(SessionClock::new(Duration::from_secs(timeout)));
    inner.last_lock_reason = None;
}

/// Run `f` against the unlocked vault (read-only intent).
pub fn with_vault<T>(state: &State<'_, AppState>, f: impl FnOnce(&mut UnlockedVault) -> kurogane_core::Result<T>) -> CmdResult<T> {
    let mut inner = state.inner.lock().unwrap();
    if let Some(s) = inner.session.as_mut() {
        s.touch();
    }
    let v = inner.vault.as_mut().ok_or("Vault is locked")?;
    f(v).map_err(err)
}

/// Run an edit, persist the vault atomically, schedule a sync and return the
/// fresh topology. On failure the working copy is rolled back from disk.
pub fn mutate<T>(state: &State<'_, AppState>, f: impl FnOnce(&mut UnlockedVault) -> kurogane_core::Result<T>) -> CmdResult<(T, Topology)> {
    let mut inner = state.inner.lock().unwrap();
    if let Some(s) = inner.session.as_mut() {
        s.touch();
    }
    let v = inner.vault.as_mut().ok_or("Vault is locked")?;
    let out = match f(v) {
        Ok(x) => x,
        Err(e) => {
            let _ = v.reload();
            return Err(err(e));
        }
    };
    v.save().map_err(err)?;
    let topo = v.topology().map_err(err)?;
    inner.request_sync(Duration::from_secs(15));
    Ok((out, topo))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    id: String,
    topology: Topology,
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
}

#[tauri::command]
pub async fn create_vault(args: CreateVaultArgs, state: State<'_, AppState>) -> CmdResult<TotpEnrollment> {
    let mut path = PathBuf::from(args.path.ok_or("Choose where to save the vault first")?);
    if path.extension().is_none_or(|e| e != "kurogane") {
        path.set_extension("kurogane");
    }
    let opts = CreateOptions {
        display_name: if args.display_name.trim().is_empty() { "Infrastructure".into() } else { args.display_name.trim().into() },
        kdf: if args.kdf == "hardened" { KdfParams::HARDENED } else { KdfParams::STANDARD },
        totp_account: args.account,
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
    state.remember(&mut inner, &path);
    Ok(enrol)
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
    inner.pending_remote = None;
    state.remember(&mut inner, &path);
    Ok(Some(status_of(&inner)))
}

/// "Open a different vault" from the lock screen.
#[tauri::command]
pub fn close_vault(state: State<'_, AppState>) -> AppStatus {
    let mut inner = state.inner.lock().unwrap();
    state.lock_inner(&mut inner, LockReason::Manual);
    inner.vault_path = None;
    inner.last_lock_reason = None;
    status_of(&inner)
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
                let label = crate::sync::provider_label(p.provider).to_string();
                let body = p.section.to_body();
                let link = NewSyncRemote {
                    id: None,
                    provider: p.provider.rclone_type(),
                    label: &label,
                    remote_path: &p.remote_path,
                    rclone_section: &body,
                    // The provider ("local") already selects the folder transport.
                    transport: "auto",
                };
                if let Err(e) = v.db().upsert_sync_remote(&v.keys().sync, &link).and_then(|_| v.save()) {
                    eprintln!("could not store cloud link: {e}");
                }
            }
            inner.vault = Some(v);
            inner.failed_unlocks = 0;
            inner.unlock_not_before = None;
            start_session(&mut inner);
            inner.request_sync(Duration::from_secs(2));
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
pub async fn lock(app: AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::flush_pending(&app);
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().unwrap();
        if state.lock_inner(&mut inner, LockReason::Manual) {
            let _ = app.emit("vault://locked", LockReason::Manual);
        }
    })
    .await
    .map_err(err)
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

// -------------------------------------------------------------------- editing

#[tauri::command]
pub fn save_tenant(tenant: Tenant, state: State<'_, AppState>) -> CmdResult<Saved> {
    mutate(&state, |v| v.db().save_tenant(&tenant)).map(|(id, topology)| Saved { id, topology })
}

#[tauri::command]
pub fn save_network(network: Network, state: State<'_, AppState>) -> CmdResult<Saved> {
    mutate(&state, |v| v.db().save_network(&network)).map(|(id, topology)| Saved { id, topology })
}

#[tauri::command]
pub fn save_host(host: Host, state: State<'_, AppState>) -> CmdResult<Saved> {
    mutate(&state, |v| v.db().save_host(&host)).map(|(id, topology)| Saved { id, topology })
}

#[tauri::command]
pub fn save_service(service: Service, state: State<'_, AppState>) -> CmdResult<Saved> {
    mutate(&state, |v| v.db().save_service(&service)).map(|(id, topology)| Saved { id, topology })
}

#[tauri::command]
pub fn save_proxy(proxy: ReverseProxy, state: State<'_, AppState>) -> CmdResult<Saved> {
    mutate(&state, |v| v.db().save_proxy(&proxy)).map(|(id, topology)| Saved { id, topology })
}

#[tauri::command]
pub fn save_credential(credential: CredentialInput, state: State<'_, AppState>) -> CmdResult<Saved> {
    mutate(&state, |v| {
        let id = v.db().save_credential(&v.keys().field, &credential)?;
        v.db().audit("save_credential", Some("credential"), Some(&id), None)?;
        Ok(id)
    })
    .map(|(id, topology)| Saved { id, topology })
}

#[tauri::command]
pub fn delete_impact(kind: EntityKind, id: String, state: State<'_, AppState>) -> CmdResult<DeleteImpact> {
    with_vault(&state, |v| v.db().delete_impact(kind, &id))
}

#[tauri::command]
pub fn delete_entity(kind: EntityKind, id: String, state: State<'_, AppState>) -> CmdResult<Topology> {
    mutate(&state, |v| v.db().delete_entity(kind, &id)).map(|(_, t)| t)
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
        let addr = host
            .management_address()
            .ok_or_else(|| kurogane_core::Error::Invalid("this machine has no IP address or FQDN".into()))?
            .to_string();
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
                    // Fallback: 0600 temp file, shredded shortly after ssh has read it.
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
                    note = "temporary key file (shredded in 20 s)".into();
                }
            } else if meta.has_secret {
                let pw = v.reveal(&cid, SecretField::Secret, "launch_ssh_password")?;
                state.clipboard.copy_secret(pw, Duration::from_secs(30));
                note = "password copied — paste it when asked (clears in 30 s)".into();
            }
        }
        v.audit("launch_ssh", "host", &host_id)?;
        Ok((SshTarget { user, host: addr, port: host.ssh_port.unwrap_or(22), identity_file }, note))
    })?;
    let how = launch::launch_ssh(&target, &scratch).map_err(err)?;
    let _ = with_vault(&state, |v| v.save_if_dirty());
    Ok(format!("Opened {how}{}", if note.is_empty() { String::new() } else { format!(" · {note}") }))
}

#[tauri::command]
pub fn launch_rdp(host_id: String, credential_id: Option<String>, state: State<'_, AppState>) -> CmdResult<String> {
    let scratch = state.paths.scratch();
    let _ = std::fs::create_dir_all(&scratch);
    let (target, note) = with_vault(&state, |v| {
        let host = v.db().host(&host_id)?;
        let addr = host
            .management_address()
            .ok_or_else(|| kurogane_core::Error::Invalid("this machine has no IP address or FQDN".into()))?
            .to_string();
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
                note = " · password copied (clears in 30 s)".into();
            }
        }
        v.audit("launch_rdp", "host", &host_id)?;
        Ok((RdpTarget { host: addr, port: host.rdp_port.unwrap_or(3389), user }, note))
    })?;
    let how = launch::launch_rdp(&target, &scratch).map_err(err)?;
    let _ = with_vault(&state, |v| v.save_if_dirty());
    Ok(format!("Opened {how}{note}"))
}

#[tauri::command]
pub fn launch_web(url: String, app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    launch::validate_web_url(&url).map_err(err)?;
    with_vault(&state, |_| Ok(()))?;
    app.opener().open_url(url, None::<&str>).map_err(err)
}

// ------------------------------------------------------------------- settings

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    display_name: String,
    lock_timeout_secs: u32,
    clipboard_clear_secs: u32,
    lock_on_suspend: bool,
    totp_enabled: bool,
    kdf: KdfParams,
    kdf_profile: &'static str,
    kdf_meets_floor: bool,
    vault_path: String,
    memory_locked: bool,
    auto_sync: bool,
    app_version: &'static str,
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<SettingsDto> {
    let auto_sync = state.inner.lock().unwrap().config.auto_sync;
    with_vault(&state, |v| {
        let s = v.db().settings()?;
        let kdf = v.header().kdf;
        Ok(SettingsDto {
            display_name: s.display_name,
            lock_timeout_secs: s.lock_timeout_secs,
            clipboard_clear_secs: s.clipboard_clear_secs,
            lock_on_suspend: s.lock_on_suspend,
            totp_enabled: v.totp_enabled()?,
            kdf,
            kdf_profile: if kdf == KdfParams::STANDARD {
                "standard"
            } else if kdf == KdfParams::HARDENED {
                "hardened"
            } else {
                "custom"
            },
            kdf_meets_floor: kdf.meets_recommended_floor(),
            vault_path: v.path().display().to_string(),
            memory_locked: v.keys().all_memory_locked() && !kurogane_core::secure::memory_lock_degraded(),
            auto_sync,
            app_version: env!("CARGO_PKG_VERSION"),
        })
    })
}

#[tauri::command]
pub fn update_settings(settings: SettingsUpdate, state: State<'_, AppState>) -> CmdResult<()> {
    mutate(&state, |v| v.db().update_settings(&settings))?;
    if let Some(s) = state.inner.lock().unwrap().session.as_mut() {
        s.set_timeout(Duration::from_secs(settings.lock_timeout_secs as u64));
        s.touch();
    }
    Ok(())
}

#[tauri::command]
pub async fn change_password(
    current: Zeroizing<String>,
    new_password: Zeroizing<String>,
    kdf: Option<String>,
    app: AppHandle,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().unwrap();
        let v = inner.vault.as_mut().ok_or("Vault is locked")?;
        v.verify_password(current.as_bytes()).map_err(|_| "Current password is incorrect".to_string())?;
        let kdf = match kdf.as_deref() {
            Some("standard") => Some(KdfParams::STANDARD),
            Some("hardened") => Some(KdfParams::HARDENED),
            _ => None,
        };
        v.change_password(new_password.as_bytes(), kdf).map_err(err)?;
        inner.request_sync(Duration::from_secs(5));
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn totp_begin(account: String, state: State<'_, AppState>) -> CmdResult<TotpEnrollment> {
    with_vault(&state, |v| v.begin_totp_enrollment(&account))
}

#[tauri::command]
pub fn confirm_totp(code: String, state: State<'_, AppState>) -> CmdResult<()> {
    with_vault(&state, |v| v.confirm_totp(&code))?;
    state.inner.lock().unwrap().request_sync(Duration::from_secs(5));
    Ok(())
}

#[tauri::command]
pub fn totp_disable(code: String, state: State<'_, AppState>) -> CmdResult<()> {
    with_vault(&state, |v| v.disable_totp(&code))?;
    state.inner.lock().unwrap().request_sync(Duration::from_secs(5));
    Ok(())
}
