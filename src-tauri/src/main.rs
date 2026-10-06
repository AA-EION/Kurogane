//! KUROGANE desktop shell.
//!
//! Thin by design: the Rust core owns every key and every decision; the
//! webview only renders and asks. See `docs/ARCHITECTURE.md`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod commands;
mod state;

use std::sync::Mutex;
use std::time::Duration;

use kurogane_core::session::LockReason;
use tauri::{Emitter, Manager, RunEvent};

use crate::clipboard::ClipboardWorker;
use crate::state::{AppConfig, AppState, Inner, Paths};

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let config_file = app.path().app_config_dir()?.join("kurogane.json");
            kurogane_core::fsutil::create_private_dir(&data)?;
            let paths = Paths { data, config_file };
            // Leftover working copies / temp keys from a crash are ciphertext,
            // but remove them anyway.
            for dir in [paths.work(), paths.scratch()] {
                let _ = std::fs::remove_dir_all(&dir);
                kurogane_core::fsutil::create_private_dir(&dir)?;
            }
            let config = AppConfig::load(&paths.config_file);
            let inner = Inner { vault_path: config.last_vault_path.filter(|p| p.exists()), ..Default::default() };
            app.manage(AppState { inner: Mutex::new(inner), paths, clipboard: ClipboardWorker::spawn() });

            // Session watchdog: inactivity timeout and suspend detection.
            let handle = app.handle().clone();
            std::thread::Builder::new().name("kurogane-session".into()).spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let state = handle.state::<AppState>();
                let mut inner = state.inner.lock().unwrap();
                let reason = inner.session.as_mut().and_then(|s| s.poll());
                if let Some(reason) = reason {
                    let lock_on_suspend = inner.vault.as_ref().and_then(|v| v.db().settings().ok()).map_or(true, |s| s.lock_on_suspend);
                    if reason == LockReason::SystemSuspend && !lock_on_suspend {
                        continue;
                    }
                    if state.lock_inner(&mut inner, reason) {
                        let _ = handle.emit("vault://locked", reason);
                    }
                }
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::create_vault,
            commands::confirm_totp,
            commands::pick_vault_save_path,
            commands::open_vault,
            commands::unlock,
            commands::lock,
            commands::touch,
            commands::topology,
            commands::reveal_secret,
            commands::copy_secret,
            commands::copy_text,
            commands::launch_ssh,
            commands::launch_rdp,
            commands::launch_web,
            commands::export_text,
            commands::connect_cloud,
            commands::sync_status,
            commands::sync_now,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Kurogane");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            let mut inner = state.inner.lock().unwrap();
            state.lock_inner(&mut inner, LockReason::Manual);
        }
    });
}
