use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

use crate::models::{AppDefaults, PathInfo, ProcessingRequest, ProcessingState, ToolPaths};
use crate::processing::{run_jobs, Job};
use crate::runner::CANCELLED;
use crate::utils::{
    app_bin_dir, app_default_output_dir, compute_output_for_batch, compute_output_for_single,
    derive_output_base, describe_tools, emit_log, emit_status, list_video_files,
    resolve_output_base, resolve_output_dir, resolve_tool, resolve_tools, same_path, FileMatcher,
    DEFAULT_TOOL_NAMES,
};

const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
const DOWNLOAD_MAX_RETRIES: usize = 3;
const MIN_EXE_SIZE: u64 = 100 * 1024;

// ---------------------------------------------------------------------------
// download_file
// ---------------------------------------------------------------------------

fn looks_like_html(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start().to_ascii_lowercase();
    trimmed.starts_with("<!") || trimmed.starts_with("<html")
}

async fn download_once(
    client: &reqwest::Client,
    url: &str,
    part_path: &Path,
    is_exe: bool,
) -> Result<u64, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.starts_with("text/html") {
        return Err(format!(
            "Server returned an HTML page instead of a file (content-type: {})",
            content_type
        ));
    }

    let expected_len = response.content_length();

    let mut file = tokio::fs::File::create(part_path)
        .await
        .map_err(|e| format!("Failed to create {}: {}", part_path.display(), e))?;

    let mut written: u64 = 0;
    let mut head: Vec<u8> = Vec::new();
    let mut response = response;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => return Err(format!("Failed while reading the download: {}", e)),
        };
        if head.len() < 16 {
            head.extend_from_slice(&chunk[..chunk.len().min(16 - head.len())]);
            if looks_like_html(&head) {
                return Err("Downloaded content is an HTML page, not a binary".to_string());
            }
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write to {}: {}", part_path.display(), e))?;
        written += chunk.len() as u64;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    if let Some(expected) = expected_len {
        if expected != written {
            return Err(format!(
                "Incomplete download: expected {} bytes, received {}",
                expected, written
            ));
        }
    }
    if is_exe && written < MIN_EXE_SIZE {
        return Err(format!(
            "Downloaded file is only {} bytes, which is too small to be a valid executable",
            written
        ));
    }
    Ok(written)
}

#[tauri::command]
pub async fn download_file(
    url: String,
    filename: String,
    app: AppHandle,
) -> Result<String, String> {
    emit_log(&app, "info", format!("Downloading {}...", filename));

    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err(format!("Invalid download file name: {}", filename));
    }

    // Use the app data directory to avoid permission issues in Program Files.
    let bin_path = app_bin_dir(&app).ok_or("Could not resolve app data directory".to_string())?;
    fs::create_dir_all(&bin_path)
        .map_err(|e| format!("Cannot create {}: {}", bin_path.display(), e))?;

    let target_path = bin_path.join(&filename);
    let part_path = bin_path.join(format!("{}.part", filename));
    let is_exe = filename.to_ascii_lowercase().ends_with(".exe");

    let client = reqwest::Client::builder()
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TOTAL_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut last_error = String::from("Unknown error");
    for attempt in 1..=DOWNLOAD_MAX_RETRIES {
        if attempt > 1 {
            emit_log(
                &app,
                "info",
                format!(
                    "Retrying download (attempt {}/{})...",
                    attempt, DOWNLOAD_MAX_RETRIES
                ),
            );
            tokio::time::sleep(Duration::from_secs(2)).await;
        }

        let result = download_once(&client, &url, &part_path, is_exe).await;
        match result {
            Ok(written) => {
                let _ = fs::remove_file(&target_path);
                fs::rename(&part_path, &target_path).map_err(|e| {
                    format!("Failed to move {} into place: {}", part_path.display(), e)
                })?;
                emit_log(
                    &app,
                    "success",
                    format!(
                        "Downloaded {} ({} bytes) to {}",
                        filename,
                        written,
                        target_path.display()
                    ),
                );
                return Ok(target_path.to_string_lossy().to_string());
            }
            Err(e) => {
                let _ = fs::remove_file(&part_path);
                emit_log(
                    &app,
                    "warning",
                    format!("Download attempt {} failed: {}", attempt, e),
                );
                last_error = e;
            }
        }
    }

    Err(format!(
        "Failed after {} attempts. Last error: {}",
        DOWNLOAD_MAX_RETRIES, last_error
    ))
}

