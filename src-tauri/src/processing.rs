use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use regex::Regex;

use crate::models::{
    ProcessingState, ToolPaths, QueueItem, QueueContext, QueuePayload, FilePayload
};
use crate::utils::{
    emit_log, emit_step, emit_queue, emit_file, resolve_path,
    compute_output_for_single, compute_output_for_batch, normalize_output_path,
    find_matching_dv_file, get_video_metadata
};

const STEP_NAMES: [&str; 6] = [
    "Extract Audio & Subtitles",
    "Extract DV Video",
    "Extract RPU Data",
    "Extract HDR10 Video",
    "Inject RPU Data",
    "Mux Final Output",
];

fn run_command(
    state: &ProcessingState,
    mut command: Command,
    app: &AppHandle,
    step_id: usize,
    step_name: &str,
    input_path: &Path,
    output_path: &Path,
    emit_progress: bool,
    step_index: usize,
    total_steps: usize,
    queue_ctx: Option<&QueueContext>,
) -> Result<(), String> {
    if *state.cancel_flag.lock().map_err(|_| "State lock failed")? {
        return Err("Processing cancelled".to_string());
    }

    emit_step(app, step_id, step_name, "active", 0);
    emit_log(app, "info", format!("Step {}: {}", step_id, step_name));

    let emit_queue_progress = |progress: u8| {
        if let Some(ctx) = queue_ctx {
            let file_progress = ((step_index as f64 + progress as f64 / 100.0)
                / total_steps as f64)
                * 100.0;

            let overall_progress = if let Some(tracker) = &ctx.tracker {
                if let Ok(mut guard) = tracker.lock() {
                    if ctx.file_index < guard.len() {
                        guard[ctx.file_index] = file_progress.round() as u8;
                    }
                    let sum: u32 = guard.iter().map(|v| *v as u32).sum();
                    (sum as f64 / ctx.file_total as f64).round() as u8
                } else {
                    file_progress.round() as u8
                }
            } else {
                file_progress.round() as u8
            };

            let step_label = match &ctx.label {
                Some(label) => format!("{} - {}", label, step_name),
                None => step_name.to_string(),
            };

            emit_queue(
                app,
                QueuePayload {
                    id: ctx.id.clone(),
                    status: "processing".to_string(),
                    progress: overall_progress,
                    current_step: Some(step_label),
                    active_workers: ctx
                        .active_workers
                        .as_ref()
                        .and_then(|workers| workers.lock().ok().map(|v| *v)),
                    file_total: Some(ctx.file_total),
                },
            );

            if let (Some(file_id), Some(file_name)) = (&ctx.file_id, &ctx.file_name) {
                emit_file(
                    app,
                    FilePayload {
                        id: file_id.clone(),
                        queue_id: ctx.id.clone(),
                        name: file_name.clone(),
                        progress: file_progress.round() as u8,
                    },
                );
            }
        }
    };

    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    let input_size = fs::metadata(input_path).map(|m| m.len()).unwrap_or(1);

    let result = loop {
        if *state.cancel_flag.lock().map_err(|_| "State lock failed")? {
            let _ = child.kill();
            return Err("Processing cancelled".to_string());
        }

        if emit_progress {
            if let Ok(metadata) = fs::metadata(output_path) {
                let percent = ((metadata.len() as f64 / input_size as f64) * 100.0)
                    .min(95.0)
                    .max(0.0) as u8;
                emit_step(app, step_id, step_name, "active", percent);
                emit_queue_progress(percent);
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    emit_step(app, step_id, step_name, "completed", 100);
                    emit_queue_progress(100);
                    emit_log(app, "success", format!("Step completed: {}", step_name));
                    break Ok(());
                } else {
                    emit_step(app, step_id, step_name, "error", 0);
                    emit_queue_progress(0);
                    emit_log(app, "error", format!("Step failed: {}", step_name));
                    break Err(format!("Step failed: {}", step_name));
                }
            }
            Ok(None) => {
                thread::sleep(Duration::from_millis(500));
            }
            Err(err) => {
                emit_step(app, step_id, step_name, "error", 0);
                break Err(err.to_string());
            }
        }
    };

    result
}

