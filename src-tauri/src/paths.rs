use regex::Regex;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

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
    let project_candidate = PathBuf::from("src-tauri").join(path);
    if project_candidate.exists() {
        return project_candidate;
    }
    if let Ok(current_dir) = std::env::current_dir() {
        return current_dir.join(path);
    }
    path_buf
}

pub fn prepare_tool(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let resolved = resolve_path(app, path);
    if !resolved.exists() {
        return Err(format!("Tool not found: {}", resolved.display()));
    }
    let file_name = resolved
        .file_name()
        .ok_or_else(|| format!("Invalid tool path: {}", resolved.display()))?;
    let cache_dir = std::env::temp_dir().join("hybrid-dv-hdr-tools");
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Cannot create tool cache: {}", e))?;
    let cached = cache_dir.join(file_name);
    if !cached.exists() {
        fs::copy(&resolved, &cached)
            .map_err(|e| format!("Cannot cache tool {}: {}", resolved.display(), e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&cached)
                .map_err(|e| format!("Cannot read permissions {}: {}", cached.display(), e))?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&cached, perms)
                .map_err(|e| format!("Cannot set permissions {}: {}", cached.display(), e))?;
        }
    }
    Ok(cached)
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

pub fn ensure_readable(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Input not found: {}", path.display()));
    }
    OpenOptions::new()
        .read(true)
        .open(path)
        .map(|_| ())
        .map_err(|e| format!("Cannot read {}: {}", path.display(), e))
}

pub fn ensure_writable(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid output path: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {}", parent.display(), e))?;
    let test_path = parent.join(format!(".write_test_{}.tmp", std::process::id()));
    match OpenOptions::new().create(true).write(true).open(&test_path) {
        Ok(_) => {
            let _ = fs::remove_file(&test_path);
            Ok(())
        }
        Err(e) => Err(format!("Cannot write to {}: {}", parent.display(), e)),
    }
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
