use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::models::{FilePayload, ProcessingState, QueueContext, QueuePayload, Tools};
use crate::probe::{fps_argument, is_hevc, probe_video, VideoInfo};
use crate::runner::{describe_command, is_cancelled, run_tool, ToolOutput, CANCELLED};
use crate::utils::{emit_file, emit_log, emit_queue, emit_step, same_path};

const STEP_NAMES: [&str; 6] = [
    "Extract Audio & Subtitles",
    "Extract DV Video",
    "Extract RPU Data",
    "Extract HDR10 Video",
    "Inject RPU Data",
    "Mux Final Output",
];

const ERROR_TAIL_LINES: usize = 30;
pub const MAX_PARALLEL: usize = 16;

/// One HDR/DV file pair to process.
#[derive(Debug, Clone)]
pub struct Job {
    pub hdr: PathBuf,
    pub dv: PathBuf,
    pub hdr10plus: Option<PathBuf>,
    pub output: PathBuf,
    pub dv_delay_ms: f64,
    pub hdr10plus_delay_ms: f64,
    pub queue_id: Option<String>,
    pub label: Option<String>,
    pub file_name: String,
    pub file_index: usize,
}

struct QueueProgress {
    tracker: Arc<Mutex<Vec<u8>>>,
    active_workers: Arc<Mutex<usize>>,
    remaining: Mutex<usize>,
    failed: Mutex<bool>,
    file_total: usize,
}

// ---------------------------------------------------------------------------
// Step execution helpers
// ---------------------------------------------------------------------------

enum StepProgress {
    Indeterminate,
    SizeRatio { input: PathBuf, output: PathBuf },
}

struct StepCtx<'a> {
    app: &'a AppHandle,
    state: &'a ProcessingState,
    queue: Option<&'a QueueContext>,
}

