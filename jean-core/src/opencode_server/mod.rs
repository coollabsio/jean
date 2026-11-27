use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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

/// Bumped on every `acquire_server`. An idle timer stands down when this changed
/// after it was scheduled, so only the latest release can stop the server.
static IDLE_EPOCH: AtomicUsize = AtomicUsize::new(0);

/// Idle grace period before an unused managed server is stopped.
static IDLE_TIMEOUT_MS: AtomicU64 = AtomicU64::new(600_000);

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
    /// `None` for a 2.x server adopted from an earlier Jean (`adopt_server`).
    child: Option<Child>,
    pid: u32,
    port: u16,
    hostname: String,
    api: OpenCodeApi,
    password: Option<String>,
}

/// HTTP API generation of an OpenCode server. OpenCode 2.x replaced the
/// 1.x API (bare paths) with a new API under `/api/*`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeApi {
    V1,
    V2,
}

/// A running OpenCode server that Jean can talk to.
#[derive(Clone, PartialEq, Eq)]
pub struct OpenCodeServer {
    pub url: String,
    pub api: OpenCodeApi,
    /// HTTP Basic password (user `opencode`). 2.x servers only.
    pub password: Option<String>,
}

impl std::fmt::Debug for OpenCodeServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenCodeServer")
            .field("url", &self.url)
            .field("api", &self.api)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// OpenCode 2.x reads the server password from this variable. Without it,
/// 2.x generates a random password and requires it on every `/api` call.
const SERVER_PASSWORD_ENV: &str = "OPENCODE_SERVER_PASSWORD";
pub const SERVER_USERNAME: &str = "opencode";

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

/// What answers on an OpenCode server URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerHealth {
    Healthy(OpenCodeApi),
    /// A 2.x server that rejects the password Jean has (or has none).
    Locked,
    /// A server answered, but not with a supported OpenCode API.
    Unsupported,
    /// No answer yet, or a server that is not healthy yet.
    Unreachable,
}

/// Classify `GET /global/health`. 1.x answers JSON; 2.x serves its web UI
/// HTML there, so a non-JSON answer needs the 2.x probe (`None`).
fn classify_v1_health(success: bool, body: &str) -> Option<ServerHealth> {
    if !success {
        return Some(ServerHealth::Unreachable);
    }
    match serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("healthy").and_then(serde_json::Value::as_bool))
    {
        Some(true) => Some(ServerHealth::Healthy(OpenCodeApi::V1)),
        Some(false) => Some(ServerHealth::Unreachable),
        None => None,
    }
}

/// Classify the 2.x `GET /api/info` answer (`{"version":"2.3.0",...}`).
fn classify_v2_info(status: u16, body: &str) -> ServerHealth {
    match status {
        200 => {
            let major = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("version")?.as_str().map(str::to_string))
                .and_then(|version| version_major(&version));
            if major == Some(2) {
                ServerHealth::Healthy(OpenCodeApi::V2)
            } else {
                ServerHealth::Unsupported
            }
        }
        401 => ServerHealth::Locked,
        _ => ServerHealth::Unsupported,
    }
}

fn version_major(version: &str) -> Option<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn probe_health(url: &str, password: Option<&str>) -> ServerHealth {
    let client = reqwest::blocking::Client::new();
    let Ok(response) = client
        .get(format!("{url}/global/health"))
        .timeout(Duration::from_millis(1200))
        .send()
    else {
        return ServerHealth::Unreachable;
    };
    let success = response.status().is_success();
    if let Some(health) = classify_v1_health(success, &response.text().unwrap_or_default()) {
        return health;
    }
    let mut request = client
        .get(format!("{url}/api/info"))
        .timeout(Duration::from_millis(1200));
    if let Some(password) = password {
        request = request.basic_auth(SERVER_USERNAME, Some(password));
    }
    match request.send() {
        Ok(response) => {
            let status = response.status().as_u16();
            classify_v2_info(status, &response.text().unwrap_or_default())
        }
        Err(_) => ServerHealth::Unreachable,
    }
}

