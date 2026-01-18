#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod processing;
mod utils;

use commands::{cancel_processing, start_processing, download_file};
use models::ProcessingState;

fn main() {
    tauri::Builder::default()
        .manage(ProcessingState::default())
        .invoke_handler(tauri::generate_handler![start_processing, cancel_processing, download_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
