//! Android stand-in for the system tray module (tray.rs).
//!
//! There is no tray or launch-at-login on Android; the commands stay
//! registered so the settings UI gets a well-formed answer.

use tauri::AppHandle;

#[tauri::command]
pub fn set_minimize_to_tray(app: AppHandle, enabled: bool) -> bool {
    let _ = (app, enabled);
    false
}

#[tauri::command]
pub fn set_launch_at_startup(enabled: bool, tray: bool) -> Result<bool, String> {
    let _ = (enabled, tray);
    Ok(false)
}
