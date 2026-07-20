//! MCP server discovery + health for Grok Build CLI.
//!
//! Grok loads MCP from multiple sources (mirrors grok-build merge order):
//! - Project: `<worktree>/.grok/config.toml` → `[mcp_servers.*]`
//! - User:    `~/.grok/config.toml` → `[mcp_servers.*]`
//! - Claude compat: `~/.claude.json` (+ project project entries)
//! - Cursor compat: `~/.cursor/mcp.json` + `<worktree>/.cursor/mcp.json`
//! - Standard: `<worktree>/.mcp.json` (cwd → git root walk, best-effort cwd only here)
//!
//! `disabled_mcp_servers` in config.toml marks servers disabled.
//!
//! Jean session enablement is applied by syncing `disabled_mcp_servers` before
//! ACP `session/new`/`session/load`, and by passing enabled server configs as
//! ACP `mcpServers` (client overlay).

use crate::chat::{McpHealthStatus, McpServerInfo};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::AppHandle;

/// Discover MCP servers Grok would load for the given worktree.
/// Precedence (highest wins on name collision): project grok → user grok →
/// project .mcp.json → cursor project → cursor user → claude.
pub fn get_mcp_servers(worktree_path: Option<&str>) -> Vec<McpServerInfo> {
    let mut by_name: HashMap<String, McpServerInfo> = HashMap::new();
    let disabled = disabled_mcp_server_names(worktree_path);

    // Lowest priority first so higher scopes overwrite.
    if let Some(home) = dirs::home_dir() {
        collect_claude_json(&home.join(".claude.json"), worktree_path, &mut by_name);
        collect_mcp_json_file(&home.join(".cursor").join("mcp.json"), "user", &mut by_name);
    }

    if let Some(wt) = worktree_path {
        let wt_path = PathBuf::from(wt);
        collect_mcp_json_file(
            &wt_path.join(".cursor").join("mcp.json"),
            "project",
            &mut by_name,
        );
        collect_mcp_json_file(&wt_path.join(".mcp.json"), "project", &mut by_name);
    }

    if let Some(home) = dirs::home_dir() {
        collect_toml_mcp_servers(
            &home.join(".grok").join("config.toml"),
            "user",
            &mut by_name,
        );
    }

    if let Some(wt) = worktree_path {
        collect_toml_mcp_servers(
            &PathBuf::from(wt).join(".grok").join("config.toml"),
            "project",
            &mut by_name,
        );
    }

    let mut servers: Vec<McpServerInfo> = by_name.into_values().collect();
    for server in &mut servers {
        if disabled.contains(&server.name) {
            server.disabled = true;
        }
        server.backend = "grok".to_string();
    }
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    servers
}

/// Health check via `grok mcp doctor --json`.
pub fn check_mcp_health(
    app: &AppHandle,
    worktree_path: Option<&Path>,
) -> Result<HashMap<String, McpHealthStatus>, String> {
    let cli_path = super::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Grok CLI not installed".to_string());
    }

    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), None);
    cmd.args(["mcp", "doctor", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = worktree_path {
        cmd.current_dir(path);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run grok mcp doctor: {e}"))?;

    // doctor may exit non-zero when servers are unhealthy — still parse stdout.
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            return Err(format!("grok mcp doctor failed: {}", stderr.trim()));
        }
        return Ok(HashMap::new());
    }

    Ok(parse_doctor_json(&stdout))
}

