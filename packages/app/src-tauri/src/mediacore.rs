//! MediaCore (Dragon's Nest) account session.
//!
//! Signing in with a MediaCore account gives the app metadata through the
//! account's server (`/v1/metadata/tmdb/*`), so no TMDB key has to be entered
//! on each device. The session follows the MediaCore clients' contract:
//! `POST /auth/login` once, then `POST /auth/refresh` whenever the short-lived
//! access token runs out.
//!
//! The refresh token never leaves Rust; it is kept in the app's private data
//! directory. The frontend only ever sees the access token. Refreshing rotates
//! the refresh token server-side, so refreshes are single-flight behind one lock:
//! two concurrent refreshes with the same token would revoke the session.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

pub const BASE_URL: &str = "https://sync.dragonshieldgroup.com";
const SESSION_FILE: &str = "mediacore-session.json";
/// Refresh this long before the access token actually expires.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    refresh_token: String,
    user: Value,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    stored: Option<StoredSession>,
    access: Option<(String, Instant)>,
}

#[derive(Default)]
pub struct MediaCoreState {
    inner: tokio::sync::Mutex<Inner>,
}

/// What the frontend gets: who is signed in, and a token for the account's API.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    user: Value,
    access_token: String,
    base_url: &'static str,
    expires_in_seconds: u64,
}

/// The session bundle `/auth/login` and `/auth/refresh` answer with.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionBundle {
    user: Value,
    access_token: String,
    access_token_expires_in: u64,
    refresh_token: String,
}

enum AuthFailure {
    /// The server refused the credentials or token: the session is over.
    Rejected(String),
    /// Network trouble or a server error: keep the session and try again later.
    Unavailable(String),
}

fn session_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(SESSION_FILE))
}

