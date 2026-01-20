use std::fs;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use regex::Regex;
use serde_json::{json, Value};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn hide_console_window(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

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

#[derive(Clone)]
struct VideoInfo {
    width: u32,
    height: u32,
    fps: f64,
    track_id: Option<u32>,
    language: Option<String>,
    format: Option<String>,
}

fn parse_u32_from_value(value: &Value) -> Option<u32> {
    if let Some(v) = value.as_u64() {
        return u32::try_from(v).ok();
    }
    let raw = value.as_str()?;
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

fn parse_fractional_string(raw: &str) -> Option<f64> {
    let filtered: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '/')
        .collect();
    if filtered.is_empty() {
        return None;
    }
    if let Some((num, den)) = filtered.split_once('/') {
        let num: f64 = num.parse().ok()?;
        let den: f64 = den.parse().ok()?;
        if den == 0.0 {
            return None;
        }
        return Some(num / den);
    }
    filtered.parse().ok()
}

fn parse_f64_from_value(value: &Value) -> Option<f64> {
    if let Some(v) = value.as_f64() {
        return Some(v);
    }
    if let Some(raw) = value.as_str() {
        return parse_fractional_string(raw);
    }
    None
}

fn get_video_track(json: &Value) -> Option<&Value> {
    json.get("media")?
        .get("track")?
        .as_array()?
        .iter()
        .find(|track| {
            track
                .get("@type")
                .and_then(Value::as_str)
                .or_else(|| track.get("type").and_then(Value::as_str))
                .map(|t| t.eq_ignore_ascii_case("video"))
                .unwrap_or(false)
        })
}

fn get_mediainfo(tool_path: &Path, file_path: &Path) -> Result<VideoInfo, String> {
    let output = Command::new(tool_path)
        .arg("--Output=JSON")
        .arg("-f")
        .arg(file_path)
        .output()
        .map_err(|e| format!("Failed to run MediaInfo: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "MediaInfo failed (tool: {}): {}",
            tool_path.display(),
            stderr.trim()
        ));
    }

    if output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "MediaInfo returned empty output (tool: {}): {}",
            tool_path.display(),
            stderr.trim()
        ));
    }

    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse MediaInfo JSON: {}", e))?;

    let track = get_video_track(&json).ok_or("No video track found in MediaInfo output")?;

    let width = track
        .get("Width")
        .and_then(parse_u32_from_value)
        .ok_or("MediaInfo width missing")?;
    let height = track
        .get("Height")
        .and_then(parse_u32_from_value)
        .ok_or("MediaInfo height missing")?;

    let fps = track
        .get("FrameRate_Original_Num")
        .and_then(parse_f64_from_value)
        .zip(track.get("FrameRate_Original_Den").and_then(parse_f64_from_value))
        .map(|(num, den)| num / den)
        .or_else(|| {
            track
                .get("FrameRate_Num")
                .and_then(parse_f64_from_value)
                .zip(track.get("FrameRate_Den").and_then(parse_f64_from_value))
                .map(|(num, den)| num / den)
        })
        .or_else(|| {
            track
                .get("FrameRate_Original")
                .and_then(parse_f64_from_value)
        })
        .or_else(|| track.get("FrameRate").and_then(parse_f64_from_value))
        .ok_or("MediaInfo frame rate missing")?;

    let track_id = track
        .get("ID")
        .and_then(parse_u32_from_value)
        .or_else(|| track.get("ID/String").and_then(parse_u32_from_value));

    let language = track
        .get("Language")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    let format = track
        .get("Format")
        .and_then(Value::as_str)
        .or_else(|| track.get("Format/String").and_then(Value::as_str))
        .map(|s| s.to_string());

    Ok(VideoInfo {
        width,
        height,
        fps,
        track_id,
        language,
        format,
    })
}

fn is_mp4_container(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "mp4" | "mov" | "m4v"))
        .unwrap_or(false)
}

fn is_hevc_file(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "hevc" | "h265"))
        .unwrap_or(false)
}

fn is_hevc_format(info: &VideoInfo) -> bool {
    info.format
        .as_ref()
        .map(|fmt| fmt.to_ascii_lowercase().contains("hevc") || fmt.to_ascii_lowercase().contains("h.265"))
        .unwrap_or(false)
}

