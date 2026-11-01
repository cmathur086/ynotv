//! Android player core for ynotv.
//!
//! Android has no libmpv, so this module implements the same API as
//! mpv_core.rs on top of an ExoPlayer (Media3) plugin written in Kotlin
//! (gen/android/.../ExoPlayerPlugin.kt). The video renders into a SurfaceView
//! behind the transparent WebView, the same layering the desktop engines use.
//!
//! The frontend only talks to the player through the `mpv_*` commands and the
//! `mpv-*` events, so this module keeps both: mpv property names are mapped onto
//! ExoPlayer where there is an equivalent, and the event stream (status,
//! file-loaded, end-file, HTTP errors) is derived from polling the plugin, the
//! way mpv_core.rs derives it from polling mpv properties.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Upper bound for the in-memory player log ring buffer served by `get_log`.
const MAX_LOG_LINES: usize = 8000;

const PLUGIN_PACKAGE: &str = "com.ynotv.app";
const PLUGIN_CLASS: &str = "ExoPlayerPlugin";

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct MpvStatus {
    pub playing: bool,
    pub volume: f64,
    pub muted: bool,
    pub position: f64,
    pub duration: f64,
    #[serde(rename = "pausedForCache")]
    pub paused_for_cache: bool,
    #[serde(rename = "coreIdle")]
    pub core_idle: bool,
    #[serde(rename = "eofReached")]
    pub eof_reached: bool,
    #[serde(rename = "videoFormat")]
    pub video_format: Option<String>,
    #[serde(rename = "videoTrackId")]
    pub video_track_id: Option<Value>,
}

/// Snapshot returned by the plugin's `status` command.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PlayerSnapshot {
    play_when_ready: bool,
    is_playing: bool,
    buffering: bool,
    ended: bool,
    idle: bool,
    volume: f64,
    muted: bool,
    position: f64,
    duration: f64,
    is_live: bool,
    buffered_position: f64,
    video_format: Option<String>,
    video_track_id: Option<i64>,
    has_video: bool,
    /// Bumped by the plugin each time a new media item reaches READY.
    loaded_seq: u64,
    /// Bumped by the plugin each time playback fails.
    error_seq: u64,
    error_message: Option<String>,
    http_status: Option<u16>,
}

pub struct MpvCoreState {
    /// True between a successful `init` and `kill_mpv`.
    pub ready: Arc<AtomicBool>,
    pub current_url: Mutex<Option<String>>,
    pub is_shutting_down: Arc<AtomicBool>,
    /// Bumped on every init/kill so a stale status monitor exits.
    monitor_generation: Arc<AtomicU64>,
    /// Ring buffer of player log lines, served by `get_log` for Diagnostics.
    pub log_lines: Arc<Mutex<VecDeque<String>>>,
}

impl MpvCoreState {
    pub fn new() -> Self {
        MpvCoreState {
            ready: Arc::new(AtomicBool::new(false)),
            current_url: Mutex::new(None),
            is_shutting_down: Arc::new(AtomicBool::new(false)),
            monitor_generation: Arc::new(AtomicU64::new(0)),
            log_lines: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

struct ExoPlayer<R: Runtime>(PluginHandle<R>);

/// Registers the Kotlin ExoPlayer plugin. Added to the builder on Android only.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("exoplayer")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
            app.manage(ExoPlayer(handle));
            Ok(())
        })
        .build()
}

/// Run a plugin command off the async runtime (`run_mobile_plugin` blocks
/// until Kotlin resolves the invoke).
async fn call<R: Runtime>(app: &AppHandle<R>, command: &'static str, payload: Value) -> Result<Value, String> {
    let handle = app
        .try_state::<ExoPlayer<R>>()
        .ok_or_else(|| "ExoPlayer plugin is not registered".to_string())?
        .0
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .run_mobile_plugin::<Value>(command, payload)
            .map_err(|e| format!("exoplayer {}: {}", command, e))
    })
    .await
    .map_err(|e| format!("exoplayer {}: {}", command, e))?
}