impl StepCtx<'_> {
    fn queue_progress(&self, step_index: usize, step_name: &str, progress: u8) {
        let Some(ctx) = self.queue else {
            return;
        };
        let total_steps = STEP_NAMES.len() as f64;
        let file_progress = ((step_index as f64 + progress as f64 / 100.0) / total_steps) * 100.0;
        let file_progress = file_progress.round().min(100.0) as u8;

        let overall_progress = match &ctx.tracker {
            Some(tracker) => match tracker.lock() {
                Ok(mut guard) => {
                    if ctx.file_index < guard.len() {
                        guard[ctx.file_index] = file_progress;
                    }
                    let sum: u32 = guard.iter().map(|v| *v as u32).sum();
                    (sum as f64 / ctx.file_total.max(1) as f64).round() as u8
                }
                Err(_) => file_progress,
            },
            None => file_progress,
        };

        let step_label = match &ctx.label {
            Some(label) => format!("{} - {}", label, step_name),
            None => step_name.to_string(),
        };

        emit_queue(
            self.app,
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
                self.app,
                FilePayload {
                    id: file_id.clone(),
                    queue_id: ctx.id.clone(),
                    name: file_name.clone(),
                    progress: file_progress,
                    step_index,
                    step_name: step_name.to_string(),
                    status: "processing".to_string(),
                },
            );
        }
    }

    fn log_failure(&self, step_id: usize, step_name: &str, err: &str) {
        if err == CANCELLED {
            emit_step(self.app, step_id, step_name, "error", 0);
            emit_log(
                self.app,
                "warning",
                format!("Step {} cancelled: {}", step_id, step_name),
            );
        } else {
            emit_step(self.app, step_id, step_name, "error", 0);
            emit_log(self.app, "error", err.to_string());
        }
    }

    /// Run a numbered pipeline step. `lenient` treats exit code 1 (the
    /// mkvtoolnix "finished with warnings" code) as success.
    fn run_step(
        &self,
        step_index: usize,
        command: Command,
        progress: StepProgress,
        lenient: bool,
    ) -> Result<ToolOutput, String> {
        let step_id = step_index + 1;
        let step_name = STEP_NAMES[step_index];
        emit_step(self.app, step_id, step_name, "active", 0);
        emit_log(self.app, "info", format!("Step {}: {}", step_id, step_name));
        emit_log(
            self.app,
            "info",
            format!("$ {}", describe_command(&command)),
        );
        self.queue_progress(step_index, step_name, 0);

        let input_size = match &progress {
            StepProgress::SizeRatio { input, .. } => {
                fs::metadata(input).map(|m| m.len()).unwrap_or(0)
            }
            StepProgress::Indeterminate => 0,
        };

        let result = run_tool(self.state, command, || {
            if let StepProgress::SizeRatio { output, .. } = &progress {
                if input_size == 0 {
                    return;
                }
                if let Ok(metadata) = fs::metadata(output) {
                    let percent = ((metadata.len() as f64 / input_size as f64) * 100.0)
                        .clamp(0.0, 95.0) as u8;
                    emit_step(self.app, step_id, step_name, "active", percent);
                    self.queue_progress(step_index, step_name, percent);
                }
            }
        });

        let output = match result {
            Ok(output) => output,
            Err(err) => {
                self.log_failure(step_id, step_name, &err);
                self.queue_progress(step_index, step_name, 0);
                return Err(err);
            }
        };

        let warnings_only = lenient && output.code == Some(1);
        if output.success() || warnings_only {
            if warnings_only {
                emit_log(
                    self.app,
                    "warning",
                    format!(
                        "{} finished with warnings:\n{}",
                        step_name,
                        output.tail(ERROR_TAIL_LINES)
                    ),
                );
            }
            emit_step(self.app, step_id, step_name, "completed", 100);
            self.queue_progress(step_index, step_name, 100);
            emit_log(
                self.app,
                "success",
                format!("Step completed: {}", step_name),
            );
            return Ok(output);
        }

        let err = failure_message(&format!("Step failed: {}", step_name), &output);
        self.log_failure(step_id, step_name, &err);
        self.queue_progress(step_index, step_name, 0);
        Err(err)
    }

    /// Mark a step as completed without running anything.
    fn skip_step(&self, step_index: usize, reason: &str) {
        let step_id = step_index + 1;
        let step_name = STEP_NAMES[step_index];
        emit_step(self.app, step_id, step_name, "active", 0);
        emit_log(
            self.app,
            "info",
            format!("Step {}: {} - skipped ({})", step_id, step_name, reason),
        );
        emit_step(self.app, step_id, step_name, "completed", 100);
        self.queue_progress(step_index, step_name, 100);
    }

    /// Run an auxiliary command (RPU edit, HDR10+ handling) under an existing
    /// step id so it is cancellable and reported like every other step.
    fn run_substep(
        &self,
        step_index: usize,
        label: &str,
        command: Command,
    ) -> Result<ToolOutput, String> {
        let step_id = step_index + 1;
        let step_name = STEP_NAMES[step_index];
        emit_step(self.app, step_id, step_name, "active", 0);
        emit_log(self.app, "info", format!("Step {}: {}", step_id, label));
        emit_log(
            self.app,
            "info",
            format!("$ {}", describe_command(&command)),
        );

        let output = match run_tool(self.state, command, || {}) {
            Ok(output) => output,
            Err(err) => {
                self.log_failure(step_id, step_name, &err);
                return Err(err);
            }
        };

        if output.success() {
            emit_step(self.app, step_id, step_name, "completed", 100);
            emit_log(self.app, "success", format!("{} completed", label));
            return Ok(output);
        }

        let err = failure_message(&format!("{} failed", label), &output);
        self.log_failure(step_id, step_name, &err);
        Err(err)
    }
}

