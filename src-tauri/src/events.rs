use tauri::{AppHandle, Manager};

use crate::types::{
    DownloadProgressPayload, FilePayload, LogPayload, QueuePayload, StatusPayload, StepPayload,
};

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

pub fn emit_download(app: &AppHandle, payload: DownloadProgressPayload) {
    let _ = app.emit_all("download:progress", payload);
}
