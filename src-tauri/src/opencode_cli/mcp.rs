//! MCP server discovery for OpenCode configuration files.
//!
//! Reads:
//! - Global scope:  ~/.config/opencode/opencode.json → `mcp` object
//! - Project scope: <worktree_path>/opencode.json    → `mcp` object
//!
//! OpenCode JSON example:
//!   {
//!     "mcp": {
//!       "filesystem": { "type": "local", "command": ["npx", "..."], "enabled": true },
//!       "notion":     { "type": "remote", "url": "https://...", "enabled": true }
//!     }
//!   }

use crate::chat::McpServerInfo;
use std::collections::HashSet;

/// Discover OpenCode MCP servers from all configuration sources.
/// Precedence (highest to lowest): project → global.
pub fn get_mcp_servers(worktree_path: Option<&str>) -> Vec<McpServerInfo> {
    let mut servers = Vec::new();
    let mut seen_names = HashSet::new();

    // 1. Project scope (highest precedence): <worktree_path>/opencode.json
    if let Some(wt_path) = worktree_path {
        let project_config = std::path::PathBuf::from(wt_path).join("opencode.json");
        collect_from_opencode_json(&project_config, "project", &mut servers, &mut seen_names);
    }

    // 2. Global scope: ~/.config/opencode/opencode.json
    if let Some(config_dir) = dirs::config_dir() {
        let global_config = config_dir.join("opencode").join("opencode.json");
        collect_from_opencode_json(&global_config, "user", &mut servers, &mut seen_names);
    }

    servers
}

fn collect_from_opencode_json(
    path: &std::path::Path,
    scope: &str,
    servers: &mut Vec<McpServerInfo>,
    seen_names: &mut HashSet<String>,
) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };

    // Strip JSONC comments (// and /* */) before parsing
    let cleaned = strip_jsonc_comments(&content);

    let Ok(json) = serde_json::from_str::<serde_json::Value>(&cleaned) else {
        log::warn!("Failed to parse OpenCode config at {}", path.display());
        return;
    };

    let Some(mcp) = json.get("mcp").and_then(|v| v.as_object()) else {
        return;
    };

    for (name, config) in mcp {
        if seen_names.insert(name.clone()) {
            // OpenCode uses "enabled" bool in the server object; default true
            let disabled = config
                .get("enabled")
                .and_then(|v| v.as_bool())
                .map(|b| !b)
                .unwrap_or(false);

            servers.push(McpServerInfo {
                name: name.clone(),
                config: config.clone(),
                scope: scope.to_string(),
                disabled,
                backend: "opencode".to_string(),
            });
        }
    }
}

/// Minimal JSONC comment stripper — removes `//` line comments and `/* */` block comments.
/// Does not handle comments inside strings (good enough for config files).
fn strip_jsonc_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch == '/' {
            chars.next();
            match chars.peek() {
                Some(&'/') => {
                    // Line comment — skip until newline
                    for c in chars.by_ref() {
                        if c == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                }
                Some(&'*') => {
                    // Block comment — skip until */
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '*' && chars.peek() == Some(&'/') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    out.push('/');
                }
            }
        } else {
            out.push(ch);
            chars.next();
        }
    }

    out
}