fn failure_message(prefix: &str, output: &ToolOutput) -> String {
    let tail = output.tail(ERROR_TAIL_LINES);
    if tail.is_empty() {
        format!("{} ({})", prefix, output.exit_description())
    } else {
        format!("{} ({}):\n{}", prefix, output.exit_description(), tail)
    }
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

fn extension_is(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| extensions.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_mp4_container(path: &Path) -> bool {
    extension_is(path, &["mp4", "mov", "m4v"])
}

fn is_matroska_container(path: &Path) -> bool {
    extension_is(path, &["mkv", "mka", "mks", "webm"])
}

fn is_hevc_file(path: &Path) -> bool {
    extension_is(path, &["hevc", "h265", "265"])
}

pub fn delay_to_frames(delay_ms: f64, fps: f64) -> u32 {
    ((delay_ms.abs() * fps) / 1000.0).round() as u32
}

/// Convert a delay into `remove` (negative delay) / duplicate length
/// (positive delay) edit parameters.
fn delay_edits(delay_ms: f64, fps: f64) -> (u32, String, u32) {
    if delay_ms.abs() <= f64::EPSILON {
        return (0, String::new(), 0);
    }
    let frames = delay_to_frames(delay_ms, fps);
    if frames == 0 {
        return (0, String::new(), 0);
    }
    if delay_ms < 0.0 {
        (frames, format!("0-{}", frames - 1), 0)
    } else {
        (frames, String::new(), frames)
    }
}

/// Build the dovi_tool `editor` JSON.
///
/// * HDR shorter than DV: the HDR video was cropped while the DV stream carries
///   letterbox bars, so the L5 offsets must be zeroed (`crop: true`).
/// * HDR taller than DV: the HDR video carries the bars, so L5 offsets are
///   added through a preset that is applied to every frame.
///
/// Returns `None` when there is nothing to edit.
pub fn build_rpu_edit_json(
    hdr_height: u32,
    dv_height: u32,
    remove: &str,
    duplicate_length: u32,
) -> Option<Value> {
    let mut root = serde_json::Map::new();

    if hdr_height < dv_height {
        root.insert("active_area".to_string(), json!({ "crop": true }));
    } else if hdr_height > dv_height {
        let amount = (hdr_height - dv_height) / 2;
        root.insert(
            "active_area".to_string(),
            json!({
                "crop": false,
                "presets": [{
                    "id": 0,
                    "left": 0,
                    "right": 0,
                    "top": amount,
                    "bottom": amount
                }],
                "edits": { "all": 0 }
            }),
        );
    }

    if !remove.is_empty() {
        root.insert("remove".to_string(), json!([remove]));
    }
    if duplicate_length > 0 {
        root.insert(
            "duplicate".to_string(),
            json!([{ "source": 0, "offset": 0, "length": duplicate_length }]),
        );
    }

    if root.is_empty() {
        None
    } else {
        Some(Value::Object(root))
    }
}

/// Build the hdr10plus_tool `editor` JSON; `None` when nothing needs editing.
pub fn build_hdr10plus_edit_json(remove: &str, duplicate_length: u32) -> Option<Value> {
    let mut root = serde_json::Map::new();
    if !remove.is_empty() {
        root.insert("remove".to_string(), json!([remove]));
    }
    if duplicate_length > 0 {
        root.insert(
            "duplicate".to_string(),
            json!([{ "source": 0, "offset": 0, "length": duplicate_length }]),
        );
    }
    if root.is_empty() {
        None
    } else {
        Some(Value::Object(root))
    }
}

/// Command to demux the raw HEVC stream. Returns the command and whether the
/// tool follows the mkvtoolnix "exit 1 = warnings" convention.
fn build_demux_command(
    tools: &Tools,
    input: &Path,
    output: &Path,
    info: &VideoInfo,
) -> Result<(Command, bool), String> {
    if is_matroska_container(input) {
        let id = info.track_id.unwrap_or(0);
        let mut cmd = Command::new(&tools.mkvextract);
        cmd.arg(input)
            .arg("tracks")
            .arg(format!("{}:{}", id, output.to_string_lossy()));
        return Ok((cmd, true));
    }

    if let Some(ffmpeg) = &tools.ffmpeg {
        let mut cmd = Command::new(ffmpeg);
        cmd.arg("-y")
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-i")
            .arg(input)
            .arg("-map")
            .arg("0:v:0")
            .arg("-c:v")
            .arg("copy")
            .arg("-bsf:v")
            .arg("hevc_mp4toannexb")
            .arg("-f")
            .arg("hevc")
            .arg(output);
        return Ok((cmd, false));
    }

    if is_mp4_container(input) {
        let mp4box = tools.mp4box.as_ref().ok_or_else(|| {
            format!(
                "Neither ffmpeg nor MP4Box could be found; one of them is required to demux {}",
                input.display()
            )
        })?;
        let track_number = info
            .mediainfo_track_id
            .or_else(|| info.track_id.map(|id| id + 1))
            .unwrap_or(1);
        let mut cmd = Command::new(mp4box);
        cmd.arg("-raw")
            .arg(track_number.to_string())
            .arg("-out")
            .arg(output)
            .arg(input);
        return Ok((cmd, false));
    }

    Err(format!(
        "ffmpeg is required to demux {} but could not be found",
        input.display()
    ))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/// Execute the processing pipeline for a single file pair.
///
/// 1. Extract audio/subs (skipped when the HDR source has none)
/// 2. Extract DV video
/// 3. Extract (and optionally edit) the RPU
/// 4. Extract HDR10 video (and optionally HDR10+ metadata)
/// 5. Inject the RPU into the HDR10 stream
/// 6. Mux the final output
pub fn run_pipeline(
    app: &AppHandle,
    state: &ProcessingState,
    tools: &Tools,
    job: &Job,
    keep_temp: bool,
    queue_ctx: Option<&QueueContext>,
) -> Result<(), String> {
    let ctx = StepCtx {
        app,
        state,
        queue: queue_ctx,
    };
    let output_path = &job.output;

    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create output folder {}: {}", parent.display(), e))?;
        }
    }

    let stem = output_path.with_extension("").to_string_lossy().to_string();
    let temp = |suffix: &str| PathBuf::from(format!("{}{}", stem, suffix));
    let audio_loc = temp("_audiosubs.mka");
    let dv_hevc = temp("_dv.hevc");
    let hdr10_hevc = temp("_hdr10.hevc");
    let dv_hdr = temp("_dv_hdr.hevc");
    let rpu_bin = temp("_rpu.bin");
    let mut temp_files: Vec<PathBuf> = Vec::new();

    emit_log(
        app,
        "info",
        format!("Processing: {}", output_path.display()),
    );

    if let Some(qc) = queue_ctx {
        emit_queue(
            app,
            QueuePayload {
                id: qc.id.clone(),
                status: "processing".to_string(),
                progress: 0,
                current_step: qc.label.clone(),
                active_workers: qc
                    .active_workers
                    .as_ref()
                    .and_then(|workers| workers.lock().ok().map(|v| *v)),
                file_total: Some(qc.file_total),
            },
        );
        if let (Some(file_id), Some(file_name)) = (&qc.file_id, &qc.file_name) {
            emit_file(
                app,
                FilePayload {
                    id: file_id.clone(),
                    queue_id: qc.id.clone(),
                    name: file_name.clone(),
                    progress: 0,
                    step_index: 0,
                    step_name: String::new(),
                    status: "processing".to_string(),
                },
            );
        }
    }

    // --- Probe sources -----------------------------------------------------
    let hdr_info = probe_video(state, app, tools, &job.hdr)?;
    let dv_info = probe_video(state, app, tools, &job.dv)?;
    emit_log(
        app,
        "info",
        format!(
            "HDR: {}x{} @ {:.3} fps ({}) | DV: {}x{} @ {:.3} fps ({})",
            hdr_info.width,
            hdr_info.height,
            hdr_info.fps,
            hdr_info.codec.as_deref().unwrap_or("unknown codec"),
            dv_info.width,
            dv_info.height,
            dv_info.fps,
            dv_info.codec.as_deref().unwrap_or("unknown codec"),
        ),
    );

    if (hdr_info.fps - dv_info.fps).abs() > 0.001 {
        return Err(format!(
            "Frame rate mismatch - DV: {:.3} | HDR: {:.3}",
            dv_info.fps, hdr_info.fps
        ));
    }

    if hdr_info.height < dv_info.height {
        emit_log(
            app,
            "info",
            format!(
                "HDR source is cropped ({} vs DV {}): letterbox offsets will be removed from the RPU",
                hdr_info.height, dv_info.height
            ),
        );
    } else if hdr_info.height > dv_info.height {
        emit_log(
            app,
            "info",
            format!(
                "HDR source carries letterbox bars ({} vs DV {}): {} px offsets will be added to the RPU",
                hdr_info.height,
                dv_info.height,
                (hdr_info.height - dv_info.height) / 2
            ),
        );
    }

    let (dv_delay_frames, dv_remove_frames, dv_duplicate_length) =
        delay_edits(job.dv_delay_ms, hdr_info.fps);
    if dv_delay_frames > 0 {
        emit_log(
            app,
            "info",
            format!("Dolby Vision delay: {} frames", dv_delay_frames),
        );
    }

    // --- Step 1: audio & subtitles ----------------------------------------
    let mux_audio = hdr_info.has_audio_or_subs;
    if mux_audio {
        let mut cmd = Command::new(&tools.mkvmerge);
        cmd.arg("--ui-language")
            .arg("en")
            .arg("-o")
            .arg(&audio_loc)
            .arg("--no-video")
            .arg(&job.hdr);
        temp_files.push(audio_loc.clone());
        ctx.run_step(0, cmd, StepProgress::Indeterminate, true)?;
    } else {
        ctx.skip_step(0, "no audio/subtitle tracks in the HDR source");
    }

    // --- Step 2: DV video --------------------------------------------------
    let dv_hevc_path = if is_hevc_file(&job.dv) && is_hevc(&dv_info) {
        ctx.skip_step(1, "DV source is already a raw HEVC stream");
        job.dv.clone()
    } else {
        let (cmd, lenient) = build_demux_command(tools, &job.dv, &dv_hevc, &dv_info)?;
        temp_files.push(dv_hevc.clone());
        ctx.run_step(
            1,
            cmd,
            StepProgress::SizeRatio {
                input: job.dv.clone(),
                output: dv_hevc.clone(),
            },
            lenient,
        )?;
        dv_hevc.clone()
    };

    // --- Step 3: RPU -------------------------------------------------------
    let mut cmd = Command::new(&tools.dovi_tool);
    cmd.arg("-m")
        .arg("3")
        .arg("extract-rpu")
        .arg(&dv_hevc_path)
        .arg("-o")
        .arg(&rpu_bin);
    temp_files.push(rpu_bin.clone());
    ctx.run_step(2, cmd, StepProgress::Indeterminate, false)?;

    let mut rpu_path = rpu_bin.clone();
    if let Some(rpu_json) = build_rpu_edit_json(
        hdr_info.height,
        dv_info.height,
        &dv_remove_frames,
        dv_duplicate_length,
    ) {
        let rpu_json_path = temp("_rpu.json");
        let rpu_edited = temp("_rpu_edited.bin");
        write_json(&rpu_json_path, &rpu_json)?;
        temp_files.push(rpu_json_path.clone());
        temp_files.push(rpu_edited.clone());

        let mut cmd = Command::new(&tools.dovi_tool);
        cmd.arg("editor")
            .arg("-i")
            .arg(&rpu_path)
            .arg("-o")
            .arg(&rpu_edited)
            .arg("-j")
            .arg(&rpu_json_path);
        ctx.run_substep(2, "Edit RPU metadata", cmd)?;
        rpu_path = rpu_edited;
    }

    // --- Step 4: HDR10 video -----------------------------------------------
    let hdr_hevc_path = if is_hevc_file(&job.hdr) && is_hevc(&hdr_info) {
        ctx.skip_step(3, "HDR source is already a raw HEVC stream");
        job.hdr.clone()
    } else {
        let (cmd, lenient) = build_demux_command(tools, &job.hdr, &hdr10_hevc, &hdr_info)?;
        temp_files.push(hdr10_hevc.clone());
        ctx.run_step(
            3,
            cmd,
            StepProgress::SizeRatio {
                input: job.hdr.clone(),
                output: hdr10_hevc.clone(),
            },
            lenient,
        )?;
        hdr10_hevc.clone()
    };

    // --- HDR10+ ------------------------------------------------------------
    let mut hdr10_for_dv = hdr_hevc_path.clone();
    if let Some(hdr10plus_source) = job
        .hdr10plus
        .as_deref()
        .filter(|p| !p.as_os_str().is_empty())
    {
        let hdr10plus_tool = tools
            .hdr10plus_tool
            .as_ref()
            .ok_or("hdr10plus_tool is required for HDR10+ processing but could not be found")?;

        let same_as_hdr = same_path(hdr10plus_source, &job.hdr);
        let (hdr10plus_hevc_path, hdr10plus_info) = if same_as_hdr {
            emit_log(
                app,
                "info",
                "HDR10+ source is the HDR file: reusing the demuxed HDR10 stream",
            );
            (hdr_hevc_path.clone(), hdr_info.clone())
        } else {
            let info = probe_video(state, app, tools, hdr10plus_source)?;
            if is_hevc_file(hdr10plus_source) && is_hevc(&info) {
                (hdr10plus_source.to_path_buf(), info)
            } else {
                let hdr10plus_demux = temp("_hdr10plus.hevc");
                let (cmd, _) =
                    build_demux_command(tools, hdr10plus_source, &hdr10plus_demux, &info)?;
                temp_files.push(hdr10plus_demux.clone());
                ctx.run_substep(3, "Extract HDR10+ video", cmd)?;
                (hdr10plus_demux, info)
            }
        };

        let hdr10plus_metadata = temp("_hdr10plus.json");
        let mut cmd = Command::new(hdr10plus_tool);
        cmd.arg("extract")
            .arg(&hdr10plus_hevc_path)
            .arg("-o")
            .arg(&hdr10plus_metadata);
        temp_files.push(hdr10plus_metadata.clone());
        ctx.run_substep(3, "Extract HDR10+ metadata", cmd)?;

        let mut hdr10plus_metadata_path = hdr10plus_metadata.clone();
        let mut edited = false;
        let (hdr10plus_delay_frames, hdr10plus_remove, hdr10plus_duplicate) =
            delay_edits(job.hdr10plus_delay_ms, hdr10plus_info.fps);
        if hdr10plus_delay_frames > 0 {
            emit_log(
                app,
                "info",
                format!("HDR10+ delay: {} frames", hdr10plus_delay_frames),
            );
        }
        if let Some(edits_json) = build_hdr10plus_edit_json(&hdr10plus_remove, hdr10plus_duplicate)
        {
            let hdr10plus_edits = temp("_hdr10plus_edits.json");
            let hdr10plus_edited = temp("_hdr10plus_edited.json");
            write_json(&hdr10plus_edits, &edits_json)?;
            temp_files.push(hdr10plus_edits.clone());
            temp_files.push(hdr10plus_edited.clone());

            let mut cmd = Command::new(hdr10plus_tool);
            cmd.arg("editor")
                .arg(&hdr10plus_metadata)
                .arg("-j")
                .arg(&hdr10plus_edits)
                .arg("-o")
                .arg(&hdr10plus_edited);
            ctx.run_substep(3, "Edit HDR10+ metadata", cmd)?;
            hdr10plus_metadata_path = hdr10plus_edited;
            edited = true;
        }

        if same_as_hdr && !edited {
            emit_log(
                app,
                "info",
                "HDR10+ metadata is already carried by the HDR10 stream; skipping injection",
            );
        } else {
            let hdr10plus_injected = temp("_hdr10plus_injected.hevc");
            let mut cmd = Command::new(hdr10plus_tool);
            cmd.arg("inject")
                .arg("-i")
                .arg(&hdr10_for_dv)
                .arg("-j")
                .arg(&hdr10plus_metadata_path)
                .arg("-o")
                .arg(&hdr10plus_injected);
            temp_files.push(hdr10plus_injected.clone());
            ctx.run_substep(3, "Inject HDR10+ metadata", cmd)?;
            hdr10_for_dv = hdr10plus_injected;
        }
    }

    // --- Step 5: inject RPU ------------------------------------------------
    let mut cmd = Command::new(&tools.dovi_tool);
    cmd.arg("inject-rpu")
        .arg("-i")
        .arg(&hdr10_for_dv)
        .arg("--rpu-in")
        .arg(&rpu_path)
        .arg("-o")
        .arg(&dv_hdr);
    temp_files.push(dv_hdr.clone());
    ctx.run_step(4, cmd, StepProgress::Indeterminate, false)?;

    // --- Step 6: mux -------------------------------------------------------
    let fps_arg = fps_argument(&hdr_info);
    emit_log(
        app,
        "info",
        format!("Muxing with --default-duration 0:{}", fps_arg),
    );
    let mut cmd = Command::new(&tools.mkvmerge);
    cmd.arg("--ui-language")
        .arg("en")
        .arg("--no-date")
        .arg("--output")
        .arg(output_path)
        .arg("--default-duration")
        .arg(format!("0:{}", fps_arg))
        .arg(&dv_hdr);
    if mux_audio {
        cmd.arg(&audio_loc);
    }
    ctx.run_step(
        5,
        cmd,
        StepProgress::SizeRatio {
            input: dv_hdr.clone(),
            output: output_path.clone(),
        },
        true,
    )?;

    if !keep_temp {
        for file in temp_files.iter() {
            let _ = fs::remove_file(file);
        }
        emit_log(app, "info", "Temporary files cleaned up.");
    }

    emit_log(
        app,
        "success",
        format!("Finished: {}", output_path.display()),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

fn emit_queue_final(
    app: &AppHandle,
    id: &str,
    status: &str,
    progress: u8,
    current_step: Option<String>,
    file_total: usize,
) {
    emit_queue(
        app,
        QueuePayload {
            id: id.to_string(),
            status: status.to_string(),
            progress,
            current_step,
            active_workers: Some(0),
            file_total: Some(file_total),
        },
    );
}

fn short_error(err: &str) -> String {
    let first = err.lines().next().unwrap_or(err).trim();
    if first.chars().count() > 120 {
        let cut: String = first.chars().take(117).collect();
        format!("{}...", cut)
    } else {
        first.to_string()
    }
}

/// Run every job through a fixed pool of `parallel` workers. Queue payloads are
/// emitted per queue id; `completed` is emitted exactly once per queue, when
/// all of its files are done.
pub fn run_jobs(
    app: &AppHandle,
    state: &ProcessingState,
    tools: Arc<Tools>,
    jobs: Vec<Job>,
    parallel: usize,
    keep_temp: bool,
) -> Result<(), String> {
    if jobs.is_empty() {
        return Err("Nothing to process".to_string());
    }

    let mut counts: HashMap<String, usize> = HashMap::new();
    for job in &jobs {
        if let Some(id) = &job.queue_id {
            *counts.entry(id.clone()).or_insert(0) += 1;
        }
    }
    let queues: HashMap<String, Arc<QueueProgress>> = counts
        .into_iter()
        .map(|(id, count)| {
            (
                id,
                Arc::new(QueueProgress {
                    tracker: Arc::new(Mutex::new(vec![0u8; count])),
                    active_workers: Arc::new(Mutex::new(0)),
                    remaining: Mutex::new(count),
                    failed: Mutex::new(false),
                    file_total: count,
                }),
            )
        })
        .collect();
    let queues = Arc::new(queues);

    let worker_count = parallel.clamp(1, MAX_PARALLEL).min(jobs.len());
    emit_log(
        app,
        "info",
        format!(
            "{} file(s) to process with {} parallel worker(s)",
            jobs.len(),
            worker_count
        ),
    );

    let task_queue = Arc::new(Mutex::new(VecDeque::from(jobs)));
    let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let task_queue = Arc::clone(&task_queue);
        let errors = Arc::clone(&errors);
        let queues = Arc::clone(&queues);
        let tools = Arc::clone(&tools);
        let app = app.clone();
        let state = state.clone();

        handles.push(thread::spawn(move || loop {
            if is_cancelled(&state).unwrap_or(true) {
                break;
            }
            let job = match task_queue.lock() {
                Ok(mut guard) => guard.pop_front(),
                Err(_) => None,
            };
            let Some(job) = job else {
                break;
            };

            let progress = job.queue_id.as_ref().and_then(|id| queues.get(id).cloned());
            if let Some(progress) = &progress {
                if let Ok(mut count) = progress.active_workers.lock() {
                    *count += 1;
                }
            }

            let queue_ctx = job
                .queue_id
                .as_ref()
                .zip(progress.as_ref())
                .map(|(id, progress)| QueueContext {
                    id: id.clone(),
                    label: job.label.clone(),
                    file_index: job.file_index,
                    file_total: progress.file_total,
                    tracker: Some(Arc::clone(&progress.tracker)),
                    active_workers: Some(Arc::clone(&progress.active_workers)),
                    file_id: Some(format!("{}:{}", id, job.file_index)),
                    file_name: Some(job.file_name.clone()),
                });

            let result = run_pipeline(&app, &state, &tools, &job, keep_temp, queue_ctx.as_ref());

            // Per-file outcome, so the UI can mark a single file in a folder
            // job as finished or failed while its siblings keep running.
            if let Some(qc) = &queue_ctx {
                if let (Some(file_id), Some(file_name)) = (&qc.file_id, &qc.file_name) {
                    let (status, progress, step_name) = match &result {
                        Ok(()) => ("completed", 100, String::new()),
                        Err(err) if err == CANCELLED => ("pending", 0, String::new()),
                        Err(err) => ("error", 0, short_error(err)),
                    };
                    emit_file(
                        &app,
                        FilePayload {
                            id: file_id.clone(),
                            queue_id: qc.id.clone(),
                            name: file_name.clone(),
                            progress,
                            step_index: 0,
                            step_name,
                            status: status.to_string(),
                        },
                    );
                }
            }

            if let Some(progress) = &progress {
                if let Ok(mut count) = progress.active_workers.lock() {
                    *count = count.saturating_sub(1);
                }
            }

            let cancelled = matches!(&result, Err(err) if err == CANCELLED);
            if let Err(err) = &result {
                if !cancelled {
                    if let Ok(mut guard) = errors.lock() {
                        guard.push(format!("{}: {}", job.file_name, err));
                    }
                }
            }

            if let (Some(id), Some(progress)) = (&job.queue_id, &progress) {
                let remaining = {
                    let mut guard = progress.remaining.lock().unwrap_or_else(|e| e.into_inner());
                    *guard = guard.saturating_sub(1);
                    *guard
                };
                match &result {
                    Ok(()) => {
                        let failed = progress.failed.lock().map(|f| *f).unwrap_or(false);
                        if remaining == 0 && !failed {
                            emit_queue_final(&app, id, "completed", 100, None, progress.file_total);
                        }
                    }
                    Err(err) => {
                        if let Ok(mut failed) = progress.failed.lock() {
                            *failed = true;
                        }
                        let overall = progress
                            .tracker
                            .lock()
                            .map(|t| {
                                (t.iter().map(|v| *v as u32).sum::<u32>() as f64
                                    / progress.file_total.max(1) as f64)
                                    .round() as u8
                            })
                            .unwrap_or(0);
                        let status = if cancelled { "pending" } else { "error" };
                        let step = if cancelled {
                            None
                        } else {
                            Some(short_error(err))
                        };
                        emit_queue_final(&app, id, status, overall, step, progress.file_total);
                    }
                }
            }

            if cancelled {
                break;
            }
        }));
    }

    for handle in handles {
        let _ = handle.join();
    }

    if is_cancelled(state)? {
        // Reset queues that never started so the UI does not show them as stuck.
        if let Ok(guard) = task_queue.lock() {
            let mut seen = std::collections::HashSet::new();
            for job in guard.iter() {
                if let Some(id) = &job.queue_id {
                    if seen.insert(id.clone()) {
                        if let Some(progress) = queues.get(id) {
                            emit_queue_final(app, id, "pending", 0, None, progress.file_total);
                        }
                    }
                }
            }
        }
        return Err(CANCELLED.to_string());
    }

    let errors = errors.lock().map(|e| e.clone()).unwrap_or_default();
    if errors.is_empty() {
        Ok(())
    } else if errors.len() == 1 {
        Err(errors.into_iter().next().unwrap_or_default())
    } else {
        Err(format!(
            "{} file(s) failed:\n{}",
            errors.len(),
            errors.join("\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpu_edit_removes_bars_when_hdr_is_cropped() {
        let value = build_rpu_edit_json(1600, 2160, "", 0).unwrap();
        assert_eq!(value, json!({ "active_area": { "crop": true } }));
    }

    #[test]
    fn rpu_edit_adds_preset_and_edits_when_hdr_has_bars() {
        let value = build_rpu_edit_json(2160, 1600, "", 0).unwrap();
        assert_eq!(
            value,
            json!({
                "active_area": {
                    "crop": false,
                    "presets": [{ "id": 0, "left": 0, "right": 0, "top": 280, "bottom": 280 }],
                    "edits": { "all": 0 }
                }
            })
        );
    }

    #[test]
    fn rpu_edit_only_includes_non_empty_delay_edits() {
        assert_eq!(build_rpu_edit_json(2160, 2160, "", 0), None);

        let value = build_rpu_edit_json(2160, 2160, "0-23", 0).unwrap();
        assert_eq!(value, json!({ "remove": ["0-23"] }));
        assert!(value.get("active_area").is_none());
        assert!(value.get("duplicate").is_none());

        let value = build_rpu_edit_json(1600, 2160, "", 12).unwrap();
        assert_eq!(value["active_area"]["crop"], json!(true));
        assert_eq!(
            value["duplicate"],
            json!([{ "source": 0, "offset": 0, "length": 12 }])
        );
        assert!(value.get("remove").is_none());
    }

    #[test]
    fn hdr10plus_edit_json_only_when_needed() {
        assert_eq!(build_hdr10plus_edit_json("", 0), None);
        assert_eq!(
            build_hdr10plus_edit_json("0-5", 0).unwrap(),
            json!({ "remove": ["0-5"] })
        );
        assert_eq!(
            build_hdr10plus_edit_json("", 3).unwrap(),
            json!({ "duplicate": [{ "source": 0, "offset": 0, "length": 3 }] })
        );
    }

    #[test]
    fn delay_edits_from_milliseconds() {
        assert_eq!(delay_edits(0.0, 23.976), (0, String::new(), 0));
        assert_eq!(delay_edits(-1000.0, 24.0), (24, "0-23".to_string(), 0));
        assert_eq!(delay_edits(500.0, 24.0), (12, String::new(), 12));
        assert_eq!(delay_edits(1.0, 24.0), (0, String::new(), 0));
    }

    #[test]
    fn short_error_uses_first_line() {
        assert_eq!(
            short_error("Step failed: X (exit code 2):\nblah"),
            "Step failed: X (exit code 2):"
        );
    }
}
