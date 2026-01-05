use reqwest::blocking::Client;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;

use crate::events::{emit_download, emit_log};
use crate::types::ToolPaths;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const DOVI_TOOL_DRIVE_ID: &str = "1xDHd8ZYoQY_YqIRTjAHHwI_8rlQLq3yH";
const MKVEXTRACT_DRIVE_ID: &str = "1qZrSH7uX6V7GVuileOk0tk7XTyVJsvlF";
const FFMPEG_DRIVE_ID: &str = "1jsAh_R5RiRzL-vw_2TYbtFjsfFT_X6ES";
const MKVMERGE_DRIVE_ID: &str = "1fhKLll-WtrWMPcfipre6D0DUgyHUpMci";

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<(), String> {
    let mut perms = fs::metadata(path)
        .map_err(|e| format!("Cannot read permissions {}: {}", path.display(), e))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)
        .map_err(|e| format!("Cannot set permissions {}: {}", path.display(), e))?;
    Ok(())
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn drive_direct_url(id: &str) -> String {
    format!("https://dd.bypass-bot.workers.dev/direct.aspx?id={}", id)
}

fn log_backend(level: &str, message: &str) {
    println!("[{}] {}", level.to_uppercase(), message);
}

fn log_download(app: &AppHandle, level: &str, message: &str) {
    let tagged = format!("download: {}", message);
    emit_log(app, level, &tagged);
    log_backend(level, &tagged);
}

fn emit_download_progress(
    app: &AppHandle,
    tool: &str,
    stage: &str,
    bytes_received: u64,
    total_bytes: Option<u64>,
    percent: Option<u8>,
    path: Option<&Path>,
) {
    emit_download(
        app,
        crate::types::DownloadProgressPayload {
            tool: tool.to_string(),
            stage: stage.to_string(),
            bytes_received,
            total_bytes,
            percent,
            path: path.map(|value| value.to_string_lossy().to_string()),
        },
    );
}

fn download_to(
    app: &AppHandle,
    tool: &str,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Cannot create HTTP client: {}", e))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("Download failed {}: {}", url, e))?;
    if !response.status().is_success() {
        return Err(format!("Download failed {}: {}", url, response.status()));
    }

    let total_bytes = response.content_length();
    emit_download_progress(app, tool, "downloading", 0, total_bytes, Some(0), None);

    let mut file = File::create(dest).map_err(|e| format!("Cannot write {}: {}", dest.display(), e))?;
    let mut buffer = [0u8; 8192];
    let mut bytes_received: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut last_emit_bytes: u64 = 0;

    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("Cannot read download {}: {}", url, e))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("Cannot save {}: {}", dest.display(), e))?;
        bytes_received += read as u64;

        if let Some(total) = total_bytes {
            let percent = ((bytes_received as f64 / total as f64) * 100.0).floor() as u8;
            if percent != last_percent {
                last_percent = percent;
                emit_download_progress(
                    app,
                    tool,
                    "downloading",
                    bytes_received,
                    total_bytes,
                    Some(percent),
                    None,
                );
            }
        } else if bytes_received.saturating_sub(last_emit_bytes) >= 256 * 1024 {
            last_emit_bytes = bytes_received;
            emit_download_progress(
                app,
                tool,
                "downloading",
                bytes_received,
                total_bytes,
                None,
                None,
            );
        }
    }

    let percent = total_bytes.map(|_| 100);
    emit_download_progress(
        app,
        tool,
        "downloaded",
        bytes_received,
        total_bytes,
        percent,
        None,
    );
    Ok(())
}

fn download_tool_file(
    app: &AppHandle,
    tool_key: &str,
    label: &str,
    drive_id: &str,
    dest: &Path,
) -> Result<(), String> {
    let url = drive_direct_url(drive_id);
    emit_download_progress(app, tool_key, "starting", 0, None, Some(0), None);
    let message = format!("Downloading {} from {}", label, url);
    log_download(app, "info", &message);
    download_to(app, tool_key, &url, dest)?;
    ensure_executable(dest)?;
    emit_download_progress(app, tool_key, "installed", 0, None, Some(100), Some(dest));
    let message = format!("Installed {} to {}", label, dest.display());
    log_download(app, "info", &message);
    Ok(())
}

fn tool_names() -> (&'static str, &'static str, &'static str, &'static str) {
    ("dovi_tool.exe", "mkvmerge.exe", "mkvextract.exe", "ffmpeg.exe")
}

