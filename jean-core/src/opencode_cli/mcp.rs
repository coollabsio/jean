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
//! OpenCode 2.x nests servers under `mcp.servers` and uses `disabled`
//! instead of `enabled`; both shapes are read (2.x first).
//!
//! OpenCode 1.x JSON example:
//!   {
//!     "mcp": {
//!       "filesystem": { "type": "local", "command": ["npx", "..."], "enabled": true },
//!       "notion":     { "type": "remote", "url": "https://...", "enabled": true }
//!     }
//!   }
//!
//! Remote, managed, and env config servers come from `opencode mcp list`
//! (see [`crate::chat::mcp_external`]).

use crate::chat::mcp_external::{self, ExternalServer};
use crate::chat::{McpHealthStatus, McpServerInfo};
use std::collections::HashSet;
use std::process::Stdio;
use tauri::AppHandle;

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

    mcp_external::append("opencode", worktree_path, &mut servers);
    log::debug!("OpenCode MCP: discovered {} servers total", servers.len());
    servers
}

/// Run `opencode mcp list` and return its stdout.
pub fn run_mcp_list(app: &AppHandle, worktree_path: Option<&str>) -> Result<String, String> {
    let cli_path = super::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("OpenCode CLI not installed".to_string());
    }
    log::debug!("Running: opencode mcp list");
    let output = crate::platform::cli_command(
        &cli_path.to_string_lossy(),
        worktree_path.map(std::path::Path::new),
    )
    .args(["mcp", "list"])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .output()
    .map_err(|e| format!("Failed to run opencode mcp list: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("opencode mcp list failed: {stderr}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parse `opencode mcp list` output. Each server is one line
/// `● <icon> <name> <status>`, then optional error lines, then the URL or command.
pub fn parse_mcp_list_output(output: &str) -> Vec<ExternalServer> {
    let mut servers: Vec<ExternalServer> = Vec::new();
    for line in crate::cursor_cli::mcp::strip_ansi(output).lines() {
        let text = line.trim().trim_start_matches(['●', '│']).trim();
        let mut chars = text.chars();
        if let Some('✓' | '○' | '⚠' | '✗') = chars.next() {
            let rest = chars.as_str().trim();
            let (name, status) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            let status = status.trim();
            let mut server = ExternalServer::new(name, "", "cli");
            server.status = Some(if status.starts_with("connected") {
                McpHealthStatus::Connected
            } else if status.starts_with("disabled") {
                McpHealthStatus::Disabled
            } else if status.starts_with("needs authentication") {
                McpHealthStatus::NeedsAuthentication
            } else if status.starts_with("failed") || status.starts_with("needs client") {
                McpHealthStatus::CouldNotConnect
            } else {
                McpHealthStatus::Unknown
            });
            servers.push(server);
        } else if let Some(server) = servers.last_mut() {
            // The last line of a server block is its URL or command.
            if !text.is_empty() && !text.starts_with(['└', '┌']) {
                server.target = text.to_string();
            }
        }
    }
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

    // OpenCode 2.x: `mcp.servers.<name>` with a `disabled` flag (default false).
    // `servers`/`timeout` are 1.x server names only when they hold a server entry.
    let is_v2_container = |key: &str| {
        mcp.get(key)
            .is_some_and(|v| v.is_object() && v.get("type").is_none())
    };
    if is_v2_container("servers") {
        if let Some(entries) = mcp.get("servers").and_then(|v| v.as_object()) {
            for (name, config) in entries {
                let disabled = config
                    .get("disabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                push_server(servers, seen_names, name, config, scope, disabled);
            }
        }
    }

    // OpenCode 1.x: `mcp.<name>` with an `enabled` flag (default true).
    for (name, config) in mcp {
        if matches!(name.as_str(), "servers" | "timeout") && is_v2_container(name) {
            continue;
        }
        let disabled = config
            .get("enabled")
            .and_then(|v| v.as_bool())
            .map(|b| !b)
            .unwrap_or(false);
        push_server(servers, seen_names, name, config, scope, disabled);
    }
}

fn push_server(
    servers: &mut Vec<McpServerInfo>,
    seen_names: &mut HashSet<String>,
    name: &str,
    config: &serde_json::Value,
    scope: &str,
    disabled: bool,
) {
    if seen_names.insert(name.to_string()) {
        servers.push(McpServerInfo {
            name: name.to_string(),
            config: config.clone(),
            scope: scope.to_string(),
            disabled,
            backend: "opencode".to_string(),
        });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_opencode_mcp_list_output() {
        let output = "\u{1b}[0m\n┌  MCP Servers\n│\n●  ✓ agent-browser \u{1b}[90mconnected\n│      \u{1b}[90m/bin/agent-browser mcp\n│\n●  ⚠ notion \u{1b}[90mneeds authentication\n│      \u{1b}[90mhttps://mcp.notion.com/mcp\n│\n●  ✗ broken \u{1b}[90mfailed\n    spawn ENOENT\n    missing-cmd\n│\n└  3 server(s)\n";
        let servers = parse_mcp_list_output(output);
        assert_eq!(servers.len(), 3);
        assert_eq!(servers[0].name, "agent-browser");
        assert_eq!(servers[0].target, "/bin/agent-browser mcp");
        assert_eq!(servers[0].status, Some(McpHealthStatus::Connected));
        assert_eq!(
            servers[1].status,
            Some(McpHealthStatus::NeedsAuthentication)
        );
        assert_eq!(servers[2].target, "missing-cmd");
        assert_eq!(servers[2].status, Some(McpHealthStatus::CouldNotConnect));
    }

    #[test]
    fn parses_opencode_v2_mcp_list_output() {
        let output = "✗ jean-test  failed: Method not found\n✓ docs  connected\n○ slow  pending\n";
        let servers = parse_mcp_list_output(output);
        let names: Vec<_> = servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["jean-test", "docs", "slow"]);
        assert_eq!(servers[0].status, Some(McpHealthStatus::CouldNotConnect));
        assert_eq!(servers[1].status, Some(McpHealthStatus::Connected));
        assert_eq!(servers[2].status, Some(McpHealthStatus::Unknown));
    }

    fn collect(content: &str) -> Vec<(String, bool)> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        std::fs::write(&path, content).unwrap();
        let mut servers = Vec::new();
        collect_from_opencode_json(&path, "user", &mut servers, &mut HashSet::new());
        servers.into_iter().map(|s| (s.name, s.disabled)).collect()
    }

    #[test]
    fn reads_opencode_v2_servers_with_disabled_flag() {
        let servers = collect(
            r#"{
  // 2.x shape
  "mcp": {
    "timeout": { "connect": 5000 },
    "servers": {
      "on": { "type": "local", "command": ["/bin/cat"] },
      "off": { "type": "remote", "url": "https://x.test/mcp", "disabled": true }
    }
  }
}"#,
        );
        assert_eq!(
            servers,
            [("off".to_string(), true), ("on".to_string(), false)]
        );
    }

    #[test]
    fn reads_mixed_opencode_v1_and_v2_entries() {
        let servers = collect(
            r#"{
  "mcp": {
    "legacy": { "type": "local", "command": ["x"], "enabled": false },
    "servers": { "modern": { "type": "local", "command": ["y"] } },
    "timeout": { "connect": 1 }
  }
}"#,
        );
        assert_eq!(
            servers,
            [("modern".to_string(), false), ("legacy".to_string(), true)]
        );
    }

    #[test]
    fn keeps_v1_server_literally_named_servers() {
        let servers = collect(r#"{ "mcp": { "servers": { "type": "local", "command": ["z"] } } }"#);
        assert_eq!(servers, [("servers".to_string(), false)]);
    }
}
