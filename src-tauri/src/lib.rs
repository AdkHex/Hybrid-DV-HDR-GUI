mod commands;
mod models;
mod probe;
mod processing;
mod runner;
mod tools;
mod utils;

use commands::{
    cancel_processing, download_file, get_app_defaults, inspect_paths, start_processing,
};
use models::ProcessingState;
use tools::{check_tools, probe_source, save_text_file};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ProcessingState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_processing,
            cancel_processing,
            download_file,
            inspect_paths,
            get_app_defaults,
            probe_source,
            check_tools,
            save_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
