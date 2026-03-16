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

use crate::chat::McpServerInfo;
use std::collections::{HashMap, HashSet};

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

    servers
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
