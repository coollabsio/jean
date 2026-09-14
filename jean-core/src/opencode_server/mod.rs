use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

use crate::opencode_cli::resolve_cli_binary;

const DEFAULT_PORT: u16 = 4096;
const DEFAULT_HOSTNAME: &str = "127.0.0.1";
/// Keep a short ring of sanitized managed-server lines for startup failure messages.
const DIAGNOSTIC_RING_CAP: usize = 80;
const DIAGNOSTIC_LINE_MAX: usize = 400;

/// Number of active consumers (prompts) using the managed server.
/// Server is shut down only when this drops to 0.
static USAGE_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Cached AppHandle so stop/release paths can access app data dir without param changes.
static APP_HANDLE: once_cell::sync::OnceCell<AppHandle> = once_cell::sync::OnceCell::new();

/// Recent sanitized stdout/stderr lines from the Jean-managed OpenCode server.
/// Scoped to the current spawn generation — cleared before each new process.
static RECENT_DIAGNOSTICS: Lazy<Mutex<VecDeque<String>>> =
    Lazy::new(|| Mutex::new(VecDeque::with_capacity(DIAGNOSTIC_RING_CAP)));

/// Monotonic generation for managed-server diagnostics. Logger threads from a
/// prior process only append when their generation still matches, so a later
/// startup failure cannot report stale lines from an earlier server.
static DIAGNOSTIC_GENERATION: AtomicUsize = AtomicUsize::new(0);

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

/// Strip control characters, truncate, and redact obvious secret-looking tokens
/// before logging or surfacing managed OpenCode server output.
fn sanitize_diagnostic_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut cleaned: String = trimmed
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    // Collapse runs of whitespace introduced by control-char replacement.
    while cleaned.contains("  ") {
        cleaned = cleaned.replace("  ", " ");
    }
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return None;
    }
    let lowercase = cleaned.to_ascii_lowercase();
    let secret_start = [
        "sk-",
        "api_key",
        "apikey",
        "authorization:",
        "bearer ",
        "token=",
        "secret=",
    ]
    .iter()
    .filter_map(|needle| lowercase.find(needle))
    .min();
    let mut redacted = match secret_start {
        Some(idx) => format!("{prefix}[redacted]", prefix = &cleaned[..idx]),
        None => cleaned.to_string(),
    };
    // Truncate by Unicode scalar values so multi-byte UTF-8 never panics
    // on a mid-character boundary (String::truncate requires a char boundary).
    if redacted.chars().count() > DIAGNOSTIC_LINE_MAX {
        redacted = redacted.chars().take(DIAGNOSTIC_LINE_MAX).collect();
        redacted.push('…');
    }
    Some(redacted)
}

/// Clear the diagnostics ring and advance the generation so prior logger
/// threads cannot contaminate the next startup failure report.
fn begin_diagnostics_generation() -> usize {
    let next = DIAGNOSTIC_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut guard) = RECENT_DIAGNOSTICS.lock() {
        guard.clear();
    }
    next
}

fn push_diagnostic_line(stream: &str, line: &str, generation: usize) {
    let Some(sanitized) = sanitize_diagnostic_line(line) else {
        return;
    };
    log::info!("OpenCode managed server {stream}: {sanitized}");
    // Drop ring writes from a previous server generation (stale logger threads).
    if DIAGNOSTIC_GENERATION.load(Ordering::SeqCst) != generation {
        return;
    }
    if let Ok(mut guard) = RECENT_DIAGNOSTICS.lock() {
        // Re-check under the lock: a concurrent begin_diagnostics_generation()
        // may have advanced the generation and cleared the ring.
        if DIAGNOSTIC_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if guard.len() >= DIAGNOSTIC_RING_CAP {
            guard.pop_front();
        }
        guard.push_back(format!("[{stream}] {sanitized}"));
    }
}

/// Snapshot of recent sanitized managed-server output (for error messages / tests).
pub fn recent_managed_server_diagnostics() -> Vec<String> {
    RECENT_DIAGNOSTICS
        .lock()
        .map(|g| g.iter().cloned().collect())
        .unwrap_or_default()
}

