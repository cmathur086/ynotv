//! Android stand-in for the libmpv canvas multiview (mpv_canvas.rs).
//!
//! The desktop implementation renders extra multiview slots with offscreen
//! libmpv instances, and libmpv is not linked on Android. The commands keep the
//! same signatures so the invoke handler is unchanged; starting a slot reports
//! an error the frontend already handles, and the rest are no-ops.

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

#[derive(Default)]
pub struct CanvasMultiviewState;

impl CanvasMultiviewState {
    pub fn new() -> Self {
        Self
    }
}

#[tauri::command]
pub async fn multiview_canvas_start(
    slot_id: u8,
    url: String,
    width: u32,
    height: u32,
    channel: Channel<InvokeResponseBody>,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let _ = (url, width, height, channel, state);
    Err(format!(
        "Canvas multiview slot {} is not supported on Android",
        slot_id
    ))
}

#[tauri::command]
pub async fn multiview_canvas_ack(
    slot_id: u8,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let _ = (slot_id, state);
    Ok(())
}

#[tauri::command]
pub async fn multiview_canvas_stop(
    slot_id: u8,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let _ = (slot_id, state);
    Ok(())
}

#[tauri::command]
pub async fn multiview_canvas_resize(
    slot_id: u8,
    width: u32,
    height: u32,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let _ = (slot_id, width, height, state);
    Ok(())
}

#[tauri::command]
pub async fn multiview_canvas_set_property(
    slot_id: u8,
    property: String,
    value: Value,
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let _ = (slot_id, property, value, state);
    Ok(())
}

#[tauri::command]
pub async fn multiview_canvas_stop_all(
    state: State<'_, CanvasMultiviewState>,
) -> Result<(), String> {
    let _ = state;
    Ok(())
}