// ---------------------------------------------------------------------------
// inspect_paths / get_app_defaults
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn inspect_paths(paths: Vec<String>) -> Vec<PathInfo> {
    paths
        .into_iter()
        .map(|path| {
            let p = Path::new(&path);
            let metadata = fs::metadata(p).ok();
            PathInfo {
                exists: metadata.is_some(),
                is_dir: metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                is_file: metadata.as_ref().map(|m| m.is_file()).unwrap_or(false),
                path,
            }
        })
        .collect()
}

#[tauri::command]
pub fn get_app_defaults(app: AppHandle) -> Result<AppDefaults, String> {
    let default_output = app_default_output_dir(&app);
    let bin_dir = app_bin_dir(&app).ok_or("Could not resolve app data directory".to_string())?;

    let resolved: HashMap<&str, String> = DEFAULT_TOOL_NAMES
        .iter()
        .map(|(key, name)| {
            let value = resolve_tool(&app, name)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| name.to_string());
            (*key, value)
        })
        .collect();
    let get = |key: &str| resolved.get(key).cloned().unwrap_or_default();

    Ok(AppDefaults {
        default_output: default_output.to_string_lossy().to_string(),
        bin_dir: bin_dir.to_string_lossy().to_string(),
        tool_paths: ToolPaths {
            dovi_tool: get("dovi_tool"),
            mkvmerge: get("mkvmerge"),
            mkvextract: get("mkvextract"),
            ffmpeg: get("ffmpeg"),
            mediainfo: get("mediainfo"),
            mp4box: get("mp4box"),
            hdr10plus_tool: get("hdr10plus_tool"),
            default_output: default_output.to_string_lossy().to_string(),
        },
    })
}

// ---------------------------------------------------------------------------
// start_processing
// ---------------------------------------------------------------------------

