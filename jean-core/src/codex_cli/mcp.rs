//! MCP server discovery for Codex CLI configuration files.
//!
//! Reads:
//! - Global scope:  ~/.codex/config.toml → `[mcp_servers.<name>]` sections
//! - Project scope: <worktree_path>/.codex/config.toml → same format
//!
//! Codex TOML section examples:
//!   [mcp_servers.filesystem]
//!   command = "/usr/bin/fs-server"
//!   args = ["--root", "/home"]
//!   enabled = true
//!
//!   [mcp_servers.notion]
//!   url = "https://mcp.notion.com/mcp"
//!   enabled = true
//!
//! Plugin servers and ChatGPT apps (`codex_apps`) are not in these files. Jean
//! finds them with the app-server `mcpServerStatus/list` request
//! (see [`crate::chat::mcp_external`]).

use crate::chat::mcp_external::{self, ExternalServer};
use crate::chat::{McpHealthStatus, McpServerInfo};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;

/// Time limit for the one-shot app-server list. It waits for every MCP server
/// to start, so allow more than a plain CLI call.
const APP_SERVER_LIST_TIMEOUT: Duration = Duration::from_secs(60);

/// Top-level Codex config, only the mcp_servers section is parsed.
#[derive(serde::Deserialize, Debug)]
struct CodexConfig {
    #[serde(default)]
    mcp_servers: HashMap<String, CodexMcpServerEntry>,
}

/// A single MCP server entry in Codex TOML config.
#[derive(serde::Deserialize, Debug)]
struct CodexMcpServerEntry {
    // STDIO transport
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    // HTTP transport
    url: Option<String>,
    bearer_token_env_var: Option<String>,
    http_headers: Option<HashMap<String, String>>,
    // Common
    #[serde(default = "default_enabled")]
    enabled: bool,
    startup_timeout_sec: Option<u64>,
    tool_timeout_sec: Option<u64>,
    enabled_tools: Option<Vec<String>>,
    disabled_tools: Option<Vec<String>>,
    required: Option<bool>,
}

fn default_enabled() -> bool {
    true
}

/// Discover Codex MCP servers from all configuration sources.
/// Precedence (highest to lowest): project → global.
pub fn get_mcp_servers(worktree_path: Option<&str>) -> Vec<McpServerInfo> {
    let mut servers = Vec::new();
    let mut seen_names = HashSet::new();

    // 1. Project scope (highest precedence): <worktree_path>/.codex/config.toml
    if let Some(wt_path) = worktree_path {
        let project_config = std::path::PathBuf::from(wt_path)
            .join(".codex")
            .join("config.toml");
        collect_from_toml(&project_config, "project", &mut servers, &mut seen_names);
    }

    // 2. Global scope: ~/.codex/config.toml
    if let Some(home) = dirs::home_dir() {
        let global_config = home.join(".codex").join("config.toml");
        collect_from_toml(&global_config, "user", &mut servers, &mut seen_names);
    }

    // 3. Plugin servers and ChatGPT apps (cached app-server list)
    mcp_external::append("codex", worktree_path, &mut servers);

    servers
}

/// List every MCP server Codex loads, with a short-lived `codex app-server`.
/// A separate process keeps this away from the shared chat app-server.
pub fn list_app_server_servers(
    app: &AppHandle,
    worktree_path: Option<&str>,
) -> Result<Vec<ExternalServer>, String> {
    let binary = super::resolve_cli_binary(app)?;
    if !binary.exists() {
        return Err("Codex CLI not installed".to_string());
    }
    let mut child = crate::platform::cli_command(
        &binary.to_string_lossy(),
        worktree_path.map(std::path::Path::new),
    )
    .arg("app-server")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|e| format!("Failed to start codex app-server: {e}"))?;

    let result = request_server_status_list(&mut child);
    drop(child.stdin.take());
    let _ = child.kill();
    let _ = child.wait();
    Ok(parse_server_status_list(&result?))
}

fn request_server_status_list(child: &mut std::process::Child) -> Result<Value, String> {
    let mut stdin = child.stdin.take().ok_or("No stdin for codex app-server")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("No stdout for codex app-server")?;
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value.get("id").is_some() && tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let mut send = |message: Value| {
        writeln!(stdin, "{message}")
            .map_err(|e| format!("Failed to write to codex app-server: {e}"))
    };
    let wait_for = |id: u64| -> Result<Value, String> {
        let deadline = std::time::Instant::now() + APP_SERVER_LIST_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let value = rx
                .recv_timeout(left)
                .map_err(|_| "codex app-server did not answer in time".to_string())?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(format!("codex app-server error: {error}"));
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    };

    send(json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": { "name": "jean", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true },
        },
    }))?;
    wait_for(1)?;
    send(json!({ "method": "initialized" }))?;
    send(json!({
        "id": 2,
        "method": "mcpServerStatus/list",
        "params": { "detail": "toolsAndAuthOnly", "limit": 500 },
    }))?;
    wait_for(2)
}

