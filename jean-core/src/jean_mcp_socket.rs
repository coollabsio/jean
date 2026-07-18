//! Parent-side local socket for Jean MCP helpers.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::jean_mcp_core::{call_tool, extract_tool_call, jsonrpc_error, jsonrpc_ok};

#[derive(Debug)]
pub struct JeanMcpSocketHandle {
    pub shutdown_tx: tokio::sync::oneshot::Sender<()>,
    pub path: PathBuf,
    pub token: String,
}

pub fn socket_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(platform_socket_path(&dir))
}

#[cfg(unix)]
fn platform_socket_path(app_data_dir: &std::path::Path) -> PathBuf {
    app_data_dir.join("jean-mcp.sock")
}

#[cfg(windows)]
fn platform_socket_path(app_data_dir: &std::path::Path) -> PathBuf {
    windows_pipe_path_for_app_data(app_data_dir)
}

#[cfg(not(any(unix, windows)))]
fn platform_socket_path(app_data_dir: &std::path::Path) -> PathBuf {
    app_data_dir.join("jean-mcp.sock")
}

#[cfg(any(windows, test))]
fn windows_pipe_path_for_app_data(app_data_dir: &std::path::Path) -> PathBuf {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(app_data_dir.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    PathBuf::from(format!(r"\\.\pipe\jean-mcp-{suffix}"))
}

pub async fn get_socket_status(app: AppHandle) -> (bool, Option<String>, Option<String>) {
    match app.try_state::<Arc<Mutex<Option<JeanMcpSocketHandle>>>>() {
        Some(state) => {
            let guard = state.lock().await;
            match guard.as_ref() {
                Some(handle) => (
                    true,
                    Some(handle.path.to_string_lossy().to_string()),
                    Some(handle.token.clone()),
                ),
                None => (false, None, None),
            }
        }
        None => (false, None, None),
    }
}

#[cfg(unix)]
pub async fn start_socket_server(
    app: AppHandle,
    path: PathBuf,
    token: String,
) -> Result<JeanMcpSocketHandle, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create Jean MCP socket dir: {e}"))?;
    }
    if path.exists() {
        let _ = tokio::fs::remove_file(&path).await;
    }

    let listener = UnixListener::bind(&path)
        .map_err(|e| format!("Failed to bind Jean MCP socket {}: {e}", path.display()))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&path, perms)
            .map_err(|e| format!("Failed to lock down Jean MCP socket perms: {e}"))?;
    }
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
    let path_for_task = path.clone();
    let token_for_task = token.clone();

    tokio::spawn(async move {
        log::info!(
            "Jean MCP proxy socket listening at {}",
            path_for_task.display()
        );
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    log::info!("Jean MCP proxy socket shutting down");
                    break;
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _addr)) => {
                            let app = app.clone();
                            let expected_token = token_for_task.clone();
                            tokio::spawn(async move {
                                let (read_half, mut write_half) = stream.into_split();
                                let mut reader = BufReader::new(read_half);
                                let mut line = String::new();
                                let response = match tokio::time::timeout(
                                    std::time::Duration::from_secs(30),
                                    reader.read_line(&mut line),
                                )
                                .await
                                {
                                    Ok(Ok(0)) => json!({"error":"empty request"}),
                                    Ok(Ok(_)) => handle_socket_request(&app, &expected_token, &line).await,
                                    Ok(Err(e)) => json!({"error": format!("read failed: {e}")}),
                                    Err(_) => json!({"error":"read timeout"}),
                                };
                                if let Ok(encoded) = serde_json::to_string(&response) {
                                    let _ = write_half.write_all(encoded.as_bytes()).await;
                                    let _ = write_half.write_all(b"\n").await;
                                    let _ = write_half.flush().await;
                                }
                            });
                        }
                        Err(e) => log::warn!("Jean MCP socket accept failed: {e}"),
                    }
                }
            }
        }
        let _ = tokio::fs::remove_file(&path_for_task).await;
    });

    Ok(JeanMcpSocketHandle {
        shutdown_tx,
        path,
        token,
    })
}