fn push_log(log_lines: &Mutex<VecDeque<String>>, line: String) {
    let mut buf = log_lines.lock().unwrap();
    if buf.len() >= MAX_LOG_LINES {
        buf.pop_front();
    }
    buf.push_back(line);
}

/// Pull the HTTP settings ExoPlayer can honour out of the mpv-style params
/// (`--user-agent=...`, `--referrer=...`, `--http-header-fields=...`).
fn http_options_from_params(custom_params: &[String]) -> Value {
    let mut options = serde_json::Map::new();
    for param in custom_params {
        let clean = param.trim().trim_start_matches('-');
        let Some((key, value)) = clean.split_once('=').or_else(|| clean.split_once(' ')) else {
            continue;
        };
        let value = value.trim().trim_matches('"').to_string();
        match key.trim() {
            "user-agent" => {
                options.insert("userAgent".into(), Value::String(value));
            }
            "referrer" => {
                options.insert("referrer".into(), Value::String(value));
            }
            "http-header-fields" => {
                options.insert("headers".into(), Value::String(value));
            }
            _ => {}
        }
    }
    Value::Object(options)
}

pub async fn init_mpv_with_params<R: Runtime>(
    app: AppHandle<R>,
    custom_params: Vec<String>,
) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();

    // Stop and tear down any existing session
    kill_mpv(&app).await;

    call(&app, "init", http_options_from_params(&custom_params)).await?;
    state.ready.store(true, Ordering::SeqCst);

    let generation = state.monitor_generation.fetch_add(1, Ordering::SeqCst) + 1;
    spawn_status_monitor(
        app.clone(),
        state.monitor_generation.clone(),
        generation,
        state.log_lines.clone(),
    );

    let _ = app.emit("mpv-ready", true);
    log::info!("[ynotv::mpv_core] ExoPlayer initialized successfully");
    Ok(())
}

fn spawn_status_monitor<R: Runtime>(
    app: AppHandle<R>,
    monitor_generation: Arc<AtomicU64>,
    generation: u64,
    log_lines: Arc<Mutex<VecDeque<String>>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut last_ended = false;
        let mut was_idle = true;
        let mut last_position: f64 = 0.0;
        let mut last_loaded_seq: u64 = 0;
        let mut last_error_seq: u64 = 0;

        while monitor_generation.load(Ordering::SeqCst) == generation {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if monitor_generation.load(Ordering::SeqCst) != generation {
                break;
            }

            let snapshot: PlayerSnapshot = match call(&app, "status", json!({})).await {
                Ok(v) => serde_json::from_value(v).unwrap_or_default(),
                Err(_) => continue,
            };

            // mpv's core-idle is true whenever frames aren't advancing:
            // paused, buffering, or nothing loaded.
            let core_idle = !snapshot.is_playing;
            let paused_for_cache = snapshot.buffering && snapshot.play_when_ready;

            if snapshot.loaded_seq != last_loaded_seq {
                last_loaded_seq = snapshot.loaded_seq;
                let _ = app.emit("mpv-file-loaded", true);
            }

            if was_idle && !core_idle {
                let _ = app.emit("mpv-playback-restart", true);
            }
            was_idle = core_idle;

            if (snapshot.position - last_position).abs() > 2.0 && !core_idle {
                let _ = app.emit("mpv-seek", true);
            }
            last_position = snapshot.position;

            if snapshot.ended && !last_ended {
                let _ = app.emit(
                    "mpv-end-file",
                    json!({
                        "reason": "eof",
                        "position": snapshot.position,
                        "duration": snapshot.duration,
                    }),
                );
                let _ = app.emit("mpv-stream-ended", ());
            }
            last_ended = snapshot.ended;

            if snapshot.error_seq != last_error_seq {
                last_error_seq = snapshot.error_seq;
                let detail = snapshot.error_message.clone().unwrap_or_default();
                push_log(&log_lines, format!("[exoplayer:error] {}", detail));
                log::warn!("[ynotv::mpv_core] ExoPlayer error: {}", detail);

                // Same strings as the mpv engines, so the error overlay picks the
                // right title/advice.
                let http_message = snapshot.http_status.and_then(|code| {
                    crate::mpv_error_parse::http_error_message(&format!("HTTP error {}", code))
                });
                if let Some(message) = http_message {
                    let _ = app.emit("mpv-http-error", message);
                } else if let Some(message) =
                    crate::mpv_error_parse::end_file_error_message("error", &detail)
                {
                    let _ = app.emit("mpv-end-file-error", message);
                }
                let _ = app.emit(
                    "mpv-end-file",
                    json!({
                        "reason": "error",
                        "fileError": detail,
                        "position": snapshot.position,
                        "duration": snapshot.duration,
                    }),
                );
                let _ = app.emit("mpv-stream-ended", ());
            }

            // Live streams: report the seekable window ExoPlayer has buffered,
            // in the shape the timeshift UI expects.
            if snapshot.is_live && snapshot.buffered_position > snapshot.position {
                let cache_end = snapshot.buffered_position;
                let _ = app.emit(
                    "timeshift-update",
                    json!({
                        "cacheStart": snapshot.position,
                        "cacheEnd": cache_end,
                        "timePos": snapshot.position,
                        "behindLive": (cache_end - snapshot.position).max(0.0),
                        "cachedDuration": cache_end - snapshot.position,
                    }),
                );
            }

            let video_track_id = if snapshot.has_video {
                snapshot.video_track_id.map(Value::from)
            } else {
                Some(Value::Bool(false))
            };
            let status = MpvStatus {
                playing: snapshot.play_when_ready && !snapshot.ended,
                volume: snapshot.volume,
                muted: snapshot.muted,
                position: snapshot.position,
                duration: snapshot.duration,
                paused_for_cache,
                core_idle: core_idle || snapshot.idle,
                eof_reached: snapshot.ended,
                video_format: snapshot.video_format,
                video_track_id,
            };
            let _ = app.emit("mpv-status", status);
        }
    });
}

