//! Native macOS command boundary. Swift owns presentation; Rust owns the vault.
use std::ffi::{c_char, CStr};
use std::sync::OnceLock;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, Listener, Manager};
use zeroize::Zeroizing;

use crate::{commands as c, io, state::AppState, sync};

static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C" {
    fn kurogane_native_receive_json(message: *const c_char);
    fn kurogane_install_swift_shell(window: *mut std::ffi::c_void);
}

fn deliver(value: Value) {
    let mut bytes = Zeroizing::new(value.to_string().into_bytes());
    bytes.push(0);
    // JSON escapes interior NULs. Swift copies synchronously and the transport
    // buffer (including explicitly revealed secrets) is wiped on return.
    unsafe { kurogane_native_receive_json(bytes.as_ptr().cast()) };
}

pub fn install(app: &AppHandle, window: usize) -> tauri::Result<()> {
    let _ = APP.set(app.clone());
    for name in ["vault://locked", "vault://changed", "sync://status"] {
        app.listen(name, move |event| {
            deliver(json!({"event": name, "payload": serde_json::from_str::<Value>(event.payload()).unwrap_or(Value::Null)}));
        });
    }
    app.run_on_main_thread(move || unsafe { kurogane_install_swift_shell(window as *mut std::ffi::c_void) })
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|_| format!("Invalid native argument: {key}"))
}

fn value<T: serde::Serialize>(result: Result<T, String>) -> Result<Value, String> {
    serde_json::to_value(result?).map_err(c::err)
}

/// Entry point deliberately accepts only the same finite command set as Tauri IPC.
/// The input pointer belongs to Swift and is copied before this function returns.
#[no_mangle]
pub unsafe extern "C" fn kurogane_native_request(message: *const c_char) {
    if message.is_null() {
        return;
    }
    let bytes = Zeroizing::new(unsafe { CStr::from_ptr(message) }.to_bytes().to_vec());
    let Ok(request) = serde_json::from_slice::<Value>(&bytes) else { return };
    let Some(app) = APP.get().cloned() else { return };
    tauri::async_runtime::spawn(async move {
        let id = request["id"].as_str().unwrap_or_default().to_owned();
        let command = request["command"].as_str().unwrap_or_default();
        let result = dispatch(&app, command, &request["args"]).await;
        match result {
            Ok(result) => deliver(json!({"id": id, "result": result})),
            Err(error) => deliver(json!({"id": id, "error": error})),
        }
    });
}

async fn dispatch(app: &AppHandle, command: &str, a: &Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let channel = || {
        Channel::new(|body| {
            if let tauri::ipc::InvokeResponseBody::Json(payload) = body {
                deliver(json!({"event": "cloud:step", "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null)}));
            }
            Ok(())
        })
    };
    match command {
        "app_status" => value(Ok(c::app_status(state))),
        "create_vault" => value(c::create_vault(arg(a, "args")?, state).await),
        "pick_vault_save_path" => value(c::pick_vault_save_path(app.clone()).await),
        "open_vault" => value(c::open_vault(arg(a, "path")?, app.clone(), state).await),
        "close_vault" => value(Ok(c::close_vault(state))),
        "unlock" => value(c::unlock(arg(a, "password")?, arg(a, "totp")?, state).await),
        "lock" => value(c::lock(app.clone()).await),
        "touch" => {
            c::touch(state);
            Ok(Value::Null)
        }
        "topology" => value(c::topology(state)),
        "save_tenant" => value(c::save_tenant(arg(a, "tenant")?, state)),
        "save_network" => value(c::save_network(arg(a, "network")?, state)),
        "save_host" => value(c::save_host(arg(a, "host")?, state)),
        "save_service" => value(c::save_service(arg(a, "service")?, state)),
        "save_proxy" => value(c::save_proxy(arg(a, "proxy")?, state)),
        "save_credential" => value(c::save_credential(arg(a, "credential")?, state)),
        "delete_impact" => value(c::delete_impact(arg(a, "kind")?, arg(a, "id")?, state)),
        "delete_entity" => value(c::delete_entity(arg(a, "kind")?, arg(a, "id")?, state)),
        "reveal_secret" => value(c::reveal_secret(arg(a, "credentialId")?, arg(a, "field")?, state)),
        "copy_secret" => value(c::copy_secret(arg(a, "credentialId")?, arg(a, "field")?, state)),
        "copy_text" => {
            c::copy_text(arg(a, "text")?, state);
            Ok(Value::Null)
        }
        "launch_ssh" => value(c::launch_ssh(arg(a, "hostId")?, arg(a, "credentialId")?, state)),
        "launch_rdp" => value(c::launch_rdp(arg(a, "hostId")?, arg(a, "credentialId")?, state)),
        "launch_web" => value(c::launch_web(arg(a, "url")?, app.clone(), state)),
        "get_settings" => value(c::get_settings(state)),
        "update_settings" => value(c::update_settings(arg(a, "settings")?, state)),
        "change_password" => value(c::change_password(arg(a, "current")?, arg(a, "newPassword")?, arg(a, "kdf")?, app.clone()).await),
        "totp_begin" => value(c::totp_begin(arg(a, "account")?, state)),
        "confirm_totp" => value(c::confirm_totp(arg(a, "code")?, state)),
        "totp_disable" => value(c::totp_disable(arg(a, "code")?, state)),
        "download_template" => value(io::download_template(app.clone()).await),
        "export_data" => {
            value(io::export_data(arg(a, "format")?, arg(a, "includeSecrets")?, arg(a, "password")?, app.clone(), state).await)
        }
        "export_backup" => value(io::export_backup(app.clone(), state).await),
        "import_preview" => value(io::import_preview(app.clone(), state).await),
        "import_apply" => value(io::import_apply(state)),
        "save_file" => value(
            io::save_file(arg(a, "suggestedName")?, arg(a, "dataBase64")?, arg(a, "filterName")?, arg(a, "extensions")?, app.clone()).await,
        ),
        "connect_cloud" => value(sync::connect_cloud(arg(a, "provider")?, arg(a, "mega")?, channel(), app.clone()).await),
        "connect_cloud_finish" => value(sync::connect_cloud_finish(arg(a, "remotePath")?, channel(), app.clone()).await),
        "link_remote" => value(sync::link_remote(arg(a, "provider")?, arg(a, "mega")?, channel(), app.clone()).await),
        "link_folder" => value(sync::link_folder(app.clone()).await),
        "unlink_remote" => value(sync::unlink_remote(arg(a, "id")?, state)),
        "sync_status" => value(Ok(sync::sync_status(state))),
        "set_auto_sync" => value(Ok(sync::set_auto_sync(arg(a, "enabled")?, state))),
        "sync_now" => value(sync::sync_now(app.clone()).await),
        "resolve_conflict" => value(sync::resolve_conflict(arg(a, "choice")?, app.clone()).await),
        _ => Err("Unknown native command".into()),
    }
}
