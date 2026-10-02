//! Devin MCP config discovery. Local overrides take priority over project and user config.
//! https://docs.devin.ai/cli/extensibility/mcp/configuration

use crate::chat::McpServerInfo;
use std::collections::HashSet;
use std::path::Path;

pub fn get_mcp_servers(worktree_path: Option<&str>) -> Vec<McpServerInfo> {
    let user_dir = user_config_dir();
    discover(worktree_path.map(Path::new), user_dir.as_deref())
}

pub(crate) fn user_config_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        dirs::config_dir().map(|path| path.join("devin"))
    }
    #[cfg(not(windows))]
    {
        dirs::home_dir().map(|path| path.join(".config/devin"))
    }
}

fn discover(worktree: Option<&Path>, user_dir: Option<&Path>) -> Vec<McpServerInfo> {
    let mut paths = Vec::new();
    if let Some(worktree) = worktree {
        let dir = worktree.join(".devin");
        for (file, scope) in [
            ("mcp_config.local.json", "local"),
            ("config.local.json", "local"),
            ("mcp_config.json", "project"),
            ("config.json", "project"),
        ] {
            paths.push((dir.join(file), scope));
        }
    }
    if let Some(dir) = user_dir {
        paths.push((dir.join("mcp_config.json"), "user"));
        paths.push((dir.join("config.json"), "user"));
    }
    let mut seen = HashSet::new();
    let mut servers = Vec::new();
    for (path, scope) in paths {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let Some(configured) = value
            .get("mcpServers")
            .and_then(serde_json::Value::as_object)
        else {
            continue;
        };
        for (name, config) in configured {
            if !config.is_object() || !seen.insert(name.clone()) {
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
                backend: "devin".to_string(),
            });
        }
    }
    servers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_disabled_override_wins_and_legacy_servers_are_retained() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let user = temp.path().join("user");
        std::fs::create_dir_all(project.join(".devin")).unwrap();
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(
            project.join(".devin/mcp_config.local.json"),
            r#"{"mcpServers":{"devin":{"url":"https://mcp.devin.ai/mcp","disabled":true}}}"#,
        )
        .unwrap();
        std::fs::write(
            project.join(".devin/mcp_config.json"),
            r#"{"mcpServers":{"devin":{"url":"https://wrong.example"}}}"#,
        )
        .unwrap();
        std::fs::write(
            user.join("config.json"),
            r#"{"mcpServers":{"deepwiki":{"url":"https://mcp.deepwiki.com/mcp"},"invalid":null}}"#,
        )
        .unwrap();
        let servers = discover(Some(&project), Some(&user));
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "devin");
        assert!(servers[0].disabled);
        assert_eq!(servers[0].scope, "local");
        assert_eq!(servers[0].config["url"], "https://mcp.devin.ai/mcp");
        assert_eq!(servers[1].name, "deepwiki");
        assert_eq!(servers[1].backend, "devin");
    }

    #[test]
    fn dedicated_config_wins_over_legacy_config() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("mcp_config.json"),
            r#"{"mcpServers":{"wiki":{"url":"https://current.example"}}}"#,
        )
        .unwrap();
        std::fs::write(
            temp.path().join("config.json"),
            r#"{"mcpServers":{"wiki":{"url":"https://legacy.example"}}}"#,
        )
        .unwrap();
        let servers = discover(None, Some(temp.path()));
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].config["url"], "https://current.example");
        assert!(discover(None, None).is_empty());
    }
}