/// Player logs are always captured at one level on Android; kept for API parity.
pub async fn set_verbose_logging<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let _ = (app, enabled);
    Ok(())
}

pub async fn get_log<R: Runtime>(app: &AppHandle<R>, tail: usize) -> Result<Value, String> {
    let state = app.state::<MpvCoreState>();
    let lines: Vec<String> = {
        let buf = state.log_lines.lock().unwrap();
        buf.iter().cloned().collect()
    };
    let start = lines.len().saturating_sub(tail.max(1));
    Ok(json!({
        "log": lines[start..].join("\n"),
        "path": "ExoPlayer (in-process)",
        "filtered": false,
    }))
}

async fn ensure_initialized<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if app.state::<MpvCoreState>().ready.load(Ordering::SeqCst) {
        return Ok(());
    }
    log::info!("[ynotv::mpv_core] Player not initialized on load_file, auto-initializing with stored settings...");
    let params = crate::get_mpv_params_from_store(app).await;
    let safe_params = crate::sanitize_mpv_args(params);
    init_mpv_with_params(app.clone(), safe_params).await
}

/// Forward a command only when the player exists, like the libmpv core does.
async fn call_if_ready<R: Runtime>(app: &AppHandle<R>, command: &'static str, payload: Value) -> Result<(), String> {
    if !app.state::<MpvCoreState>().ready.load(Ordering::SeqCst) {
        return Ok(());
    }
    call(app, command, payload).await.map(|_| ())
}

pub async fn load_file<R: Runtime>(app: &AppHandle<R>, url: String) -> Result<(), String> {
    ensure_initialized(app).await?;
    let state = app.state::<MpvCoreState>();
    push_log(&state.log_lines, format!("[exoplayer:info] load {}", url));
    call(app, "load", json!({ "url": url })).await?;
    *state.current_url.lock().unwrap() = Some(url);
    Ok(())
}

pub async fn play<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    call_if_ready(app, "setPaused", json!({ "paused": false })).await
}

pub async fn pause<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    call_if_ready(app, "setPaused", json!({ "paused": true })).await
}

