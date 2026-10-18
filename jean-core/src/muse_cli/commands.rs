use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

use super::config::{
    auth_path, binary_exists, ensure_cli_dir, find_system_muse_binary, get_cli_binary_path,
    get_cli_dir, muse_mode, provider_override, resolve_cli_binary,
};
use crate::platform::silent_command;

const INSTALL_SCRIPT_URL: &str = "https://dev.meta.ai/install.sh";
const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(15);
pub const DEFAULT_MODEL_ID: &str = "muse/default";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuseCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MuseAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub timed_out: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusePathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MuseModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuseInstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
}

/// `Muse Code 1.4.10 (1.4.10-R6427.1)` -> `1.4.10`.
fn parse_version(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .split_whitespace()
        .find(|part| {
            part.trim_start_matches('v')
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_digit())
        })
        .map(|part| part.trim_start_matches('v').to_string())
}

fn version_of(binary: &Path) -> Option<String> {
    crate::platform::cli_command(&binary.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| parse_version(&output.stdout))
}

pub async fn check_muse_cli_installed(app: AppHandle) -> Result<MuseCliStatus, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(MuseCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }
    Ok(MuseCliStatus {
        installed: true,
        version: version_of(&binary),
        path: Some(binary.to_string_lossy().to_string()),
    })
}

pub async fn detect_muse_in_path(app: AppHandle) -> Result<MusePathDetection, String> {
    let Some(binary) = find_system_muse_binary(&app) else {
        return Ok(MusePathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    };
    Ok(MusePathDetection {
        found: true,
        version: version_of(&binary),
        path: Some(binary.to_string_lossy().to_string()),
        package_manager: Some("path".to_string()),
    })
}

/// Credential precedence per `muse login --help`: `META_API_KEY`, then the
/// stored key or browser session in `auth.json` (any non-empty `providers.meta`).
fn auth_status(api_key_env: Option<&str>, auth_file: Option<&Path>) -> MuseAuthStatus {
    if api_key_env.is_some_and(|key| !key.trim().is_empty()) {
        return MuseAuthStatus {
            authenticated: true,
            error: None,
            timed_out: false,
        };
    }
    let stored = auth_file
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|value| value.pointer("/providers/meta").cloned())
        .is_some_and(|meta| meta.as_object().is_some_and(|meta| !meta.is_empty()));
    MuseAuthStatus {
        authenticated: stored,
        error: (!stored)
            .then(|| "Not signed in. Run `muse login` or set META_API_KEY.".to_string()),
        timed_out: false,
    }
}

pub async fn check_muse_cli_auth(app: AppHandle) -> Result<MuseAuthStatus, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(MuseAuthStatus {
            authenticated: false,
            error: Some("Muse Code CLI not installed".to_string()),
            timed_out: false,
        });
    }
    let api_key = std::env::var("META_API_KEY").ok();
    Ok(auth_status(api_key.as_deref(), auth_path().as_deref()))
}

fn builtin_models() -> Vec<MuseModelInfo> {
    vec![
        MuseModelInfo {
            id: DEFAULT_MODEL_ID.to_string(),
            label: "Muse default".to_string(),
            is_default: true,
        },
        MuseModelInfo {
            id: "muse/muse-spark-1.2".to_string(),
            label: "Muse Spark 1.2".to_string(),
            is_default: false,
        },
    ]
}

/// Rows from MSP `model/list` (`result.models[]`), namespaced with `muse/`.
fn parse_model_list(result: &Value) -> Vec<MuseModelInfo> {
    result
        .pointer("/result/models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model.get("modelId")?.as_str()?;
            Some(MuseModelInfo {
                id: format!("muse/{id}"),
                label: model
                    .get("displayLabel")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                is_default: false,
            })
        })
        .collect()
}

fn catalog_models(binary: PathBuf) -> Vec<MuseModelInfo> {
    let cwd = std::env::temp_dir();
    let Ok((mut child, mut client)) = crate::chat::muse::spawn_serve(
        &binary,
        &crate::chat::muse::ServeOptions {
            cwd: &cwd,
            mode: muse_mode(Some("plan")),
            model: None,
            developer_prompt: None,
            provider: None,
        },
        &[],
    ) else {
        return Vec::new();
    };
    let pid = child.id();
    std::thread::spawn(move || {
        std::thread::sleep(MODEL_LIST_TIMEOUT);
        let _ = crate::platform::kill_process(pid);
    });
    let mut ignore = |_: &Value| Ok(());
    let models = crate::chat::muse::initialize(&mut client, &mut ignore)
        .and_then(|_| client.request("model/list", serde_json::json!({}), &mut ignore))
        .map(|result| parse_model_list(&result))
        .unwrap_or_default();
    crate::platform::kill_and_reap(&mut child);
    models
}

pub async fn list_muse_models(app: AppHandle) -> Result<Vec<MuseModelInfo>, String> {
    let mut models = builtin_models();
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) || provider_override().is_some() {
        return Ok(models);
    }
    if !check_muse_cli_auth(app).await?.authenticated {
        return Ok(models);
    }
    let catalog = tokio::task::spawn_blocking(move || catalog_models(binary))
        .await
        .unwrap_or_default();
    for model in catalog {
        if !models.iter().any(|known| known.id == model.id) {
            models.push(model);
        }
    }
    Ok(models)
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Meta's install.sh is bash; `MUSE_INSTALL_DIR` picks the target and
/// `MUSE_NO_MODIFY_PATH` keeps it out of shell profiles.
fn unix_install_script(dir: &str) -> String {
    format!(
        "curl -fsSL {INSTALL_SCRIPT_URL} | MUSE_INSTALL_DIR={} MUSE_NO_MODIFY_PATH=1 bash",
        shell_single_quote(dir)
    )
}

