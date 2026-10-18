//! Antigravity CLI MCP discovery.
//!
//! Reads the workspace and user Antigravity MCP profiles, and the profiles of
//! installed plugins (`~/.gemini/config/plugins/<plugin>/mcp_config.json`).

use crate::chat::McpServerInfo;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub fn get_mcp_servers(worktree_path: Option<&str>) -> Vec<McpServerInfo> {
    let mut servers = Vec::new();
    let mut seen = HashSet::new();

    if let Some(worktree_path) = worktree_path {
        collect(
            &PathBuf::from(worktree_path)
                .join(".agents")
                .join("mcp_config.json"),
            "project",
            &mut servers,
            &mut seen,
        );
    }
    if let Some(home) = dirs::home_dir() {
        collect(
            &home.join(".gemini").join("config").join("mcp_config.json"),
            "user",
            &mut servers,
            &mut seen,
        );
        let plugins_dir = home.join(".gemini").join("config").join("plugins");
        let mut plugin_dirs: Vec<PathBuf> = std::fs::read_dir(plugins_dir)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .collect();
        plugin_dirs.sort();
        for dir in plugin_dirs {
            collect(
                &dir.join("mcp_config.json"),
                "plugin",
                &mut servers,
                &mut seen,
            );
        }
    }
    servers
}

fn collect(path: &Path, scope: &str, servers: &mut Vec<McpServerInfo>, seen: &mut HashSet<String>) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        log::warn!(
            "Failed to parse Antigravity MCP config at {}",
            path.display()
        );
        return;
    };
    let Some(configured) = value
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };
    for (name, config) in configured {
        if !seen.insert(name.clone()) {
            continue;
        }
        servers.push(McpServerInfo {
            name: name.clone(),
            config: config.clone(),
            scope: scope.to_string(),
            disabled: config
                .get("disabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            backend: "antigravity".to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_antigravity_mcp_config() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"linear":{"serverUrl":"https://mcp.linear.app/mcp"}}}"#,
        )
        .expect("write config");
        let mut servers = Vec::new();
        let mut seen = HashSet::new();

        collect(&path, "user", &mut servers, &mut seen);

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "linear");
        assert_eq!(servers[0].backend, "antigravity");
    }
}
