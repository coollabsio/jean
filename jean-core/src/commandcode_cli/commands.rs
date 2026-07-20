//! Tauri commands for Command Code CLI management.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use super::config::{
    ensure_cli_dir, find_system_commandcode_binary, get_cli_binary_path, get_cli_dir,
    resolve_cli_binary,
};
use crate::platform::silent_command;

const AUTH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const COMMANDCODE_NPM_REGISTRY_URL: &str = "https://registry.npmjs.org/command-code";
const COMMANDCODE_VERSIONS_CACHE_FILE: &str = "commandcode-versions-cache.json";
const FALLBACK_COMMANDCODE_VERSION: &str = "latest";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodePathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeInstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeModelInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeReleaseInfo {
    pub version: String,
    #[serde(alias = "tag_name")]
    pub tag_name: String,
    #[serde(alias = "published_at")]
    pub published_at: String,
    pub prerelease: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedCommandCodeVersions {
    versions: Vec<CommandCodeReleaseInfo>,
    #[serde(alias = "fetched_at")]
    fetched_at: String,
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek().is_some_and(|c| *c == '[') {
                let _ = chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn parse_version(stdout: &[u8]) -> Option<String> {
    let version = strip_ansi(&String::from_utf8_lossy(stdout))
        .trim()
        .to_string();
    if version.is_empty() {
        None
    } else {
        Some(version.trim_start_matches('v').to_string())
    }
}

fn looks_authenticated(output: &str) -> bool {
    let lower = output.to_lowercase();
    if lower.contains("not authenticated")
        || lower.contains("not logged in")
        || lower.contains("login required")
    {
        return false;
    }
    lower.contains("authenticated")
        || lower.contains("logged in")
        || lower.contains("signed in")
        || lower.contains("user") && lower.contains('@')
}

fn parse_json_auth_status(output: &str) -> Option<CommandCodeAuthStatus> {
    let value: serde_json::Value = serde_json::from_str(output.trim()).ok()?;
    let authenticated = value
        .get("authenticated")
        .or_else(|| value.get("logged_in"))
        .or_else(|| value.get("loggedIn"))
        .and_then(|v| v.as_bool());
    if let Some(authenticated) = authenticated {
        let error = value
            .get("error")
            .or_else(|| value.get("message"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(ToString::to_string);
        return Some(CommandCodeAuthStatus {
            authenticated,
            error,
            timed_out: false,
        });
    }

    let has_user = value.get("user").is_some()
        || value.get("email").and_then(|v| v.as_str()).is_some()
        || value.get("account").is_some();
    if has_user {
        return Some(CommandCodeAuthStatus {
            authenticated: true,
            error: None,
            timed_out: false,
        });
    }
    None
}

fn is_model_token(token: &str) -> bool {
    let token = token.trim_matches(|c: char| {
        c == '`' || c == '"' || c == '\'' || c == ',' || c == '|' || c == '*'
    });
    let lower = token.to_ascii_lowercase();
    if token.is_empty()
        || token.starts_with('-')
        || token.starts_with("http://")
        || token.starts_with("https://")
        || token.contains(':')
        || token.matches('/').count() > 1
        || token.eq_ignore_ascii_case("model")
        || token.eq_ignore_ascii_case("id")
        || token.eq_ignore_ascii_case("name")
        || token.eq_ignore_ascii_case("provider")
        || token.eq_ignore_ascii_case("best")
        || token.eq_ignore_ascii_case("for")
        || token.eq_ignore_ascii_case("default")
        || token == "cmd"
    {
        return false;
    }

    let provider_model = token
        .split_once('/')
        .is_some_and(|(provider, model)| !provider.is_empty() && !model.is_empty());

    provider_model
        || token.starts_with("claude-")
        || token.starts_with("gpt-")
        || token.starts_with("gemini-")
        || lower.contains("kimi-")
}

fn format_model_word(word: &str) -> String {
    let lower = word.to_ascii_lowercase();
    match lower.as_str() {
        "claude" => "Claude".to_string(),
        "gpt" => "GPT".to_string(),
        "glm" => "GLM".to_string(),
        "kimi" => "Kimi".to_string(),
        "codex" => "Codex".to_string(),
        "sonnet" => "Sonnet".to_string(),
        "haiku" => "Haiku".to_string(),
        "opus" => "Opus".to_string(),
        "minimax" => "MiniMax".to_string(),
        "qwen" => "Qwen".to_string(),
        "nvidia" => "NVIDIA".to_string(),
        _ if lower.starts_with("qwen") => format!("Qwen{}", &word[4..]),
        _ if lower.starts_with("kimi") => format!("Kimi{}", &word[4..]),
        _ if word.len() <= 3 || word.chars().any(|c| c.is_ascii_digit()) => {
            word.to_ascii_uppercase()
        }
        _ => {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                }
                None => String::new(),
            }
        }
    }
}

fn label_from_model_id(id: &str) -> String {
    let raw_tokens: Vec<String> = id
        .rsplit('/')
        .next()
        .unwrap_or(id)
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(ToString::to_string)
        .collect();

    let mut merged_tokens = Vec::new();
    let mut i = 0;
    while i < raw_tokens.len() {
        let current = &raw_tokens[i];
        if current.len() == 1
            && current.chars().all(|c| c.is_ascii_digit())
            && raw_tokens
                .get(i + 1)
                .is_some_and(|next| next.len() == 1 && next.chars().all(|c| c.is_ascii_digit()))
        {
            merged_tokens.push(format!("{}.{}", current, raw_tokens[i + 1]));
            i += 2;
            continue;
        }
        merged_tokens.push(current.clone());
        i += 1;
    }

    merged_tokens
        .iter()
        .map(|word| format_model_word(word))
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_models_output(output: &str) -> Vec<CommandCodeModelInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for raw_line in strip_ansi(output).lines() {
        let line = raw_line
            .trim()
            .trim_start_matches(['|', '-', '*', '•'])
            .trim();
        if line.is_empty() {
            continue;
        }
        let Some(raw_token) = line
            .split(|c: char| c.is_whitespace() || c == '|')
            .find(|token| is_model_token(token))
        else {
            continue;
        };
        let id = raw_token
            .trim_matches(|c: char| {
                c == '`' || c == '"' || c == '\'' || c == ',' || c == '|' || c == '*'
            })
            .to_string();
        if seen.insert(id.to_ascii_lowercase()) {
            models.push(CommandCodeModelInfo {
                label: label_from_model_id(&id),
                id,
            });
        }
    }
    models
}

enum TimedCommandResult {
    Output(Output),
    TimedOut,
}

fn run_command_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<TimedCommandResult, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn command: {error}"))?;
    let start = std::time::Instant::now();

    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            if let Some(mut handle) = child.stdout.take() {
                let _ = handle.read_to_end(&mut stdout);
            }
            if let Some(mut handle) = child.stderr.take() {
                let _ = handle.read_to_end(&mut stderr);
            }
            return Ok(TimedCommandResult::Output(Output {
                status,
                stdout,
                stderr,
            }));
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(TimedCommandResult::TimedOut);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub async fn check_commandcode_cli_installed(
    app: AppHandle,
) -> Result<CommandCodeCliStatus, String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_path.exists() {
        return Ok(CommandCodeCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }
    let version = match crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
    {
        Ok(output) if output.status.success() => parse_version(&output.stdout),
        Ok(output) => {
            log::warn!(
                "Command Code version command failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
            None
        }
        Err(error) => {
            log::warn!("Failed to execute Command Code CLI: {error}");
            None
        }
    };
    Ok(CommandCodeCliStatus {
        installed: true,
        version,
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

pub async fn check_commandcode_cli_auth(app: AppHandle) -> Result<CommandCodeAuthStatus, String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_path.exists() {
        return Ok(CommandCodeAuthStatus {
            authenticated: false,
            error: Some("Command Code CLI not found in PATH".to_string()),
            timed_out: false,
        });
    }

    for args in [
        ["status", "--json"].as_slice(),
        ["status"].as_slice(),
        ["whoami"].as_slice(),
    ] {
        let output = match run_command_with_timeout(
            {
                let mut command =
                    crate::platform::cli_command(&binary_path.to_string_lossy(), None);
                command.args(args);
                command
            },
            AUTH_CHECK_TIMEOUT,
        ) {
            Ok(TimedCommandResult::Output(output)) => output,
            Ok(TimedCommandResult::TimedOut) => {
                return Ok(CommandCodeAuthStatus {
                    authenticated: false,
                    error: Some(
                        "Command Code auth check timed out. Try again or run `cmd login`."
                            .to_string(),
                    ),
                    timed_out: true,
                })
            }
            Err(error) => {
                log::warn!(
                    "Failed to execute Command Code auth check {:?}: {error}",
                    args
                );
                continue;
            }
        };
        let combined = strip_ansi(&format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
        if let Some(status) = parse_json_auth_status(&combined) {
            return Ok(status);
        }
        if looks_authenticated(&combined) {
            return Ok(CommandCodeAuthStatus {
                authenticated: true,
                error: None,
                timed_out: false,
            });
        }
        if !output.status.success() {
            let msg = combined.trim();
            return Ok(CommandCodeAuthStatus {
                authenticated: false,
                error: Some(if msg.is_empty() {
                    "Not authenticated. Run `cmd login`.".to_string()
                } else {
                    msg.to_string()
                }),
                timed_out: false,
            });
        }
    }
    Ok(CommandCodeAuthStatus {
        authenticated: false,
        error: Some("Not authenticated. Run `cmd login`.".to_string()),
        timed_out: false,
    })
}

pub async fn detect_commandcode_in_path(
    app: AppHandle,
) -> Result<CommandCodePathDetection, String> {
    let Some(found_path) = find_system_commandcode_binary(&app) else {
        return Ok(CommandCodePathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    };

    let version = crate::platform::cli_command(&found_path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                parse_version(&o.stdout)
            } else {
                None
            }
        });
    let package_manager = crate::platform::detect_package_manager(&found_path);

    Ok(CommandCodePathDetection {
        found: true,
        path: Some(found_path.to_string_lossy().to_string()),
        version,
        package_manager,
    })
}

pub async fn list_commandcode_models(app: AppHandle) -> Result<Vec<CommandCodeModelInfo>, String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_path.exists() {
        return Ok(vec![]);
    }
    let output = run_command_with_timeout(
        {
            let mut command = crate::platform::cli_command(&binary_path.to_string_lossy(), None);
            command.arg("--list-models");
            command
        },
        Duration::from_secs(10),
    )?;
    let output = match output {
        TimedCommandResult::Output(output) => output,
        TimedCommandResult::TimedOut => {
            log::warn!("Command Code model list timed out");
            return Ok(vec![]);
        }
    };
    if !output.status.success() {
        log::warn!(
            "Command Code --list-models failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return Ok(vec![]);
    }
    Ok(parse_models_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn version_sort_key(version: &str) -> Vec<u64> {
    version
        .split(['.', '-'])
        .take(3)
        .map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect()
}

fn is_prerelease_version(version: &str) -> bool {
    version.contains('-')
}

fn parse_npm_commandcode_versions(body: &str) -> Result<Vec<CommandCodeReleaseInfo>, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Failed to parse npm metadata: {e}"))?;
    let versions_obj = value
        .get("versions")
        .and_then(|versions| versions.as_object())
        .ok_or("npm metadata missing versions object")?;

    let mut versions: Vec<CommandCodeReleaseInfo> = versions_obj
        .keys()
        .filter(|version| !version.trim().is_empty())
        .map(|version| CommandCodeReleaseInfo {
            version: version.to_string(),
            tag_name: format!("command-code@{version}"),
            published_at: String::new(),
            prerelease: is_prerelease_version(version),
        })
        .collect();

    versions.sort_by(|a, b| {
        a.prerelease
            .cmp(&b.prerelease)
            .then_with(|| version_sort_key(&b.version).cmp(&version_sort_key(&a.version)))
            .then_with(|| b.version.cmp(&a.version))
    });
    versions.truncate(20);
    Ok(versions)
}

fn fallback_commandcode_versions() -> Vec<CommandCodeReleaseInfo> {
    vec![CommandCodeReleaseInfo {
        version: FALLBACK_COMMANDCODE_VERSION.to_string(),
        tag_name: "command-code@latest".to_string(),
        published_at: String::new(),
        prerelease: false,
    }]
}

fn save_commandcode_versions_cache(app: &AppHandle, versions: &[CommandCodeReleaseInfo]) {
    let cache_path = match ensure_cli_dir(app) {
        Ok(dir) => dir.join(COMMANDCODE_VERSIONS_CACHE_FILE),
        Err(e) => {
            log::warn!("Cannot resolve/create Command Code CLI dir for cache: {e}");
            return;
        }
    };
    let cached = CachedCommandCodeVersions {
        versions: versions.to_vec(),
        fetched_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default(),
    };
    match serde_json::to_string(&cached) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&cache_path, json) {
                log::warn!("Failed to write Command Code versions cache: {e}");
            }
        }
        Err(e) => log::warn!("Failed to serialize Command Code versions cache: {e}"),
    }
}

fn load_commandcode_versions_cache(app: &AppHandle) -> Option<Vec<CommandCodeReleaseInfo>> {
    let cache_path = get_cli_dir(app).ok()?.join(COMMANDCODE_VERSIONS_CACHE_FILE);
    let contents = std::fs::read_to_string(cache_path).ok()?;
    let cached: CachedCommandCodeVersions = serde_json::from_str(&contents).ok()?;
    if cached.versions.is_empty() {
        None
    } else {
        Some(cached.versions)
    }
}

async fn fetch_commandcode_versions_from_npm() -> Result<Vec<CommandCodeReleaseInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create npm registry client: {e}"))?;
    let response = client
        .get(COMMANDCODE_NPM_REGISTRY_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Command Code npm metadata: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "npm registry returned status: {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read npm registry response: {e}"))?;
    parse_npm_commandcode_versions(&body)
}

pub async fn get_available_commandcode_versions(
    app: AppHandle,
) -> Result<Vec<CommandCodeReleaseInfo>, String> {
    match fetch_commandcode_versions_from_npm().await {
        Ok(versions) if !versions.is_empty() => {
            save_commandcode_versions_cache(&app, &versions);
            Ok(versions)
        }
        Ok(_) => {
            log::warn!("npm registry returned no Command Code versions, falling back to cache");
            Ok(load_commandcode_versions_cache(&app).unwrap_or_else(fallback_commandcode_versions))
        }
        Err(e) => {
            log::warn!("Command Code npm registry request failed ({e}), falling back to cache");
            Ok(load_commandcode_versions_cache(&app).unwrap_or_else(fallback_commandcode_versions))
        }
    }
}

pub async fn check_commandcode_cli_version_exists(
    _app: AppHandle,
    version: String,
) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create npm registry client: {e}"))?;
    let response = client
        .get(COMMANDCODE_NPM_REGISTRY_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Command Code npm metadata: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "npm registry returned status: {}",
            response.status()
        ));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse npm metadata: {e}"))?;
    Ok(value
        .get("versions")
        .and_then(|versions| versions.as_object())
        .is_some_and(|versions| versions.contains_key(version)))
}

