#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod downloads;
mod events;
mod paths;
mod pipeline;
mod state;
mod types;

use commands::{cancel_processing, start_processing};
use downloads::download_prerequisites;
use state::ProcessingState;

fn main() {
    tauri::Builder::default()
        .manage(ProcessingState::default())
        .invoke_handler(tauri::generate_handler![
            start_processing,
            cancel_processing,
            download_prerequisites
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