fn non_empty_path(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

#[allow(clippy::too_many_arguments)]
fn folder_jobs(
    app: &AppHandle,
    hdr_dir: &Path,
    dv_dir: &Path,
    hdr10plus: Option<&Path>,
    output_dir: &Path,
    dv_delay_ms: f64,
    hdr10plus_delay_ms: f64,
    queue_id: Option<&str>,
) -> Result<Vec<Job>, String> {
    let (hdr_files, skipped_hdr) = list_video_files(hdr_dir)?;
    let (dv_files, skipped_dv) = list_video_files(dv_dir)?;
    emit_log(
        app,
        "info",
        format!(
            "Found {} HDR file(s) in {} ({} entries skipped)",
            hdr_files.len(),
            hdr_dir.display(),
            skipped_hdr
        ),
    );
    emit_log(
        app,
        "info",
        format!(
            "Found {} DV file(s) in {} ({} entries skipped)",
            dv_files.len(),
            dv_dir.display(),
            skipped_dv
        ),
    );
    if hdr_files.is_empty() {
        return Err(format!("No video files found in {}", hdr_dir.display()));
    }

    let hdr10plus_dir = hdr10plus.filter(|p| p.is_dir());
    let hdr10plus_is_hdr_dir = hdr10plus_dir
        .map(|dir| same_path(dir, hdr_dir))
        .unwrap_or(false);
    let hdr10plus_files = match hdr10plus_dir {
        Some(dir) if !hdr10plus_is_hdr_dir => {
            let (files, skipped) = list_video_files(dir)?;
            emit_log(
                app,
                "info",
                format!(
                    "Found {} HDR10+ file(s) in {} ({} entries skipped)",
                    files.len(),
                    dir.display(),
                    skipped
                ),
            );
            files
        }
        _ => Vec::new(),
    };

    let total = hdr_files.len();
    let mut jobs = Vec::with_capacity(total);
    for (index, hdr_file) in hdr_files.iter().enumerate() {
        let base = derive_output_base(hdr_file);
        let matcher = FileMatcher::new(&base)?;
        let dv_file = matcher.find(&dv_files).ok_or_else(|| {
            format!(
                "No matching DV file for {} (looked for '{}' in {})",
                hdr_file,
                base,
                dv_dir.display()
            )
        })?;

        let hdr_path = hdr_dir.join(hdr_file);
        let hdr10plus_path = match hdr10plus_dir {
            Some(_) if hdr10plus_is_hdr_dir => Some(hdr_path.clone()),
            Some(dir) => {
                let name = matcher.find(&hdr10plus_files).ok_or_else(|| {
                    format!(
                        "No matching HDR10+ file for {} in {}",
                        hdr_file,
                        dir.display()
                    )
                })?;
                Some(dir.join(name))
            }
            None => hdr10plus.map(Path::to_path_buf),
        };

        jobs.push(Job {
            hdr: hdr_path,
            dv: dv_dir.join(dv_file),
            hdr10plus: hdr10plus_path,
            output: compute_output_for_batch(output_dir, hdr_file),
            dv_delay_ms,
            hdr10plus_delay_ms,
            queue_id: queue_id.map(str::to_string),
            label: Some(format!("{}/{} {}", index + 1, total, hdr_file)),
            file_name: hdr_file.clone(),
            file_index: index,
        });
    }
    Ok(jobs)
}

fn single_job(
    hdr: PathBuf,
    dv: PathBuf,
    hdr10plus: Option<PathBuf>,
    output: PathBuf,
    dv_delay_ms: f64,
    hdr10plus_delay_ms: f64,
    queue_id: Option<&str>,
) -> Result<Job, String> {
    if !hdr.is_file() {
        return Err(format!("HDR file not found: {}", hdr.display()));
    }
    if !dv.is_file() {
        return Err(format!("DV file not found: {}", dv.display()));
    }
    if let Some(path) = &hdr10plus {
        if !path.is_file() {
            return Err(format!("HDR10+ file not found: {}", path.display()));
        }
    }
    let file_name = hdr
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("output")
        .to_string();
    Ok(Job {
        hdr,
        dv,
        hdr10plus,
        output,
        dv_delay_ms,
        hdr10plus_delay_ms,
        queue_id: queue_id.map(str::to_string),
        label: None,
        file_name,
        file_index: 0,
    })
}

/// Flatten the request into one job per HDR/DV file pair.
fn build_jobs(
    app: &AppHandle,
    request: &ProcessingRequest,
    default_output: &Path,
) -> Result<Vec<Job>, String> {
    let mut jobs = Vec::new();

    if request.mode == "batch" {
        if request.queue.is_empty() {
            return Err("Queue is empty".to_string());
        }
        emit_log(
            app,
            "info",
            format!("Batch mode: {} items", request.queue.len()),
        );

        for item in &request.queue {
            let hdr10plus = non_empty_path(&item.hdr10plus_path)
                .or_else(|| non_empty_path(&request.hdr10plus_path));
            let (dv_delay_ms, hdr10plus_delay_ms) =
                if item.dv_delay_ms != 0.0 || item.hdr10plus_delay_ms != 0.0 {
                    (item.dv_delay_ms, item.hdr10plus_delay_ms)
                } else {
                    (request.dv_delay_ms, request.hdr10plus_delay_ms)
                };
            let hdr = PathBuf::from(item.hdr_path.trim());
            let dv = PathBuf::from(item.dv_path.trim());

            if hdr.is_dir() && dv.is_dir() {
                let output_dir = resolve_output_dir(default_output, &item.output_path);
                jobs.extend(folder_jobs(
                    app,
                    &hdr,
                    &dv,
                    hdr10plus.as_deref(),
                    &output_dir,
                    dv_delay_ms,
                    hdr10plus_delay_ms,
                    Some(&item.id),
                )?);
            } else {
                let output = compute_output_for_single(default_output, &item.output_path, &hdr);
                jobs.push(single_job(
                    hdr,
                    dv,
                    hdr10plus,
                    output,
                    dv_delay_ms,
                    hdr10plus_delay_ms,
                    Some(&item.id),
                )?);
            }
        }
        return Ok(jobs);
    }

    let hdr10plus = non_empty_path(&request.hdr10plus_path);
    let hdr = PathBuf::from(request.hdr_path.trim());
    let dv = PathBuf::from(request.dv_path.trim());

    if hdr.is_dir() {
        if !dv.is_dir() {
            return Err(format!(
                "HDR path is a folder but DV path is not: {}",
                dv.display()
            ));
        }
        let output_dir = resolve_output_dir(default_output, &request.output_path);
        jobs.extend(folder_jobs(
            app,
            &hdr,
            &dv,
            hdr10plus.as_deref(),
            &output_dir,
            request.dv_delay_ms,
            request.hdr10plus_delay_ms,
            None,
        )?);
    } else {
        let output = compute_output_for_single(default_output, &request.output_path, &hdr);
        jobs.push(single_job(
            hdr,
            dv,
            hdr10plus,
            output,
            request.dv_delay_ms,
            request.hdr10plus_delay_ms,
            None,
        )?);
    }
    Ok(jobs)
}

fn check_duplicate_outputs(jobs: &[Job]) -> Result<(), String> {
    let mut by_output: HashMap<String, Vec<String>> = HashMap::new();
    for job in jobs {
        let key = job.output.to_string_lossy().to_ascii_lowercase();
        by_output
            .entry(key)
            .or_default()
            .push(job.hdr.display().to_string());
    }
    let mut duplicates: Vec<String> = by_output
        .into_iter()
        .filter(|(_, sources)| sources.len() > 1)
        .map(|(output, sources)| format!("{} <- {}", output, sources.join(", ")))
        .collect();
    if duplicates.is_empty() {
        return Ok(());
    }
    duplicates.sort();
    Err(format!(
        "{} output path(s) would be written by more than one source:\n{}",
        duplicates.len(),
        duplicates.join("\n")
    ))
}

#[tauri::command]
pub async fn start_processing(
    app: AppHandle,
    state: tauri::State<'_, ProcessingState>,
    request: ProcessingRequest,
) -> Result<(), String> {
    {
        let mut guard = state.cancel_flag.lock().map_err(|_| "State lock failed")?;
        *guard = false;
    }

    emit_status(&app, "processing");
    emit_log(&app, "info", "Starting Hybrid DV HDR processing...");

    let app_handle = app.clone();
    let state_inner = state.inner().clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let default_output = resolve_output_base(&app_handle, &request.tool_paths.default_output);
        emit_log(
            &app_handle,
            "info",
            format!("Default output folder: {}", default_output.display()),
        );

        let jobs = build_jobs(&app_handle, &request, &default_output)?;
        check_duplicate_outputs(&jobs)?;

        let need_hdr10plus = jobs.iter().any(|job| job.hdr10plus.is_some());
        let tools = resolve_tools(&app_handle, &request.tool_paths, need_hdr10plus)?;
        emit_log(
            &app_handle,
            "info",
            format!("Tools: {}", describe_tools(&tools)),
        );

        run_jobs(
            &app_handle,
            &state_inner,
            Arc::new(tools),
            jobs,
            request.parallel_tasks,
            request.keep_temp_files,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(_) => {
            emit_log(&app, "success", "Processing completed successfully!");
            emit_status(&app, "completed");
            Ok(())
        }
        Err(err) => {
            if err == CANCELLED {
                emit_log(&app, "warning", err.clone());
                emit_status(&app, "idle");
                Ok(())
            } else {
                emit_log(&app, "error", err.clone());
                emit_status(&app, "error");
                Err(err)
            }
        }
    }
}

#[tauri::command]
pub fn cancel_processing(state: tauri::State<'_, ProcessingState>, app: AppHandle) {
    if let Ok(mut guard) = state.cancel_flag.lock() {
        *guard = true;
    }
    emit_log(
        &app,
        "warning",
        "Cancellation requested; stopping running tools...",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(output: &str, hdr: &str) -> Job {
        Job {
            hdr: PathBuf::from(hdr),
            dv: PathBuf::from("dv.mkv"),
            hdr10plus: None,
            output: PathBuf::from(output),
            dv_delay_ms: 0.0,
            hdr10plus_delay_ms: 0.0,
            queue_id: None,
            label: None,
            file_name: hdr.to_string(),
            file_index: 0,
        }
    }

    #[test]
    fn duplicate_outputs_are_rejected() {
        let jobs = vec![
            job("/out/A.mkv", "a.HDR.mkv"),
            job("/out/a.mkv", "a.HDR10.mkv"),
            job("/out/B.mkv", "b.mkv"),
        ];
        let err = check_duplicate_outputs(&jobs).unwrap_err();
        assert!(
            err.contains("/out/a.mkv <- a.HDR.mkv, a.HDR10.mkv"),
            "{}",
            err
        );
        assert!(check_duplicate_outputs(&jobs[2..]).is_ok());
    }

    #[test]
    fn html_detection() {
        assert!(looks_like_html(b"<!DOCTYPE html>"));
        assert!(looks_like_html(b"  <HTML>"));
        assert!(!looks_like_html(b"MZ\x90\x00"));
    }

    #[test]
    fn queue_item_defaults_for_new_fields() {
        let item: crate::models::QueueItem =
            serde_json::from_str(r#"{"id":"1","hdrPath":"h","dvPath":"d","outputPath":""}"#)
                .unwrap();
        assert_eq!(item.hdr10plus_path, "");
        assert_eq!(item.dv_delay_ms, 0.0);
        let item: crate::models::QueueItem = serde_json::from_str(
            r#"{"id":"1","hdrPath":"h","dvPath":"d","outputPath":"","hdr10plusPath":"p","dvDelayMs":-41.7,"hdr10plusDelayMs":2}"#,
        )
        .unwrap();
        assert_eq!(item.hdr10plus_path, "p");
        assert_eq!(item.dv_delay_ms, -41.7);
        assert_eq!(item.hdr10plus_delay_ms, 2.0);
    }
}