/// Poll until the server answers with anything but `Unreachable`.
fn wait_for_server(url: &str, password: Option<&str>, attempts: u32) -> ServerHealth {
    for _ in 0..attempts {
        let health = probe_health(url, password);
        if health != ServerHealth::Unreachable {
            return health;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    ServerHealth::Unreachable
}

fn unsupported_server_error(url: &str) -> String {
    format!(
        "The OpenCode server at {url} does not serve a supported OpenCode API (1.x or 2.x). \
         Install a supported version in Settings > Backends > OpenCode > Change version."
    )
}

fn locked_server_error(url: &str) -> String {
    format!(
        "The OpenCode 2.x server at {url} requires a password. Stop it so Jean can start \
         its own server, or start Jean with {SERVER_PASSWORD_ENV} set to that server's password."
    )
}

fn unmanaged_server(url: &str) -> Result<Option<OpenCodeServer>, String> {
    let password = std::env::var(SERVER_PASSWORD_ENV).ok();
    match probe_health(url, password.as_deref()) {
        ServerHealth::Healthy(api) => Ok(Some(OpenCodeServer {
            url: url.to_string(),
            api,
            password: if api == OpenCodeApi::V2 {
                password
            } else {
                None
            },
        })),
        ServerHealth::Locked => Err(locked_server_error(url)),
        ServerHealth::Unsupported => Err(unsupported_server_error(url)),
        ServerHealth::Unreachable => Ok(None),
    }
}

/// Major version of the OpenCode CLI binary, from `opencode --version`
/// (`1.19.5` on 1.x, `opencode v2.3.0` on 2.x).
fn cli_major_version(cli_path: &std::path::Path) -> Option<u64> {
    let output = crate::platform::cli_command(&cli_path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    version_major(stdout.split_whitespace().last()?)
}

fn random_password() -> String {
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

// ---------------------------------------------------------------------------
// PID file for crash-recovery cleanup
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct ServerPidRecord {
    jean_pid: u32,
    server_pid: u32,
    port: u16,
    /// 2.x only: lets a later Jean adopt a server left running for
    /// unfinished turns. The file is readable by the user only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

fn pid_file_path() -> Option<PathBuf> {
    APP_HANDLE
        .get()
        .and_then(|app| app.path().app_data_dir().ok())
        .map(|d| d.join("opencode-server.pid"))
}

fn write_pid_file(server_pid: u32, port: u16, password: Option<&str>) {
    let Some(path) = pid_file_path() else { return };
    let record = ServerPidRecord {
        jean_pid: std::process::id(),
        server_pid,
        port,
        password: password.map(str::to_string),
    };
    let Ok(json) = serde_json::to_string(&record) else {
        return;
    };
    // Remove first: `mode` applies only to a new file, and an older file
    // can have wider permissions.
    let _ = fs::remove_file(&path);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Err(e) = options
        .open(&path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, json.as_bytes()))
    {
        log::warn!("Failed to write {}: {e}", path.display());
    }
}

fn read_pid_file(path: &std::path::Path) -> Option<ServerPidRecord> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Take over a 2.x server that an earlier Jean left running for unfinished
/// turns (`shutdown_managed_server`, `cleanup_orphaned_server`).
fn adopt_server(port: u16) -> Option<OpenCodeServerProcess> {
    let record = read_pid_file(&pid_file_path()?)?;
    let password = record.password?;
    if record.port != port || !crate::platform::is_process_alive(record.server_pid) {
        return None;
    }
    let url = server_url(DEFAULT_HOSTNAME, port);
    if probe_health(&url, Some(&password)) != ServerHealth::Healthy(OpenCodeApi::V2) {
        return None;
    }
    log::info!(
        "Adopted the OpenCode 2.x server (PID {}) left running for unfinished turns",
        record.server_pid
    );
    write_pid_file(record.server_pid, port, Some(&password));
    Some(OpenCodeServerProcess {
        child: None,
        pid: record.server_pid,
        port,
        hostname: DEFAULT_HOSTNAME.to_string(),
        api: OpenCodeApi::V2,
        password: Some(password),
    })
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

    // A 2.x server kept for unfinished turns: leave it for `adopt_server`.
    let url = server_url(DEFAULT_HOSTNAME, record.port);
    if let Some(password) = record.password.as_deref() {
        if crate::platform::is_process_alive(record.server_pid)
            && probe_health(&url, Some(password)) == ServerHealth::Healthy(OpenCodeApi::V2)
            && crate::chat::run_log::has_incomplete_opencode_turns(app)
        {
            log::info!(
                "[OPENCODE CLEANUP] Keeping OpenCode 2.x server (PID {}) for unfinished turns",
                record.server_pid
            );
            return;
        }
    }

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
    let responds = |url: &str| {
        matches!(
            probe_health(url, None),
            ServerHealth::Healthy(_) | ServerHealth::Locked
        )
    };
    if crate::platform::is_process_alive(record.server_pid) && responds(&url) {
        log::info!(
            "[OPENCODE CLEANUP] Killing orphaned OpenCode server (PID {}) from crashed Jean (PID {})",
            record.server_pid,
            record.jean_pid
        );
        let _ = crate::platform::kill_process_tree(record.server_pid);
        std::thread::sleep(Duration::from_millis(300));
        // Verify kill succeeded
        if responds(&url) {
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

/// Output of a managed 2.x server (in the app data directory).
const SERVER_LOG_FILE: &str = "opencode-server.log";

const CONFIG_CONTENT_ENV: &str = "OPENCODE_CONFIG_CONTENT";

/// Inline OpenCode config that sets `compaction.auto`, merged into an
/// inherited `OPENCODE_CONFIG_CONTENT` object. `None` when nothing changes.
fn config_content_with_auto_compact(inherited: Option<&str>, auto: Option<bool>) -> Option<String> {
    let auto = auto?;
    let mut config = inherited
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    if !config["compaction"].is_object() {
        config["compaction"] = serde_json::json!({});
    }
    config["compaction"]["auto"] = serde_json::json!(auto);
    Some(config.to_string())
}

impl OpenCodeServerProcess {
    fn is_alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => crate::platform::is_process_alive(self.pid),
        }
    }
}

fn managed_server(proc_info: &OpenCodeServerProcess) -> OpenCodeServer {
    OpenCodeServer {
        url: server_url(&proc_info.hostname, proc_info.port),
        api: proc_info.api,
        password: proc_info.password.clone(),
    }
}

pub fn ensure_running(app: &AppHandle) -> Result<OpenCodeServer, String> {
    // Cache the AppHandle for stop/release paths that don't have it.
    let _ = APP_HANDLE.set(app.clone());
    let hostname = DEFAULT_HOSTNAME.to_string();
    let port = DEFAULT_PORT;
    let url = server_url(&hostname, port);

    let mut guard = OPENCODE_SERVER
        .lock()
        .map_err(|e| format!("OpenCode server lock error: {e}"))?;

    // If we manage a process and it's still alive, return it. Check it before
    // the port probe: only the managed record knows a 2.x server's password.
    if let Some(proc_info) = guard.as_mut() {
        if proc_info.is_alive() {
            let server = managed_server(proc_info);
            let health = wait_for_server(&server.url, server.password.as_deref(), 5);
            if health == ServerHealth::Healthy(server.api) {
                return Ok(server);
            }
        } else {
            *guard = None;
        }
    }

    // Take over a 2.x server an earlier Jean left running for unfinished
    // turns, else use an unmanaged server that is already running.
    if guard.is_none() {
        if let Some(proc_info) = adopt_server(port) {
            let server = managed_server(&proc_info);
            *guard = Some(proc_info);
            return Ok(server);
        }
        if let Some(server) = unmanaged_server(&url)? {
            return Ok(server);
        }
    }

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err(format!(
            "OpenCode CLI not found at {}. Install it in Settings > General.",
            cli_path.display()
        ));
    }

    let (api, password) = match cli_major_version(&cli_path) {
        Some(2) => (OpenCodeApi::V2, Some(random_password())),
        Some(major) if major > 2 => return Err(unsupported_server_error(&url)),
        _ => (OpenCodeApi::V1, None),
    };

    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), None);
    cmd.arg("serve")
        .arg("--hostname")
        .arg(&hostname)
        .arg("--port")
        .arg(port.to_string())
        // User flags such as `--pure` (issue #335). The server is shared, so a
        // changed value applies from the next server start.
        .args(crate::chat::extra_args::extra_args_for(
            app,
            &crate::chat::types::Backend::Opencode,
            &[
                "serve".to_string(),
                "--hostname".to_string(),
                "--port".to_string(),
            ],
        )?)
        // Capture output for diagnostics (startup failures, provider issues)
        // instead of discarding it to null.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A 2.x server can outlive Jean for unfinished turns. Pipes would break
    // when Jean exits, so its output goes to a log file.
    let log_path = (api == OpenCodeApi::V2)
        .then(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|d| d.join(SERVER_LOG_FILE))
        })
        .flatten();
    if let Some(path) = &log_path {
        let log = fs::File::create(path)
            .map_err(|e| format!("Failed to create {}: {e}", path.display()))?;
        let log_err = log
            .try_clone()
            .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
        cmd.stdout(log).stderr(log_err);
    }

    // The server is shared and stops when idle, so a changed value applies
    // from the next server start.
    let auto_compact = crate::load_preferences_sync(app)
        .ok()
        .and_then(|p| p.opencode_auto_compact);
    if let Some(content) = config_content_with_auto_compact(
        std::env::var(CONFIG_CONTENT_ENV).ok().as_deref(),
        auto_compact,
    ) {
        cmd.env(CONFIG_CONTENT_ENV, content);
    }
    if let Some(password) = &password {
        cmd.env(SERVER_PASSWORD_ENV, password);
    }

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
        child: Some(child),
        pid: server_pid,
        port,
        hostname: hostname.clone(),
        api,
        password: password.clone(),
    });

    // Write PID file so a future Jean instance can clean up if we crash.
    write_pid_file(server_pid, port, password.as_deref());

    match wait_for_server(&url, password.as_deref(), 50) {
        ServerHealth::Healthy(answered) if answered == api => {}
        ServerHealth::Healthy(_) | ServerHealth::Locked | ServerHealth::Unsupported => {
            stop_managed_server_locked(&mut guard);
            return Err(unsupported_server_error(&url));
        }
        ServerHealth::Unreachable => {
            // Give logger threads a moment to flush a few lines after exit.
            std::thread::sleep(Duration::from_millis(150));
            if let Some(output) = log_path.and_then(|path| fs::read_to_string(path).ok()) {
                output
                    .lines()
                    .for_each(|line| push_diagnostic_line("log", line, diagnostics_generation));
            }
            let diag = diagnostics_summary_for_error();
            return Err(format!(
                "OpenCode server started but did not become healthy in time. Diagnostics: {diag}"
            ));
        }
    }

    Ok(OpenCodeServer { url, api, password })
}

