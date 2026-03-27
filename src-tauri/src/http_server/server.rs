use axum::{
    extract::{ws::WebSocketUpgrade, Path as AxumPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use super::auth;
use super::websocket::handle_ws_connection;
use super::EmitExt;
use super::WsBroadcaster;

/// Shared state for the Axum server.
#[derive(Clone)]
struct AppState {
    app: AppHandle,
    token: String,
    token_required: bool,
}

/// Server handle for shutdown coordination.
pub struct HttpServerHandle {
    pub shutdown_tx: tokio::sync::oneshot::Sender<()>,
    pub port: u16,
    pub token: String,
    pub url: String,
    pub localhost_only: bool,
    pub token_required: bool,
}

/// Status response for the HTTP server.
#[derive(Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    pub url: Option<String>,
    pub token: Option<String>,
    pub port: Option<u16>,
    pub localhost_only: Option<bool>,
}

#[derive(Deserialize)]
struct WsAuth {
    token: Option<String>,
    /// Comma-separated worktreeId:sessionId pairs from the browser's current state.
    /// Used by /api/init to load the correct active sessions even when
    /// ui_state.json on disk is stale (debounced save hasn't flushed yet).
    active_sessions: Option<String>,
}

/// Resolve the dist directory path at runtime.
/// Checks multiple locations for development and production scenarios.
fn resolve_dist_path(app: &AppHandle) -> std::path::PathBuf {
    // Development: prefer local dist output first so `vite build --watch`
    // changes are served immediately instead of stale bundled resources.
    let dev_dist = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
    if cfg!(debug_assertions) && dev_dist.exists() && dev_dist.join("index.html").exists() {
        log::info!("Serving frontend from dev dist: {}", dev_dist.display());
        return dev_dist;
    }

    // 1. Check if app has a resource dir with dist/ (bundled via resources config)
    if let Ok(resource_dir) = app.path().resource_dir() {
        log::info!("Resource dir: {}", resource_dir.display());

        let dist = resource_dir.join("dist");
        if dist.exists() && dist.join("index.html").exists() {
            log::info!("Serving frontend from resource dir: {}", dist.display());
            return dist;
        }

        // 1b. Check resource dir itself (flat resources on some platforms)
        if resource_dir.join("index.html").exists() {
            log::info!(
                "Serving frontend from resource dir (flat): {}",
                resource_dir.display()
            );
            return resource_dir;
        }
    }

    // 2. Fallback to local dist path (also used in release if needed)
    if dev_dist.exists() && dev_dist.join("index.html").exists() {
        log::info!("Serving frontend from dev dist: {}", dev_dist.display());
        return dev_dist;
    }

    // 3. Fallback: relative to executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let dist = parent.join("dist");
            if dist.exists() && dist.join("index.html").exists() {
                log::info!(
                    "Serving frontend from exe-relative dist: {}",
                    dist.display()
                );
                return dist;
            }
        }
    }

    // Last resort: return dev path even if it doesn't exist yet
    log::warn!(
        "No dist directory found with index.html, using dev path: {}",
        dev_dist.display()
    );
    dev_dist
}

