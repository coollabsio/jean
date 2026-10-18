//! Muse Code MCP discovery: the `mcp_servers` object of
//! `$XDG_CONFIG_HOME/muse/settings.json`.

use crate::chat::McpServerInfo;
use std::path::Path;

pub fn get_mcp_servers(_worktree_path: Option<&str>) -> Vec<McpServerInfo> {
    super::settings_path()
        .map(|path| collect(&path, "user"))
        .unwrap_or_default()
}

fn collect(path: &Path, scope: &str) -> Vec<McpServerInfo> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        log::warn!("Failed to parse Muse settings at {}", path.display());
        return Vec::new();
    };
    let Some(configured) = value
        .get("mcp_servers")
        .and_then(serde_json::Value::as_object)
    else {
        return Vec::new();
    };
    configured
        .iter()
        .map(|(name, config)| McpServerInfo {
            name: name.clone(),
            config: config.clone(),
            scope: scope.to_string(),
            disabled: config.get("enabled").and_then(serde_json::Value::as_bool) == Some(false),
            backend: "muse".to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_muse_settings_mcp_servers() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"schema_version":1,"mcp_servers":{"linear":{"transport":"streamable_http","url":"https://mcp.linear.app/mcp"},"off":{"transport":"stdio","command":"x","enabled":false}}}"#,
        )
        .expect("write settings");

        let servers = collect(&path, "user");

        assert_eq!(servers.len(), 2);
        let linear = servers.iter().find(|s| s.name == "linear").expect("linear");
        assert_eq!(linear.backend, "muse");
        assert!(!linear.disabled);
        assert_eq!(linear.config["url"], "https://mcp.linear.app/mcp");
        assert!(
            servers
                .iter()
                .find(|s| s.name == "off")
                .expect("off")
                .disabled
        );
    }
}