/// Increment usage count and ensure the server is running.
/// Each `acquire_server` must be paired with a `release` when the caller is done.
pub fn acquire_server(app: &AppHandle) -> Result<OpenCodeServer, String> {
    begin_usage();
    match ensure_running(app) {
        Ok(server) => Ok(server),
        Err(e) => {
            // Roll back on failure so we don't leave a phantom user. Re-arm the
            // idle timer: the epoch bump above disarmed any earlier one.
            if USAGE_COUNT.fetch_sub(1, Ordering::SeqCst) == 1 {
                schedule_idle_stop();
            }
            Err(e)
        }
    }
}

fn begin_usage() {
    IDLE_EPOCH.fetch_add(1, Ordering::SeqCst);
    USAGE_COUNT.fetch_add(1, Ordering::SeqCst);
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
            stop_if_idle(IDLE_EPOCH.load(Ordering::SeqCst));
            return;
        }
        schedule_idle_stop();
    }
}

/// Stop the server after the grace period unless it was acquired meanwhile.
fn schedule_idle_stop() {
    let epoch = IDLE_EPOCH.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(
            IDLE_TIMEOUT_MS.load(Ordering::SeqCst),
        ));
        stop_if_idle(epoch);
    });
}

/// Stop the managed server if nothing acquired it since `epoch`. Checked under
/// the `OPENCODE_SERVER` lock (also taken by `ensure_running`), so a concurrent
/// `acquire_server` either stands this down or respawns after the stop. Returns
/// whether the server was stopped.
fn stop_if_idle(epoch: usize) -> bool {
    let mut guard = match OPENCODE_SERVER.lock() {
        Ok(guard) => guard,
        Err(e) => {
            log::warn!("OpenCode server lock error: {e}");
            return false;
        }
    };
    if USAGE_COUNT.load(Ordering::SeqCst) != 0 || IDLE_EPOCH.load(Ordering::SeqCst) != epoch {
        return false;
    }
    stop_managed_server_locked(&mut guard)
}

