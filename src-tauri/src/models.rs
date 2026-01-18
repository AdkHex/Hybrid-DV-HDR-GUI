use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct ProcessingState {
    pub cancel_flag: Arc<Mutex<bool>>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolPaths {
    pub dovi_tool: String,
    pub mkvmerge: String,
    pub mkvextract: String,
    pub ffmpeg: String,
    pub default_output: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    pub hdr_path: String,
    pub dv_path: String,
    pub output_path: String,
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
    pub keep_temp_files: bool,
    pub parallel_tasks: usize,
    pub tool_paths: ToolPaths,
    pub queue: Vec<QueueItem>,
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
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub status: String,
}
