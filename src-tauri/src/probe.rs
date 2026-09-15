use std::path::Path;
use std::process::Command;

use serde_json::Value;
use tauri::AppHandle;

use crate::models::{ProcessingState, Tools};
use crate::runner::{run_tool, CANCELLED};
use crate::utils::emit_log;

const FPS_TOLERANCE: f64 = 0.0015;
const KNOWN_RATES: [(u64, u64); 12] = [
    (24000, 1001),
    (24, 1),
    (25, 1),
    (30000, 1001),
    (30, 1),
    (48, 1),
    (50, 1),
    (60000, 1001),
    (60, 1),
    (100, 1),
    (120000, 1001),
    (120, 1),
];

#[derive(Clone, Debug, PartialEq)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub fps_num: Option<u64>,
    pub fps_den: Option<u64>,
    pub default_duration_ns: Option<u64>,
    /// mkvmerge track id (0-based; what mkvextract expects).
    pub track_id: Option<u32>,
    /// MediaInfo container track ID (1-based; what MP4Box expects).
    pub mediainfo_track_id: Option<u32>,
    pub codec: Option<String>,
    pub has_audio_or_subs: bool,
}

/// Raw fields from one probe tool; every field optional so probes can be
/// merged field by field.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProbeFields {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub fps_num: Option<u64>,
    pub fps_den: Option<u64>,
    pub default_duration_ns: Option<u64>,
    pub track_id: Option<u32>,
    pub mediainfo_track_id: Option<u32>,
    pub codec: Option<String>,
    pub has_audio_or_subs: Option<bool>,
}

impl ProbeFields {
    fn merge(self, other: ProbeFields) -> ProbeFields {
        ProbeFields {
            width: self.width.or(other.width),
            height: self.height.or(other.height),
            fps: self.fps.or(other.fps),
            fps_num: self.fps_num.or(other.fps_num),
            fps_den: self.fps_den.or(other.fps_den),
            default_duration_ns: self.default_duration_ns.or(other.default_duration_ns),
            track_id: self.track_id.or(other.track_id),
            mediainfo_track_id: self.mediainfo_track_id.or(other.mediainfo_track_id),
            codec: self.codec.or(other.codec),
            has_audio_or_subs: self.has_audio_or_subs.or(other.has_audio_or_subs),
        }
    }

    fn finish(self, path: &Path) -> Result<VideoInfo, String> {
        let width = self
            .width
            .ok_or_else(|| format!("Could not determine video width of {}", path.display()))?;
        let height = self
            .height
            .ok_or_else(|| format!("Could not determine video height of {}", path.display()))?;
        let fps = self
            .fps
            .filter(|fps| fps.is_finite() && *fps > 0.0)
            .ok_or_else(|| format!("Could not determine frame rate of {}", path.display()))?;
        let (fps_num, fps_den) = match (self.fps_num, self.fps_den) {
            (Some(num), Some(den)) if den > 0 => (Some(num), Some(den)),
            _ => match snap_fps(fps) {
                Some((num, den)) => (Some(num), Some(den)),
                None => (None, None),
            },
        };
        Ok(VideoInfo {
            width,
            height,
            fps,
            fps_num,
            fps_den,
            default_duration_ns: self.default_duration_ns,
            track_id: self.track_id,
            mediainfo_track_id: self.mediainfo_track_id,
            codec: self.codec,
            has_audio_or_subs: self.has_audio_or_subs.unwrap_or(true),
        })
    }
}

/// Map a decimal frame rate onto a well-known rational when it is close enough.
pub fn snap_fps(fps: f64) -> Option<(u64, u64)> {
    KNOWN_RATES
        .iter()
        .copied()
        .find(|(num, den)| (fps - *num as f64 / *den as f64).abs() < FPS_TOLERANCE)
}

/// Value for `mkvmerge --default-duration 0:<value>`.
pub fn fps_argument(info: &VideoInfo) -> String {
    match (info.fps_num, info.fps_den) {
        (Some(num), Some(1)) => format!("{}fps", num),
        (Some(num), Some(den)) if den > 0 => format!("{}/{}fps", num, den),
        _ => match info.default_duration_ns {
            Some(ns) if ns > 0 => format!("{}ns", ns),
            _ => format!("{:.3}fps", info.fps),
        },
    }
}