/// Start the HTTP + WebSocket server.
pub async fn start_server(
    app: AppHandle,
    port: u16,
    token: String,
    localhost_only: bool,
    token_required: bool,
) -> Result<HttpServerHandle, String> {
    let state = AppState {
        app: app.clone(),
        token: token.clone(),
        token_required,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Resolve the dist directory at runtime for static file serving
    let dist_path = resolve_dist_path(&app);
    let index_path = dist_path.join("index.html");

    let serve_dir = ServeDir::new(&dist_path)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(&index_path));

    let router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/auth", get(auth_handler))
        .route("/api/init", get(init_handler))
        .route("/api/files/{*filepath}", get(file_handler))
        .fallback_service(serve_dir)
        .layer(cors)
        .with_state(state);

    // Bind to localhost only or all interfaces based on preference
    let addr = if localhost_only {
        SocketAddr::from(([127, 0, 0, 1], port))
    } else {
        SocketAddr::from(([0, 0, 0, 0], port))
    };
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind to port {port}: {e}"))?;

    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {e}"))?;

    // Get LAN IP for the URL (only used when not localhost-only)
    let ip = if localhost_only {
        "127.0.0.1".to_string()
    } else {
        get_local_ip().unwrap_or_else(|| "127.0.0.1".to_string())
    };
    let url = format!("http://{ip}:{}", local_addr.port());

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

    // Spawn the server
    tokio::spawn(async move {
        log::info!("HTTP server listening on {local_addr} (localhost_only: {localhost_only})");
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
                log::info!("HTTP server shutting down");
            })
            .await
            .unwrap_or_else(|e| log::error!("HTTP server error: {e}"));
    });

    Ok(HttpServerHandle {
        shutdown_tx,
        port: local_addr.port(),
        token,
        url,
        localhost_only,
        token_required,
    })
}

/// WebSocket upgrade handler with token auth.
async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsAuth>,
    State(state): State<AppState>,
) -> Response {
    // Validate token (skip if token not required)
    if state.token_required {
        let provided = params.token.unwrap_or_default();
        if !auth::validate_token(&provided, &state.token) {
            return (StatusCode::UNAUTHORIZED, "Invalid token").into_response();
        }
    }

    // Get broadcast receiver for this client
    let broadcaster = state.app.try_state::<WsBroadcaster>();
    let event_rx = match broadcaster {
        Some(b) => b.subscribe(),
        None => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Server not initialized").into_response();
        }
    };

    let app = state.app.clone();
    ws.on_upgrade(move |socket| handle_ws_connection(socket, app, event_rx))
}

/// Token validation endpoint. Returns 200 with { ok: true } on success,
/// or 401 with { ok: false, error: "..." } on failure.
async fn auth_handler(Query(params): Query<WsAuth>, State(state): State<AppState>) -> Response {
    // If token not required, always return success
    if !state.token_required {
        return Json(serde_json::json!({ "ok": true, "token_required": false })).into_response();
    }

    let provided = params.token.unwrap_or_default();
    if auth::validate_token(&provided, &state.token) {
        Json(serde_json::json!({ "ok": true })).into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "ok": false, "error": "Invalid token" })),
        )
            .into_response()
    }
}

