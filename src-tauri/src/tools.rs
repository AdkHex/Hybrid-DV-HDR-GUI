//! Commands the UI calls while a job is being set up: probing a picked source
//! and reporting which external tools are usable.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use regex::Regex;
use serde::Serialize;
use tauri::AppHandle;

use crate::models::{ProcessingState, ToolPaths, Tools};
use crate::probe::probe_video;
use crate::runner::hide_console_window;
use crate::utils::{resolve_tool, DEFAULT_TOOL_NAMES};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: Option<String>,
    pub has_audio_or_subs: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub key: String,
    pub name: String,
    pub required: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

fn configured_name<'a>(paths: &'a ToolPaths, key: &str, default_name: &'a str) -> &'a str {
    let configured = match key {
        "dovi_tool" => paths.dovi_tool.as_str(),
        "mkvmerge" => paths.mkvmerge.as_str(),
        "mkvextract" => paths.mkvextract.as_str(),
        "ffmpeg" => paths.ffmpeg.as_str(),
        "mediainfo" => paths.mediainfo.as_str(),
        "mp4box" => paths.mp4box.as_str(),
        "hdr10plus_tool" => paths.hdr10plus_tool.as_str(),
        _ => "",
    }
    .trim();
    if configured.is_empty() {
        default_name
    } else {
        configured
    }
}

/// Flag each tool accepts to print its version; the first version-looking
/// number in the output is reported.
fn version_flag(key: &str) -> &'static str {
    match key {
        "ffmpeg" => "-version",
        "mediainfo" => "--Version",
        "mp4box" => "-version",
        _ => "--version",
    }
}

fn read_version(path: &Path, flag: &str) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.arg(flag)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let re = Regex::new(r"\d+\.\d+(?:\.\d+)?").ok()?;
    re.find(&text).map(|m| m.as_str().to_string())
}

/// Resolve and version-check every tool. Runs the tools, so it is `async`
/// and executed off the main thread.
#[tauri::command]
pub async fn check_tools(app: AppHandle, tool_paths: ToolPaths) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        DEFAULT_TOOL_NAMES
            .iter()
            .map(|(key, default_name)| {
                let name = configured_name(&tool_paths, key, default_name);
                let path = resolve_tool(&app, name);
                let version = path
                    .as_deref()
                    .and_then(|p| read_version(p, version_flag(key)));
                ToolStatus {
                    key: key.to_string(),
                    name: default_name.to_string(),
                    required: matches!(*key, "dovi_tool" | "mkvmerge" | "mkvextract"),
                    path: path.map(|p| p.to_string_lossy().to_string()),
                    version,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Probe one picked source with mkvmerge (MediaInfo as fallback) so the UI can
/// show its resolution and frame rate before the job runs.
#[tauri::command]
pub async fn probe_source(
    app: AppHandle,
    path: String,
    tool_paths: ToolPaths,
) -> Result<SourceInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mkvmerge = resolve_tool(&app, configured_name(&tool_paths, "mkvmerge", "mkvmerge"))
            .ok_or_else(|| "mkvmerge was not found; set it under Preferences > Tools".to_string())?;
        let tools = Tools {
            dovi_tool: PathBuf::new(),
            mkvmerge,
            mkvextract: PathBuf::new(),
            ffmpeg: None,
            mediainfo: resolve_tool(&app, configured_name(&tool_paths, "mediainfo", "MediaInfo")),
            mp4box: None,
            hdr10plus_tool: None,
        };
        let info = probe_video(&ProcessingState::default(), &app, &tools, Path::new(&path))?;
        Ok(SourceInfo {
            path,
            width: info.width,
            height: info.height,
            fps: info.fps,
            codec: info.codec,
            has_audio_or_subs: info.has_audio_or_subs,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write the log panel's contents to a path the user picked in a save dialog.
#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|e| format!("Cannot write {}: {}", path, e))
}
