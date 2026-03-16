use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::opencode_cli::resolve_cli_binary;
use crate::platform::silent_command;

const DEFAULT_PORT: u16 = 4096;
const DEFAULT_HOSTNAME: &str = "127.0.0.1";

/// Number of active consumers (prompts) using the managed server.
/// Server is shut down only when this drops to 0.
static USAGE_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Cached AppHandle so stop/release paths can access app data dir without param changes.
static APP_HANDLE: once_cell::sync::OnceCell<AppHandle> = once_cell::sync::OnceCell::new();

#[derive(Debug)]
struct OpenCodeServerProcess {
    child: Child,
    port: u16,
    hostname: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenCodeServerStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub hostname: Option<String>,
    pub managed: bool,
}

static OPENCODE_SERVER: Lazy<Mutex<Option<OpenCodeServerProcess>>> = Lazy::new(|| Mutex::new(None));

fn server_url(hostname: &str, port: u16) -> String {
    format!("http://{hostname}:{port}")
}

fn is_healthy(url: &str) -> bool {
    let health_url = format!("{url}/global/health");
    reqwest::blocking::Client::new()
        .get(health_url)
        .timeout(Duration::from_millis(1200))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn wait_until_healthy(url: &str, attempts: u32) -> bool {
    for _ in 0..attempts {
        if is_healthy(url) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

// ---------------------------------------------------------------------------
// PID file for crash-recovery cleanup
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct ServerPidRecord {
    jean_pid: u32,
    server_pid: u32,
    port: u16,
}

fn pid_file_path() -> Option<PathBuf> {
    APP_HANDLE
        .get()
        .and_then(|app| app.path().app_data_dir().ok())
        .map(|d| d.join("opencode-server.pid"))
}

fn write_pid_file(server_pid: u32, port: u16) {
    let Some(path) = pid_file_path() else { return };
    let record = ServerPidRecord {
        jean_pid: std::process::id(),
        server_pid,
        port,
    };
    if let Ok(json) = serde_json::to_string(&record) {
        let _ = fs::write(&path, json);
    }
}

fn remove_pid_file() {
    if let Some(path) = pid_file_path() {
        let _ = fs::remove_file(path);
    }
}

/// Kill an orphaned OpenCode server left behind by a previous Jean crash.
/// Call once at app startup, before any `ensure_running()`.
pub fn cleanup_orphaned_server(app: &AppHandle) {
    // Seed the OnceCell early so pid_file_path() works.
    let _ = APP_HANDLE.set(app.clone());

    let path = match app.path().app_data_dir() {
        Ok(d) => d.join("opencode-server.pid"),
        Err(_) => return,
    };

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return, // No PID file → nothing to clean up
    };

    let record: ServerPidRecord = match serde_json::from_str(&content) {
        Ok(r) => r,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return;
        }
    };

    // If the Jean instance that spawned the server is still alive, leave it alone.
    if crate::platform::is_process_alive(record.jean_pid) {
        log::debug!(
            "[OPENCODE CLEANUP] PID file exists but Jean PID {} is still alive — another instance owns the server",
            record.jean_pid
        );
        return;
    }

    // Jean is dead. Check if the server is still running AND healthy on our port
    // (health check guards against PID recycling — an unrelated process won't respond).
    let url = server_url(DEFAULT_HOSTNAME, record.port);
    if crate::platform::is_process_alive(record.server_pid) && is_healthy(&url) {
        log::info!(
            "[OPENCODE CLEANUP] Killing orphaned OpenCode server (PID {}) from crashed Jean (PID {})",
            record.server_pid,
            record.jean_pid
        );
        let _ = crate::platform::kill_process_tree(record.server_pid);
        std::thread::sleep(Duration::from_millis(300));
        // Verify kill succeeded
        if is_healthy(&url) {
            log::warn!(
                "[OPENCODE CLEANUP] Server still healthy after tree kill, trying direct kill"
            );
            let _ = crate::platform::kill_process(record.server_pid);
        }
    } else {
        log::debug!(
            "[OPENCODE CLEANUP] Stale PID file (server PID {} not alive or not healthy), cleaning up",
            record.server_pid
        );
    }

    let _ = fs::remove_file(&path);
}

pub fn ensure_running(app: &AppHandle) -> Result<String, String> {
    // Cache the AppHandle for stop/release paths that don't have it.
    let _ = APP_HANDLE.set(app.clone());
    let hostname = DEFAULT_HOSTNAME.to_string();
    let port = DEFAULT_PORT;
    let url = server_url(&hostname, port);

    // If an unmanaged server is already running, use it.
    if is_healthy(&url) {
        return Ok(url);
    }

    let mut guard = OPENCODE_SERVER
        .lock()
        .map_err(|e| format!("OpenCode server lock error: {e}"))?;

    // If we manage a process and it's still alive, return it.
    if let Some(proc_info) = guard.as_mut() {
        match proc_info.child.try_wait() {
            Ok(None) => {
                let running_url = server_url(&proc_info.hostname, proc_info.port);
                if wait_until_healthy(&running_url, 5) {
                    return Ok(running_url);
                }
            }
            Ok(Some(_)) | Err(_) => {
                *guard = None;
            }
        }
    }

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err(format!(
            "OpenCode CLI not found at {}. Install it in Settings > General.",
            cli_path.display()
        ));
    }

    let mut cmd = silent_command(&cli_path);
    cmd.arg("serve")
        .arg("--hostname")
        .arg(&hostname)
        .arg("--port")
        .arg(port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Start in its own process group so we can terminate the full tree.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // silent_command sets CREATE_NO_WINDOW, but creation_flags replaces it.
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start OpenCode server: {e}"))?;

    let server_pid = child.id();
    *guard = Some(OpenCodeServerProcess {
        child,
        port,
        hostname: hostname.clone(),
    });

    // Write PID file so a future Jean instance can clean up if we crash.
    write_pid_file(server_pid, port);

    if !wait_until_healthy(&url, 50) {
        return Err("OpenCode server started but did not become healthy in time".to_string());
    }

    Ok(url)
}

/// Increment usage count and ensure the server is running. Returns the base URL.
/// Each `acquire` must be paired with a `release` when the caller is done.
pub fn acquire(app: &AppHandle) -> Result<String, String> {
    USAGE_COUNT.fetch_add(1, Ordering::SeqCst);
    match ensure_running(app) {
        Ok(url) => Ok(url),
        Err(e) => {
            // Roll back on failure so we don't leave a phantom user.
            USAGE_COUNT.fetch_sub(1, Ordering::SeqCst);
            Err(e)
        }
    }
}

/// Decrement usage count. If this was the last user, schedule a delayed shutdown.
/// The delay prevents killing the server during the brief window between sequential
/// operations (e.g., naming finishes just before chat sends its next request).
pub fn release() {
    let prev = USAGE_COUNT.fetch_sub(1, Ordering::SeqCst);
    if prev == 1 {
        // Schedule delayed shutdown — if no one re-acquires within 10min, stop the server.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(600));
            if USAGE_COUNT.load(Ordering::SeqCst) == 0 {
                if let Err(e) = stop_managed_server_inner() {
                    log::warn!("Failed to stop managed OpenCode server on last release: {e}");
                }
            }
        });
    }
}

