//! Prepare MCP OAuth login for Jean's existing embedded login terminal.
//! Credentials and OAuth callback validation remain owned by the backend CLI.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMcpLogin {
    pub command: String,
    pub command_args: Vec<String>,
    pub worktree_path: String,
}

fn login_args(backend: &str, server_name: &str) -> Result<Vec<String>, String> {
    if !matches!(backend, "claude" | "codex") {
        return Err(format!(
            "MCP sign-in inside Jean is not supported for {backend}"
        ));
    }
    // Pass names as individual arguments, not shell text. Reject option-like
    // names and control characters so a config entry cannot supply CLI flags.
    if server_name.is_empty()
        || server_name.starts_with('-')
        || server_name.chars().any(char::is_control)
    {
        return Err("Invalid MCP server name".to_string());
    }
    Ok(vec![
        "mcp".to_string(),
        "login".to_string(),
        "--no-browser".to_string(),
        server_name.to_string(),
    ])
}

fn check_login_support(binary: &Path, cwd: &Path) -> Result<(), String> {
    let output = crate::platform::cli_command(&binary.to_string_lossy(), Some(cwd))
        .args(["mcp", "login", "--help"])
        .output()
        .map_err(|error| format!("Could not check MCP sign-in support: {error}"))?;
    let help = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !help.contains("--no-browser") {
        return Err(
            "Update this backend CLI in Settings to use MCP sign-in inside Jean".to_string(),
        );
    }
    Ok(())
}

pub async fn prepare_mcp_login(
    app: AppHandle,
    backend: String,
    server_name: String,
    worktree_path: Option<String>,
) -> Result<PreparedMcpLogin, String> {
    let command_args = login_args(&backend, &server_name)?;
    let cwd = worktree_path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or("Could not find the home directory")?;
    if !cwd.is_dir() {
        return Err("The MCP project directory does not exist".to_string());
    }
    let servers = super::get_mcp_servers(
        app.clone(),
        Some(backend.clone()),
        Some(cwd.to_string_lossy().to_string()),
    )
    .await?;
    if !servers.iter().any(|server| server.name == server_name) {
        return Err(format!(
            "MCP server {server_name} is not configured for {backend}"
        ));
    }
    let binary = match backend.as_str() {
        "claude" => crate::claude_cli::resolve_cli_binary(&app),
        "codex" => crate::codex_cli::resolve_cli_binary(&app)?,
        _ => unreachable!("login_args checked backend"),
    };
    tokio::task::spawn_blocking(move || {
        check_login_support(&binary, &cwd)?;
        Ok(PreparedMcpLogin {
            command: binary.to_string_lossy().to_string(),
            command_args,
            worktree_path: cwd.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|error| format!("Could not prepare MCP sign-in: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_headless_login_for_supported_backends() {
        for backend in ["claude", "codex"] {
            assert_eq!(
                login_args(backend, "orbit-dev").unwrap(),
                ["mcp", "login", "--no-browser", "orbit-dev"]
            );
        }
    }

    #[test]
    fn keeps_server_name_as_one_argument() {
        let name = "server with spaces; $(touch /tmp/unwanted)";
        assert_eq!(login_args("claude", name).unwrap()[3], name);
    }

    #[test]
    fn rejects_flags_and_control_characters() {
        for name in ["", "--help", "-x", "server\nname", "server\0name"] {
            assert!(login_args("claude", name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn rejects_backends_without_a_headless_callback_flow() {
        for backend in ["opencode", "cursor", "grok", "kimi", "unknown"] {
            assert!(login_args(backend, "orbit-dev").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn requires_no_browser_support_and_uses_project_directory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("fake-cli");
        std::fs::write(
            &binary,
            "#!/bin/sh\n[ \"$(pwd -P)\" = \"$(cd \"$(dirname \"$0\")\" && pwd -P)\" ] || exit 1\n[ \"$*\" = 'mcp login --help' ] || exit 1\necho 'Options: --no-browser'\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(check_login_support(&binary, dir.path()).is_ok());
        std::fs::write(&binary, "#!/bin/sh\necho 'Unknown command: login'\n").unwrap();
        assert!(check_login_support(&binary, dir.path())
            .unwrap_err()
            .contains("Update"));
        std::fs::write(&binary, "#!/bin/sh\necho '--no-browser'\nexit 1\n").unwrap();
        assert!(check_login_support(&binary, dir.path()).is_err());
    }
    #[cfg(unix)]
    fn configured_runtime(dir: &Path) -> crate::RuntimeContext {
        use std::os::unix::fs::PermissionsExt;
        let app = crate::RuntimeContext::new(dir.join("app-data"), dir.to_path_buf()).unwrap();
        let binary = crate::claude_cli::get_cli_binary_path(&app).unwrap();
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, "#!/bin/sh\ncase \"$*\" in\n'mcp login --help') echo '--no-browser';;\n'mcp list') cat .health-status;;\n*) exit 1;;\nesac\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            dir.join(".mcp.json"),
            r#"{"mcpServers":{"orbit-dev":{"type":"http","url":"https://example.com/mcp"}}}"#,
        )
        .unwrap();
        app
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shared_dispatch_prepares_project_login_with_camel_or_snake_keys() {
        let dir = tempfile::tempdir().unwrap();
        let app = configured_runtime(dir.path());
        for (name_key, path_key) in [
            ("serverName", "worktreePath"),
            ("server_name", "worktree_path"),
        ] {
            let result = crate::http_server::dispatch::dispatch_command(
                &app,
                "prepare_mcp_login",
                serde_json::json!({"backend":"claude", name_key:"orbit-dev", path_key:dir.path()}),
            )
            .await
            .unwrap();
            assert_eq!(
                result["commandArgs"],
                serde_json::json!(["mcp", "login", "--no-browser", "orbit-dev"])
            );
            assert_eq!(
                result["worktreePath"],
                dir.path().to_string_lossy().as_ref()
            );
            assert_eq!(
                result["command"],
                crate::claude_cli::get_cli_binary_path(&app)
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            );
        }
        let error = prepare_mcp_login(
            app,
            "claude".into(),
            "missing-server".into(),
            Some(dir.path().to_string_lossy().into()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("not configured"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn project_health_check_runs_from_the_selected_directory() {
        let dir = tempfile::tempdir().unwrap();
        let app = configured_runtime(dir.path());
        std::fs::write(
            dir.path().join(".health-status"),
            "orbit-dev: https://example.com/mcp (HTTP) - connected\n",
        )
        .unwrap();
        let result = super::super::check_mcp_health(
            app,
            Some("claude".into()),
            Some(dir.path().to_string_lossy().into()),
        )
        .await
        .unwrap();
        assert_eq!(
            result.statuses["orbit-dev"],
            super::super::McpHealthStatus::Connected
        );
    }
}
