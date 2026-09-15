use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::models::ProcessingState;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub const CANCELLED: &str = "Processing cancelled";
const POLL_INTERVAL: Duration = Duration::from_millis(300);

pub fn hide_console_window(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

/// Captured result of an external tool invocation.
pub struct ToolOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl ToolOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn exit_description(&self) -> String {
        match self.code {
            Some(code) => format!("exit code {}", code),
            None => "terminated by signal".to_string(),
        }
    }

    /// Last `lines` lines of stderr and stdout, for error reporting.
    pub fn tail(&self, lines: usize) -> String {
        let mut combined = String::new();
        let stderr = tail_lines(&self.stderr, lines);
        if !stderr.is_empty() {
            combined.push_str(&stderr);
        }
        let stdout = tail_lines(&self.stdout, lines);
        if !stdout.is_empty() {
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(&stdout);
        }
        combined
    }
}

pub fn tail_lines(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}

pub fn is_cancelled(state: &ProcessingState) -> Result<bool, String> {
    state
        .cancel_flag
        .lock()
        .map(|flag| *flag)
        .map_err(|_| "State lock failed".to_string())
}

pub fn describe_command(command: &Command) -> String {
    let mut parts = vec![command.get_program().to_string_lossy().to_string()];
    for arg in command.get_args() {
        let arg = arg.to_string_lossy();
        if arg.contains(' ') {
            parts.push(format!("\"{}\"", arg));
        } else {
            parts.push(arg.to_string());
        }
    }
    parts.join(" ")
}

fn drain<R: Read + Send + 'static>(reader: Option<R>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut reader) = reader {
            let _ = reader.read_to_end(&mut buffer);
        }
        String::from_utf8_lossy(&buffer).to_string()
    })
}

/// Spawn `command`, poll it until it exits while honouring the cancel flag,
/// and capture stdout/stderr. `on_poll` is invoked on every poll tick so the
/// caller can report progress.
pub fn run_tool<F: FnMut()>(
    state: &ProcessingState,
    mut command: Command,
    mut on_poll: F,
) -> Result<ToolOutput, String> {
    if is_cancelled(state)? {
        return Err(CANCELLED.to_string());
    }

    let program = command.get_program().to_string_lossy().to_string();
    hide_console_window(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", program, e))?;

    let stdout_reader = drain(child.stdout.take());
    let stderr_reader = drain(child.stderr.take());

    let status = loop {
        if is_cancelled(state)? {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(CANCELLED.to_string());
        }

        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                on_poll();
                thread::sleep(POLL_INTERVAL);
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("Failed while waiting for {}: {}", program, err));
            }
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();

    Ok(ToolOutput {
        code: status.code(),
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_lines_keeps_last_lines_only() {
        let text = "a\nb\n\nc\nd\n";
        assert_eq!(tail_lines(text, 2), "c\nd");
        assert_eq!(tail_lines(text, 10), "a\nb\nc\nd");
        assert_eq!(tail_lines("", 3), "");
    }
}
