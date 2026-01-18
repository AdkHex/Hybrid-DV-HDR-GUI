use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::io::Write;
use tauri::AppHandle;
use regex::Regex;

use crate::models::{ProcessingState, ProcessingRequest};
use crate::processing::{process_queue_item, run_pipeline};
use crate::utils::{
    emit_log, emit_status, compute_output_for_batch, compute_output_for_single,
    find_matching_dv_file
};

#[tauri::command]
pub async fn download_file(url: String, filename: String, app: AppHandle) -> Result<String, String> {
    emit_log(&app, "info", format!("Downloading {}...", filename));
    
    // Resolve bin directory relative to current executable or app directory
    let bin_path = if let Ok(mut path) = std::env::current_exe() {
        path.pop();
        path.push("bin");
        path
    } else {
        return Err("Could not determine executable path".to_string());
    };

    if !bin_path.exists() {
        fs::create_dir_all(&bin_path).map_err(|e| e.to_string())?;
    }

    let target_path = bin_path.join(&filename);
    let mut last_error = String::from("Unknown error");
    let max_retries = 3;

    for attempt in 1..=max_retries {
        if attempt > 1 {
            emit_log(&app, "info", format!("Retrying download (attempt {}/{})...", attempt, max_retries));
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }

        let download_result = async {
            let response = reqwest::get(&url)
                .await
                .map_err(|e| format!("Failed to connect: {}", e))?;
            
            if !response.status().is_success() {
                return Err(format!("Download failed with status: {}", response.status()));
            }

            let content = response.bytes()
                .await
                .map_err(|e| format!("Failed to read bytes: {}", e))?;

            // Write to a temporary file first to avoid corruption? 
            // For now, simplicity: write to target directly but truncate.
            let mut file = fs::File::create(&target_path)
                .map_err(|e| format!("Failed to create file: {}", e))?;
            
            file.write_all(&content)
                .map_err(|e| format!("Failed to write to file: {}", e))?;
                
            Ok(())
        }.await;

        match download_result {
            Ok(_) => {
                emit_log(&app, "success", format!("Downloaded {} to {}", filename, target_path.display()));
                return Ok(target_path.to_string_lossy().to_string());
            },
            Err(e) => {
                emit_log(&app, "warning", format!("Download attempt {} failed: {}", attempt, e));
                last_error = e;
            }
        }
    }

    Err(format!("Failed after {} attempts. Last error: {}", max_retries, last_error))
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

    let tool_paths = request.tool_paths;
    let app_handle = app.clone();
    let state_inner = state.inner().clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        if request.mode == "batch" {
            if request.queue.is_empty() {
                return Err("Queue is empty".to_string());
            }
            emit_log(
                &app_handle,
                "info",
                format!("Batch mode: {} items", request.queue.len()),
            );

            let mut handles = Vec::new();
            let error_state = Arc::new(Mutex::new(None::<String>));

            for item in request.queue.iter().cloned() {
                let app_handle = app_handle.clone();
                let state = state_inner.clone();
                let tool_paths = tool_paths.clone();
                let error_state = Arc::clone(&error_state);
                let keep_temp = request.keep_temp_files;

                let handle = thread::spawn(move || {
                    let result = process_queue_item(
                        app_handle,
                        state,
                        tool_paths,
                        item,
                        keep_temp,
                    );

                    if let Err(err) = result {
                        let _ = error_state.lock().map(|mut e| {
                            if e.is_none() {
                                *e = Some(err);
                            }
                        });
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
            };
        } else if Path::new(&request.hdr_path).is_dir() {
            let mut hdr_files = fs::read_dir(&request.hdr_path)
                .map_err(|e| e.to_string())?
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect::<Vec<String>>();

            let mut dv_files = fs::read_dir(&request.dv_path)
                .map_err(|e| e.to_string())?
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect::<Vec<String>>();

            hdr_files.sort();
            dv_files.sort();
            let output_base = if request.output_path.is_empty() {
                tool_paths.default_output.clone()
            } else {
                request.output_path.clone()
            };

            for (index, hdr_file) in hdr_files.iter().enumerate() {
                let base_regex = Regex::new(r"(.*)\.(HDR)+.*")
                    .map_err(|e| e.to_string())?;
                let base = base_regex
                    .captures(hdr_file)
                    .and_then(|c| c.get(1).map(|m| m.as_str()))
                    .unwrap_or_else(|| hdr_file.split('.').next().unwrap_or(hdr_file));

                let dv_file = find_matching_dv_file(&dv_files, base)
                    .or_else(|| dv_files.get(index).cloned())
                    .ok_or_else(|| format!("No DV file available for {}", hdr_file))?;

                let hdr_path = PathBuf::from(&request.hdr_path).join(hdr_file);
                let dv_path = PathBuf::from(&request.dv_path).join(dv_file);
                let output_path = compute_output_for_batch(&output_base, hdr_file);

                run_pipeline(
                    &app_handle,
                    &state_inner,
                    &tool_paths,
                    &hdr_path,
                    &dv_path,
                    &output_path,
                    request.keep_temp_files,
                    None,
                    None,
                    None,
                    0,
                    1,
                    None,
                    None,
                )?;
            }
        } else {
            let hdr_path = PathBuf::from(&request.hdr_path);
            let dv_path = PathBuf::from(&request.dv_path);
            let output_path = compute_output_for_single(
                &tool_paths.default_output,
                &request.output_path,
                &hdr_path,
            );

            run_pipeline(
                &app_handle,
                &state_inner,
                &tool_paths,
                &hdr_path,
                &dv_path,
                &output_path,
                request.keep_temp_files,
                None,
                None,
                None,
                0,
                1,
                None,
                None,
            )?;
        }

        Ok(())
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
            if err == "Processing cancelled" {
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
    let _ = app;
}