pub async fn get_muse_install_command(app: AppHandle) -> Result<MuseInstallCommand, String> {
    if cfg!(windows) {
        return Err("Muse Code publishes no Windows installer; use WSL".to_string());
    }
    let dir = get_cli_dir(&app)?.to_string_lossy().to_string();
    Ok(MuseInstallCommand {
        command: "sh".to_string(),
        args: vec!["-c".to_string(), unix_install_script(&dir)],
        description: "Install Muse Code from Meta's official installer".to_string(),
    })
}

pub async fn install_muse_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    if let Some(requested) = version
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "latest")
    {
        log::warn!("Muse installer always installs the latest release; ignoring {requested}");
    }
    let _ = ensure_cli_dir(&app)?;
    let install = get_muse_install_command(app.clone()).await?;
    let output = silent_command(&install.command)
        .args(&install.args)
        .output()
        .map_err(|error| format!("Failed to install Muse Code: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if !output.status.success() {
        return Err(format!("Muse Code install failed: {detail}"));
    }
    let binary = get_cli_binary_path(&app)?;
    if !binary.exists() {
        return Err(format!(
            "Muse Code install completed but the `muse` launcher was not found ({})",
            if detail.is_empty() {
                "no installer output"
            } else {
                detail
            }
        ));
    }
    crate::expose_managed_cli("muse", &binary);
    Ok(())
}

pub async fn uninstall_muse_cli(app: AppHandle) -> Result<(), String> {
    let dir = get_cli_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|error| format!("Failed to remove Muse Code: {error}"))?;
    }
    Ok(())
}

pub async fn update_muse_cli(app: AppHandle) -> Result<(), String> {
    uninstall_muse_cli(app.clone()).await?;
    install_muse_cli(app, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_version_banner() {
        assert_eq!(
            parse_version(b"Muse Code 1.4.10 (1.4.10-R6427.1)\n").as_deref(),
            Some("1.4.10")
        );
    }

    #[test]
    fn auth_detection_reads_env_then_auth_json() {
        let temp = tempfile::tempdir().expect("tempdir");
        let config_dir = temp.path().join("muse");
        std::fs::create_dir_all(&config_dir).unwrap();
        let auth_file = config_dir.join("auth.json");

        assert!(!auth_status(None, Some(&auth_file)).authenticated);
        assert!(auth_status(Some("sk-meta"), Some(&auth_file)).authenticated);
        assert!(!auth_status(Some("  "), Some(&auth_file)).authenticated);

        std::fs::write(
            &auth_file,
            r#"{"schema_version":1,"providers":{"meta":{"api_key":"stored"}}}"#,
        )
        .unwrap();
        let status = auth_status(None, Some(&auth_file));
        assert_eq!(
            status,
            MuseAuthStatus {
                authenticated: true,
                error: None,
                timed_out: false
            }
        );

        std::fs::write(
            &auth_file,
            r#"{"schema_version":1,"providers":{"meta":{}}}"#,
        )
        .unwrap();
        let status = auth_status(None, Some(&auth_file));
        assert!(!status.authenticated);
        assert_eq!(
            status.error.as_deref(),
            Some("Not signed in. Run `muse login` or set META_API_KEY.")
        );
    }

    #[test]
    fn auth_path_follows_xdg_config_home() {
        let temp = tempfile::tempdir().expect("tempdir");
        let previous = std::env::var_os("XDG_CONFIG_HOME");
        std::env::set_var("XDG_CONFIG_HOME", temp.path());
        let path = auth_path();
        match previous {
            Some(value) => std::env::set_var("XDG_CONFIG_HOME", value),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
        assert_eq!(path, Some(temp.path().join("muse").join("auth.json")));
    }

    #[test]
    fn auth_status_serializes_camel_case() {
        let value = serde_json::to_value(MuseAuthStatus {
            authenticated: false,
            error: None,
            timed_out: true,
        })
        .unwrap();
        assert_eq!(value["timedOut"], true);
        assert!(value.get("timed_out").is_none());
    }

    #[test]
    fn install_script_sets_dir_and_skips_profile_edits() {
        let script = unix_install_script("/tmp/it's here/muse-cli");
        assert_eq!(
            script,
            "curl -fsSL https://dev.meta.ai/install.sh | MUSE_INSTALL_DIR='/tmp/it'\\''s here/muse-cli' MUSE_NO_MODIFY_PATH=1 bash"
        );
    }

    #[test]
    fn model_list_rows_are_namespaced_and_merged_after_builtins() {
        let rows = parse_model_list(&serde_json::json!({"result": {"models": [
            {"modelId": "muse-spark-1.2", "displayLabel": "Muse Spark 1.2", "isDefault": true},
            {"modelId": "muse-next", "displayLabel": "Muse Next"}
        ]}}));
        assert_eq!(
            rows,
            vec![
                MuseModelInfo {
                    id: "muse/muse-spark-1.2".to_string(),
                    label: "Muse Spark 1.2".to_string(),
                    is_default: false
                },
                MuseModelInfo {
                    id: "muse/muse-next".to_string(),
                    label: "Muse Next".to_string(),
                    is_default: false
                },
            ]
        );
        assert_eq!(builtin_models()[0].id, DEFAULT_MODEL_ID);
        assert!(builtin_models()[0].is_default);
    }
}