fn delay_to_frames(delay_ms: f64, fps: f64) -> u32 {
    ((delay_ms.abs() * fps) / 1000.0).round() as u32
}

fn build_demux_command(
    mkvextract: &Path,
    mp4box: &Path,
    input: &Path,
    output: &Path,
    track_id: Option<u32>,
) -> Result<Command, String> {
    if is_mp4_container(input) {
        let id = track_id.ok_or("Missing track ID for MP4Box demux")?;
        let mut cmd = Command::new(mp4box);
        cmd.arg("-raw")
            .arg(id.to_string())
            .arg("-out")
            .arg(output)
            .arg(input);
        return Ok(cmd);
    }

    let mut cmd = Command::new(mkvextract);
    cmd.arg(input).arg("tracks").arg(format!("0:{}", output.to_string_lossy()));
    Ok(cmd)
}

fn noop_command() -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "exit", "0"]);
        cmd
    } else {
        Command::new("true")
    }
}

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

    hide_console_window(&mut command);
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
    hdr10plus_path: Option<&Path>,
    output_path: &Path,
    dv_delay_ms: f64,
    hdr10plus_delay_ms: f64,
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
    let mediainfo = resolve_path(app, &tool_paths.mediainfo);
    let mp4box = resolve_path(app, &tool_paths.mp4box);
    let hdr10plus_tool = resolve_path(app, &tool_paths.hdr10plus_tool);

    let output_base = output_path.to_string_lossy().to_string();
    let audio_loc = PathBuf::from(format!("{}_audiosubs.mka", output_base));
    let dv_hevc = PathBuf::from(format!("{}_dv.hevc", output_base));
    let hdr10_hevc = PathBuf::from(format!("{}_hdr10.hevc", output_base));
    let dv_hdr = PathBuf::from(format!("{}_dv_hdr.hevc", output_base));
    let rpu_bin = PathBuf::from(format!("{}_rpu.bin", output_base));
    let mut temp_files = vec![
        audio_loc.clone(),
        dv_hevc.clone(),
        hdr10_hevc.clone(),
        dv_hdr.clone(),
        rpu_bin.clone(),
    ];

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

    let hdr_info = get_mediainfo(&mediainfo, input_hdr)?;
    let dv_info = get_mediainfo(&mediainfo, input_dv)?;

    if (hdr_info.fps - dv_info.fps).abs() > 0.001 {
        return Err(format!(
            "Frame rate mismatch - DV: {:.3} | HDR: {:.3}",
            dv_info.fps, hdr_info.fps
        ));
    }

    let mut crop = false;
    let mut crop_amount = 0u32;
    if dv_info.height != hdr_info.height {
        if hdr_info.height < dv_info.height {
            crop_amount = (dv_info.height - hdr_info.height) / 2;
            emit_log(
                app,
                "info",
                format!(
                    "Letterboxing needed - {} | HDR: {} | DV: {}",
                    crop_amount, hdr_info.height, dv_info.height
                ),
            );
        } else {
            crop = true;
            crop_amount = (hdr_info.height - dv_info.height) / 2;
            emit_log(
                app,
                "info",
                format!(
                    "Cropping needed - {} | HDR: {} | DV: {}",
                    crop_amount, hdr_info.height, dv_info.height
                ),
            );
        }
    }

    let mut dv_delay_frames = 0u32;
    let mut dv_remove_frames = String::new();
    let mut dv_duplicate_length = 0u32;

    if dv_delay_ms.abs() > f64::EPSILON {
        dv_delay_frames = delay_to_frames(dv_delay_ms, hdr_info.fps);
        emit_log(
            app,
            "info",
            format!("Dolby Vision delay: {} frames", dv_delay_frames),
        );
    }

    if dv_delay_ms < 0.0 && dv_delay_frames > 0 {
        dv_remove_frames = format!("0-{}", dv_delay_frames - 1);
    } else if dv_delay_ms > 0.0 {
        dv_duplicate_length = dv_delay_frames;
    }

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

    let mut dv_extract_cmd = None;
    let mut dv_extract_output = dv_hevc.clone();
    let mut dv_hevc_path = dv_hevc.clone();
    if is_hevc_file(input_dv) && is_hevc_format(&dv_info) {
        dv_hevc_path = input_dv.to_path_buf();
        dv_extract_output = input_dv.to_path_buf();
    } else {
        dv_extract_cmd = Some(build_demux_command(
            &mkvextract,
            &mp4box,
            input_dv,
            &dv_hevc,
            dv_info.track_id,
        )?);
    }

    let mut hdr_extract_cmd = None;
    let mut hdr_extract_output = hdr10_hevc.clone();
    let mut hdr_hevc_path = hdr10_hevc.clone();
    if is_hevc_file(input_hdr) && is_hevc_format(&hdr_info) {
        hdr_hevc_path = input_hdr.to_path_buf();
        hdr_extract_output = input_hdr.to_path_buf();
    } else {
        hdr_extract_cmd = Some(build_demux_command(
            &mkvextract,
            &mp4box,
            input_hdr,
            &hdr10_hevc,
            hdr_info.track_id,
        )?);
    }

    let mut cmd0 = Command::new(&mkvmerge);
    cmd0
        .arg("-o")
        .arg(&audio_loc)
        .arg("--no-video")
        .arg(input_hdr);

    let dv_emit_progress = dv_extract_cmd.is_some();
    let cmd1 = dv_extract_cmd.unwrap_or_else(noop_command);

    let mut cmd2 = Command::new(&dovi_tool);
    cmd2
        .arg("-m")
        .arg("3")
        .arg("extract-rpu")
        .arg(&dv_hevc_path)
        .arg("-o")
        .arg(&rpu_bin);

    let hdr_emit_progress = hdr_extract_cmd.is_some();
    let cmd3 = hdr_extract_cmd.unwrap_or_else(noop_command);

    run_command(
        state,
        cmd0,
        app,
        1,
        STEP_NAMES[0],
        input_hdr,
        &audio_loc,
        true,
        0,
        STEP_NAMES.len(),
        queue_ctx.as_ref(),
    )?;

    run_command(
        state,
        cmd1,
        app,
        2,
        STEP_NAMES[1],
        input_dv,
        &dv_extract_output,
        dv_emit_progress,
        1,
        STEP_NAMES.len(),
        queue_ctx.as_ref(),
    )?;

    run_command(
        state,
        cmd2,
        app,
        3,
        STEP_NAMES[2],
        &dv_hevc_path,
        &rpu_bin,
        false,
        2,
        STEP_NAMES.len(),
        queue_ctx.as_ref(),
    )?;

    let mut rpu_path = rpu_bin.clone();
    let needs_rpu_edit = crop_amount > 0 || !dv_remove_frames.is_empty() || dv_duplicate_length > 0;
    if needs_rpu_edit {
        let rpu_json_path = PathBuf::from(format!("{}_rpu.json", output_base));
        let rpu_edited = PathBuf::from(format!("{}_rpu_edited.bin", output_base));
        let rpu_json = json!({
            "active_area": {
                "crop": crop,
                "presets": [{
                    "id": 0,
                    "left": 0,
                    "right": 0,
                    "top": crop_amount,
                    "bottom": crop_amount
                }]
            },
            "remove": [dv_remove_frames],
            "duplicate": [{
                "source": 0,
                "offset": 0,
                "length": dv_duplicate_length
            }]
        });

        fs::write(&rpu_json_path, serde_json::to_vec_pretty(&rpu_json).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;

        emit_log(app, "info", "Editing RPU metadata...");
        let mut rpu_edit_cmd = Command::new(&dovi_tool);
        rpu_edit_cmd
            .arg("editor")
            .arg("-i")
            .arg(&rpu_path)
            .arg("-o")
            .arg(&rpu_edited)
            .arg("-j")
            .arg(&rpu_json_path);
        hide_console_window(&mut rpu_edit_cmd);
        let status = rpu_edit_cmd.status().map_err(|e| e.to_string())?;

        if !status.success() {
            return Err("RPU edit failed".to_string());
        }
        rpu_path = rpu_edited.clone();
        temp_files.push(rpu_json_path);
        temp_files.push(rpu_edited);
    }

    run_command(
        state,
        cmd3,
        app,
        4,
        STEP_NAMES[3],
        input_hdr,
        &hdr_extract_output,
        hdr_emit_progress,
        3,
        STEP_NAMES.len(),
        queue_ctx.as_ref(),
    )?;

    let mut hdr10_for_dv = hdr_hevc_path.clone();
    if let Some(hdr10plus_source) = hdr10plus_path {
        if !hdr10plus_source.as_os_str().is_empty() {
            emit_log(app, "info", "Extracting HDR10+ metadata...");
            let hdr10plus_info = get_mediainfo(&mediainfo, hdr10plus_source)?;
            let mut hdr10plus_hevc_path = hdr10plus_source.to_path_buf();

            if !(is_hevc_file(hdr10plus_source) && is_hevc_format(&hdr10plus_info)) {
                let hdr10plus_demux = PathBuf::from(format!("{}_hdr10plus.hevc", output_base));
                let mut demux_cmd = build_demux_command(
                    &mkvextract,
                    &mp4box,
                    hdr10plus_source,
                    &hdr10plus_demux,
                    hdr10plus_info.track_id,
                )?;
                hide_console_window(&mut demux_cmd);
                let status = demux_cmd.status().map_err(|e| e.to_string())?;
                if !status.success() {
                    return Err("HDR10+ demux failed".to_string());
                }
                hdr10plus_hevc_path = hdr10plus_demux;
                temp_files.push(hdr10plus_hevc_path.clone());
            }

            let hdr10plus_metadata = PathBuf::from(format!("{}_hdr10plus.json", output_base));
            let mut hdr10plus_extract_cmd = Command::new(&hdr10plus_tool);
            hdr10plus_extract_cmd
                .arg("extract")
                .arg(&hdr10plus_hevc_path)
                .arg("-o")
                .arg(&hdr10plus_metadata);
            hide_console_window(&mut hdr10plus_extract_cmd);
            let status = hdr10plus_extract_cmd.status().map_err(|e| e.to_string())?;

            if !status.success() {
                return Err("HDR10+ metadata extraction failed".to_string());
            }
            temp_files.push(hdr10plus_metadata.clone());

            let mut hdr10plus_metadata_path = hdr10plus_metadata.clone();
            if hdr10plus_delay_ms.abs() > f64::EPSILON {
                let hdr10plus_delay_frames = delay_to_frames(hdr10plus_delay_ms, hdr10plus_info.fps);
                let mut hdr10plus_remove_frames = String::new();
                let mut hdr10plus_duplicate_length = 0u32;

                if hdr10plus_delay_ms < 0.0 && hdr10plus_delay_frames > 0 {
                    hdr10plus_remove_frames = format!("0-{}", hdr10plus_delay_frames - 1);
                } else if hdr10plus_delay_ms > 0.0 {
                    hdr10plus_duplicate_length = hdr10plus_delay_frames;
                }

                if !hdr10plus_remove_frames.is_empty() || hdr10plus_duplicate_length > 0 {
                    let hdr10plus_edits = PathBuf::from(format!("{}_hdr10plus_edits.json", output_base));
                    let hdr10plus_edited = PathBuf::from(format!("{}_hdr10plus_edited.json", output_base));
                    let edits_json = json!({
                        "remove": [hdr10plus_remove_frames],
                        "duplicate": [{
                            "source": 0,
                            "offset": 0,
                            "length": hdr10plus_duplicate_length
                        }]
                    });
                    fs::write(&hdr10plus_edits, serde_json::to_vec_pretty(&edits_json).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;

                    emit_log(app, "info", "Editing HDR10+ metadata...");
                    let mut hdr10plus_edit_cmd = Command::new(&hdr10plus_tool);
                    hdr10plus_edit_cmd
                        .arg("editor")
                        .arg(&hdr10plus_metadata)
                        .arg("-j")
                        .arg(&hdr10plus_edits)
                        .arg("-o")
                        .arg(&hdr10plus_edited);
                    hide_console_window(&mut hdr10plus_edit_cmd);
                    let status = hdr10plus_edit_cmd.status().map_err(|e| e.to_string())?;
                    if !status.success() {
                        return Err("HDR10+ metadata edit failed".to_string());
                    }
                    hdr10plus_metadata_path = hdr10plus_edited.clone();
                    temp_files.push(hdr10plus_edits);
                    temp_files.push(hdr10plus_edited);
                }
            }

            emit_log(app, "info", "Injecting HDR10+ metadata...");
            let hdr10plus_injected = PathBuf::from(format!("{}_hdr10plus_injected.hevc", output_base));
            let mut hdr10plus_inject_cmd = Command::new(&hdr10plus_tool);
            hdr10plus_inject_cmd
                .arg("inject")
                .arg("-i")
                .arg(&hdr10_for_dv)
                .arg("-j")
                .arg(&hdr10plus_metadata_path)
                .arg("-o")
                .arg(&hdr10plus_injected);
            hide_console_window(&mut hdr10plus_inject_cmd);
            let status = hdr10plus_inject_cmd.status().map_err(|e| e.to_string())?;

            if !status.success() {
                return Err("HDR10+ metadata injection failed".to_string());
            }
            hdr10_for_dv = hdr10plus_injected;
            temp_files.push(hdr10_for_dv.clone());
        }
    }

    let mut cmd4 = Command::new(&dovi_tool);
    cmd4
        .arg("inject-rpu")
        .arg("-i")
        .arg(&hdr10_for_dv)
        .arg("--rpu-in")
        .arg(&rpu_path)
        .arg("-o")
        .arg(&dv_hdr);

    run_command(
        state,
        cmd4,
        app,
        5,
        STEP_NAMES[4],
        &hdr10_for_dv,
        &dv_hdr,
        false,
        4,
        STEP_NAMES.len(),
        queue_ctx.as_ref(),
    )?;

    let mut cmd5 = Command::new(&mkvmerge);
    cmd5
        .arg("--ui-language")
        .arg("en")
        .arg("--no-date")
        .arg("--output")
        .arg(output_path);

    if let Some(duration) = detected_duration {
        cmd5.arg("--default-duration").arg(format!("0:{}", duration));
    }

    cmd5
        .arg(&dv_hdr)
        .arg(&audio_loc);

    run_command(
        state,
        cmd5,
        app,
        6,
        STEP_NAMES[5],
        &dv_hdr,
        output_path,
        true,
        5,
        STEP_NAMES.len(),
        queue_ctx.as_ref(),
    )?;

    if !keep_temp {
        for file in temp_files.iter() {
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
    hdr10plus_path: Option<PathBuf>,
    dv_delay_ms: f64,
    hdr10plus_delay_ms: f64,
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
        let hdr10plus_dir = hdr10plus_path.as_ref().filter(|path| path.is_dir());
        let mut hdr10plus_files: Vec<String> = if let Some(dir) = hdr10plus_dir {
            fs::read_dir(dir)
                .map_err(|e| e.to_string())?
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()
        } else {
            Vec::new()
        };
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
        hdr10plus_files.sort();

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
            let hdr10plus_file_path = if let Some(dir) = hdr10plus_dir {
                if dir == &hdr_path {
                    Some(hdr_file_path.clone())
                } else {
                    find_matching_dv_file(&hdr10plus_files, base)
                        .or_else(|| hdr10plus_files.get(index).cloned())
                        .map(|name| dir.join(name))
                }
            } else {
                hdr10plus_path.clone()
            };
            let dv_file_path = dv_path.join(dv_file);
            let output_path = compute_output_for_batch(&output_base, hdr_file);
            let label = format!("{}/{} {}", index + 1, total_files, hdr_file);

            tasks.push((
                index,
                label,
                hdr_file.to_string(),
                hdr_file_path,
                hdr10plus_file_path,
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
            let hdr10plus_path = hdr10plus_path.clone();

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

                let Some((index, label, file_name, hdr_file_path, hdr10plus_file_path, dv_file_path, output_path)) =
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
                    hdr10plus_file_path.as_deref(),
                    &output_path,
                    dv_delay_ms,
                    hdr10plus_delay_ms,
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
            hdr10plus_path.as_deref(),
            &output_path,
            dv_delay_ms,
            hdr10plus_delay_ms,
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