/// Parse `grok mcp doctor --json` into health statuses.
pub fn parse_doctor_json(output: &str) -> HashMap<String, McpHealthStatus> {
    let mut statuses = HashMap::new();
    let Ok(json) = serde_json::from_str::<Value>(output) else {
        return statuses;
    };
    let Some(servers) = json.get("servers").and_then(Value::as_array) else {
        return statuses;
    };

    for server in servers {
        let Some(name) = server.get("name").and_then(Value::as_str) else {
            continue;
        };
        let healthy = server
            .get("healthy")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let checks = server
            .get("checks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let status = if healthy {
            McpHealthStatus::Connected
        } else if checks.iter().any(|c| {
            let label = c.get("label").and_then(Value::as_str).unwrap_or("");
            let detail = c.get("detail").and_then(Value::as_str).unwrap_or("");
            label.contains("disabled")
                || detail.contains("disabled in config")
                || detail.contains("disabled_mcp_servers")
        }) {
            McpHealthStatus::Disabled
        } else if checks.iter().any(|c| {
            let label = c.get("label").and_then(Value::as_str).unwrap_or("");
            let detail = c.get("detail").and_then(Value::as_str).unwrap_or("");
            label.contains("auth")
                || detail.contains("AuthorizationRequired")
                || detail.contains("authentication")
                || detail.contains("Needs authentication")
        }) {
            McpHealthStatus::NeedsAuthentication
        } else if checks.iter().any(|c| {
            let label = c.get("label").and_then(Value::as_str).unwrap_or("");
            label.contains("handshake failed")
                || label.contains("could not connect")
                || label.contains("connection")
                || label.contains("failed")
        }) {
            McpHealthStatus::CouldNotConnect
        } else {
            McpHealthStatus::Unknown
        };

        statuses.insert(name.to_string(), status);
    }

    statuses
}

/// Convert Jean/Claude-style `{ "mcpServers": { name: config } }` into ACP
/// `mcpServers` array entries for `session/new` / `session/load`.
pub fn mcp_config_to_acp_servers(mcp_config: Option<&str>) -> Vec<Value> {
    let Some(config) = mcp_config else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(config) else {
        return Vec::new();
    };
    let Some(servers) = json.get("mcpServers").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (name, cfg) in servers {
        if let Some(entry) = config_to_acp_server(name, cfg) {
            out.push(entry);
        }
    }
    out
}

/// Names enabled in a Jean `mcpConfig` JSON blob.
pub fn enabled_names_from_mcp_config(mcp_config: Option<&str>) -> HashSet<String> {
    let Some(config) = mcp_config else {
        return HashSet::new();
    };
    serde_json::from_str::<Value>(config)
        .ok()
        .and_then(|json| json.get("mcpServers").and_then(Value::as_object).cloned())
        .map(|servers| servers.keys().cloned().collect())
        .unwrap_or_default()
}

/// Sync `disabled_mcp_servers` in `~/.grok/config.toml` so Grok only auto-loads
/// Jean-enabled servers for this turn.
///
/// Returns the previous `disabled_mcp_servers` value so the caller can restore
/// it after the ACP host exits (best-effort, avoids permanently rewriting the
/// user's Grok config when Jean sessions end).
pub fn sync_disabled_for_enabled_set(
    worktree_path: Option<&str>,
    desired_enabled: &HashSet<String>,
) -> Result<Option<Vec<String>>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    let config_path = home.join(".grok").join("config.toml");

    let previous = read_disabled_list(&config_path);
    let discovered: HashSet<String> = get_mcp_servers(worktree_path)
        .into_iter()
        .map(|s| s.name)
        .collect();

    // Preserve disables for names Jean does not manage (not discovered).
    let mut new_disabled: HashSet<String> = previous
        .iter()
        .flatten()
        .filter(|name| !discovered.contains(*name))
        .cloned()
        .collect();

    // Known servers: disabled unless Jean enabled them for this turn.
    for name in &discovered {
        if !desired_enabled.contains(name) {
            new_disabled.insert(name.clone());
        }
    }

    let mut sorted: Vec<String> = new_disabled.into_iter().collect();
    sorted.sort();

    write_disabled_list(&config_path, &sorted)?;
    Ok(previous)
}

/// Restore a previously snapshotted `disabled_mcp_servers` list.
pub fn restore_disabled_list(previous: Option<Vec<String>>) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    let config_path = home.join(".grok").join("config.toml");
    match previous {
        Some(list) => write_disabled_list(&config_path, &list),
        None => write_disabled_list(&config_path, &[]),
    }
}

// ── internals ──────────────────────────────────────────────────────────