fn stop_managed_server_inner() -> Result<bool, String> {
    let mut guard = OPENCODE_SERVER
        .lock()
        .map_err(|e| format!("OpenCode server lock error: {e}"))?;
    Ok(stop_managed_server_locked(&mut guard))
}

fn stop_managed_server_locked(
    guard: &mut std::sync::MutexGuard<'_, Option<OpenCodeServerProcess>>,
) -> bool {
    let Some(proc_info) = guard.as_mut() else {
        return false;
    };

    let _ = crate::platform::kill_process_tree(proc_info.pid);
    // Fallback direct child kill in case tree-kill is unsupported/fails.
    if let Some(child) = proc_info.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    **guard = None;
    remove_pid_file();
    true
}

/// Get the current server without incrementing the usage count.
/// Returns `None` if no server is running (managed or unmanaged).
pub fn current_server() -> Option<OpenCodeServer> {
    if let Ok(mut guard) = OPENCODE_SERVER.lock() {
        if let Some(proc) = guard.as_mut() {
            if proc.is_alive() {
                return Some(managed_server(proc));
            }
        }
    }
    unmanaged_server(&server_url(DEFAULT_HOSTNAME, DEFAULT_PORT))
        .ok()
        .flatten()
}

/// Stop Jean-managed OpenCode server process during app lifecycle shutdown.
/// A 2.x server with unfinished turns keeps running on Unix; the next Jean
/// adopts it from the PID file and re-attaches to the turns.
pub fn shutdown_managed_server() -> Result<bool, String> {
    let mut guard = OPENCODE_SERVER
        .lock()
        .map_err(|e| format!("OpenCode server lock error: {e}"))?;
    let keep = cfg!(unix)
        && guard
            .as_ref()
            .is_some_and(|proc_info| proc_info.api == OpenCodeApi::V2)
        && APP_HANDLE
            .get()
            .is_some_and(crate::chat::run_log::has_incomplete_opencode_turns);
    if keep {
        log::info!("Keeping the OpenCode 2.x server running for unfinished turns");
        // Dropping the record does not stop the process.
        *guard = None;
        return Ok(false);
    }
    Ok(stop_managed_server_locked(&mut guard))
}