fn load_stored<R: Runtime>(app: &AppHandle<R>) -> Option<StoredSession> {
    let path = session_path(app).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_stored<R: Runtime>(app: &AppHandle<R>, session: &StoredSession) -> Result<(), String> {
    let path = session_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Write then rename, so a crash mid-write can't leave a truncated token behind.
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(session).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn clear_stored<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(path) = session_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

fn client<R: Runtime>(app: &AppHandle<R>) -> Result<reqwest::Client, String> {
    let version = app.package_info().version.to_string();
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(format!("ynoTV/{} (MediaCore)", version))
        .build()
        .map_err(|e| e.to_string())
}

/// Turn a non-2xx auth answer into a user-facing message.
fn failure_message(status: reqwest::StatusCode, body: &Value) -> String {
    let code = body.get("error").and_then(Value::as_str).unwrap_or_default();
    match (status.as_u16(), code) {
        (_, "INVALID_CREDENTIALS") | (401, _) => "Username or password is incorrect.".to_string(),
        (429, _) => "Too many sign-in attempts. Wait a minute and try again.".to_string(),
        (403, _) => body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("This account can't sign in right now.")
            .to_string(),
        _ => format!("MediaCore sign-in failed (HTTP {}).", status.as_u16()),
    }
}

async fn post_auth<R: Runtime>(app: &AppHandle<R>, path: &str, body: Value) -> Result<SessionBundle, AuthFailure> {
    let response = client(app)
        .map_err(AuthFailure::Unavailable)?
        .post(format!("{}{}", BASE_URL, path))
        .json(&body)
        .send()
        .await
        .map_err(|e| AuthFailure::Unavailable(format!("Can't reach MediaCore: {}", e)))?;
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return serde_json::from_value(payload)
            .map_err(|e| AuthFailure::Unavailable(format!("Unexpected MediaCore response: {}", e)));
    }
    let message = failure_message(status, &payload);
    if status.is_client_error() && status.as_u16() != 429 {
        Err(AuthFailure::Rejected(message))
    } else {
        Err(AuthFailure::Unavailable(message))
    }
}

fn adopt<R: Runtime>(app: &AppHandle<R>, inner: &mut Inner, bundle: SessionBundle) -> Result<SessionView, String> {
    let stored = StoredSession {
        refresh_token: bundle.refresh_token,
        user: bundle.user.clone(),
    };
    save_stored(app, &stored)?;
    inner.stored = Some(stored);
    inner.access = Some((
        bundle.access_token.clone(),
        Instant::now() + Duration::from_secs(bundle.access_token_expires_in),
    ));
    Ok(SessionView {
        user: bundle.user,
        access_token: bundle.access_token,
        base_url: BASE_URL,
        expires_in_seconds: bundle.access_token_expires_in,
    })
}

#[tauri::command]
pub async fn mediacore_login<R: Runtime>(
    app: AppHandle<R>,
    identifier: String,
    password: String,
) -> Result<SessionView, String> {
    let state = app.state::<MediaCoreState>();
    let mut inner = state.inner.lock().await;
    let bundle = post_auth(
        &app,
        "/auth/login",
        json!({ "identifier": identifier.trim(), "password": password }),
    )
    .await
    .map_err(|failure| match failure {
        AuthFailure::Rejected(m) | AuthFailure::Unavailable(m) => m,
    })?;
    inner.loaded = true;
    adopt(&app, &mut inner, bundle)
}

/// The current session, refreshing the access token when it is (nearly)
/// expired. `None` when signed out or the server ended the session.
#[tauri::command]
pub async fn mediacore_session<R: Runtime>(
    app: AppHandle<R>,
    force_refresh: Option<bool>,
) -> Result<Option<SessionView>, String> {
    let state = app.state::<MediaCoreState>();
    let mut inner = state.inner.lock().await;
    if !inner.loaded {
        inner.stored = load_stored(&app);
        inner.loaded = true;
    }
    let Some(stored) = inner.stored.clone() else {
        return Ok(None);
    };

    if !force_refresh.unwrap_or(false) {
        if let Some((token, expires_at)) = &inner.access {
            let remaining = expires_at.saturating_duration_since(Instant::now());
            if remaining > EXPIRY_MARGIN {
                return Ok(Some(SessionView {
                    user: stored.user,
                    access_token: token.clone(),
                    base_url: BASE_URL,
                    expires_in_seconds: remaining.as_secs(),
                }));
            }
        }
    }

    match post_auth(&app, "/auth/refresh", json!({ "refreshToken": stored.refresh_token })).await {
        Ok(bundle) => adopt(&app, &mut inner, bundle).map(Some),
        Err(AuthFailure::Rejected(message)) => {
            log::warn!("[MediaCore] session ended by server: {}", message);
            inner.stored = None;
            inner.access = None;
            clear_stored(&app);
            Ok(None)
        }
        Err(AuthFailure::Unavailable(message)) => Err(message),
    }
}

#[tauri::command]
pub async fn mediacore_logout<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MediaCoreState>();
    let mut inner = state.inner.lock().await;
    if !inner.loaded {
        inner.stored = load_stored(&app);
        inner.loaded = true;
    }
    if let Some(stored) = inner.stored.take() {
        // Best effort: the local sign-out must succeed even offline.
        if let Ok(client) = client(&app) {
            let _ = client
                .post(format!("{}/auth/logout", BASE_URL))
                .json(&json!({ "refreshToken": stored.refresh_token }))
                .send()
                .await;
        }
    }
    inner.access = None;
    clear_stored(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_auth_failures_to_readable_messages() {
        let bad = json!({ "error": "INVALID_CREDENTIALS", "message": "nope" });
        assert_eq!(
            failure_message(reqwest::StatusCode::UNAUTHORIZED, &bad),
            "Username or password is incorrect."
        );
        let limited = json!({ "error": "RATE_LIMITED" });
        assert!(failure_message(reqwest::StatusCode::TOO_MANY_REQUESTS, &limited).contains("Too many"));
        let disabled = json!({ "error": "ACCOUNT_DISABLED", "message": "Account is disabled." });
        assert_eq!(
            failure_message(reqwest::StatusCode::FORBIDDEN, &disabled),
            "Account is disabled."
        );
    }

    #[test]
    fn reads_the_session_bundle_shape() {
        let bundle: SessionBundle = serde_json::from_value(json!({
            "user": { "id": "u1", "username": "cam" },
            "session": { "id": "s1" },
            "accessToken": "a.b.c",
            "accessTokenExpiresIn": 900,
            "refreshToken": "r".repeat(40),
            "refreshTokenExpiresAt": "2026-12-01T00:00:00.000Z",
            "passwordMustChange": false
        }))
        .unwrap();
        assert_eq!(bundle.access_token_expires_in, 900);
        assert_eq!(bundle.user["username"], "cam");
    }
}
