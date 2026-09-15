use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use tauri::{AppHandle, Emitter, Manager};

use crate::models::{
    FilePayload, LogPayload, QueuePayload, StatusPayload, StepPayload, ToolPaths, Tools,
};

pub const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "m4v", "mov", "hevc", "h265", "ts", "m2ts"];
pub const DEFAULT_OUTPUT_DIR_NAME: &str = "DV.HDR";
const OUTPUT_SUFFIX: &str = ".DV.HDR.H.265-NOGRP.mkv";

pub const DEFAULT_TOOL_NAMES: [(&str, &str); 7] = [
    ("dovi_tool", "dovi_tool"),
    ("mkvmerge", "mkvmerge"),
    ("mkvextract", "mkvextract"),
    ("ffmpeg", "ffmpeg"),
    ("mediainfo", "MediaInfo"),
    ("mp4box", "MP4Box"),
    ("hdr10plus_tool", "hdr10plus_tool"),
];

// ---------------------------------------------------------------------------
// Event emitters
// ---------------------------------------------------------------------------

pub fn emit_log(app: &AppHandle, log_type: &str, message: impl Into<String>) {
    let _ = app.emit(
        "processing:log",
        LogPayload {
            log_type: log_type.to_string(),
            message: message.into(),
        },
    );
}

pub fn emit_step(app: &AppHandle, step_id: usize, name: &str, status: &str, progress: u8) {
    let _ = app.emit(
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
    let _ = app.emit("processing:queue", payload);
}

pub fn emit_file(app: &AppHandle, payload: FilePayload) {
    let _ = app.emit("processing:file", payload);
}

pub fn emit_status(app: &AppHandle, status: &str) {
    let _ = app.emit(
        "processing:status",
        StatusPayload {
            status: status.to_string(),
        },
    );
}

// ---------------------------------------------------------------------------
// Tool resolution
// ---------------------------------------------------------------------------

fn executable_name_variants(name: &str) -> Vec<String> {
    let mut variants = vec![name.to_string()];
    if cfg!(target_os = "windows") {
        let has_exe = Path::new(name)
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        if !has_exe {
            variants.insert(0, format!("{}.exe", name));
        }
    }
    variants
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

pub fn app_bin_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("bin"))
}

/// Every location that is searched for a non-absolute tool name, in order.
pub fn tool_candidates(app: &AppHandle, name: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(bin) = app_bin_dir(app) {
        dirs.push(bin);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join("bin"));
        dirs.push(resource_dir);
    }
    if let Some(dir) = exe_dir() {
        dirs.push(dir);
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path_var).filter(|p| !p.as_os_str().is_empty()));
    }

    let variants = executable_name_variants(name);
    let mut candidates = Vec::with_capacity(dirs.len() * variants.len());
    for dir in dirs {
        for variant in &variants {
            candidates.push(dir.join(variant));
        }
    }
    candidates
}

/// Resolve `name` to an existing executable if possible. Returns `None` when
/// nothing was found.
pub fn resolve_tool(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let given = PathBuf::from(name);
    if given.is_absolute() {
        for variant in executable_name_variants(name) {
            let candidate = PathBuf::from(&variant);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        return None;
    }
    tool_candidates(app, name).into_iter().find(|p| p.is_file())
}

fn effective_tool_name<'a>(configured: &'a str, default_name: &'a str) -> &'a str {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        default_name
    } else {
        trimmed
    }
}

fn require_tool(
    app: &AppHandle,
    label: &str,
    configured: &str,
    default_name: &str,
) -> Result<PathBuf, String> {
    let name = effective_tool_name(configured, default_name);
    if let Some(path) = resolve_tool(app, name) {
        return Ok(path);
    }
    let tried: Vec<String> = if Path::new(name).is_absolute() {
        vec![name.to_string()]
    } else {
        tool_candidates(app, name)
            .iter()
            .map(|p| p.display().to_string())
            .collect()
    };
    Err(format!(
        "Required tool '{}' ({}) was not found. Tried: {}",
        label,
        name,
        tried.join(", ")
    ))
}

fn optional_tool(app: &AppHandle, configured: &str, default_name: &str) -> Option<PathBuf> {
    resolve_tool(app, effective_tool_name(configured, default_name))
}

