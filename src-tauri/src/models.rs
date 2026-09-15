use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct ProcessingState {
    pub cancel_flag: Arc<Mutex<bool>>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolPaths {
    #[serde(default)]
    pub dovi_tool: String,
    #[serde(default)]
    pub mkvmerge: String,
    #[serde(default)]
    pub mkvextract: String,
    #[serde(default)]
    pub ffmpeg: String,
    #[serde(default)]
    pub mediainfo: String,
    #[serde(default)]
    pub mp4box: String,
    #[serde(default)]
    pub hdr10plus_tool: String,
    #[serde(default)]
    pub default_output: String,
}

/// Tool paths resolved to real executables. Optional tools are `None` when
/// they could not be located anywhere.
#[derive(Debug, Clone)]
pub struct Tools {
    pub dovi_tool: PathBuf,
    pub mkvmerge: PathBuf,
    pub mkvextract: PathBuf,
    pub ffmpeg: Option<PathBuf>,
    pub mediainfo: Option<PathBuf>,
    pub mp4box: Option<PathBuf>,
    pub hdr10plus_tool: Option<PathBuf>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    pub hdr_path: String,
    pub dv_path: String,
    pub output_path: String,
    #[serde(default)]
    pub hdr10plus_path: String,
    #[serde(default)]
    pub dv_delay_ms: f64,
    #[serde(default)]
    pub hdr10plus_delay_ms: f64,
}

#[derive(Clone)]
pub struct QueueContext {
    pub id: String,
    pub label: Option<String>,
    pub file_index: usize,
    pub file_total: usize,
    pub tracker: Option<Arc<Mutex<Vec<u8>>>>,
    pub active_workers: Option<Arc<Mutex<usize>>>,
    pub file_id: Option<String>,
    pub file_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingRequest {
    pub mode: String,
    pub hdr_path: String,
    pub dv_path: String,
    pub output_path: String,
    pub hdr10plus_path: String,
    pub dv_delay_ms: f64,
    pub hdr10plus_delay_ms: f64,
    pub keep_temp_files: bool,
    pub parallel_tasks: usize,
    pub tool_paths: ToolPaths,
    pub queue: Vec<QueueItem>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub is_file: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppDefaults {
    pub default_output: String,
    pub bin_dir: String,
    pub tool_paths: ToolPaths,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogPayload {
    pub log_type: String,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StepPayload {
    pub step_id: usize,
    pub name: String,
    pub status: String,
    pub progress: u8,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QueuePayload {
    pub id: String,
    pub status: String,
    pub progress: u8,
    pub current_step: Option<String>,
    pub active_workers: Option<usize>,
    pub file_total: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilePayload {
    pub id: String,
    pub queue_id: String,
    pub name: String,
    pub progress: u8,
    /// 0-based index of the pipeline step this file is on.
    pub step_index: usize,
    pub step_name: String,
    /// "processing", "completed", "error" or "pending" (reset after a cancel).
    pub status: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub status: String,
}