/// Execute the processing pipeline for a single file pair.
///
/// This function coordinates the extraction, processing, and merging steps:
/// 1. Extract audio/subs
/// 2. Extract DV video and RPU
/// 3. Extract HDR10 video
/// 4. Inject RPU into HDR10
/// 5. Mux final output
pub fn run_pipeline(
    app: &AppHandle,
    state: &ProcessingState,
    tool_paths: &ToolPaths,
    input_hdr: &Path,
    input_dv: &Path,
    output_path: &Path,
    keep_temp: bool,
    queue_id: Option<&str>,
    queue_label: Option<&str>,
    queue_file_name: Option<&str>,
    queue_file_index: usize,
    queue_file_total: usize,
    queue_tracker: Option<Arc<Mutex<Vec<u8>>>>,
    queue_active_workers: Option<Arc<Mutex<usize>>>,
) -> Result<(), String> {
    let dovi_tool = resolve_path(app, &tool_paths.dovi_tool);
    let mkvmerge = resolve_path(app, &tool_paths.mkvmerge);
    let mkvextract = resolve_path(app, &tool_paths.mkvextract);

    let output_base = output_path.to_string_lossy().to_string();
    let audio_loc = format!("{}_audiosubs.mka", output_base);
    let hevc = format!("{}_dv.hevc", output_base);
    let hdr10 = format!("{}_hdr10.hevc", output_base);
    let dv_hdr = format!("{}_dv_hdr.hevc", output_base);
    let rpu_bin = format!("{}_rpu.bin", output_base);

    if let Some(parent) = output_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    // Detect Source Headers / FPS
    let detected_duration = match get_video_metadata(&mkvmerge, input_hdr) {
        Ok(d) => {
            emit_log(app, "info", format!("Detected video duration/fps: {}", d));
            Some(d)
        },
        Err(e) => {
            emit_log(app, "warning", format!("Could not detect video FPS: {}. Defaulting to mkvmerge behavior.", e));
            None
        }
    };

    emit_log(app, "info", format!("Processing: {}", output_path.display()));

    let queue_ctx = queue_id.map(|id| QueueContext {
        id: id.to_string(),
        label: queue_label.map(|label| label.to_string()),
        file_index: queue_file_index,
        file_total: queue_file_total,
        tracker: queue_tracker,
        active_workers: queue_active_workers,
        file_id: Some(format!("{}:{}", id, queue_file_index)),
        file_name: queue_file_name.map(|name| name.to_string()),
    });

    if let Some(ctx) = &queue_ctx {
        let current_step = ctx.label.clone();
        emit_queue(
            app,
            QueuePayload {
                id: ctx.id.clone(),
                status: "processing".to_string(),
                progress: 0,
                current_step,
                active_workers: ctx
                    .active_workers
                    .as_ref()
                    .and_then(|workers| workers.lock().ok().map(|v| *v)),
                file_total: Some(ctx.file_total),
            },
        );

        if let (Some(file_id), Some(file_name)) = (&ctx.file_id, &ctx.file_name) {
            emit_file(
                app,
                FilePayload {
                    id: file_id.clone(),
                    queue_id: ctx.id.clone(),
                    name: file_name.clone(),
                    progress: 0,
                },
            );
        }
    }

    let mut cmd0 = Command::new(&mkvmerge);
    cmd0
        .arg("-o")
        .arg(&audio_loc)
        .arg("--no-video")
        .arg(input_hdr);

    let mut cmd1 = Command::new(&mkvextract);
    cmd1.arg(input_dv).arg("tracks").arg(format!("0:{}", hevc));

    let mut cmd2 = Command::new(&dovi_tool);
    cmd2
        .arg("-m")
        .arg("3")
        .arg("extract-rpu")
        .arg(&hevc)
        .arg("-o")
        .arg(&rpu_bin);

    let mut cmd3 = Command::new(&mkvextract);
    cmd3
        .arg(input_hdr)
        .arg("tracks")
        .arg(format!("0:{}", hdr10));

    let mut cmd4 = Command::new(&dovi_tool);
    cmd4
        .arg("inject-rpu")
        .arg("-i")
        .arg(&hdr10)
        .arg("--rpu-in")
        .arg(&rpu_bin)
        .arg("-o")
        .arg(&dv_hdr);

    let mut cmd5 = Command::new(&mkvmerge);
    cmd5
        .arg("--ui-language")
        .arg("en")
        .arg("--no-date")
        .arg("--output")
        .arg(output_path);

    // Apply forced usage of FPS if detected
    if let Some(duration) = detected_duration {
        cmd5.arg("--default-duration").arg(format!("0:{}", duration));
    }

    cmd5
        .arg(&dv_hdr)
        .arg(&audio_loc);

    let steps: Vec<(usize, Command, PathBuf, PathBuf, bool)> = vec![
        (0, cmd0, input_hdr.to_path_buf(), PathBuf::from(&audio_loc), true),
        (1, cmd1, input_dv.to_path_buf(), PathBuf::from(&hevc), true),
        (2, cmd2, PathBuf::from(&hevc), PathBuf::from(&rpu_bin), false),
        (3, cmd3, input_hdr.to_path_buf(), PathBuf::from(&hdr10), true),
        (4, cmd4, PathBuf::from(&hdr10), PathBuf::from(&dv_hdr), false),
        (5, cmd5, PathBuf::from(&dv_hdr), output_path.to_path_buf(), true),
    ];

    for (index, command, input, output, emit_progress) in steps {
        run_command(
            state,
            command,
            app,
            index + 1,
            STEP_NAMES[index],
            &input,
            &output,
            emit_progress,
            index,
            STEP_NAMES.len(),
            queue_ctx.as_ref(),
        )?;
    }

    if !keep_temp {
        let cleanup_files = [audio_loc, hevc, hdr10, dv_hdr, rpu_bin];
        for file in cleanup_files.iter() {
            let _ = fs::remove_file(file);
        }
        emit_log(app, "info", "Temporary files cleaned up.");
    }

    if let Some(ctx) = &queue_ctx {
        emit_queue(
            app,
            QueuePayload {
                id: ctx.id.clone(),
                status: "completed".to_string(),
                progress: 100,
                current_step: None,
                active_workers: Some(0),
                file_total: Some(ctx.file_total),
            },
        );
    }

    Ok(())
}

