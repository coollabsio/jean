//! Kimi Code MCP discovery.
//!
//! Reads project `.kimi-code/mcp.json` before user `~/.kimi-code/mcp.json`,
//! matching Kimi Code's documented configuration locations.

use crate::chat::McpServerInfo;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub fn get_mcp_servers(worktree_path: Option<&str>) -> Vec<McpServerInfo> {
    let mut servers = Vec::new();
    let mut seen = HashSet::new();

    if let Some(worktree_path) = worktree_path {
        collect(
            &PathBuf::from(worktree_path)
                .join(".kimi-code")
                .join("mcp.json"),
            "project",
            &mut servers,
            &mut seen,
        );
    }
    if let Some(home) = dirs::home_dir() {
        collect(
            &home.join(".kimi-code").join("mcp.json"),
            "user",
            &mut servers,
            &mut seen,
        );
    }
    servers
}

fn collect(path: &Path, scope: &str, servers: &mut Vec<McpServerInfo>, seen: &mut HashSet<String>) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        log::warn!("Failed to parse Kimi MCP config at {}", path.display());
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
            backend: "kimi".to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kimi_mcp_config() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"linear":{"url":"https://mcp.linear.app/mcp"}}}"#,
        )
        .expect("write config");
        let mut servers = Vec::new();
        let mut seen = HashSet::new();

        collect(&path, "user", &mut servers, &mut seen);

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "linear");
        assert_eq!(servers[0].backend, "kimi");
    }
}