fn disabled_mcp_server_names(worktree_path: Option<&str>) -> HashSet<String> {
    let mut disabled = HashSet::new();
    if let Some(home) = dirs::home_dir() {
        if let Some(list) = read_disabled_list(&home.join(".grok").join("config.toml")) {
            disabled.extend(list);
        }
    }
    if let Some(wt) = worktree_path {
        if let Some(list) = read_disabled_list(&PathBuf::from(wt).join(".grok").join("config.toml"))
        {
            disabled.extend(list);
        }
    }
    disabled
}

fn read_disabled_list(path: &Path) -> Option<Vec<String>> {
    let content = std::fs::read_to_string(path).ok()?;
    let table: toml::Value = toml::from_str(&content).ok()?;
    let arr = table.get("disabled_mcp_servers")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
    )
}

fn write_disabled_list(path: &Path, names: &[String]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let content = if path.exists() {
        std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?
    } else {
        String::new()
    };

    let mut doc = content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    let mut arr = toml_edit::Array::new();
    for name in names {
        arr.push(name.as_str());
    }
    doc["disabled_mcp_servers"] = toml_edit::value(arr);

    std::fs::write(path, doc.to_string())
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

fn collect_toml_mcp_servers(
    path: &Path,
    scope: &str,
    by_name: &mut HashMap<String, McpServerInfo>,
) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(table) = content.parse::<toml::Value>() else {
        log::warn!("Failed to parse Grok config at {}", path.display());
        return;
    };
    let Some(servers) = table.get("mcp_servers").and_then(|v| v.as_table()) else {
        return;
    };

    for (name, server_val) in servers {
        let Some(server_table) = server_val.as_table() else {
            continue;
        };
        let config = toml_table_to_json(server_table);
        let enabled = server_table
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        by_name.insert(
            name.clone(),
            McpServerInfo {
                name: name.clone(),
                config,
                scope: scope.to_string(),
                disabled: !enabled,
                backend: "grok".to_string(),
            },
        );
    }
}

fn collect_mcp_json_file(path: &Path, scope: &str, by_name: &mut HashMap<String, McpServerInfo>) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<Value>(&content) else {
        log::warn!("Failed to parse MCP JSON at {}", path.display());
        return;
    };
    let Some(servers) = json
        .get("mcpServers")
        .and_then(Value::as_object)
        .or_else(|| json.as_object())
    else {
        return;
    };

    for (name, config) in servers {
        // Skip non-object entries (malformed)
        if !config.is_object() {
            continue;
        }
        let disabled = config
            .get("disabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || config
                .get("enabled")
                .and_then(Value::as_bool)
                .map(|b| !b)
                .unwrap_or(false);
        by_name.insert(
            name.clone(),
            McpServerInfo {
                name: name.clone(),
                config: config.clone(),
                scope: scope.to_string(),
                disabled,
                backend: "grok".to_string(),
            },
        );
    }
}

fn collect_claude_json(
    path: &Path,
    worktree_path: Option<&str>,
    by_name: &mut HashMap<String, McpServerInfo>,
) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<Value>(&content) else {
        log::warn!("Failed to parse Claude config at {}", path.display());
        return;
    };

    // User-level mcpServers
    if let Some(servers) = json.get("mcpServers").and_then(Value::as_object) {
        for (name, config) in servers {
            if !config.is_object() {
                continue;
            }
            let disabled = config
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            by_name.insert(
                name.clone(),
                McpServerInfo {
                    name: name.clone(),
                    config: config.clone(),
                    scope: "user".to_string(),
                    disabled,
                    backend: "grok".to_string(),
                },
            );
        }
    }

    // Project-local under projects.<cwd>.mcpServers
    if let Some(wt) = worktree_path {
        if let Some(projects) = json.get("projects").and_then(Value::as_object) {
            if let Some(project) = projects.get(wt).or_else(|| {
                // Try without trailing slash variants
                let trimmed = wt.trim_end_matches('/');
                projects.get(trimmed)
            }) {
                if let Some(servers) = project.get("mcpServers").and_then(Value::as_object) {
                    for (name, config) in servers {
                        if !config.is_object() {
                            continue;
                        }
                        let disabled = config
                            .get("disabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        by_name.insert(
                            name.clone(),
                            McpServerInfo {
                                name: name.clone(),
                                config: config.clone(),
                                scope: "local".to_string(),
                                disabled,
                                backend: "grok".to_string(),
                            },
                        );
                    }
                }
            }
        }
    }
}

