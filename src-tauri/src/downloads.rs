use regex::Regex;
use reqwest::blocking::Client;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;
use zip::ZipArchive;

use crate::events::emit_log;
use crate::types::ToolPaths;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const DOVI_TOOL_WINDOWS_URL: &str = "https://github.com/quietvoid/dovi_tool/releases/download/2.3.1/dovi_tool-2.3.1-x86_64-pc-windows-msvc.zip";
const FFMPEG_WINDOWS_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

fn ensure_clean_dir(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("Cannot remove {}: {}", path.display(), e))?;
    }
    fs::create_dir_all(path).map_err(|e| format!("Cannot create {}: {}", path.display(), e))?;
    Ok(())
}

fn download_to(url: &str, dest: &Path) -> Result<(), String> {
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
    let mut file = File::create(dest).map_err(|e| format!("Cannot write {}: {}", dest.display(), e))?;
    io::copy(&mut response, &mut file)
        .map_err(|e| format!("Cannot save {}: {}", dest.display(), e))?;
    Ok(())
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("Cannot open {}: {}", zip_path.display(), e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid zip {}: {}", zip_path.display(), e))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Cannot read zip {}: {}", zip_path.display(), e))?;
        let Some(relative_path) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest.join(relative_path);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Cannot create {}: {}", out_path.display(), e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
            }
            let mut out_file =
                File::create(&out_path).map_err(|e| format!("Cannot write {}: {}", out_path.display(), e))?;
            io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Cannot extract {}: {}", out_path.display(), e))?;
        }
        #[cfg(unix)]
        {
            if let Some(mode) = entry.unix_mode() {
                let mut perms = fs::metadata(&out_path)
                    .map_err(|e| format!("Cannot read permissions {}: {}", out_path.display(), e))?
                    .permissions();
                perms.set_mode(mode);
                fs::set_permissions(&out_path, perms)
                    .map_err(|e| format!("Cannot set permissions {}: {}", out_path.display(), e))?;
            }
        }
    }
    Ok(())
}

fn extract_7z(archive_path: &Path, dest: &Path) -> Result<(), String> {
    sevenz_rust::decompress_file(archive_path, dest)
        .map_err(|e| format!("Cannot extract {}: {}", archive_path.display(), e))?;
    Ok(())
}

fn find_file_recursive(root: &Path, target: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, target) {
                return Some(found);
            }
        } else if path.file_name().and_then(|name| name.to_str()) == Some(target) {
            return Some(path);
        }
    }
    None
}

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

fn fetch_mkvtoolnix_url() -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Cannot create HTTP client: {}", e))?;
    let html = client
        .get("https://mkvtoolnix.download/downloads.html")
        .send()
        .map_err(|e| format!("Cannot fetch MKVToolNix downloads: {}", e))?
        .text()
        .map_err(|e| format!("Cannot read MKVToolNix downloads: {}", e))?;

    let windows_re =
        Regex::new(r"windows/releases/[0-9.]+/mkvtoolnix-64-bit-[0-9.]+\.7z")
            .map_err(|e| e.to_string())?;

    let win_match = windows_re
        .find(&html)
        .ok_or("Cannot find MKVToolNix Windows download URL")?;

    Ok(format!(
        "https://mkvtoolnix.download/{}",
        win_match.as_str()
    ))
}

fn copy_tool(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
    }
    if dest.exists() {
        fs::remove_file(dest)
            .map_err(|e| format!("Cannot remove {}: {}", dest.display(), e))?;
    }
    fs::copy(src, dest).map_err(|e| format!("Cannot copy {}: {}", src.display(), e))?;
    ensure_executable(dest)?;
    Ok(())
}

fn tool_names() -> (&'static str, &'static str, &'static str, &'static str) {
    ("dovi_tool.exe", "mkvmerge.exe", "mkvextract.exe", "ffmpeg.exe")
}