pub async fn resume<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    play(app).await
}

pub async fn stop<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    call_if_ready(app, "stop", json!({})).await
}

pub async fn seek<R: Runtime>(app: &AppHandle<R>, seconds: f64) -> Result<(), String> {
    call_if_ready(app, "seek", json!({ "seconds": seconds })).await
}

pub async fn set_volume<R: Runtime>(app: &AppHandle<R>, volume: f64) -> Result<(), String> {
    call_if_ready(app, "setVolume", json!({ "volume": volume })).await
}

pub async fn toggle_mute<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    call_if_ready(app, "toggleMute", json!({})).await
}

pub async fn cycle_audio<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    call_if_ready(app, "cycleTrack", json!({ "type": "audio" })).await
}

pub async fn cycle_sub<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    call_if_ready(app, "cycleTrack", json!({ "type": "sub" })).await
}

/// Track list in mpv's `track-list` shape (id/type/lang/title/selected/...).
pub async fn get_track_list<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    if !app.state::<MpvCoreState>().ready.load(Ordering::SeqCst) {
        return Ok(json!([]));
    }
    let res = call(app, "tracks", json!({})).await?;
    Ok(res.get("tracks").cloned().unwrap_or_else(|| json!([])))
}

pub async fn set_audio_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    call_if_ready(app, "selectTrack", json!({ "type": "audio", "id": id })).await
}

pub async fn set_subtitle_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    call_if_ready(app, "selectTrack", json!({ "type": "sub", "id": id })).await
}

/// ExoPlayer loads subtitle URLs itself (query strings included), so external
/// subtitles are passed through as-is.
pub async fn resolve_external_subtitle(file_path: &str) -> String {
    file_path.to_string()
}

pub async fn add_subtitle_file<R: Runtime>(
    app: &AppHandle<R>,
    file_path: String,
    flag: Option<String>,
    title: Option<String>,
    lang: Option<String>,
) -> Result<String, String> {
    let resolved = resolve_external_subtitle(&file_path).await;
    call_if_ready(
        app,
        "addSubtitle",
        json!({
            "url": resolved,
            "select": flag.as_deref().unwrap_or("select") == "select",
            "title": title,
            "lang": lang,
        }),
    )
    .await?;
    Ok(resolved)
}

pub async fn remove_subtitle_file<R: Runtime>(
    app: &AppHandle<R>,
    file_path: String,
) -> Result<(), String> {
    call_if_ready(app, "removeSubtitle", json!({ "url": file_path })).await
}

/// Track ids arrive as numbers, numeric strings, or "no"/false for none.
fn track_id_from_value(value: &Value) -> i64 {
    match value {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

fn bool_from_value(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.as_str() {
            "yes" | "true" => Some(true),
            "no" | "false" => Some(false),
            _ => None,
        },
        Value::Number(n) => n.as_i64().map(|i| i != 0),
        _ => None,
    }
}

pub async fn set_property<R: Runtime>(
    app: &AppHandle<R>,
    name: String,
    value: Value,
) -> Result<(), String> {
    if !app.state::<MpvCoreState>().ready.load(Ordering::SeqCst) {
        return Ok(());
    }
    match name.as_str() {
        "pause" => match bool_from_value(&value) {
            Some(paused) => call(app, "setPaused", json!({ "paused": paused })).await.map(|_| ()),
            None => Ok(()),
        },
        "volume" => match value.as_f64().or_else(|| value.as_str().and_then(|s| s.parse().ok())) {
            Some(volume) => set_volume(app, volume).await,
            None => Ok(()),
        },
        "mute" => match bool_from_value(&value) {
            Some(muted) => call(app, "setMuted", json!({ "muted": muted })).await.map(|_| ()),
            None => Ok(()),
        },
        "speed" => match value.as_f64().or_else(|| value.as_str().and_then(|s| s.parse().ok())) {
            Some(speed) => call(app, "setSpeed", json!({ "speed": speed })).await.map(|_| ()),
            None => Ok(()),
        },
        "aid" => set_audio_track(app, track_id_from_value(&value)).await,
        "sid" => set_subtitle_track(app, track_id_from_value(&value)).await,
        "user-agent" | "referrer" | "http-header-fields" => {
            let text = value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string());
            let param = format!("{}={}", name, text);
            call(app, "setHttpOptions", http_options_from_params(&[param])).await.map(|_| ())
        }
        // Subtitle appearance: the plugin maps what ExoPlayer's SubtitleView
        // supports (colors, scale, position, visibility) and ignores the rest.
        n if n.starts_with("sub-") => call(app, "setSubtitleStyle", json!({ "name": name, "value": value }))
            .await
            .map(|_| ()),
        _ => {
            log::debug!("[ynotv::mpv_core] ignoring unsupported property on Android: {}", name);
            Ok(())
        }
    }
}