fn toml_table_to_json(table: &toml::map::Map<String, toml::Value>) -> Value {
    let mut map = Map::new();
    for (k, v) in table {
        map.insert(k.clone(), toml_value_to_json(v));
    }
    Value::Object(map)
}

fn toml_value_to_json(value: &toml::Value) -> Value {
    match value {
        toml::Value::String(s) => Value::String(s.clone()),
        toml::Value::Integer(i) => Value::Number((*i).into()),
        toml::Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        toml::Value::Boolean(b) => Value::Bool(*b),
        toml::Value::Datetime(d) => Value::String(d.to_string()),
        toml::Value::Array(arr) => Value::Array(arr.iter().map(toml_value_to_json).collect()),
        toml::Value::Table(t) => toml_table_to_json(t),
    }
}

/// Convert a Claude/Cursor/Grok-style server config object into an ACP McpServer JSON value.
fn config_to_acp_server(name: &str, config: &Value) -> Option<Value> {
    let obj = config.as_object()?;

    // HTTP / SSE (url present)
    if let Some(url) = obj
        .get("url")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty())
    {
        let transport = obj
            .get("type")
            .or_else(|| obj.get("transport"))
            .and_then(Value::as_str)
            .unwrap_or("http");
        let acp_type = if transport.eq_ignore_ascii_case("sse") || url.ends_with("/sse") {
            "sse"
        } else {
            "http"
        };
        let mut entry = Map::new();
        entry.insert("type".into(), Value::String(acp_type.into()));
        entry.insert("name".into(), Value::String(name.into()));
        entry.insert("url".into(), Value::String(url.into()));
        entry.insert(
            "headers".into(),
            headers_to_acp(obj.get("headers")).unwrap_or_else(|| Value::Array(Vec::new())),
        );
        return Some(Value::Object(entry));
    }

    // stdio: command as string, or OpenCode-style command array
    let (command, args) = if let Some(cmd) = obj.get("command").and_then(Value::as_str) {
        let args = obj
            .get("args")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| Value::String(s.to_string())))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        (cmd.to_string(), args)
    } else {
        let arr = obj.get("command").and_then(Value::as_array)?;
        // OpenCode local: "command": ["npx", "-y", "..."]
        let mut iter = arr.iter().filter_map(|v| v.as_str());
        let cmd = iter.next()?.to_string();
        let args = iter.map(|s| Value::String(s.to_string())).collect();
        (cmd, args)
    };

    let mut entry = Map::new();
    entry.insert("name".into(), Value::String(name.into()));
    entry.insert("command".into(), Value::String(command));
    entry.insert("args".into(), Value::Array(args));
    entry.insert(
        "env".into(),
        env_to_acp(obj.get("env").or_else(|| obj.get("environment")))
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    Some(Value::Object(entry))
}

fn headers_to_acp(value: Option<&Value>) -> Option<Value> {
    let obj = value?.as_object()?;
    let arr: Vec<Value> = obj
        .iter()
        .map(|(k, v)| {
            serde_json::json!({
                "name": k,
                "value": v.as_str().unwrap_or("").to_string(),
            })
        })
        .collect();
    Some(Value::Array(arr))
}