/// Resolve every configured tool. Required tools produce an error naming the
/// tool and the locations tried; optional tools become `None`.
pub fn resolve_tools(
    app: &AppHandle,
    paths: &ToolPaths,
    need_hdr10plus: bool,
) -> Result<Tools, String> {
    let hdr10plus_tool = if need_hdr10plus {
        Some(require_tool(
            app,
            "hdr10plus_tool",
            &paths.hdr10plus_tool,
            "hdr10plus_tool",
        )?)
    } else {
        optional_tool(app, &paths.hdr10plus_tool, "hdr10plus_tool")
    };

    Ok(Tools {
        dovi_tool: require_tool(app, "dovi_tool", &paths.dovi_tool, "dovi_tool")?,
        mkvmerge: require_tool(app, "mkvmerge", &paths.mkvmerge, "mkvmerge")?,
        mkvextract: require_tool(app, "mkvextract", &paths.mkvextract, "mkvextract")?,
        ffmpeg: optional_tool(app, &paths.ffmpeg, "ffmpeg"),
        mediainfo: optional_tool(app, &paths.mediainfo, "MediaInfo"),
        mp4box: optional_tool(app, &paths.mp4box, "MP4Box"),
        hdr10plus_tool,
    })
}

pub fn describe_tools(tools: &Tools) -> String {
    fn opt(path: &Option<PathBuf>) -> String {
        path.as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(not found)".to_string())
    }
    format!(
        "dovi_tool={} | mkvmerge={} | mkvextract={} | ffmpeg={} | MediaInfo={} | MP4Box={} | hdr10plus_tool={}",
        tools.dovi_tool.display(),
        tools.mkvmerge.display(),
        tools.mkvextract.display(),
        opt(&tools.ffmpeg),
        opt(&tools.mediainfo),
        opt(&tools.mp4box),
        opt(&tools.hdr10plus_tool),
    )
}

// ---------------------------------------------------------------------------
// Output locations
// ---------------------------------------------------------------------------

/// The user-facing base directory: Videos, then home, then the app data dir.
pub fn user_base_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .video_dir()
        .or_else(|_| app.path().home_dir())
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn app_default_output_dir(app: &AppHandle) -> PathBuf {
    user_base_dir(app).join(DEFAULT_OUTPUT_DIR_NAME)
}

/// Turn the configured default output folder into an absolute path. Relative
/// values are resolved against the user base dir, never the CWD.
pub fn resolve_output_base(app: &AppHandle, configured: &str) -> PathBuf {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return app_default_output_dir(app);
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        candidate
    } else {
        user_base_dir(app).join(candidate)
    }
}

/// Output directory for folder/batch jobs.
pub fn resolve_output_dir(default_output: &Path, output_path: &str) -> PathBuf {
    let trimmed = output_path.trim();
    if trimmed.is_empty() {
        return default_output.to_path_buf();
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        candidate
    } else {
        default_output.join(candidate)
    }
}

pub fn has_video_extension(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            VIDEO_EXTENSIONS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

pub fn strip_video_extension(name: &str) -> &str {
    if has_video_extension(name) {
        match name.rfind('.') {
            Some(idx) if idx > 0 => &name[..idx],
            _ => name,
        }
    } else {
        name
    }
}

/// Derive the output base name for an HDR source file name.
///
/// The trailing video extension is removed. If the stem contains a
/// dot-delimited token starting with `HDR` (e.g. `.HDR.`, `.HDR10.`,
/// `.HDR10Plus.`), the name is cut before the LAST such token. Otherwise the
/// full stem is used.
pub fn derive_output_base(file_name: &str) -> String {
    let stem = strip_video_extension(file_name);
    let tokens: Vec<&str> = stem.split('.').collect();
    let is_hdr_token = |token: &str| {
        token
            .get(..3)
            .map(|head| head.eq_ignore_ascii_case("hdr"))
            .unwrap_or(false)
    };
    let cut = tokens
        .iter()
        .enumerate()
        .skip(1)
        .filter(|(_, token)| is_hdr_token(token))
        .map(|(idx, _)| idx)
        .next_back();
    match cut {
        Some(idx) => tokens[..idx].join("."),
        None => stem.to_string(),
    }
}

pub fn auto_output_filename(hdr_file_name: &str) -> String {
    format!("{}{}", derive_output_base(hdr_file_name), OUTPUT_SUFFIX)
}

fn ends_with_separator(path: &str) -> bool {
    path.ends_with('/') || path.ends_with('\\')
}

/// Output file for a single-file job. A folder (existing directory or a path
/// ending with a separator) gets the auto-generated file name joined onto it.
pub fn compute_output_for_single(
    default_output: &Path,
    output_path: &str,
    hdr_path: &Path,
) -> PathBuf {
    let file_name = hdr_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let default_filename = auto_output_filename(file_name);

    let trimmed = output_path.trim();
    if trimmed.is_empty() {
        return default_output.join(default_filename);
    }

    let mut candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        candidate = default_output.join(candidate);
    }
    if ends_with_separator(trimmed) || candidate.is_dir() {
        return candidate.join(default_filename);
    }
    candidate
}

