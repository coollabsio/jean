//! MCP config sync for the Antigravity CLI (`agy`).
//!
//! Antigravity loads MCP servers from `~/.gemini/config/mcp_config.json`
//! (`mcpServers` map) — the HOME-level file, since the workspace-local
//! `.agents/mcp_config.json` is read-but-ignored upstream (antigravity-cli #60).
//!
//! Jean owns a single managed server named `jean`. Each turn we sync it into the
//! shared Gemini config from Jean's per-session `mcpConfig` blob (the same blob
//! other backends receive), and remove it when the session disables Jean MCP —
//! never touching the user's own servers.

use serde_json::{Map, Value};
use std::path::PathBuf;

const JEAN_SERVER_NAME: &str = "jean";

fn gemini_mcp_config_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".gemini")
            .join("config")
            .join("mcp_config.json"),
    )
}

/// Extract the `mcpServers` object from a Jean `mcpConfig` JSON blob.
fn enabled_servers(mcp_config: Option<&str>) -> Map<String, Value> {
    mcp_config
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .and_then(|v| v.get("mcpServers").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

/// Sync Jean's managed MCP server into the shared Gemini/Antigravity config.
/// Best-effort: writes nothing on IO/JSON errors and preserves user servers.
pub fn sync_jean_mcp_config(mcp_config: Option<&str>) {
    let Some(path) = gemini_mcp_config_path() else {
        return;
    };
    let desired = enabled_servers(mcp_config);
    let jean_enabled = desired.get(JEAN_SERVER_NAME).cloned();

    // Load existing config, or start fresh.
    let mut root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let Some(obj) = root.as_object_mut() else {
        return;
    };

    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(servers) = servers.as_object_mut() else {
        return;
    };

    let mut changed = false;
    match jean_enabled {
        Some(config) => {
            if servers.get(JEAN_SERVER_NAME) != Some(&config) {
                servers.insert(JEAN_SERVER_NAME.to_string(), config);
                changed = true;
            }
        }
        None => {
            if servers.remove(JEAN_SERVER_NAME).is_some() {
                changed = true;
            }
        }
    }

    if changed {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(serialized) = serde_json::to_string_pretty(&root) {
            let _ = std::fs::write(&path, serialized);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_servers_extracts_map() {
        let blob = r#"{"mcpServers":{"jean":{"command":"jean-mcp"},"other":{"url":"http://x"}}}"#;
        let servers = enabled_servers(Some(blob));
        assert!(servers.contains_key("jean"));
        assert!(servers.contains_key("other"));
        assert!(enabled_servers(None).is_empty());
    }
}