pub fn process_queue_item(
    app_handle: AppHandle,
    state: ProcessingState,
    tool_paths: ToolPaths,
    item: QueueItem,
    keep_temp_files: bool,
) -> Result<(), String> {
    emit_log(
        &app_handle,
        "info",
        format!("Processing: {}", item.output_path),
    );

    let hdr_path = PathBuf::from(&item.hdr_path);
    let dv_path = PathBuf::from(&item.dv_path);

    if hdr_path.is_dir() && dv_path.is_dir() {
        let mut hdr_files = fs::read_dir(&hdr_path)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<Vec<String>>();

        let mut dv_files = fs::read_dir(&dv_path)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<Vec<String>>();

        hdr_files.sort();
        dv_files.sort();

        emit_log(
            &app_handle,
            "info",
            format!("Found {} HDR files in {}", hdr_files.len(), hdr_path.display()),
        );

        let output_base = if item.output_path.is_empty() {
            tool_paths.default_output.clone()
        } else {
            item.output_path.clone()
        };

        let total_files = hdr_files.len().max(1);
        emit_queue(
            &app_handle,
            QueuePayload {
                id: item.id.clone(),
                status: "processing".to_string(),
                progress: 0,
                current_step: Some("Scanning folders".to_string()),
                active_workers: Some(0),
                file_total: Some(total_files),
            },
        );

        let mut tasks = Vec::new();
        for (index, hdr_file) in hdr_files.iter().enumerate() {
            let base_regex = Regex::new(r"(.*)\.(HDR)+.*").map_err(|e| e.to_string())?;
            let base = base_regex
                .captures(hdr_file)
                .and_then(|c| c.get(1).map(|m| m.as_str()))
                .unwrap_or_else(|| hdr_file.split('.').next().unwrap_or(hdr_file));

            let dv_file = find_matching_dv_file(&dv_files, base)
                .or_else(|| dv_files.get(index).cloned())
                .ok_or_else(|| format!("No DV file available for {}", hdr_file))?;

            let hdr_file_path = hdr_path.join(hdr_file);
            let dv_file_path = dv_path.join(dv_file);
            let output_path = compute_output_for_batch(&output_base, hdr_file);
            let label = format!("{}/{} {}", index + 1, total_files, hdr_file);

            tasks.push((
                index,
                label,
                hdr_file.to_string(),
                hdr_file_path,
                dv_file_path,
                output_path,
            ));
        }

        let worker_count = total_files;
        let task_queue = Arc::new(Mutex::new(std::collections::VecDeque::from(tasks)));
        let tracker = Arc::new(Mutex::new(vec![0u8; total_files]));
        let active_workers = Arc::new(Mutex::new(0usize));
        let error_state = Arc::new(Mutex::new(None::<String>));
        let queue_id = item.id.clone();

        let mut handles = Vec::new();
        for _ in 0..worker_count {
            let task_queue = Arc::clone(&task_queue);
            let error_state = Arc::clone(&error_state);
            let tracker = Arc::clone(&tracker);
            let active_workers = Arc::clone(&active_workers);
            let app_handle = app_handle.clone();
            let state = state.clone();
            let tool_paths = tool_paths.clone();
            let queue_id = queue_id.clone();

            let handle = thread::spawn(move || loop {
                if let Ok(flag) = state.cancel_flag.lock() {
                    if *flag {
                        break;
                    }
                }

                if error_state.lock().map(|e| e.is_some()).unwrap_or(true) {
                    break;
                }

                let task = {
                    let mut guard = task_queue.lock().unwrap();
                    guard.pop_front()
                };

                let Some((index, label, file_name, hdr_file_path, dv_file_path, output_path)) =
                    task
                else {
                    break;
                };

                if let Ok(mut count) = active_workers.lock() {
                    *count += 1;
                }

                let result = run_pipeline(
                    &app_handle,
                    &state,
                    &tool_paths,
                    &hdr_file_path,
                    &dv_file_path,
                    &output_path,
                    keep_temp_files,
                    Some(&queue_id),
                    Some(&label),
                    Some(&file_name),
                    index,
                    total_files,
                    Some(Arc::clone(&tracker)),
                    Some(Arc::clone(&active_workers)),
                );

                if let Ok(mut count) = active_workers.lock() {
                    *count = count.saturating_sub(1);
                }

                if let Err(err) = result {
                    let _ = error_state.lock().map(|mut e| {
                        if e.is_none() {
                            *e = Some(err);
                        }
                    });
                    break;
                }
            });
            handles.push(handle);
        }

        for handle in handles {
            let _ = handle.join();
        }

        if let Ok(mut guard) = error_state.lock() {
            if let Some(err) = guard.take() {
                return Err(err);
            }
        }

        emit_queue(
            &app_handle,
            QueuePayload {
                id: item.id.clone(),
                status: "completed".to_string(),
                progress: 100,
                current_step: None,
                active_workers: Some(0),
                file_total: Some(total_files),
            },
        );
    } else {
        let output_path = if item.output_path.is_empty() {
            compute_output_for_single(&tool_paths.default_output, "", &hdr_path)
        } else {
            normalize_output_path(&tool_paths.default_output, &item.output_path)
        };

        run_pipeline(
            &app_handle,
            &state,
            &tool_paths,
            &hdr_path,
            &dv_path,
            &output_path,
            keep_temp_files,
            Some(&item.id),
            None,
            None,
            0,
            1,
            None,
            None,
        )?;
    }

    Ok(())
}
