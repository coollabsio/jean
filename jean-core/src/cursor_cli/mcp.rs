//! MCP server discovery + approval syncing for Cursor CLI.
//!
//! Reads:
//! - Project scope: <worktree_path>/.cursor/mcp.json → `mcpServers`
//! - User scope:    ~/.cursor/mcp.json              → `mcpServers`

use crate::chat::{McpHealthStatus, McpServerInfo};
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

static WORKSPACE_MCP_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Discover Cursor MCP servers from all configuration sources.
/// Precedence (highest to lowest): project → user.
pub fn get_mcp_servers(worktree_path: Option<&str>) -> Vec<McpServerInfo> {
    let mut servers = Vec::new();
    let mut seen_names = HashSet::new();

    if let Some(wt_path) = worktree_path {
        let project_config = PathBuf::from(wt_path).join(".cursor").join("mcp.json");
        collect_from_json(&project_config, "project", &mut servers, &mut seen_names);
    }

    if let Some(home) = dirs::home_dir() {
        let user_config = home.join(".cursor").join("mcp.json");
        collect_from_json(&user_config, "user", &mut servers, &mut seen_names);
    }

    servers
}

pub fn parse_cursor_mcp_list_output(output: &str) -> HashMap<String, McpHealthStatus> {
    let mut statuses = HashMap::new();

    for line in strip_ansi(output).lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("Loading MCP") {
            continue;
        }

        let Some((name, status_raw)) = line.split_once(':') else {
            continue;
        };
        let status_raw = status_raw.trim().to_lowercase();
        let status = if status_raw.contains("disabled")
            || status_raw.contains("needs approval")
            || status_raw.contains("not loaded")
        {
            McpHealthStatus::Disabled
        } else if status_raw.contains("connected") || status_raw.contains("loaded") {
            McpHealthStatus::Connected
        } else if status_raw.contains("needs authentication")
            || status_raw.contains("not authenticated")
            || status_raw.contains("auth required")
        {
            McpHealthStatus::NeedsAuthentication
        } else if status_raw.contains("could not connect")
            || status_raw.contains("connection failed")
            || status_raw.contains("failed")
            || status_raw.contains("error")
        {
            McpHealthStatus::CouldNotConnect
        } else {
            McpHealthStatus::Unknown
        };

        statuses.insert(name.trim().to_string(), status);
    }

    statuses
}

pub fn check_mcp_health(
    app: &AppHandle,
    worktree_path: Option<&Path>,
) -> Result<HashMap<String, McpHealthStatus>, String> {
    let cli_path = super::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Cursor CLI not installed".to_string());
    }

    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), None);
    cmd.args(["mcp", "list"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = worktree_path {
        cmd.current_dir(path);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run Cursor MCP list: {e}"))?;

    if !output.status.success() {
        let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
        return Err(format!("Cursor MCP list failed: {}", stderr.trim()));
    }

    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(parse_cursor_mcp_list_output(&combined))
}

pub fn sync_cursor_mcp_approvals(
    app: &AppHandle,
    worktree_path: &Path,
    desired_enabled_names: &HashSet<String>,
) -> Result<(), String> {
    let workspace_lock = workspace_lock(worktree_path)?;
    let _guard = workspace_lock
        .lock()
        .map_err(|_| "Failed to acquire Cursor MCP workspace lock".to_string())?;
    let configured_servers = get_mcp_servers(worktree_path.to_str());
    if configured_servers.is_empty() {
        return Ok(());
    }

    let current_statuses = check_mcp_health(app, Some(worktree_path)).unwrap_or_default();
    for server in configured_servers {
        let should_enable = desired_enabled_names.contains(&server.name) && !server.disabled;
        let currently_enabled = current_statuses
            .get(&server.name)
            .map(is_status_effectively_enabled)
            .unwrap_or(false);

        if should_enable == currently_enabled {
            continue;
        }

        if should_enable {
            run_mcp_approval_command(app, worktree_path, "enable", &server.name)?;
        } else {
            run_mcp_approval_command(app, worktree_path, "disable", &server.name)?;
        }
    }

    Ok(())
}

fn collect_from_json(
    path: &Path,
    scope: &str,
    servers: &mut Vec<McpServerInfo>,
    seen_names: &mut HashSet<String>,
) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        log::warn!("Failed to parse Cursor MCP config at {}", path.display());
        return;
    };

    let source = json
        .get("mcpServers")
        .and_then(|value| value.as_object())
        .or_else(|| json.as_object());

    let Some(source) = source else {
        return;
    };

    for (name, config) in source {
        if seen_names.insert(name.clone()) {
            let disabled = config
                .get("disabled")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            servers.push(McpServerInfo {
                name: name.clone(),
                config: config.clone(),
                scope: scope.to_string(),
                disabled,
                backend: "cursor".to_string(),
            });
        }
    }
}