/// Initial data endpoint. Returns all data needed to render the initial view.
/// This is used by the web view to preload data before WebSocket connects.
async fn init_handler(Query(params): Query<WsAuth>, State(state): State<AppState>) -> Response {
    // Validate token (skip if token not required)
    if state.token_required {
        let provided = params.token.unwrap_or_default();
        if !auth::validate_token(&provided, &state.token) {
            return (StatusCode::UNAUTHORIZED, "Invalid token").into_response();
        }
    }

    // Fetch base data in parallel
    let (projects_result, preferences_result, ui_state_result) = tokio::join!(
        crate::projects::list_projects(state.app.clone()),
        crate::load_preferences(state.app.clone()),
        crate::load_ui_state(state.app.clone()),
    );

    // Build response object with available data (don't fail if one part fails)
    let mut response = serde_json::json!({});

    // Extract projects and fetch worktrees for each
    let projects = match projects_result {
        Ok(projects) => projects,
        Err(e) => {
            log::error!("Failed to load projects for /api/init: {e}");
            vec![]
        }
    };

    // Fetch worktrees for all projects in parallel
    let worktrees_futures: Vec<_> = projects
        .iter()
        .filter(|p| !p.is_folder) // Only fetch worktrees for actual projects
        .map(|p| {
            let app = state.app.clone();
            let project_id = p.id.clone();
            async move {
                let worktrees = crate::projects::list_worktrees(app, project_id.clone())
                    .await
                    .unwrap_or_default();
                (project_id, worktrees)
            }
        })
        .collect();

    let worktrees_by_project: std::collections::HashMap<
        String,
        Vec<crate::projects::types::Worktree>,
    > = futures_util::future::join_all(worktrees_futures)
        .await
        .into_iter()
        .collect();

    // Collect all worktrees for session/status fetching
    let all_worktrees: Vec<_> = worktrees_by_project
        .values()
        .flat_map(|wts| wts.iter())
        .collect();

    // Fetch sessions for all worktrees in parallel
    let sessions_futures: Vec<_> = all_worktrees
        .iter()
        .map(|wt| {
            let app = state.app.clone();
            let worktree_id = wt.id.clone();
            let worktree_path = wt.path.clone();
            async move {
                let sessions = crate::chat::get_sessions(
                    app,
                    worktree_id.clone(),
                    worktree_path,
                    None,       // include_archived
                    Some(true), // include_message_counts
                )
                .await
                .unwrap_or_default();
                (worktree_id, sessions)
            }
        })
        .collect();

    // WorktreeSessions contains the full struct - keep as-is for frontend compatibility
    let sessions_by_worktree: std::collections::HashMap<
        String,
        crate::chat::types::WorktreeSessions,
    > = futures_util::future::join_all(sessions_futures)
        .await
        .into_iter()
        .collect();

    // Note: Git status is already included in the Worktree struct (cached_* fields)
    // No need to fetch separately - the frontend will use worktree.cached_* values

    let is_active_session_valid = |worktree_id: &str, session_id: &str| {
        sessions_by_worktree
            .get(worktree_id)
            .map(|ws| {
                ws.sessions
                    .iter()
                    .any(|s| s.id == session_id && s.archived_at.is_none())
            })
            .unwrap_or(false)
    };

    // Parse browser-provided active session IDs (worktreeId:sessionId pairs).
    // These override ui_state.json which may be stale due to debounced save.
    let browser_active_sessions: std::collections::HashMap<String, String> =
        params.active_sessions
            .as_deref()
            .unwrap_or("")
            .split(',')
            .filter_map(|pair| {
                let pair = pair.trim();
                let (wt, sess) = pair.split_once(':')?;
                if wt.is_empty() || sess.is_empty() {
                    return None;
                }
                Some((wt.to_string(), sess.to_string()))
            })
            .collect();

    // Extract ui_state early so we can use it to fetch active sessions
    let mut ui_state = match &ui_state_result {
        Ok(ui_state) => Some(ui_state.clone()),
        Err(_) => None,
    };

    // Merge browser's active sessions into ui_state (browser is more recent
    // than disk when ui_state.json save is debounced).
    if !browser_active_sessions.is_empty() {
        if let Some(ref mut ui) = ui_state {
            for (worktree_id, session_id) in &browser_active_sessions {
                if is_active_session_valid(worktree_id, session_id) {
                    log::debug!(
                        "Using browser active session {session_id} for worktree {worktree_id}"
                    );
                    ui.active_session_ids
                        .insert(worktree_id.clone(), session_id.clone());
                }
            }
        }
    }

    let mut cleaned_active_sessions: Vec<(String, Option<String>)> = Vec::new();

    // Clean up stale active_session_ids that reference deleted/archived sessions.
    // This happens when a session is deleted in the native app but ui-state.json
    // hasn't been flushed yet (debounced save) before a web client connects.
    if let Some(ref mut ui) = ui_state {
        let stale_keys: Vec<String> = ui
            .active_session_ids
            .iter()
            .filter(|(worktree_id, session_id)| !is_active_session_valid(worktree_id, session_id))
            .map(|(k, _)| k.clone())
            .collect();

        for worktree_id in stale_keys {
            let old_id = ui.active_session_ids.remove(&worktree_id);
            // Try to fall back to the most recent non-archived session
            let fallback_session_id = sessions_by_worktree
                .get(&worktree_id)
                .and_then(|ws| ws.sessions.iter().find(|s| s.archived_at.is_none()))
                .map(|fallback| fallback.id.clone());

            if let Some(ref fallback_id) = fallback_session_id {
                log::info!(
                    "Replacing stale active session {} with {} for worktree {worktree_id}",
                    old_id.as_deref().unwrap_or("?"),
                    fallback_id
                );
                ui.active_session_ids
                    .insert(worktree_id.clone(), fallback_id.clone());
            } else {
                log::info!(
                    "Removed stale active session {} for worktree {worktree_id} (no fallback)",
                    old_id.as_deref().unwrap_or("?")
                );
            }

            cleaned_active_sessions.push((worktree_id, fallback_session_id));
        }
    }

    if !cleaned_active_sessions.is_empty() {
        match crate::load_ui_state(state.app.clone()).await {
            Ok(mut latest_ui_state) => {
                let mut persisted_cleanup = false;

                for (worktree_id, fallback_session_id) in &cleaned_active_sessions {
                    let should_update = latest_ui_state
                        .active_session_ids
                        .get(worktree_id)
                        .map(|session_id| !is_active_session_valid(worktree_id, session_id))
                        .unwrap_or(false);

                    if !should_update {
                        continue;
                    }

                    persisted_cleanup = true;

                    if let Some(fallback_id) = fallback_session_id {
                        latest_ui_state
                            .active_session_ids
                            .insert(worktree_id.clone(), fallback_id.clone());
                    } else {
                        latest_ui_state.active_session_ids.remove(worktree_id);
                    }
                }

                if persisted_cleanup {
                    if let Err(e) = crate::save_ui_state(state.app.clone(), latest_ui_state).await {
                        log::error!("Failed to persist cleaned ui_state for /api/init: {e}");
                    } else if let Err(e) = state.app.emit_all(
                        "cache:invalidate",
                        &serde_json::json!({ "keys": ["ui-state"] }),
                    ) {
                        log::error!("Failed to emit cache:invalidate after ui_state cleanup: {e}");
                    }
                }
            }
            Err(e) => {
                log::error!(
                    "Failed to reload ui_state before persisting cleanup for /api/init: {e}"
                );
            }
        }
    }

    // Fetch full session details (with messages) for all active sessions
    // This ensures the chat history is immediately available when the app loads
    let active_sessions: std::collections::HashMap<String, crate::chat::types::Session> =
        if let Some(ref ui) = ui_state {
            // Build a map of worktree_id -> worktree for path lookup
            let worktree_map: std::collections::HashMap<&str, &crate::projects::types::Worktree> =
                all_worktrees
                    .iter()
                    .map(|wt| (wt.id.as_str(), *wt))
                    .collect();

            // Fetch full session details for each active session
            let session_futures: Vec<_> = ui
                .active_session_ids
                .iter()
                .filter_map(|(worktree_id, session_id)| {
                    worktree_map.get(worktree_id.as_str()).map(|wt| {
                        let app = state.app.clone();
                        let wt_id = worktree_id.clone();
                        let wt_path = wt.path.clone();
                        let sess_id = session_id.clone();
                        async move {
                            match crate::chat::get_session(app, wt_id, wt_path, sess_id.clone())
                                .await
                            {
                                Ok(session) => Some((sess_id, session)),
                                Err(e) => {
                                    log::warn!("Failed to load active session {sess_id}: {e}");
                                    None
                                }
                            }
                        }
                    })
                })
                .collect();

            futures_util::future::join_all(session_futures)
                .await
                .into_iter()
                .flatten()
                .collect()
        } else {
            std::collections::HashMap::new()
        };

    // Serialize projects
    if let Ok(val) = serde_json::to_value(&projects) {
        response["projects"] = val;
    }

    // Serialize worktrees map (projectId -> worktrees[])
    if let Ok(val) = serde_json::to_value(&worktrees_by_project) {
        response["worktreesByProject"] = val;
    }

    // Serialize sessions map (worktreeId -> WorktreeSessions)
    if let Ok(val) = serde_json::to_value(&sessions_by_worktree) {
        response["sessionsByWorktree"] = val;
    }

    // Serialize active sessions map (sessionId -> Session with messages)
    if !active_sessions.is_empty() {
        if let Ok(val) = serde_json::to_value(&active_sessions) {
            response["activeSessions"] = val;
        }
    }

    // Include app data dir so the web view can build file-serving URLs
    if let Ok(app_data_dir) = state.app.path().app_data_dir() {
        response["appDataDir"] = Value::String(app_data_dir.to_string_lossy().to_string());
    }

    match preferences_result {
        Ok(preferences) => {
            if let Ok(val) = serde_json::to_value(&preferences) {
                response["preferences"] = val;
            }
        }
        Err(e) => {
            log::error!("Failed to load preferences for /api/init: {e}");
            response["preferences"] = Value::Null;
        }
    }

    // Use the cleaned ui_state (with stale active_session_ids removed) if available,
    // otherwise fall back to the original result for error handling
    // Include currently running session IDs so web clients can restore sending state
    let running_sessions = crate::chat::registry::get_running_sessions();
    response["runningSessions"] = serde_json::to_value(&running_sessions).unwrap_or_default();

    match ui_state {
        Some(cleaned_ui) => {
            if let Ok(val) = serde_json::to_value(&cleaned_ui) {
                response["uiState"] = val;
            }
        }
        None => {
            if let Err(e) = &ui_state_result {
                log::error!("Failed to load ui_state for /api/init: {e}");
            }
            response["uiState"] = Value::Null;
        }
    }

    Json(response).into_response()
}

