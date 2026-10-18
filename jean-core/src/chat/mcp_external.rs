//! MCP servers a backend CLI loads that Jean cannot read from config files:
//! claude.ai connectors, Claude/Codex/Grok plugins, ChatGPT apps (`codex_apps`),
//! remote or managed config, and so on.
//!
//! Jean learns them from the CLI's own list command, caches them per backend
//! and worktree, and appends them to the config-file discovery in each
//! `<backend>_cli::mcp::get_mcp_servers`. Their `config` only holds
//! [`EXTERNAL_SERVER_MARKER`]: the CLI resolves them itself, so Jean must never
//! pass them as a server definition.

use crate::chat::{McpHealthStatus, McpServerInfo};
use crate::http_server::EmitExt;
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Config key that marks a server the backend CLI resolves itself.
pub const EXTERNAL_SERVER_MARKER: &str = "jeanExternal";

/// Minimum time between two background refreshes for one backend + worktree.
/// List commands start every MCP server, so keep this long. Explicit health
/// checks refresh the cache at once.
const REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// One MCP server as reported by a backend CLI.
#[derive(Clone, Debug, PartialEq)]
pub struct ExternalServer {
    pub name: String,
    /// URL or command, for display only.
    pub target: String,
    /// Where the server comes from ("plugin", "claude.ai", "cli", ...).
    pub scope: String,
    /// Health, when the list command reports it.
    pub status: Option<McpHealthStatus>,
}

impl ExternalServer {
    pub fn new(
        name: impl Into<String>,
        target: impl Into<String>,
        scope: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            target: target.into(),
            scope: scope.into(),
            status: None,
        }
    }
}

#[derive(Default)]
struct Entry {
    servers: Vec<ExternalServer>,
    fetched_at: Option<Instant>,
    refreshing: bool,
}