fn stop_managed_server_inner() -> Result<bool, String> {
    let mut guard = OPENCODE_SERVER
        .lock()
        .map_err(|e| format!("OpenCode server lock error: {e}"))?;

    let Some(proc_info) = guard.as_mut() else {
        return Ok(false);
    };

    let pid = proc_info.child.id();
    let _ = crate::platform::kill_process_tree(pid);
    // Fallback direct child kill in case tree-kill is unsupported/fails.
    let _ = proc_info.child.kill();
    let _ = proc_info.child.wait();
    *guard = None;
    remove_pid_file();
    Ok(true)
}

/// Get the current server URL without incrementing the usage count.
/// Returns `None` if no server is running (managed or unmanaged).
pub fn get_current_url() -> Option<String> {
    let url = server_url(DEFAULT_HOSTNAME, DEFAULT_PORT);

    // Check managed process first
    if let Ok(mut guard) = OPENCODE_SERVER.lock() {
        if let Some(proc) = guard.as_mut() {
            if matches!(proc.child.try_wait(), Ok(None)) {
                return Some(server_url(&proc.hostname, proc.port));
            }
        }
    }

    // Fall back to checking if an unmanaged server is healthy on the default port
    if is_healthy(&url) {
        return Some(url);
    }

    None
}

/// Stop Jean-managed OpenCode server process during app lifecycle shutdown.
pub fn shutdown_managed_server() -> Result<bool, String> {
    stop_managed_server_inner()
}

#[tauri::command]
pub async fn start_opencode_server(app: AppHandle) -> Result<OpenCodeServerStatus, String> {
    let url = ensure_running(&app)?;
    Ok(OpenCodeServerStatus {
        running: true,
        url: Some(url),
        port: Some(DEFAULT_PORT),
        hostname: Some(DEFAULT_HOSTNAME.to_string()),
        managed: true,
    })
}

#[tauri::command]
pub async fn stop_opencode_server() -> Result<(), String> {
    let _ = stop_managed_server_inner()?;
    Ok(())
}

#[tauri::command]
pub async fn get_opencode_server_status() -> Result<OpenCodeServerStatus, String> {
    let mut managed_running = false;
    {
        let mut guard = OPENCODE_SERVER
            .lock()
            .map_err(|e| format!("OpenCode server lock error: {e}"))?;

        if let Some(proc_info) = guard.as_mut() {
            managed_running = matches!(proc_info.child.try_wait(), Ok(None));
            if !managed_running {
                *guard = None;
            }
        }
    }

    let url = server_url(DEFAULT_HOSTNAME, DEFAULT_PORT);
    let healthy = is_healthy(&url);

    Ok(OpenCodeServerStatus {
        running: managed_running || healthy,
        url: if managed_running || healthy {
            Some(url)
        } else {
            None
        },
        port: if managed_running || healthy {
            Some(DEFAULT_PORT)
        } else {
            None
        },
        hostname: if managed_running || healthy {
            Some(DEFAULT_HOSTNAME.to_string())
        } else {
            None
        },
        managed: managed_running,
    })
}
