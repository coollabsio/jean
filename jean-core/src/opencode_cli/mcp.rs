//! MCP server discovery for OpenCode configuration files.
//!
//! OpenCode uses xdg-basedir which resolves to `$HOME/.config` on all platforms.
//! Config filenames checked in order: opencode.jsonc, opencode.json, config.json.
//!
//! Reads:
//! - Project scope: <worktree_path>/{opencode.jsonc,opencode.json,config.json}    → `mcp` object
//! - Home scope:    ~/{opencode.jsonc,opencode.json,config.json}                  → `mcp` object
//! - Global scope:  ~/.config/opencode/{opencode.jsonc,opencode.json,config.json} → `mcp` object
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

    // 1. Project scope (highest precedence): <worktree_path>/{opencode.jsonc,opencode.json,config.json}
    if let Some(wt_path) = worktree_path {
        let wt = std::path::PathBuf::from(wt_path);
        if let Some(path) = find_opencode_config(&wt) {
            collect_from_opencode_json(&path, "project", &mut servers, &mut seen_names);
        }
    }

    if let Some(home) = dirs::home_dir() {
        // 2. Home-directory config: ~/{opencode.jsonc,opencode.json,config.json}
        //    OpenCode also checks the home directory itself as a config source.
        if let Some(path) = find_opencode_config(&home) {
            log::debug!("OpenCode MCP: found home config at {}", path.display());
            collect_from_opencode_json(&path, "user", &mut servers, &mut seen_names);
        }

        // 3. Global scope: ~/.config/opencode/{opencode.jsonc,opencode.json,config.json}
        //    OpenCode uses the xdg-basedir package which always resolves to $HOME/.config
        //    on all platforms (macOS, Linux, Windows), NOT the platform-native config dir.
        let config_dir = home.join(".config").join("opencode");
        log::debug!(
            "OpenCode MCP: looking for global config in {}",
            config_dir.display()
        );
        if let Some(path) = find_opencode_config(&config_dir) {
            log::debug!("OpenCode MCP: found global config at {}", path.display());
            collect_from_opencode_json(&path, "user", &mut servers, &mut seen_names);
        }
    } else {
        log::warn!("OpenCode MCP: dirs::home_dir() returned None");
    }

    log::debug!("OpenCode MCP: discovered {} servers total", servers.len());
    servers
}

/// Find the first existing OpenCode config file in a directory.
/// OpenCode checks these filenames in order: opencode.jsonc, opencode.json, config.json.
fn find_opencode_config(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    for name in ["opencode.jsonc", "opencode.json", "config.json"] {
        let p = dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
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

    let json = match serde_json::from_str::<serde_json::Value>(&cleaned) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "Failed to parse OpenCode config at {}: {e} — cleaned content: {:?}",
                path.display(),
                &cleaned[..cleaned.len().min(300)]
            );
            return;
        }
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
/// Correctly skips comment detection inside JSON strings (handles `\"` escapes).
fn strip_jsonc_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;

    while let Some(&ch) = chars.peek() {
        if in_string {
            out.push(ch);
            chars.next();
            if ch == '\\' {
                // Escaped character — push next char as-is
                if let Some(&next) = chars.peek() {
                    out.push(next);
                    chars.next();
                }
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            out.push(ch);
            chars.next();
        } else if ch == '/' {
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