pub fn compute_output_for_batch(output_dir: &Path, hdr_file: &str) -> PathBuf {
    output_dir.join(auto_output_filename(hdr_file))
}

// ---------------------------------------------------------------------------
// Folder scanning and pairing
// ---------------------------------------------------------------------------

/// Regular, non-hidden files with a known video extension, sorted. Returns the
/// file names and the number of directory entries that were skipped.
pub fn list_video_files(dir: &Path) -> Result<(Vec<String>, usize), String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("Cannot read folder {}: {}", dir.display(), e))?;
    let mut files = Vec::new();
    let mut skipped = 0usize;
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if !entry.path().is_file() || !is_video_file_name(&name) {
            skipped += 1;
            continue;
        }
        files.push(name);
    }
    files.sort();
    Ok((files, skipped))
}

pub fn is_video_file_name(name: &str) -> bool {
    !name.starts_with('.') && has_video_extension(name)
}

/// Matches DV / HDR10+ companions for an HDR base name. Compiled once per base.
pub struct FileMatcher {
    base_lower: String,
    contains: Regex,
}

impl FileMatcher {
    pub fn new(base: &str) -> Result<Self, String> {
        let contains = Regex::new(&format!("(?i){}", regex::escape(base)))
            .map_err(|e| format!("Invalid match pattern for '{}': {}", base, e))?;
        Ok(Self {
            base_lower: base.to_ascii_lowercase(),
            contains,
        })
    }

    /// Prefer an exact stem match, then a prefix match on a token boundary,
    /// then any file whose name contains the base.
    pub fn find(&self, files: &[String]) -> Option<String> {
        if self.base_lower.is_empty() {
            return None;
        }
        let mut prefix: Option<&String> = None;
        let mut contains: Option<&String> = None;
        for file in files {
            let stem_lower = strip_video_extension(file).to_ascii_lowercase();
            if stem_lower == self.base_lower {
                return Some(file.clone());
            }
            if prefix.is_none() && stem_lower.starts_with(&self.base_lower) {
                let boundary = stem_lower.as_bytes()[self.base_lower.len()];
                if matches!(boundary, b'.' | b'-' | b'_' | b' ') {
                    prefix = Some(file);
                }
            }
            if contains.is_none() && self.contains.is_match(file) {
                contains = Some(file);
            }
        }
        prefix.or(contains).cloned()
    }
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_base_cuts_at_last_hdr_token() {
        assert_eq!(
            derive_output_base("Movie.2020.2160p.HDR.WEB-DL.mkv"),
            "Movie.2020.2160p"
        );
        assert_eq!(
            derive_output_base("Movie.2020.hdr10.x265.mkv"),
            "Movie.2020"
        );
        assert_eq!(derive_output_base("Movie.HDR10Plus.2160p.mkv"), "Movie");
        assert_eq!(
            derive_output_base("Show.S01E01.HDR.Group.HDR10.mkv"),
            "Show.S01E01.HDR.Group"
        );
    }

    #[test]
    fn output_base_uses_full_stem_without_hdr_token() {
        assert_eq!(
            derive_output_base("Movie.2020.2160p.mkv"),
            "Movie.2020.2160p"
        );
        assert_eq!(derive_output_base("Movie 2020.MP4"), "Movie 2020");
        assert_eq!(derive_output_base("plain"), "plain");
        assert_eq!(derive_output_base("HDR.Movie.mkv"), "HDR.Movie");
        assert_eq!(derive_output_base("Movie.HDRip.mkv"), "Movie");
        assert_eq!(derive_output_base("Fïlm.ñé.mkv"), "Fïlm.ñé");
    }

