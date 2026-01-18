use std::path::{Path, PathBuf};
use regex::Regex;
use tauri::{AppHandle, Manager};
use crate::models::{LogPayload, StepPayload, QueuePayload, FilePayload, StatusPayload};

pub fn emit_log(app: &AppHandle, log_type: &str, message: impl Into<String>) {
    let _ = app.emit_all(
        "processing:log",
        LogPayload {
            log_type: log_type.to_string(),
            message: message.into(),
        },
    );
}

pub fn emit_step(app: &AppHandle, step_id: usize, name: &str, status: &str, progress: u8) {
    let _ = app.emit_all(
        "processing:step",
        StepPayload {
            step_id,
            name: name.to_string(),
            status: status.to_string(),
            progress,
        },
    );
}

pub fn emit_queue(app: &AppHandle, payload: QueuePayload) {
    let _ = app.emit_all("processing:queue", payload);
}

pub fn emit_file(app: &AppHandle, payload: FilePayload) {
    let _ = app.emit_all("processing:file", payload);
}

pub fn emit_status(app: &AppHandle, status: &str) {
    let _ = app.emit_all(
        "processing:status",
        StatusPayload {
            status: status.to_string(),
        },
    );
}

pub fn resolve_path(app: &AppHandle, path: &str) -> PathBuf {
    let path_buf = PathBuf::from(path);
    if path_buf.is_absolute() {
        return path_buf;
    }
    if let Some(resource_dir) = app.path_resolver().resource_dir() {
        let candidate = resource_dir.join(path);
        if candidate.exists() {
            return candidate;
        }
    }
    if let Ok(current_dir) = std::env::current_dir() {
        return current_dir.join(path);
    }
    path_buf
}

pub fn normalize_output_path(default_output: &str, output_path: &str) -> PathBuf {
    let candidate = PathBuf::from(output_path);
    if output_path.is_empty() {
        return PathBuf::from(default_output);
    }
    if candidate.is_absolute() {
        return candidate;
    }
    Path::new(default_output).join(candidate)
}

pub fn compute_output_for_single(
    default_output: &str,
    output_path: &str,
    hdr_path: &Path,
) -> PathBuf {
    if !output_path.is_empty() {
        return PathBuf::from(output_path);
    }
    let filename = hdr_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let regex = Regex::new(r"(.*)\.(HDR)+.*").ok();
    let base = regex
        .and_then(|re| re.captures(filename).and_then(|c| c.get(1).map(|m| m.as_str())))
        .unwrap_or_else(|| filename.split('.').next().unwrap_or("output"));
    let filename = format!("{}.DV.HDR.H.265-NOGRP.mkv", base);
    Path::new(default_output).join(filename)
}

pub fn compute_output_for_batch(default_output: &str, hdr_file: &str) -> PathBuf {
    let regex = Regex::new(r"(.*)\.(HDR)+.*").ok();
    let base = regex
        .and_then(|re| re.captures(hdr_file).and_then(|c| c.get(1).map(|m| m.as_str())))
        .unwrap_or_else(|| hdr_file.split('.').next().unwrap_or(hdr_file));
    let filename = format!("{}.DV.HDR.H.265-NOGRP.mkv", base);
    Path::new(default_output).join(filename)
}


pub fn find_matching_dv_file(dv_files: &[String], base: &str) -> Option<String> {
    let re = Regex::new(base).ok()?;
    dv_files.iter().find(|f| re.is_match(f)).cloned()
}

pub fn get_video_metadata(tool_path: &Path, file_path: &Path) -> Result<String, String> {
    use std::process::Command;
    
    let output = Command::new(tool_path)
        .arg("--identify")
        .arg("--ui-language")
        .arg("en")
        .arg("--output-charset")
        .arg("utf-8")
        .arg("-J")
        .arg(file_path)
        .output()
        .map_err(|e| format!("Failed to run identification: {}", e))?;

    if !output.status.success() {
        return Err("mkvmerge identification failed".to_string());
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    let tracks = json["tracks"]
        .as_array()
        .ok_or("No tracks found in JSON output")?;

    for track in tracks {
        if track["type"] == "video" {
            let props = &track["properties"];
            
            // Try string format (e.g., "23.976fps")
            if let Some(duration) = props["default_duration"].as_str() {
                return Ok(duration.to_string());
            }
            
            // Try numeric format (nanoseconds)
            if let Some(duration_ns) = props["default_duration"].as_u64() {
                return Ok(format!("{}ns", duration_ns));
            }

            // Fallback logic could go here, but default_duration is the standard mkvmerge way.
            // We could try to calc from frame_rate if present, but relying on default_duration is safest.
        }
    }

    // Log the JSON tracks to help debug if we fail
    // We can't emit log here easily without AppHandle passed in, 
    // so we include the tracks in the error message for debugging.
    Err(format!("No video track with default_duration found (checked string and u64). Tracks: {:?}", tracks))
}