fn env_to_acp(value: Option<&Value>) -> Option<Value> {
    let obj = value?.as_object()?;
    let arr: Vec<Value> = obj
        .iter()
        .map(|(k, v)| {
            serde_json::json!({
                "name": k,
                "value": v.as_str().unwrap_or("").to_string(),
            })
        })
        .collect();
    Some(Value::Array(arr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_stdio_and_http_configs_to_acp() {
        let config = r#"{
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "server"], "env": { "A": "1" } },
                "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer x" } },
                "sse": { "url": "https://example.com/sse" }
            }
        }"#;
        let servers = mcp_config_to_acp_servers(Some(config));
        assert_eq!(servers.len(), 3);

        let fs = servers.iter().find(|s| s["name"] == "fs").unwrap();
        assert_eq!(fs["command"], "npx");
        assert!(fs["args"].as_array().unwrap().len() == 2);
        assert_eq!(fs["env"][0]["name"], "A");

        let remote = servers.iter().find(|s| s["name"] == "remote").unwrap();
        assert_eq!(remote["type"], "http");
        assert_eq!(remote["url"], "https://example.com/mcp");

        let sse = servers.iter().find(|s| s["name"] == "sse").unwrap();
        assert_eq!(sse["type"], "sse");
    }

    #[test]
    fn includes_empty_required_acp_fields() {
        let config = r#"{
            "mcpServers": {
                "stdio": { "command": "server" },
                "http": { "url": "https://example.com/mcp" }
            }
        }"#;

        let servers = mcp_config_to_acp_servers(Some(config));

        let stdio = servers.iter().find(|s| s["name"] == "stdio").unwrap();
        assert_eq!(stdio["args"], serde_json::json!([]));
        assert_eq!(stdio["env"], serde_json::json!([]));

        let http = servers.iter().find(|s| s["name"] == "http").unwrap();
        assert_eq!(http["headers"], serde_json::json!([]));
    }

    #[test]
    fn parses_doctor_json_statuses() {
        let json = r#"{
            "servers": [
                { "name": "ok", "healthy": true, "checks": [] },
                {
                    "name": "off",
                    "healthy": false,
                    "checks": [{ "label": "disabled in config", "passed": false, "detail": "server is disabled in config.toml" }]
                },
                {
                    "name": "auth",
                    "healthy": false,
                    "checks": [{ "label": "handshake failed", "passed": false, "detail": "AuthorizationRequired" }]
                },
                {
                    "name": "down",
                    "healthy": false,
                    "checks": [{ "label": "handshake failed", "passed": false, "detail": "connection refused" }]
                }
            ]
        }"#;
        let statuses = parse_doctor_json(json);
        assert_eq!(statuses.get("ok"), Some(&McpHealthStatus::Connected));
        assert_eq!(statuses.get("off"), Some(&McpHealthStatus::Disabled));
        assert_eq!(
            statuses.get("auth"),
            Some(&McpHealthStatus::NeedsAuthentication)
        );
        assert_eq!(
            statuses.get("down"),
            Some(&McpHealthStatus::CouldNotConnect)
        );
    }

    #[test]
    fn discovers_toml_and_json_mcp_servers() {
        let temp = tempfile::tempdir().expect("tempdir");
        let grok_dir = temp.path().join(".grok");
        std::fs::create_dir_all(&grok_dir).unwrap();
        std::fs::write(
            grok_dir.join("config.toml"),
            r#"
disabled_mcp_servers = ["off-server"]

[mcp_servers.native]
command = "echo"
args = ["hi"]
enabled = true

[mcp_servers.off-server]
url = "https://example.com/mcp"
"#,
        )
        .unwrap();

        std::fs::write(
            temp.path().join(".mcp.json"),
            r#"{"mcpServers":{"proj":{"url":"https://proj.example/mcp"}}}"#,
        )
        .unwrap();

        // Point home via collecting project only — use get_mcp_servers with worktree
        // and inject by calling collect helpers through the public API path.
        let mut by_name = HashMap::new();
        collect_toml_mcp_servers(&grok_dir.join("config.toml"), "user", &mut by_name);
        collect_mcp_json_file(&temp.path().join(".mcp.json"), "project", &mut by_name);
        assert!(by_name.contains_key("native"));
        assert!(by_name.contains_key("proj"));
        assert!(by_name.contains_key("off-server"));
        assert!(!by_name["native"].disabled);
    }

    #[test]
    fn writes_and_reads_disabled_list() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        std::fs::write(&path, "models.default = \"x\"\n").unwrap();
        write_disabled_list(&path, &["a".into(), "b".into()]).unwrap();
        let list = read_disabled_list(&path).unwrap();
        assert_eq!(list, vec!["a".to_string(), "b".to_string()]);
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("models.default"));
    }
}