fn commandcode_package(version: Option<&str>) -> String {
    match version.map(str::trim).filter(|v| !v.is_empty()) {
        Some("latest") | None => "command-code@latest".to_string(),
        Some(version) if version.starts_with("command-code@") => version.to_string(),
        Some(version) => format!("command-code@{version}"),
    }
}

pub async fn get_commandcode_install_command(
    app: AppHandle,
) -> Result<CommandCodeInstallCommand, String> {
    let cli_dir = get_cli_dir(&app)?;
    Ok(CommandCodeInstallCommand {
        command: "npm".to_string(),
        args: vec![
            "install".to_string(),
            "--prefix".to_string(),
            cli_dir.to_string_lossy().to_string(),
            commandcode_package(None),
        ],
        description: "Install the latest Command Code into Jean's managed app-data directory"
            .to_string(),
    })
}

pub async fn install_commandcode_cli(
    app: AppHandle,
    version: Option<String>,
) -> Result<(), String> {
    let cli_dir = ensure_cli_dir(&app)?;
    let package = commandcode_package(version.as_deref());
    let output = silent_command("npm")
        .args(["install", "--prefix"])
        .arg(&cli_dir)
        .arg(package)
        .output()
        .map_err(|e| format!("Failed to run npm install for Command Code CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(format!(
            "Command Code CLI install failed: {}",
            if stderr.is_empty() { stdout } else { stderr }
        ));
    }

    let binary_path = get_cli_binary_path(&app)?;
    if !binary_path.exists() {
        return Err(format!(
            "Command Code install completed but binary was not found at {}",
            binary_path.display()
        ));
    }

    let verify = crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to verify Command Code CLI: {e}"))?;
    if !verify.status.success() {
        return Err("Command Code CLI verification failed".to_string());
    }

    Ok(())
}