#[tauri::command]
pub fn download_prerequisites(app: AppHandle) -> Result<ToolPaths, String> {
    let result = (|| {
    emit_log(&app, "info", "Starting prerequisite download.");
    let app_data_dir = app
        .path_resolver()
        .app_data_dir()
        .ok_or("Cannot resolve app data directory")?;
    let tools_dir = app_data_dir.join("bin");
    emit_log(
        &app,
        "info",
        format!("Tools directory: {}", tools_dir.display()),
    );
    fs::create_dir_all(&tools_dir)
        .map_err(|e| format!("Cannot create tools directory: {}", e))?;

    let temp_root = std::env::temp_dir().join("hybrid-dv-hdr-downloads");
    emit_log(
        &app,
        "info",
        format!("Using temp directory: {}", temp_root.display()),
    );
    ensure_clean_dir(&temp_root)?;

    let (dovi_name, mkvmerge_name, mkvextract_name, ffmpeg_name) = tool_names();

    let dovi_archive = temp_root.join("dovi_tool.zip");
    let dovi_extract = temp_root.join("dovi_tool");
    let dovi_url = DOVI_TOOL_WINDOWS_URL;
    emit_log(
        &app,
        "info",
        format!("Downloading dovi_tool from {}", dovi_url),
    );
    download_to(dovi_url, &dovi_archive)?;
    emit_log(
        &app,
        "info",
        format!("Extracting dovi_tool to {}", dovi_extract.display()),
    );
    ensure_clean_dir(&dovi_extract)?;
    extract_zip(&dovi_archive, &dovi_extract)?;
    let dovi_source = find_file_recursive(&dovi_extract, dovi_name)
        .ok_or_else(|| "Cannot find dovi_tool in archive".to_string())?;
    let dovi_dest = tools_dir.join(dovi_name);
    copy_tool(&dovi_source, &dovi_dest)?;
    emit_log(
        &app,
        "info",
        format!("Installed dovi_tool to {}", dovi_dest.display()),
    );

    emit_log(&app, "info", "Resolving MKVToolNix download URL.");
    let mkv_windows_url = fetch_mkvtoolnix_url()?;
    let mkv_archive = temp_root.join("mkvtoolnix.7z");
    let mkv_extract = temp_root.join("mkvtoolnix");
    emit_log(
        &app,
        "info",
        format!("Downloading MKVToolNix from {}", mkv_windows_url),
    );
    download_to(&mkv_windows_url, &mkv_archive)?;
    emit_log(
        &app,
        "info",
        format!("Extracting MKVToolNix to {}", mkv_extract.display()),
    );
    ensure_clean_dir(&mkv_extract)?;
    extract_7z(&mkv_archive, &mkv_extract)?;

    let mkvmerge_source = find_file_recursive(&mkv_extract, mkvmerge_name)
        .ok_or_else(|| "Cannot find mkvmerge in MKVToolNix archive".to_string())?;
    let mkvextract_source = find_file_recursive(&mkv_extract, mkvextract_name)
        .ok_or_else(|| "Cannot find mkvextract in MKVToolNix archive".to_string())?;

    let mkvmerge_dest = tools_dir.join(mkvmerge_name);
    let mkvextract_dest = tools_dir.join(mkvextract_name);
    copy_tool(&mkvmerge_source, &mkvmerge_dest)?;
    copy_tool(&mkvextract_source, &mkvextract_dest)?;
    emit_log(
        &app,
        "info",
        format!(
            "Installed MKVToolNix tools: {}, {}",
            mkvmerge_dest.display(),
            mkvextract_dest.display()
        ),
    );

    let ffmpeg_archive = temp_root.join("ffmpeg.zip");
    let ffmpeg_extract = temp_root.join("ffmpeg");
    let ffmpeg_url = FFMPEG_WINDOWS_URL;
    emit_log(
        &app,
        "info",
        format!("Downloading ffmpeg from {}", ffmpeg_url),
    );
    download_to(ffmpeg_url, &ffmpeg_archive)?;
    emit_log(
        &app,
        "info",
        format!("Extracting ffmpeg to {}", ffmpeg_extract.display()),
    );
    ensure_clean_dir(&ffmpeg_extract)?;
    extract_zip(&ffmpeg_archive, &ffmpeg_extract)?;
    let ffmpeg_source = find_file_recursive(&ffmpeg_extract, ffmpeg_name)
        .ok_or_else(|| "Cannot find ffmpeg in archive".to_string())?;
    let ffmpeg_dest = tools_dir.join(ffmpeg_name);
    copy_tool(&ffmpeg_source, &ffmpeg_dest)?;
    emit_log(
        &app,
        "info",
        format!("Installed ffmpeg to {}", ffmpeg_dest.display()),
    );

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

    emit_log(&app, "info", "Cleaning up download temp directory.");
    let _ = fs::remove_dir_all(&temp_root);
    emit_log(&app, "info", "Prerequisite download complete.");
    Ok(tool_paths)
    })();

    if let Err(err) = &result {
        emit_log(
            &app,
            "error",
            format!("Prerequisite download failed: {}", err),
        );
    }

    result
}