/// Convert an `mcpServerStatus/list` result into servers with health.
fn parse_server_status_list(result: &Value) -> Vec<ExternalServer> {
    let Some(data) = result.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    data.iter()
        .filter_map(|server| {
            let name = server.get("name")?.as_str()?;
            let scope = if server.get("pluginId").is_some_and(|id| !id.is_null()) {
                "plugin"
            } else if name == "codex_apps" {
                "apps"
            } else {
                "cli"
            };
            let target = server
                .get("httpOrigin")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let has_tools = server
                .get("tools")
                .and_then(Value::as_object)
                .is_some_and(|tools| !tools.is_empty());
            let status = match server.get("authStatus").and_then(Value::as_str) {
                Some("notLoggedIn") => McpHealthStatus::NeedsAuthentication,
                _ if has_tools => McpHealthStatus::Connected,
                Some("bearerToken" | "oAuth") => McpHealthStatus::Authenticated,
                _ => McpHealthStatus::Unknown,
            };
            let mut external = ExternalServer::new(name, target, scope);
            external.status = Some(status);
            Some(external)
        })
        .collect()
}

fn collect_from_toml(
    path: &std::path::Path,
    scope: &str,
    servers: &mut Vec<McpServerInfo>,
    seen_names: &mut HashSet<String>,
) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(config) = toml::from_str::<CodexConfig>(&content) else {
        log::warn!("Failed to parse Codex config at {}", path.display());
        return;
    };

    for (name, entry) in config.mcp_servers {
        if seen_names.insert(name.clone()) {
            let config_json =
                serde_json::to_value(entry_to_json_map(&entry)).unwrap_or(serde_json::Value::Null);

            servers.push(McpServerInfo {
                name,
                config: config_json,
                scope: scope.to_string(),
                disabled: !entry.enabled,
                backend: "codex".to_string(),
            });
        }
    }
}

/// Convert a Codex TOML entry into a normalized JSON map matching the
/// shape used by Claude config (command/args/env for STDIO, url for HTTP).
fn entry_to_json_map(entry: &CodexMcpServerEntry) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();

    if let Some(ref cmd) = entry.command {
        map.insert("command".into(), cmd.clone().into());
        if let Some(ref args) = entry.args {
            map.insert(
                "args".into(),
                serde_json::Value::Array(
                    args.iter()
                        .map(|a| serde_json::Value::String(a.clone()))
                        .collect(),
                ),
            );
        }
        if let Some(ref env) = entry.env {
            map.insert("env".into(), serde_json::to_value(env).unwrap_or_default());
        }
        if let Some(ref cwd) = entry.cwd {
            map.insert("cwd".into(), cwd.clone().into());
        }
    } else if let Some(ref url) = entry.url {
        map.insert("url".into(), url.clone().into());
        if let Some(ref headers) = entry.http_headers {
            map.insert(
                "httpHeaders".into(),
                serde_json::to_value(headers).unwrap_or_default(),
            );
        }
    }

    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_app_server_status_list() {
        let servers = parse_server_status_list(&json!({
            "data": [
                { "name": "codex_apps", "authStatus": "bearerToken",
                  "httpOrigin": "https://chatgpt.com", "tools": { "a": {} } },
                { "name": "linear", "authStatus": "notLoggedIn", "pluginId": "linear@m", "tools": {} },
                { "name": "local", "authStatus": "unsupported", "tools": {} },
            ]
        }));
        assert_eq!(servers[0].scope, "apps");
        assert_eq!(servers[0].target, "https://chatgpt.com");
        assert_eq!(servers[0].status, Some(McpHealthStatus::Connected));
        assert_eq!(servers[1].scope, "plugin");
        assert_eq!(
            servers[1].status,
            Some(McpHealthStatus::NeedsAuthentication)
        );
        assert_eq!(servers[2].scope, "cli");
        assert_eq!(servers[2].status, Some(McpHealthStatus::Unknown));
    }

    #[test]
    fn discovers_enabled_oauth_http_server_without_explicit_enabled_flag() {
        let temp = tempfile::tempdir().expect("temp dir");
        let config = temp.path().join("config.toml");
        std::fs::write(
            &config,
            "[mcp_servers.clickup]\nurl = \"https://mcp.clickup.com/mcp\"\n",
        )
        .expect("write config");

        let mut servers = Vec::new();
        let mut seen = HashSet::new();
        collect_from_toml(&config, "user", &mut servers, &mut seen);

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "clickup");
        assert!(!servers[0].disabled);
        assert_eq!(servers[0].config["url"], "https://mcp.clickup.com/mcp");
    }
}