pub async fn start_opencode_server(app: AppHandle) -> Result<OpenCodeServerStatus, String> {
    let server = ensure_running(&app)?;
    Ok(OpenCodeServerStatus {
        running: true,
        url: Some(server.url),
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

    #[test]
    fn pid_records_without_a_password_still_parse() {
        let old: ServerPidRecord =
            serde_json::from_str(r#"{"jean_pid":1,"server_pid":2,"port":4096}"#).unwrap();
        assert_eq!(old.password, None);
        let record = ServerPidRecord {
            jean_pid: 1,
            server_pid: 2,
            port: 4096,
            password: Some("pw".to_string()),
        };
        let round: ServerPidRecord =
            serde_json::from_str(&serde_json::to_string(&record).unwrap()).unwrap();
        assert_eq!(round.password.as_deref(), Some("pw"));
    }

    #[test]
    fn health_probe_tells_v1_from_v2_servers() {
        assert_eq!(
            classify_v1_health(true, r#"{"healthy":true,"version":"1.19.5"}"#),
            Some(ServerHealth::Healthy(OpenCodeApi::V1))
        );
        assert_eq!(
            classify_v1_health(true, r#"{"healthy":false}"#),
            Some(ServerHealth::Unreachable)
        );
        assert_eq!(
            classify_v1_health(false, ""),
            Some(ServerHealth::Unreachable)
        );
        // OpenCode 2.x serves web UI HTML on /global/health.
        assert_eq!(classify_v1_health(true, "<!doctype html><html>"), None);

        assert_eq!(
            classify_v2_info(200, r#"{"version":"2.3.0","pid":1}"#),
            ServerHealth::Healthy(OpenCodeApi::V2)
        );
        assert_eq!(
            classify_v2_info(200, r#"{"version":"3.0.0"}"#),
            ServerHealth::Unsupported
        );
        assert_eq!(
            classify_v2_info(200, "<!doctype html>"),
            ServerHealth::Unsupported
        );
        assert_eq!(
            classify_v2_info(401, r#"{"_tag":"UnauthorizedError"}"#),
            ServerHealth::Locked
        );
    }

    #[test]
    fn version_major_reads_both_cli_formats() {
        assert_eq!(version_major("1.19.5"), Some(1));
        assert_eq!(version_major("v2.3.0"), Some(2));
        assert_eq!(version_major("garbage"), None);
    }

    #[test]
    fn auto_compact_merges_into_inherited_config() {
        assert_eq!(config_content_with_auto_compact(Some("{}"), None), None);

        let fresh: serde_json::Value =
            serde_json::from_str(&config_content_with_auto_compact(None, Some(false)).unwrap())
                .unwrap();
        assert_eq!(
            fresh,
            serde_json::json!({ "compaction": { "auto": false } })
        );

        let merged: serde_json::Value = serde_json::from_str(
            &config_content_with_auto_compact(
                Some(r#"{"model":"x/y","compaction":{"buffer":"15%"}}"#),
                Some(true),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(merged["model"], "x/y");
        assert_eq!(merged["compaction"]["buffer"], "15%");
        assert_eq!(merged["compaction"]["auto"], true);
    }

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

    #[cfg(unix)]
    #[test]
    fn idle_timer_is_superseded_by_later_usage() {
        if !crate::test_support::in_isolated_process(
            "opencode_server::tests::idle_timer_is_superseded_by_later_usage",
        ) {
            return;
        }
        let child = crate::platform::silent_command("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        *OPENCODE_SERVER.lock().unwrap() = Some(OpenCodeServerProcess {
            pid: child.id(),
            child: Some(child),
            port: DEFAULT_PORT,
            hostname: DEFAULT_HOSTNAME.to_string(),
            api: OpenCodeApi::V1,
            password: None,
        });
        IDLE_TIMEOUT_MS.store(1_000, Ordering::SeqCst);
        let running = || OPENCODE_SERVER.lock().unwrap().is_some();

        begin_usage();
        release(); // timer A due at ~1000ms
        std::thread::sleep(Duration::from_millis(600));
        begin_usage();
        release(); // timer B due at ~1600ms

        std::thread::sleep(Duration::from_millis(700)); // ~1300ms: past timer A only
        assert!(running(), "stale timer must not stop the server");

        std::thread::sleep(Duration::from_millis(1_000)); // ~2300ms: past timer B
        assert!(!running(), "latest timer stops the idle server");
    }

    #[cfg(unix)]
    #[test]
    fn idle_stop_stands_down_when_acquired_before_the_check() {
        if !crate::test_support::in_isolated_process(
            "opencode_server::tests::idle_stop_stands_down_when_acquired_before_the_check",
        ) {
            return;
        }
        let child = crate::platform::silent_command("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        *OPENCODE_SERVER.lock().unwrap() = Some(OpenCodeServerProcess {
            pid: child.id(),
            child: Some(child),
            port: DEFAULT_PORT,
            hostname: DEFAULT_HOSTNAME.to_string(),
            api: OpenCodeApi::V1,
            password: None,
        });
        let epoch = IDLE_EPOCH.load(Ordering::SeqCst);

        begin_usage();
        assert!(!stop_if_idle(epoch), "in-use server must not be stopped");
        USAGE_COUNT.fetch_sub(1, Ordering::SeqCst);
        assert!(
            !stop_if_idle(epoch),
            "usage after the timer was armed supersedes it"
        );
        assert!(stop_if_idle(IDLE_EPOCH.load(Ordering::SeqCst)));
        assert!(OPENCODE_SERVER.lock().unwrap().is_none());
    }
}

pub async fn get_opencode_server_status() -> Result<OpenCodeServerStatus, String> {
    let mut managed_running = false;
    {
        let mut guard = OPENCODE_SERVER
            .lock()
            .map_err(|e| format!("OpenCode server lock error: {e}"))?;

        if let Some(proc_info) = guard.as_mut() {
            managed_running = proc_info.is_alive();
            if !managed_running {
                *guard = None;
            }
        }
    }

    let url = server_url(DEFAULT_HOSTNAME, DEFAULT_PORT);
    let healthy = managed_running || matches!(unmanaged_server(&url), Ok(Some(_)));

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