static CACHE: Lazy<Mutex<HashMap<(String, String), Entry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn key(backend: &str, worktree_path: Option<&str>) -> (String, String) {
    let path = worktree_path.unwrap_or("").trim_end_matches(['/', '\\']);
    (backend.to_string(), path.to_string())
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<(String, String), Entry>> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Backends with a list command Jean can read external servers from.
fn supports(backend: &str) -> bool {
    matches!(backend, "claude" | "codex" | "grok" | "cursor" | "opencode")
}

/// Store the servers a backend CLI reported. Tells clients to re-read MCP
/// servers when the list changed (health changes alone do not count).
pub fn store(
    app: &AppHandle,
    backend: &str,
    worktree_path: Option<&str>,
    servers: Vec<ExternalServer>,
) {
    let changed = {
        let mut cache = lock();
        let entry = cache.entry(key(backend, worktree_path)).or_default();
        entry.fetched_at = Some(Instant::now());
        let names = |list: &[ExternalServer]| -> Vec<(String, String, String)> {
            list.iter()
                .map(|s| (s.name.clone(), s.target.clone(), s.scope.clone()))
                .collect()
        };
        let changed = names(&entry.servers) != names(&servers);
        entry.servers = servers;
        changed
    };
    if changed {
        if let Err(e) = app.emit_all(
            "cache:invalidate",
            &serde_json::json!({ "keys": ["mcp-servers"] }),
        ) {
            log::error!("Failed to emit cache:invalidate for mcp-servers: {e}");
        }
    }
}

/// Append cached CLI servers that config-file discovery did not find.
pub fn append(backend: &str, worktree_path: Option<&str>, servers: &mut Vec<McpServerInfo>) {
    let cache = lock();
    let Some(entry) = cache.get(&key(backend, worktree_path)) else {
        return;
    };
    let mut seen: HashSet<String> = servers.iter().map(|s| s.name.clone()).collect();
    for server in &entry.servers {
        if seen.insert(server.name.clone()) {
            servers.push(McpServerInfo {
                name: server.name.clone(),
                config: serde_json::json!({
                    EXTERNAL_SERVER_MARKER: true,
                    "target": server.target,
                }),
                scope: server.scope.clone(),
                disabled: false,
                backend: backend.to_string(),
            });
        }
    }
}

/// Add cached health for servers the backend's health check did not report.
pub fn merge_statuses(
    backend: &str,
    worktree_path: Option<&str>,
    statuses: &mut HashMap<String, McpHealthStatus>,
) {
    let cache = lock();
    let Some(entry) = cache.get(&key(backend, worktree_path)) else {
        return;
    };
    for server in &entry.servers {
        if let Some(status) = &server.status {
            statuses
                .entry(server.name.clone())
                .or_insert_with(|| status.clone());
        }
    }
}

/// Refresh the cache in the background when it is older than [`REFRESH_INTERVAL`].
pub fn refresh_if_stale(app: &AppHandle, backend: &str, worktree_path: Option<String>) {
    if !supports(backend) {
        return;
    }
    {
        let mut cache = lock();
        let entry = cache
            .entry(key(backend, worktree_path.as_deref()))
            .or_default();
        let fresh = entry
            .fetched_at
            .is_some_and(|at| at.elapsed() < REFRESH_INTERVAL);
        if entry.refreshing || fresh {
            return;
        }
        entry.refreshing = true;
    }
    let app = app.clone();
    let backend = backend.to_string();
    std::thread::spawn(move || {
        let wt = worktree_path.as_deref();
        match fetch(&app, &backend, wt) {
            Ok(servers) => store(&app, &backend, wt, servers),
            Err(e) => {
                log::debug!("Could not list {backend} MCP servers from the CLI: {e}");
                // Wait for the next interval instead of retrying on every call.
                lock().entry(key(&backend, wt)).or_default().fetched_at = Some(Instant::now());
            }
        }
        lock().entry(key(&backend, wt)).or_default().refreshing = false;
    });
}

fn fetch(app: &AppHandle, backend: &str, wt: Option<&str>) -> Result<Vec<ExternalServer>, String> {
    let path = wt.map(std::path::Path::new);
    match backend {
        "claude" => Ok(crate::claude_cli::mcp::parse_external_servers(
            &crate::claude_cli::mcp::run_mcp_list(app, wt)?,
        )),
        "codex" => crate::codex_cli::mcp::list_app_server_servers(app, wt),
        "grok" => Ok(crate::grok_cli::mcp::parse_doctor_servers(
            &crate::grok_cli::mcp::run_doctor(app, path)?,
        )),
        "cursor" => Ok(crate::cursor_cli::mcp::servers_from_list_output(
            &crate::cursor_cli::mcp::run_mcp_list(app, path)?,
        )),
        "opencode" => Ok(crate::opencode_cli::mcp::parse_mcp_list_output(
            &crate::opencode_cli::mcp::run_mcp_list(app, wt)?,
        )),
        _ => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(name: &str) -> McpServerInfo {
        McpServerInfo {
            name: name.to_string(),
            config: serde_json::json!({ "command": "x" }),
            scope: "user".to_string(),
            disabled: false,
            backend: "test-append".to_string(),
        }
    }

    #[test]
    fn append_adds_only_servers_missing_from_config_for_that_worktree() {
        lock().insert(
            key("test-append", Some("/wt/a/")),
            Entry {
                servers: vec![
                    ExternalServer::new("config-server", "", "cli"),
                    ExternalServer::new("codex_apps", "https://chatgpt.com", "apps"),
                ],
                ..Default::default()
            },
        );

        let mut servers = vec![info("config-server")];
        append("test-append", Some("/wt/a"), &mut servers);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[1].name, "codex_apps");
        assert_eq!(servers[1].scope, "apps");
        assert_eq!(servers[1].config[EXTERNAL_SERVER_MARKER], true);

        let mut other = Vec::new();
        append("test-append", Some("/wt/b"), &mut other);
        assert!(other.is_empty());
    }
}