pub async fn set_properties<R: Runtime>(
    app: &AppHandle<R>,
    properties: HashMap<String, Value>,
) -> Result<(), String> {
    for (k, v) in properties {
        set_property(app, k, v).await?;
    }
    Ok(())
}

pub async fn get_property<R: Runtime>(
    app: &AppHandle<R>,
    name: String,
) -> Result<Value, String> {
    if !app.state::<MpvCoreState>().ready.load(Ordering::SeqCst) {
        return Ok(Value::Null);
    }
    if name == "track-list" {
        return get_track_list(app).await;
    }
    let snapshot: PlayerSnapshot = serde_json::from_value(call(app, "status", json!({})).await?)
        .unwrap_or_default();
    Ok(match name.as_str() {
        "pause" => json!(!snapshot.play_when_ready),
        "volume" => json!(snapshot.volume),
        "mute" => json!(snapshot.muted),
        "time-pos" => json!(snapshot.position),
        "duration" => json!(snapshot.duration),
        "eof-reached" => json!(snapshot.ended),
        "core-idle" => json!(!snapshot.is_playing),
        "paused-for-cache" => json!(snapshot.buffering && snapshot.play_when_ready),
        "video-format" => snapshot.video_format.map(Value::from).unwrap_or(Value::Null),
        "path" | "stream-open-filename" => app
            .state::<MpvCoreState>()
            .current_url
            .lock()
            .unwrap()
            .clone()
            .map(Value::from)
            .unwrap_or(Value::Null),
        _ => Value::Null,
    })
}

/// ExoPlayer has no stats overlay; kept for API parity.
pub async fn toggle_stats<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let _ = app;
    Ok(())
}

pub async fn sync_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    set_geometry(app, 0, 0, 0, 0).await
}

/// Position the video surface in physical pixels relative to the WebView;
/// 0x0 means fill the screen (full player / fullscreen).
pub async fn set_geometry<R: Runtime>(
    app: &AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    call_if_ready(
        app,
        "setGeometry",
        json!({ "x": x, "y": y, "width": width, "height": height }),
    )
    .await
}

pub async fn kill_mpv<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<MpvCoreState>();
    state.is_shutting_down.store(true, Ordering::Relaxed);
    let _ = app.emit("mpv-ready", false);

    state.monitor_generation.fetch_add(1, Ordering::SeqCst);
    if state.ready.swap(false, Ordering::SeqCst) {
        let _ = call(app, "release", json!({})).await;
    }

    state.is_shutting_down.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_http_options_from_mpv_params() {
        let params = vec![
            "--user-agent=VLC/3.0".to_string(),
            "--referrer=https://example.com/".to_string(),
            "--hwdec=auto".to_string(),
        ];
        let options = http_options_from_params(&params);
        assert_eq!(options["userAgent"], "VLC/3.0");
        assert_eq!(options["referrer"], "https://example.com/");
        assert!(options.get("hwdec").is_none());
    }

    #[test]
    fn parses_track_ids_like_mpv() {
        assert_eq!(track_id_from_value(&json!(2)), 2);
        assert_eq!(track_id_from_value(&json!("3")), 3);
        assert_eq!(track_id_from_value(&json!("no")), 0);
        assert_eq!(track_id_from_value(&json!(false)), 0);
    }
}