    #[test]
    fn auto_output_filename_has_suffix() {
        assert_eq!(
            auto_output_filename("A.HDR.mkv"),
            "A.DV.HDR.H.265-NOGRP.mkv"
        );
    }

    #[test]
    fn video_extension_filtering() {
        for name in [
            "a.mkv", "b.MP4", "c.m4v", "d.mov", "e.hevc", "f.h265", "g.ts", "h.M2TS",
        ] {
            assert!(is_video_file_name(name), "{}", name);
        }
        for name in [
            ".hidden.mkv",
            "notes.txt",
            "a.mka",
            "a.srt",
            "noext",
            "a.mkv.part",
        ] {
            assert!(!is_video_file_name(name), "{}", name);
        }
        assert_eq!(strip_video_extension("a.b.mkv"), "a.b");
        assert_eq!(strip_video_extension("a.txt"), "a.txt");
    }

    #[test]
    fn list_video_files_skips_dirs_and_other_extensions() {
        let dir = std::env::temp_dir().join(format!("hybrid_dv_hdr_scan_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub.mkv")).unwrap();
        fs::write(dir.join("b.mkv"), b"x").unwrap();
        fs::write(dir.join("a.MP4"), b"x").unwrap();
        fs::write(dir.join(".a.mkv"), b"x").unwrap();
        fs::write(dir.join("c.txt"), b"x").unwrap();
        let (files, skipped) = list_video_files(&dir).unwrap();
        assert_eq!(files, vec!["a.MP4".to_string(), "b.mkv".to_string()]);
        assert_eq!(skipped, 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pairing_prefers_exact_then_prefix_then_contains() {
        let dv = vec![
            "Other.Movie.DV.mkv".to_string(),
            "Movie.2020.2160p.DV.WEB-DL.mkv".to_string(),
            "movie.2020.2160p.mkv".to_string(),
            "Prefix.Movie.2020.2160p.mkv".to_string(),
        ];
        let m = FileMatcher::new("Movie.2020.2160p").unwrap();
        assert_eq!(m.find(&dv).as_deref(), Some("movie.2020.2160p.mkv"));

        let m = FileMatcher::new("Movie.2020").unwrap();
        assert_eq!(
            m.find(&dv).as_deref(),
            Some("Movie.2020.2160p.DV.WEB-DL.mkv")
        );

        let m = FileMatcher::new("Prefix").unwrap();
        assert_eq!(m.find(&dv).as_deref(), Some("Prefix.Movie.2020.2160p.mkv"));

        let m = FileMatcher::new("Nothing").unwrap();
        assert_eq!(m.find(&dv), None);
    }

    #[test]
    fn pairing_escapes_regex_metacharacters() {
        let files = vec![
            "Movie (2020) [4K].DV.mkv".to_string(),
            "Movie 2020 4K.DV.mkv".to_string(),
        ];
        let m = FileMatcher::new("Movie (2020) [4K]").unwrap();
        assert_eq!(m.find(&files).as_deref(), Some("Movie (2020) [4K].DV.mkv"));
        let m = FileMatcher::new("Movie 2020").unwrap();
        assert_eq!(m.find(&files).as_deref(), Some("Movie 2020 4K.DV.mkv"));
    }

    #[test]
    fn single_output_joins_auto_name_onto_folders() {
        let default_output = Path::new("/base/out");
        let hdr = Path::new("/in/Movie.HDR.mkv");
        assert_eq!(
            compute_output_for_single(default_output, "", hdr),
            PathBuf::from("/base/out/Movie.DV.HDR.H.265-NOGRP.mkv")
        );
        assert_eq!(
            compute_output_for_single(default_output, "/other/", hdr),
            PathBuf::from("/other/Movie.DV.HDR.H.265-NOGRP.mkv")
        );
        assert_eq!(
            compute_output_for_single(default_output, "sub\\", hdr),
            PathBuf::from("/base/out/sub\\/Movie.DV.HDR.H.265-NOGRP.mkv")
        );
        assert_eq!(
            compute_output_for_single(default_output, "/other/custom.mkv", hdr),
            PathBuf::from("/other/custom.mkv")
        );
        let tmp = std::env::temp_dir();
        assert_eq!(
            compute_output_for_single(default_output, tmp.to_str().unwrap(), hdr),
            tmp.join("Movie.DV.HDR.H.265-NOGRP.mkv")
        );
    }
}