#[tauri::command]
pub async fn download_prerequisites(app: AppHandle) -> Result<ToolPaths, String> {
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let message = "Starting prerequisite download.".to_string();
        log_download(&app_handle, "info", &message);
        let app_data_dir = app_handle
            .path_resolver()
            .app_data_dir()
            .ok_or("Cannot resolve app data directory")?;
        let tools_dir = app_data_dir.join("bin");
        let message = format!("Tools directory: {}", tools_dir.display());
        log_download(&app_handle, "info", &message);
        fs::create_dir_all(&tools_dir)
            .map_err(|e| format!("Cannot create tools directory: {}", e))?;

        let (dovi_name, mkvmerge_name, mkvextract_name, ffmpeg_name) = tool_names();

        let dovi_dest = tools_dir.join(dovi_name);
        download_tool_file(
            &app_handle,
            "doviTool",
            "dovi_tool",
            DOVI_TOOL_DRIVE_ID,
            &dovi_dest,
        )?;

        let mkvmerge_dest = tools_dir.join(mkvmerge_name);
        let mkvextract_dest = tools_dir.join(mkvextract_name);
        download_tool_file(
            &app_handle,
            "mkvmerge",
            "mkvmerge",
            MKVMERGE_DRIVE_ID,
            &mkvmerge_dest,
        )?;
        download_tool_file(
            &app_handle,
            "mkvextract",
            "mkvextract",
            MKVEXTRACT_DRIVE_ID,
            &mkvextract_dest,
        )?;
        let message = format!(
            "Installed MKVToolNix tools: {}, {}",
            mkvmerge_dest.display(),
            mkvextract_dest.display()
        );
        log_download(&app_handle, "info", &message);

        let ffmpeg_dest = tools_dir.join(ffmpeg_name);
        download_tool_file(
            &app_handle,
            "ffmpeg",
            "ffmpeg",
            FFMPEG_DRIVE_ID,
            &ffmpeg_dest,
        )?;

        let (mkvmerge_path, mkvextract_path) = (
            tools_dir.join(mkvmerge_name),
            tools_dir.join(mkvextract_name),
        );

        ensure_executable(&mkvmerge_path)?;
        ensure_executable(&mkvextract_path)?;

        let tool_paths = ToolPaths {
            dovi_tool: dovi_dest.to_string_lossy().to_string(),
            mkvmerge: mkvmerge_path.to_string_lossy().to_string(),
            mkvextract: mkvextract_path.to_string_lossy().to_string(),
            ffmpeg: ffmpeg_dest.to_string_lossy().to_string(),
            default_output: "DV.HDR".to_string(),
        };

        let message = "Prerequisite download complete.".to_string();
        log_download(&app_handle, "info", &message);
        Ok(tool_paths)
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Err(err) = &result {
        let message = format!("Prerequisite download failed: {}", err);
        log_download(&app, "error", &message);
    }

    result
}

#[tauri::command]
pub async fn download_tool(app: AppHandle, tool: String) -> Result<String, String> {
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let app_data_dir = app_handle
            .path_resolver()
            .app_data_dir()
            .ok_or("Cannot resolve app data directory")?;
        let tools_dir = app_data_dir.join("bin");
        fs::create_dir_all(&tools_dir)
            .map_err(|e| format!("Cannot create tools directory: {}", e))?;

        let (key, label, drive_id, filename) = match tool.as_str() {
            "doviTool" => ("doviTool", "dovi_tool", DOVI_TOOL_DRIVE_ID, "dovi_tool.exe"),
            "mkvmerge" => ("mkvmerge", "mkvmerge", MKVMERGE_DRIVE_ID, "mkvmerge.exe"),
            "mkvextract" => ("mkvextract", "mkvextract", MKVEXTRACT_DRIVE_ID, "mkvextract.exe"),
            "ffmpeg" => ("ffmpeg", "ffmpeg", FFMPEG_DRIVE_ID, "ffmpeg.exe"),
            _ => return Err(format!("Unknown tool key: {}", tool)),
        };

        let dest = tools_dir.join(filename);
        download_tool_file(&app_handle, key, label, drive_id, &dest)?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Err(err) = &result {
        let message = format!("Tool download failed: {}", err);
        log_download(&app, "error", &message);
    }

    result
}