/// Guess MIME type from file extension.
fn mime_from_extension(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("txt") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        Some("md") => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Serve files from the app data directory (authenticated).
/// Used by the web view to load images, avatars, and other assets
/// that Tauri's asset:// protocol would serve in native mode.
async fn file_handler(
    AxumPath(filepath): AxumPath<String>,
    Query(params): Query<WsAuth>,
    State(state): State<AppState>,
) -> Response {
    // Validate token
    if state.token_required {
        let provided = params.token.unwrap_or_default();
        if !auth::validate_token(&provided, &state.token) {
            return (StatusCode::UNAUTHORIZED, "Invalid token").into_response();
        }
    }

    // Resolve app data directory
    let app_data_dir = match state.app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cannot resolve app data dir",
            )
                .into_response()
        }
    };

    // Build requested path and canonicalize
    let requested = app_data_dir.join(&filepath);
    let canonical = match requested.canonicalize() {
        Ok(p) => p,
        Err(_) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };

    // Security: ensure path is within app data dir (prevents traversal)
    let canonical_base = match app_data_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Cannot resolve base dir").into_response()
        }
    };
    if !canonical.starts_with(&canonical_base) {
        return (StatusCode::FORBIDDEN, "Access denied").into_response();
    }

    // Only serve files, not directories
    if !canonical.is_file() {
        return (StatusCode::NOT_FOUND, "Not a file").into_response();
    }

    // Read and serve the file
    let mime = mime_from_extension(&canonical);
    match tokio::fs::read(&canonical).await {
        Ok(bytes) => Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "private, max-age=3600")
            .body(axum::body::Body::from(bytes))
            .unwrap()
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Cannot read file").into_response(),
    }
}

/// Get the local LAN IP address.
fn get_local_ip() -> Option<String> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

/// Get current server status. Called from dispatch.
pub async fn get_server_status(app: AppHandle) -> ServerStatus {
    match app.try_state::<Arc<Mutex<Option<HttpServerHandle>>>>() {
        Some(handle_state) => {
            let handle = handle_state.lock().await;
            match handle.as_ref() {
                Some(h) => ServerStatus {
                    running: true,
                    url: Some(h.url.clone()),
                    token: Some(h.token.clone()),
                    port: Some(h.port),
                    localhost_only: Some(h.localhost_only),
                },
                None => ServerStatus {
                    running: false,
                    url: None,
                    token: None,
                    port: None,
                    localhost_only: None,
                },
            }
        }
        None => ServerStatus {
            running: false,
            url: None,
            token: None,
            port: None,
            localhost_only: None,
        },
    }
}