#[cfg(windows)]
pub async fn start_socket_server(
    app: AppHandle,
    path: PathBuf,
    token: String,
) -> Result<JeanMcpSocketHandle, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    async fn handle_pipe_connection(
        app: AppHandle,
        expected_token: String,
        mut pipe: NamedPipeServer,
    ) {
        let mut line = String::new();
        let response = {
            let mut reader = BufReader::new(&mut pipe);
            match tokio::time::timeout(
                std::time::Duration::from_secs(30),
                reader.read_line(&mut line),
            )
            .await
            {
                Ok(Ok(0)) => json!({"error":"empty request"}),
                Ok(Ok(_)) => handle_socket_request(&app, &expected_token, &line).await,
                Ok(Err(e)) => json!({"error": format!("read failed: {e}")}),
                Err(_) => json!({"error":"read timeout"}),
            }
        };
        if let Ok(encoded) = serde_json::to_string(&response) {
            let _ = pipe.write_all(encoded.as_bytes()).await;
            let _ = pipe.write_all(b"\n").await;
            let _ = pipe.flush().await;
        }
    }

    let pipe_name = path.to_string_lossy().to_string();
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
        .map_err(|e| format!("Failed to create Jean MCP named pipe {pipe_name}: {e}"))?;
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
    let path_for_task = path.clone();
    let token_for_task = token.clone();

    tokio::spawn(async move {
        log::info!("Jean MCP proxy named pipe listening at {pipe_name}");
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    log::info!("Jean MCP proxy named pipe shutting down");
                    break;
                }
                connected = server.connect() => {
                    match connected {
                        Ok(()) => {
                            let next_server = match ServerOptions::new().create(&pipe_name) {
                                Ok(next) => next,
                                Err(e) => {
                                    log::warn!("Jean MCP named pipe recreate failed: {e}");
                                    break;
                                }
                            };
                            let connected_server = std::mem::replace(&mut server, next_server);
                            let app = app.clone();
                            let expected_token = token_for_task.clone();
                            tokio::spawn(handle_pipe_connection(app, expected_token, connected_server));
                        }
                        Err(e) => log::warn!("Jean MCP named pipe accept failed: {e}"),
                    }
                }
            }
        }
    });

    Ok(JeanMcpSocketHandle {
        shutdown_tx,
        path: path_for_task,
        token,
    })
}

#[cfg(not(any(unix, windows)))]
pub async fn start_socket_server(
    _app: AppHandle,
    _path: PathBuf,
    _token: String,
) -> Result<JeanMcpSocketHandle, String> {
    Err("Jean MCP local IPC is not supported on this platform".to_string())
}

async fn handle_socket_request(app: &AppHandle, expected_token: &str, line: &str) -> Value {
    let body: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({"error": format!("invalid json: {e}")}),
    };
    let provided = body.get("token").and_then(|v| v.as_str()).unwrap_or("");
    if !crate::http_server::auth::validate_token(provided, expected_token) {
        return json!({"error":"unauthorized"});
    }

    let tool_call = match extract_tool_call(body.clone()) {
        Ok(tool_call) => tool_call,
        Err(e) => return jsonrpc_error(None, e.code, &e.message),
    };
    let source = body
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("anon");
    let depth = body.get("depth").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    match call_tool(app, &tool_call.name, tool_call.arguments, source, depth).await {
        Ok(result) => jsonrpc_ok(None, result),
        Err(e) => jsonrpc_error(None, e.code, &e.message),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn windows_pipe_path_is_stable_and_named_pipe_safe() {
        let one =
            super::windows_pipe_path_for_app_data(Path::new(r"C:\Users\Ada\AppData\Roaming\Jean"));
        let two =
            super::windows_pipe_path_for_app_data(Path::new(r"C:\Users\Ada\AppData\Roaming\Jean"));
        let other = super::windows_pipe_path_for_app_data(Path::new(
            r"C:\Users\Ada\AppData\Roaming\JeanDev",
        ));

        assert_eq!(one, two);
        assert_ne!(one, other);
        assert!(one.to_string_lossy().starts_with(r"\\.\pipe\jean-mcp-"));
        assert!(!one.to_string_lossy().contains(':'));
    }
}