fn run_mcp_approval_command(
    app: &AppHandle,
    worktree_path: &Path,
    verb: &str,
    identifier: &str,
) -> Result<(), String> {
    let cli_path = super::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Cursor CLI not installed".to_string());
    }

    let output = crate::platform::cli_command(&cli_path.to_string_lossy(), Some(worktree_path))
        .args(["mcp", verb, identifier])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run Cursor MCP {verb} {identifier}: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    Err(format!(
        "Cursor MCP {verb} {identifier} failed: {}",
        stderr.trim()
    ))
}

fn is_status_effectively_enabled(status: &McpHealthStatus) -> bool {
    !matches!(status, McpHealthStatus::Disabled)
}

fn workspace_lock(worktree_path: &Path) -> Result<Arc<Mutex<()>>, String> {
    let key = worktree_path.to_string_lossy().to_string();
    let lock = WORKSPACE_MCP_LOCKS
        .lock()
        .map_err(|_| "Failed to acquire Cursor MCP lock registry".to_string())?
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    Ok(lock)
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek().is_some_and(|c| *c == '[') {
                let _ = chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cursor_mcp_list_output() {
        let output = "\
\u{1b}[2K\u{1b}[GLoading MCPs…
sentry: not loaded (needs approval)
filesystem: connected
notion: needs authentication
broken: connection failed";

        let statuses = parse_cursor_mcp_list_output(output);
        assert_eq!(statuses.get("sentry"), Some(&McpHealthStatus::Disabled));
        assert_eq!(
            statuses.get("filesystem"),
            Some(&McpHealthStatus::Connected)
        );
        assert_eq!(
            statuses.get("notion"),
            Some(&McpHealthStatus::NeedsAuthentication)
        );
        assert_eq!(
            statuses.get("broken"),
            Some(&McpHealthStatus::CouldNotConnect)
        );
    }

    #[test]
    fn discovers_cursor_mcp_servers_from_project_and_user_config() {
        let temp = tempfile::tempdir().unwrap();
        let project_root = temp.path().join("project");
        let project_cursor_dir = project_root.join(".cursor");
        let user_cursor_dir = temp.path().join("user").join(".cursor");
        std::fs::create_dir_all(&project_cursor_dir).unwrap();
        std::fs::create_dir_all(&user_cursor_dir).unwrap();

        std::fs::write(
            project_cursor_dir.join("mcp.json"),
            r#"{
              "mcpServers": {
                "filesystem": { "command": "fs", "disabled": false }
              }
            }"#,
        )
        .unwrap();
        std::fs::write(
            user_cursor_dir.join("mcp.json"),
            r#"{
              "mcpServers": {
                "filesystem": { "command": "older" },
                "sentry": { "url": "https://mcp.sentry.dev/mcp" }
              }
            }"#,
        )
        .unwrap();

        let mut servers = Vec::new();
        let mut seen_names = HashSet::new();
        collect_from_json(
            &project_cursor_dir.join("mcp.json"),
            "project",
            &mut servers,
            &mut seen_names,
        );
        collect_from_json(
            &user_cursor_dir.join("mcp.json"),
            "user",
            &mut servers,
            &mut seen_names,
        );

        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "filesystem");
        assert_eq!(servers[0].scope, "project");
        assert_eq!(servers[1].name, "sentry");
        assert_eq!(servers[1].scope, "user");
    }
}