pub async fn uninstall_commandcode_cli(app: AppHandle) -> Result<(), String> {
    let cli_dir = get_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove Command Code CLI directory: {e}"))?;
    }
    Ok(())
}

pub async fn update_commandcode_cli(app: AppHandle) -> Result<(), String> {
    install_commandcode_cli(app, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_npm_commandcode_versions_sorts_latest_stable_first() {
        let versions = parse_npm_commandcode_versions(
            r#"{
  "dist-tags": { "latest": "1.2.0" },
  "versions": {
    "1.0.0": {},
    "1.2.0-beta.1": {},
    "1.1.0": {},
    "1.2.0": {}
  }
}"#,
        )
        .expect("valid npm metadata should parse");

        assert_eq!(
            versions
                .iter()
                .map(|v| (&v.version, v.prerelease))
                .collect::<Vec<_>>(),
            vec![
                (&"1.2.0".to_string(), false),
                (&"1.1.0".to_string(), false),
                (&"1.0.0".to_string(), false),
                (&"1.2.0-beta.1".to_string(), true),
            ]
        );
        assert_eq!(versions[0].tag_name, "command-code@1.2.0");
    }

    #[test]
    fn commandcode_command_payloads_serialize_as_camel_case() {
        let auth_json = serde_json::to_value(CommandCodeAuthStatus {
            authenticated: false,
            error: None,
            timed_out: true,
        })
        .unwrap();
        let path_json = serde_json::to_value(CommandCodePathDetection {
            found: true,
            path: Some("/usr/bin/commandcode".to_string()),
            version: Some("1.0.0".to_string()),
            package_manager: Some("npm".to_string()),
        })
        .unwrap();
        let release_json = serde_json::to_value(CommandCodeReleaseInfo {
            version: "1.0.0".to_string(),
            tag_name: "command-code@1.0.0".to_string(),
            published_at: "2026-06-08".to_string(),
            prerelease: false,
        })
        .unwrap();

        assert_eq!(
            auth_json.get("timedOut").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(auth_json.get("timed_out").is_none());
        assert_eq!(
            path_json.get("packageManager").and_then(|v| v.as_str()),
            Some("npm")
        );
        assert!(path_json.get("package_manager").is_none());
        assert_eq!(
            release_json.get("tagName").and_then(|v| v.as_str()),
            Some("command-code@1.0.0")
        );
        assert_eq!(
            release_json.get("publishedAt").and_then(|v| v.as_str()),
            Some("2026-06-08")
        );
    }

    #[test]
    fn parse_models_output_formats_versions_and_skips_help_lines() {
        let models = parse_models_output(
            r#"
Available models  ·  28 models

Anthropic

claude-sonnet-4-6                  best combo of speed & intelligence (recommended)
claude-opus-4-8                    most intelligent for agents and coding
claude-haiku-4-5                   fastest & most compact, great for quick tasks

OpenAI

gpt-5.5                            latest frontier model for general complex work
gpt-5.3-codex                      frontier coding model

Open Source

moonshotai/Kimi-K2.5               multimodal frontend coding (default)
nvidia/nemotron-3-ultra-550b-a55b  open reasoning model for long-horizon autonomous agents

"/:
commandcode/"/:

Pass the full id, or just the short name after the last "/":
cmd --model moonshotai/Kimi-K2.5
cmd --model kimi-k2.5

Docs:  https://commandcode.ai/docs/reference/cli/models
"#,
        );

        assert_eq!(
            models
                .iter()
                .find(|model| model.id == "claude-sonnet-4-6")
                .map(|model| model.label.as_str()),
            Some("Claude Sonnet 4.6")
        );
        assert_eq!(
            models
                .iter()
                .find(|model| model.id == "claude-opus-4-8")
                .map(|model| model.label.as_str()),
            Some("Claude Opus 4.8")
        );
        assert_eq!(
            models
                .iter()
                .find(|model| model.id == "nvidia/nemotron-3-ultra-550b-a55b")
                .map(|model| model.label.as_str()),
            Some("Nemotron 3 Ultra 550B A55B")
        );
        assert!(!models.iter().any(|model| model.id.starts_with("https://")));
        assert!(!models.iter().any(|model| model.id == "/\":"));
        assert_eq!(
            models
                .iter()
                .filter(|model| model.id == "moonshotai/Kimi-K2.5")
                .count(),
            1
        );
    }
}
