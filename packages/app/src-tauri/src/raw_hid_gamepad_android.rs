//! Android stand-in for the raw HID gamepad reader (raw_hid_gamepad.rs).
//!
//! hidapi is not linked on Android. Paired controllers and the TV remote reach
//! the WebView as ordinary key and Gamepad API input instead, so there is
//! nothing to read here.

use tauri::AppHandle;

pub fn debug_enabled() -> bool {
    false
}

pub fn start(_app_handle: &AppHandle) {}

pub fn shutdown() {}
