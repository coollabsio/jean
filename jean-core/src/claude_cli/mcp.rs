//! MCP server discovery for Claude CLI configuration files.
//!
//! Reads:
//! - User scope:   ~/.claude.json → top-level `mcpServers`
//! - Local scope:  ~/.claude.json → `projects[worktree_path].mcpServers`
//! - Project scope: <worktree_path>/.mcp.json → `mcpServers`
//!
//! claude.ai connectors and plugin servers are not in these files. Jean finds
//! them with `claude mcp list` (see [`crate::chat::mcp_external`]).

use crate::chat::mcp_external::{self, ExternalServer};
use crate::chat::McpServerInfo;
use std::collections::HashSet;
use std::process::Stdio;
use tauri::AppHandle;

/// Run `claude mcp list` (it also health-checks each server).
pub fn run_mcp_list(app: &AppHandle, worktree_path: Option<&str>) -> Result<String, String> {
    let cli_path = super::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }
    log::debug!("Running: claude mcp list");
    let output = crate::platform::cli_command(
        &cli_path.to_string_lossy(),
        worktree_path.map(std::path::Path::new),
    )
    .args(["mcp", "list"])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .map_err(|e| format!("Failed to run claude mcp list: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("claude mcp list failed: {stderr}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parse claude.ai connectors and plugin servers from `claude mcp list` output.
/// Line format: `name: url-or-command [(Type)] - Status`. Config-file servers
/// are skipped: `claude mcp list` reads them for one directory only.
pub fn parse_external_servers(list_output: &str) -> Vec<ExternalServer> {
    list_output
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.trim().split_once(": ")?;
            let scope = if name.starts_with("claude.ai ") {
                "claude.ai"
            } else if name.starts_with("plugin:") {
                "plugin"
            } else {
                return None;
            };
            let target = rest.rsplit_once(" - ").map_or(rest, |(t, _)| t);
            Some(ExternalServer::new(name, target.trim(), scope))
        })
        .collect()
}

/// Discover Claude MCP servers from all configuration sources.
/// Precedence (highest to lowest): local → project → user.
pub fn get_mcp_servers(worktree_path: Option<&str>) -> Vec<McpServerInfo> {
    let mut servers = Vec::new();
    let mut seen_names = HashSet::new();

    // Read ~/.claude.json once for both user and local scopes
    let claude_json_data = dirs::home_dir()
        .map(|h| h.join(".claude.json"))
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

    // 1. Local scope (highest precedence): project-specific servers in ~/.claude.json
    if let (Some(ref json), Some(wt_path)) = (&claude_json_data, worktree_path) {
        if let Some(projects) = json.get("projects").and_then(|v| v.as_object()) {
            let path_key = wt_path.trim_end_matches('/');
            for (key, project_val) in projects {
                let key_normalized = key.trim_end_matches('/');
                if key_normalized == path_key {
                    if let Some(mcp) = project_val.get("mcpServers").and_then(|v| v.as_object()) {
                        for (name, config) in mcp {
                            if seen_names.insert(name.clone()) {
                                let disabled = config
                                    .get("disabled")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                servers.push(McpServerInfo {
                                    name: name.clone(),
                                    config: config.clone(),
                                    scope: "local".to_string(),
                                    disabled,
                                    backend: "claude".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Project scope: <worktree_path>/.mcp.json
    if let Some(wt_path) = worktree_path {
        let mcp_json_path = std::path::PathBuf::from(wt_path).join(".mcp.json");
        if mcp_json_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&mcp_json_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(mcp) = json.get("mcpServers").and_then(|v| v.as_object()) {
                        for (name, config) in mcp {
                            if seen_names.insert(name.clone()) {
                                let disabled = config
                                    .get("disabled")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                servers.push(McpServerInfo {
                                    name: name.clone(),
                                    config: config.clone(),
                                    scope: "project".to_string(),
                                    disabled,
                                    backend: "claude".to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. User scope (lowest precedence): top-level mcpServers in ~/.claude.json
    if let Some(ref json) = claude_json_data {
        if let Some(mcp) = json.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, config) in mcp {
                if seen_names.insert(name.clone()) {
                    let disabled = config
                        .get("disabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    servers.push(McpServerInfo {
                        name: name.clone(),
                        config: config.clone(),
                        scope: "user".to_string(),
                        disabled,
                        backend: "claude".to_string(),
                    });
                }
            }
        }
    }

    // 4. claude.ai connectors and plugin servers (cached `claude mcp list`)
    mcp_external::append("claude", worktree_path, &mut servers);

    servers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_external_servers_from_mcp_list() {
        let output = "\
Checking MCP server health…

claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication
plugin:tools:search: npx -y search-mcp - ✔ Connected
agent-browser: /bin/agent-browser mcp - ✔ Connected
notion: https://mcp.notion.com/mcp (HTTP) - ✔ Connected";

        assert_eq!(
            parse_external_servers(output),
            vec![
                ExternalServer::new(
                    "claude.ai Gmail",
                    "https://gmailmcp.googleapis.com/mcp/v1",
                    "claude.ai"
                ),
                ExternalServer::new("plugin:tools:search", "npx -y search-mcp", "plugin"),
            ]
        );
    }
}