pub fn is_hevc(info: &VideoInfo) -> bool {
    info.codec
        .as_ref()
        .map(|codec| {
            let lower = codec.to_ascii_lowercase();
            lower.contains("hevc") || lower.contains("h.265") || lower.contains("h265")
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

fn parse_u32_from_value(value: &Value) -> Option<u32> {
    if let Some(v) = value.as_u64() {
        return u32::try_from(v).ok();
    }
    let raw = value.as_str()?;
    let digits: String = raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn parse_u64_from_value(value: &Value) -> Option<u64> {
    if let Some(v) = value.as_u64() {
        return Some(v);
    }
    let raw = value.as_str()?;
    let digits: String = raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn parse_fractional_string(raw: &str) -> Option<f64> {
    let filtered: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '/')
        .collect();
    if filtered.is_empty() {
        return None;
    }
    if let Some((num, den)) = filtered.split_once('/') {
        let num: f64 = num.parse().ok()?;
        let den: f64 = den.parse().ok()?;
        if den == 0.0 {
            return None;
        }
        return Some(num / den);
    }
    filtered.parse().ok()
}

fn parse_f64_from_value(value: &Value) -> Option<f64> {
    if let Some(v) = value.as_f64() {
        return Some(v);
    }
    value.as_str().and_then(parse_fractional_string)
}

fn parse_dimensions(raw: &str) -> Option<(u32, u32)> {
    let (w, h) = raw.trim().split_once(['x', 'X'])?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

/// Parse `mkvmerge -J` output. Works for MKV, MP4 and raw HEVC inputs.
pub fn parse_mkvmerge_identify(json: &Value) -> Result<ProbeFields, String> {
    if let Some(errors) = json.get("errors").and_then(Value::as_array) {
        if !errors.is_empty() {
            let messages: Vec<String> = errors
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            return Err(format!(
                "mkvmerge could not identify the file: {}",
                messages.join("; ")
            ));
        }
    }
    let tracks = json
        .get("tracks")
        .and_then(Value::as_array)
        .ok_or("mkvmerge output has no tracks")?;

    let video = tracks
        .iter()
        .find(|track| track.get("type").and_then(Value::as_str) == Some("video"))
        .ok_or("mkvmerge found no video track")?;
    let props = video.get("properties").cloned().unwrap_or(Value::Null);

    let has_audio_or_subs = tracks.iter().any(|track| {
        matches!(
            track.get("type").and_then(Value::as_str),
            Some("audio") | Some("subtitles")
        )
    });

    let (width, height) = props
        .get("pixel_dimensions")
        .and_then(Value::as_str)
        .and_then(parse_dimensions)
        .map(|(w, h)| (Some(w), Some(h)))
        .unwrap_or((None, None));

    let default_duration_ns = props
        .get("default_duration")
        .and_then(parse_u64_from_value)
        .filter(|ns| *ns > 0);
    let fps = default_duration_ns.map(|ns| 1_000_000_000.0 / ns as f64);

    Ok(ProbeFields {
        width,
        height,
        fps,
        fps_num: None,
        fps_den: None,
        default_duration_ns,
        track_id: video.get("id").and_then(parse_u32_from_value),
        mediainfo_track_id: None,
        codec: props
            .get("codec_id")
            .and_then(Value::as_str)
            .or_else(|| video.get("codec").and_then(Value::as_str))
            .map(str::to_string),
        has_audio_or_subs: Some(has_audio_or_subs),
    })
}

fn track_type(track: &Value) -> Option<&str> {
    track
        .get("@type")
        .and_then(Value::as_str)
        .or_else(|| track.get("type").and_then(Value::as_str))
}

/// Parse `MediaInfo --Output=JSON` output.
pub fn parse_mediainfo(json: &Value) -> Result<ProbeFields, String> {
    let tracks = json
        .get("media")
        .and_then(|m| m.get("track"))
        .and_then(Value::as_array)
        .ok_or("MediaInfo output has no tracks")?;

    let video = tracks
        .iter()
        .find(|t| {
            track_type(t)
                .map(|t| t.eq_ignore_ascii_case("video"))
                .unwrap_or(false)
        })
        .ok_or("MediaInfo found no video track")?;

    let has_audio_or_subs = tracks.iter().any(|t| {
        track_type(t)
            .map(|t| t.eq_ignore_ascii_case("audio") || t.eq_ignore_ascii_case("text"))
            .unwrap_or(false)
    });

    let num_den = video
        .get("FrameRate_Original_Num")
        .and_then(parse_u64_from_value)
        .zip(
            video
                .get("FrameRate_Original_Den")
                .and_then(parse_u64_from_value),
        )
        .or_else(|| {
            video
                .get("FrameRate_Num")
                .and_then(parse_u64_from_value)
                .zip(video.get("FrameRate_Den").and_then(parse_u64_from_value))
        })
        .filter(|(_, den)| *den > 0);

    let fps = num_den
        .map(|(num, den)| num as f64 / den as f64)
        .or_else(|| {
            video
                .get("FrameRate_Original")
                .and_then(parse_f64_from_value)
        })
        .or_else(|| video.get("FrameRate").and_then(parse_f64_from_value));

    Ok(ProbeFields {
        width: video.get("Width").and_then(parse_u32_from_value),
        height: video.get("Height").and_then(parse_u32_from_value),
        fps,
        fps_num: num_den.map(|(num, _)| num),
        fps_den: num_den.map(|(_, den)| den),
        default_duration_ns: None,
        track_id: None,
        mediainfo_track_id: video
            .get("ID")
            .and_then(parse_u32_from_value)
            .or_else(|| video.get("ID/String").and_then(parse_u32_from_value)),
        codec: video
            .get("Format")
            .and_then(Value::as_str)
            .or_else(|| video.get("Format/String").and_then(Value::as_str))
            .map(str::to_string),
        has_audio_or_subs: Some(has_audio_or_subs),
    })
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

fn run_mkvmerge_identify(
    state: &ProcessingState,
    mkvmerge: &Path,
    file: &Path,
) -> Result<ProbeFields, String> {
    let mut cmd = Command::new(mkvmerge);
    cmd.arg("--identify")
        .arg("--ui-language")
        .arg("en")
        .arg("--output-charset")
        .arg("utf-8")
        .arg("-J")
        .arg(file);
    let output = run_tool(state, cmd, || {})?;
    // mkvmerge exits with 1 for warnings; the JSON is still usable.
    if !matches!(output.code, Some(0) | Some(1)) {
        return Err(format!(
            "mkvmerge -J failed ({}): {}",
            output.exit_description(),
            output.tail(10)
        ));
    }
    let json: Value = serde_json::from_str(&output.stdout)
        .map_err(|e| format!("Failed to parse mkvmerge -J output: {}", e))?;
    parse_mkvmerge_identify(&json)
}

fn run_mediainfo(
    state: &ProcessingState,
    mediainfo: &Path,
    file: &Path,
) -> Result<ProbeFields, String> {
    let mut cmd = Command::new(mediainfo);
    cmd.arg("--Output=JSON").arg("-f").arg(file);
    let output = run_tool(state, cmd, || {})?;
    if !output.success() {
        return Err(format!(
            "MediaInfo failed ({}): {}",
            output.exit_description(),
            output.tail(10)
        ));
    }
    if output.stdout.trim().is_empty() {
        return Err("MediaInfo returned empty output".to_string());
    }
    let json: Value = serde_json::from_str(&output.stdout)
        .map_err(|e| format!("Failed to parse MediaInfo JSON: {}", e))?;
    parse_mediainfo(&json)
}

/// Probe a video file: `mkvmerge -J` first, MediaInfo as a fallback (only when
/// available), merged field by field.
pub fn probe_video(
    state: &ProcessingState,
    app: &AppHandle,
    tools: &Tools,
    file: &Path,
) -> Result<VideoInfo, String> {
    if !file.is_file() {
        return Err(format!("Input file not found: {}", file.display()));
    }

    let mkv = match run_mkvmerge_identify(state, &tools.mkvmerge, file) {
        Ok(fields) => Some(fields),
        Err(err) if err == CANCELLED => return Err(err),
        Err(err) => {
            emit_log(
                app,
                "warning",
                format!("mkvmerge could not probe {}: {}", file.display(), err),
            );
            None
        }
    };

    let needs_fallback = mkv
        .as_ref()
        .map(|f| f.fps.is_none() || f.width.is_none() || f.height.is_none())
        .unwrap_or(true);

    let mut fields = mkv.unwrap_or_default();
    if needs_fallback {
        match tools.mediainfo.as_deref() {
            Some(mediainfo) => match run_mediainfo(state, mediainfo, file) {
                Ok(mi) => {
                    emit_log(
                        app,
                        "info",
                        format!(
                            "Using MediaInfo to complete the probe of {}",
                            file.display()
                        ),
                    );
                    fields = fields.merge(mi);
                }
                Err(err) if err == CANCELLED => return Err(err),
                Err(err) => emit_log(
                    app,
                    "warning",
                    format!("MediaInfo probe failed for {}: {}", file.display(), err),
                ),
            },
            None => emit_log(
                app,
                "warning",
                format!(
                    "MediaInfo is not available to complete the probe of {}",
                    file.display()
                ),
            ),
        }
    }

    fields.finish(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MKVMERGE_SAMPLE: &str = r#"{
      "attachments": [],
      "chapters": [],
      "container": {"recognized": true, "supported": true, "type": "Matroska"},
      "errors": [],
      "file_name": "movie.mkv",
      "global_tags": [],
      "identification_format_version": 20,
      "track_tags": [],
      "tracks": [
        {"codec": "HEVC/H.265/MPEG-H", "id": 0, "type": "video",
         "properties": {"codec_id": "V_MPEGH/ISO/HEVC", "default_duration": 41708333,
                        "language": "und", "number": 1, "pixel_dimensions": "3840x2160"}},
        {"codec": "TrueHD Atmos", "id": 1, "type": "audio",
         "properties": {"audio_channels": 8, "codec_id": "A_TRUEHD", "language": "eng"}},
        {"codec": "SubRip/SRT", "id": 2, "type": "subtitles",
         "properties": {"codec_id": "S_TEXT/UTF8", "language": "eng"}}
      ],
      "warnings": []
    }"#;

    #[test]
    fn parses_mkvmerge_identify_json() {
        let json: Value = serde_json::from_str(MKVMERGE_SAMPLE).unwrap();
        let fields = parse_mkvmerge_identify(&json).unwrap();
        assert_eq!(fields.width, Some(3840));
        assert_eq!(fields.height, Some(2160));
        assert_eq!(fields.default_duration_ns, Some(41708333));
        assert!((fields.fps.unwrap() - 23.976).abs() < 0.001);
        assert_eq!(fields.track_id, Some(0));
        assert_eq!(fields.codec.as_deref(), Some("V_MPEGH/ISO/HEVC"));
        assert_eq!(fields.has_audio_or_subs, Some(true));

        let info = fields.finish(Path::new("movie.mkv")).unwrap();
        assert_eq!((info.fps_num, info.fps_den), (Some(24000), Some(1001)));
        assert_eq!(fps_argument(&info), "24000/1001fps");
        assert!(is_hevc(&info));
    }

    #[test]
    fn raw_hevc_without_audio_or_duration() {
        let json = json!({
            "errors": [],
            "tracks": [
                {"codec": "HEVC/H.265/MPEG-H", "id": 0, "type": "video",
                 "properties": {"codec_id": "V_MPEGH/ISO/HEVC", "pixel_dimensions": "1920x800"}}
            ]
        });
        let fields = parse_mkvmerge_identify(&json).unwrap();
        assert_eq!(fields.has_audio_or_subs, Some(false));
        assert_eq!(fields.fps, None);
        assert!(fields.clone().finish(Path::new("x.hevc")).is_err());

        let mi = ProbeFields {
            fps: Some(25.0),
            fps_num: Some(25),
            fps_den: Some(1),
            ..Default::default()
        };
        let info = fields.merge(mi).finish(Path::new("x.hevc")).unwrap();
        assert_eq!(info.width, 1920);
        assert_eq!(fps_argument(&info), "25fps");
        assert!(!info.has_audio_or_subs);
    }

    #[test]
    fn mkvmerge_errors_are_reported() {
        let json = json!({"errors": ["The file could not be opened"], "tracks": []});
        assert!(parse_mkvmerge_identify(&json).is_err());
    }

    #[test]
    fn parses_mediainfo_json() {
        let json = json!({"media": {"track": [
            {"@type": "General"},
            {"@type": "Video", "ID": "1", "Width": "3840", "Height": "2160", "Format": "HEVC",
             "FrameRate": "23.976", "FrameRate_Num": "24000", "FrameRate_Den": "1001"},
            {"@type": "Audio", "ID": "2"}
        ]}});
        let fields = parse_mediainfo(&json).unwrap();
        assert_eq!(fields.width, Some(3840));
        assert_eq!(fields.mediainfo_track_id, Some(1));
        assert_eq!((fields.fps_num, fields.fps_den), (Some(24000), Some(1001)));
        assert_eq!(fields.codec.as_deref(), Some("HEVC"));
        assert_eq!(fields.has_audio_or_subs, Some(true));
    }

    #[test]
    fn fps_argument_falls_back_to_decimal() {
        let info = VideoInfo {
            width: 1,
            height: 1,
            fps: 23.5,
            fps_num: None,
            fps_den: None,
            default_duration_ns: None,
            track_id: None,
            mediainfo_track_id: None,
            codec: None,
            has_audio_or_subs: true,
        };
        assert_eq!(fps_argument(&info), "23.500fps");
        assert_eq!(snap_fps(29.97), Some((30000, 1001)));
        assert_eq!(snap_fps(23.5), None);
    }
}
