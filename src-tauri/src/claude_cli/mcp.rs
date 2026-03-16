//! MCP server discovery for Claude CLI configuration files.
//!
//! Reads:
//! - User scope:   ~/.claude.json → top-level `mcpServers`
//! - Local scope:  ~/.claude.json → `projects[worktree_path].mcpServers`
//! - Project scope: <worktree_path>/.mcp.json → `mcpServers`

use crate::chat::McpServerInfo;
use std::collections::HashSet;

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

    servers
}