fn diagnostics_summary_for_error() -> String {
    let lines = recent_managed_server_diagnostics();
    if lines.is_empty() {
        return "no managed-server output captured".to_string();
    }
    let tail: Vec<&str> = lines.iter().rev().take(12).map(String::as_str).collect();
    tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
}

fn spawn_stdio_logger(
    stream: &'static str,
    pipe: impl std::io::Read + Send + 'static,
    generation: usize,
) {
    let _ = std::thread::Builder::new()
        .name(format!("opencode-server-{stream}"))
        .spawn(move || {
            let reader = BufReader::new(pipe);
            for line in reader.lines() {
                match line {
                    Ok(l) => push_diagnostic_line(stream, &l, generation),
                    Err(e) => {
                        log::debug!("OpenCode managed server {stream} read ended: {e}");
                        break;
                    }
                }
            }
        });
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

    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), None);
    cmd.arg("serve")
        .arg("--hostname")
        .arg(&hostname)
        .arg("--port")
        .arg(port.to_string())
        // Capture output for diagnostics (startup failures, provider issues)
        // instead of discarding it to null.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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

    // Isolate diagnostics to this process so a later startup failure cannot
    // report output from an earlier managed server (or its dying logger threads).
    let diagnostics_generation = begin_diagnostics_generation();

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start OpenCode server: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        spawn_stdio_logger("stdout", stdout, diagnostics_generation);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_stdio_logger("stderr", stderr, diagnostics_generation);
    }

    let server_pid = child.id();
    *guard = Some(OpenCodeServerProcess {
        child,
        port,
        hostname: hostname.clone(),
    });

    // Write PID file so a future Jean instance can clean up if we crash.
    write_pid_file(server_pid, port);

    if !wait_until_healthy(&url, 50) {
        // Give logger threads a moment to flush a few lines after exit.
        std::thread::sleep(Duration::from_millis(150));
        let diag = diagnostics_summary_for_error();
        return Err(format!(
            "OpenCode server started but did not become healthy in time. Diagnostics: {diag}"
        ));
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
        let keep_warm = APP_HANDLE
            .get()
            .and_then(|app| crate::load_preferences_sync(app).ok())
            .map(|preferences| preferences.keep_ai_servers_warm)
            .unwrap_or(true);
        if !keep_warm {
            if let Err(e) = stop_managed_server_inner() {
                log::warn!("Failed to stop managed OpenCode server on last release: {e}");
            }
            return;
        }
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

pub async fn stop_opencode_server() -> Result<(), String> {
    let _ = stop_managed_server_inner()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialize tests that mutate the process-global diagnostics ring/generation.
    static DIAGNOSTICS_TEST_GUARD: Mutex<()> = Mutex::new(());

    #[test]
    fn sanitize_diagnostic_line_strips_control_and_truncates() {
        let line = format!("hello\x00world {}", "x".repeat(500));
        let cleaned = sanitize_diagnostic_line(&line).unwrap();
        assert!(!cleaned.contains('\0'));
        assert!(cleaned.chars().count() <= DIAGNOSTIC_LINE_MAX + 1); // + ellipsis
        assert!(cleaned.contains("hello"));
    }

    #[test]
    fn sanitize_diagnostic_line_truncates_non_ascii_without_panic() {
        // Multi-byte chars (each "日" is 3 bytes) would panic if truncate used a
        // raw byte index inside a UTF-8 sequence.
        let line = "日".repeat(DIAGNOSTIC_LINE_MAX + 50);
        let cleaned = sanitize_diagnostic_line(&line).unwrap();
        assert_eq!(cleaned.chars().count(), DIAGNOSTIC_LINE_MAX + 1);
        assert!(cleaned.ends_with('…'));
        assert!(cleaned.is_char_boundary(cleaned.len() - '…'.len_utf8()));
    }

    #[test]
    fn sanitize_diagnostic_line_redacts_secretish_tokens() {
        let secret = format!("sk-{}", "super-secret-token-value-".repeat(8));
        let cleaned =
            sanitize_diagnostic_line(&format!("request failed Authorization: Bearer {secret}"))
                .unwrap();
        assert!(cleaned.contains("[redacted]"), "got {cleaned}");
        assert!(cleaned.starts_with("request failed "), "got {cleaned}");
        assert!(
            !cleaned.contains(&secret) && !cleaned.contains("token-value"),
            "credential suffix leaked: {cleaned}"
        );
    }

    #[test]
    fn sanitize_diagnostic_line_redacts_long_query_credential_through_line_end() {
        let secret = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(8);
        let cleaned =
            sanitize_diagnostic_line(&format!("provider request failed: token={secret}")).unwrap();
        assert_eq!(cleaned, "provider request failed: [redacted]");
        assert!(
            !cleaned.contains(&secret[24..]),
            "credential suffix leaked: {cleaned}"
        );
    }

    #[test]
    fn push_diagnostic_line_is_retained_in_ring() {
        let _guard = DIAGNOSTICS_TEST_GUARD
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Exercise retention + eviction: overfill with uniquely identifiable lines.
        // Exact formatted strings avoid substring false-positives (e.g. "-1" in "-10").
        let generation = begin_diagnostics_generation();
        let prefix = format!("jean-diag-evict-{}", std::process::id());
        let overflow = 25;
        let total = DIAGNOSTIC_RING_CAP + overflow;
        let line = |i: usize| format!("[stderr] {prefix}-{i}");
        for i in 0..total {
            push_diagnostic_line("stderr", &format!("{prefix}-{i}"), generation);
        }

        let snapshot = recent_managed_server_diagnostics();
        assert_eq!(
            snapshot.len(),
            DIAGNOSTIC_RING_CAP,
            "ring should be capped at DIAGNOSTIC_RING_CAP, got {}",
            snapshot.len()
        );

        // Oldest entries must have been terminated (pop_front on overflow).
        for i in 0..overflow {
            let old = line(i);
            assert!(
                !snapshot.iter().any(|l| l == &old),
                "oldest entry still present after eviction: {old}"
            );
        }

        // Newest entries must remain, in FIFO order.
        let expected: Vec<String> = (overflow..total).map(line).collect();
        assert_eq!(
            snapshot, expected,
            "ring contents should be the newest DIAGNOSTIC_RING_CAP entries in order"
        );
    }

    #[test]
    fn begin_diagnostics_generation_clears_prior_lines() {
        let _guard = DIAGNOSTICS_TEST_GUARD
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let gen1 = begin_diagnostics_generation();
        let stale = format!("jean-stale-diag-{}", std::process::id());
        push_diagnostic_line("stderr", &stale, gen1);
        assert!(
            recent_managed_server_diagnostics()
                .iter()
                .any(|l| l.contains(&stale)),
            "precondition: stale line must be present before clear"
        );

        let gen2 = begin_diagnostics_generation();
        let snapshot_after_clear = recent_managed_server_diagnostics();
        assert!(
            snapshot_after_clear.is_empty(),
            "expected empty ring after new generation, got {snapshot_after_clear:?}"
        );
        // Stale-generation writes must not re-contaminate the ring.
        push_diagnostic_line("stderr", &stale, gen1);
        assert!(
            recent_managed_server_diagnostics().is_empty(),
            "stale generation must not append after clear"
        );

        let fresh = format!("jean-fresh-diag-{}", std::process::id());
        push_diagnostic_line("stderr", &fresh, gen2);
        let snapshot = recent_managed_server_diagnostics();
        assert!(
            snapshot.iter().any(|l| l.contains(&fresh)),
            "expected fresh marker in {snapshot:?}"
        );
        assert!(
            snapshot.iter().all(|l| !l.contains(&stale)),
            "stale marker must stay absent, got {snapshot:?}"
        );
    }
}

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
