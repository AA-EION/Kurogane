//! Import / export: Excel template, Excel/JSON data, encrypted backup and
//! arbitrary files produced by the UI (map PNG/SVG, FossFLOW JSON).

use std::path::PathBuf;

use kurogane_core::db::models::Topology;
use kurogane_core::interchange::{self, ImportReport};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

use crate::commands::{err, mutate, with_vault, CmdResult};
use crate::state::{AppState, PendingImport};

fn today() -> String {
    interchange::date_from_unix_ms(kurogane_core::vault::now_ms())
}

fn safe_name(s: &str) -> String {
    let n: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let n = n.trim_matches('-').to_string();
    if n.is_empty() {
        "kurogane".into()
    } else {
        n
    }
}

fn save_dialog(app: &AppHandle, title: &str, name: &str, filter: &str, ext: &[&str]) -> CmdResult<Option<PathBuf>> {
    match app.dialog().file().set_title(title).set_file_name(name).add_filter(filter, ext).blocking_save_file() {
        Some(p) => Ok(Some(p.into_path().map_err(err)?)),
        None => Ok(None),
    }
}

/// Save the blank, fillable Excel template.
#[tauri::command]
pub async fn download_template(app: AppHandle) -> CmdResult<Option<String>> {
    let Some(path) = save_dialog(&app, "Save import template", "kurogane-import-template.xlsx", "Excel workbook", &["xlsx"])? else {
        return Ok(None);
    };
    std::fs::write(&path, interchange::template_xlsx().map_err(err)?).map_err(err)?;
    Ok(Some(path.display().to_string()))
}

/// Export inventory as Excel or JSON. Including passwords requires the master
/// password again, because the output file is not encrypted.
#[tauri::command]
pub async fn export_data(
    format: String,
    include_secrets: bool,
    password: Option<Zeroizing<String>>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let vault_name = with_vault(&state, |v| Ok(v.db().settings()?.display_name))?;
    let (ext, filter) = if format == "json" { ("json", "JSON") } else { ("xlsx", "Excel workbook") };
    let suffix = if include_secrets { "-WITH-PASSWORDS" } else { "" };
    let name = format!("{}-{}{suffix}.{ext}", safe_name(&vault_name), today());
    if include_secrets {
        let pw = password.ok_or("Enter your master password to export passwords")?;
        let ok = with_vault(&state, |v| Ok(v.verify_password(pw.as_bytes()).is_ok()))?;
        if !ok {
            return Err("Master password is incorrect".into());
        }
    }
    let Some(path) = save_dialog(&app, "Export inventory", &name, filter, &[ext])? else { return Ok(None) };
    let bytes = with_vault(&state, |v| {
        let key = include_secrets.then_some(&v.keys().field);
        let b = if format == "json" { interchange::export_json(v.db(), key)? } else { interchange::export_xlsx(v.db(), key)? };
        if include_secrets {
            v.audit("export_with_secrets", "vault", &format)?;
        }
        Ok(b)
    })?;
    std::fs::write(&path, &bytes).map_err(err)?;
    let _ = with_vault(&state, |v| v.save_if_dirty());
    Ok(Some(path.display().to_string()))
}

/// Copy the encrypted `.kurogane` file somewhere else (USB stick, NAS…).
#[tauri::command]
pub async fn export_backup(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<String>> {
    let (src, name) = with_vault(&state, |v| {
        v.save_if_dirty()?;
        Ok((v.path().to_path_buf(), v.db().settings()?.display_name))
    })?;
    let Some(dst) =
        save_dialog(&app, "Save encrypted backup", &format!("{}-{}.kurogane", safe_name(&name), today()), "Kurogane vault", &["kurogane"])?
    else {
        return Ok(None);
    };
    if dst == src {
        return Err("Choose a different location than the vault itself".into());
    }
    std::fs::copy(&src, &dst).map_err(err)?;
    Ok(Some(dst.display().to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    file_name: String,
    format: &'static str,
    report: ImportReport,
}

/// Pick an .xlsx / .json file and dry-run it. Nothing is written yet.
#[tauri::command]
pub async fn import_preview(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<ImportPreview>> {
    let Some(picked) =
        app.dialog().file().set_title("Import inventory").add_filter("Excel or JSON", &["xlsx", "json"]).blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(err)?;
    let bytes = std::fs::read(&path).map_err(err)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let is_json = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json"));
    let report = with_vault(&state, |v| {
        if is_json {
            interchange::import_json(v.db(), &v.keys().field, &bytes, false)
        } else {
            interchange::import_xlsx(v.db(), &v.keys().field, &bytes, false)
        }
    })?;
    state.inner.lock().unwrap().pending_import =
        Some(if is_json { PendingImport::Json { name: name.clone(), bytes } } else { PendingImport::Xlsx { name: name.clone(), bytes } });
    Ok(Some(ImportPreview { file_name: name, format: if is_json { "json" } else { "xlsx" }, report }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    report: ImportReport,
    topology: Topology,
}

/// Apply the previewed file. All-or-nothing: on any error the working copy
/// is reloaded from the (unchanged) vault file.
#[tauri::command]
pub fn import_apply(state: State<'_, AppState>) -> CmdResult<ImportResult> {
    let pending = state.inner.lock().unwrap().pending_import.take().ok_or("Choose a file to import first")?;
    let (report, topology) = mutate(&state, |v| {
        let r = match &pending {
            PendingImport::Xlsx { bytes, .. } => interchange::import_xlsx(v.db(), &v.keys().field, bytes, true)?,
            PendingImport::Json { bytes, .. } => interchange::import_json(v.db(), &v.keys().field, bytes, true)?,
        };
        if !r.applied {
            return Err(kurogane_core::Error::Invalid(format!("{} problem(s) in the file — nothing was imported", r.errors.len())));
        }
        let name = match &pending {
            PendingImport::Xlsx { name, .. } | PendingImport::Json { name, .. } => name.clone(),
        };
        v.db().audit("import", Some("file"), Some(&name), None)?;
        Ok(r)
    })?;
    Ok(ImportResult { report, topology })
}

/// Save bytes produced by the UI (PNG/SVG map, FossFLOW JSON).
#[tauri::command]
pub async fn save_file(
    suggested_name: String,
    data_base64: String,
    filter_name: String,
    extensions: Vec<String>,
    app: AppHandle,
) -> CmdResult<Option<String>> {
    let bytes = data_encoding::BASE64.decode(data_base64.as_bytes()).map_err(|_| "invalid file data".to_string())?;
    let ext: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    let Some(path) = save_dialog(&app, "Save file", &suggested_name, &filter_name, &ext)? else { return Ok(None) };
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(Some(path.display().to_string()))
}
