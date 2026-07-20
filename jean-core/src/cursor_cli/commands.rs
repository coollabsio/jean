//! Tauri commands for Cursor CLI management.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::Duration;
use tauri::AppHandle;

use super::config::resolve_cli_binary;

const AUTH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorInstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
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
    let version = String::from_utf8_lossy(stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version.trim_start_matches('v').to_string())
    }
}

fn looks_authenticated(output: &str) -> bool {
    let lower = output.to_lowercase();
    if lower.contains("logged in as") {
        return true;
    }

    lower.lines().any(|line| {
        line.contains("user email")
            && line.contains('@')
            && !line.contains("not logged in")
            && !line.contains("unknown")
            && !line.ends_with(':')
    })
}

fn parse_cursor_models_output(output: &str) -> Vec<CursorModelInfo> {
    let cleaned = strip_ansi(output);
    let mut models = Vec::new();

    for line in cleaned.lines() {
        let line = line.trim();
        if line.is_empty()
            || line == "Available models"
            || line.starts_with("Loading models")
            || line.starts_with("Tip:")
        {
            continue;
        }

        let Some((id, rest)) = line.split_once(" - ") else {
            continue;
        };
        let mut label = rest.trim().to_string();
        let is_current = label.contains("(current)");
        let is_default = label.contains("(default)");
        label = label
            .replace("(current)", "")
            .replace("(default)", "")
            .trim()
            .to_string();

        models.push(CursorModelInfo {
            id: id.trim().to_string(),
            label,
            is_default,
            is_current,
        });
    }

    sort_cursor_models(&mut models);
    models
}

fn cursor_model_family_rank(id: &str) -> u8 {
    if id.starts_with("composer-") {
        0
    } else if id.starts_with("gpt-") {
        1
    } else if id.starts_with("claude-") {
        2
    } else {
        3
    }
}

fn cursor_model_version_numbers(id: &str) -> Vec<u32> {
    id.split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

fn cursor_model_is_fast(id: &str) -> bool {
    id.ends_with("-fast")
}

fn sort_cursor_models(models: &mut [CursorModelInfo]) {
    models.sort_by(|a, b| {
        let a_rank = cursor_model_family_rank(&a.id);
        let b_rank = cursor_model_family_rank(&b.id);

        a_rank.cmp(&b_rank).then_with(|| {
            if matches!(a_rank, 0 | 1 | 2) && a_rank == b_rank {
                cursor_model_version_numbers(&b.id)
                    .cmp(&cursor_model_version_numbers(&a.id))
                    .then_with(|| cursor_model_is_fast(&b.id).cmp(&cursor_model_is_fast(&a.id)))
            } else {
                std::cmp::Ordering::Equal
            }
        })
    });
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

pub async fn check_cursor_cli_installed(app: AppHandle) -> Result<CursorCliStatus, String> {
    log::trace!("Checking Cursor CLI installation status");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_cli_binary(&app);

    if wsl.enabled {
        let tool = binary_path.to_string_lossy().to_string();
        let installed = if tool.starts_with('/') {
            crate::platform::wsl_file_executable(&wsl.distro, &tool)
        } else {
            crate::platform::check_wsl_tool(&wsl.distro, &tool)
        };
        if !installed {
            return Ok(CursorCliStatus {
                installed: false,
                version: None,
                path: None,
            });
        }
        let version = crate::platform::wsl_tool_version(&wsl.distro, &tool)
            .and_then(|v| parse_version(v.as_bytes()));
        return Ok(CursorCliStatus {
            installed: true,
            version,
            path: Some(tool),
        });
    }

    if !binary_path.exists() {
        return Ok(CursorCliStatus {
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
                "Cursor CLI version command failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
            None
        }
        Err(error) => {
            log::warn!("Failed to execute Cursor CLI: {error}");
            None
        }
    };

    Ok(CursorCliStatus {
        installed: true,
        version,
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

pub async fn check_cursor_cli_auth(app: AppHandle) -> Result<CursorAuthStatus, String> {
    log::trace!("Checking Cursor CLI authentication status");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_cli_binary(&app);

    let binary_str = binary_path.to_string_lossy().to_string();
    if !wsl.enabled && !binary_path.exists() {
        return Ok(CursorAuthStatus {
            authenticated: false,
            error: Some("Cursor CLI not found in PATH".to_string()),
            timed_out: false,
        });
    }
    if wsl.enabled {
        let installed = if binary_str.starts_with('/') {
            crate::platform::wsl_file_executable(&wsl.distro, &binary_str)
        } else {
            crate::platform::check_wsl_tool(&wsl.distro, &binary_str)
        };
        if !installed {
            return Ok(CursorAuthStatus {
                authenticated: false,
                error: Some("Cursor CLI not installed inside WSL".to_string()),
                timed_out: false,
            });
        }
    }

    for args in [["status"].as_slice(), ["about"].as_slice()] {
        let output = match run_command_with_timeout(
            {
                let mut command = crate::platform::wsl_aware_command(&binary_str, None);
                command.args(args);
                command
            },
            AUTH_CHECK_TIMEOUT,
        ) {
            Ok(TimedCommandResult::Output(output)) => output,
            Ok(TimedCommandResult::TimedOut) => {
                log::warn!("Cursor CLI auth check {:?} timed out", args);
                return Ok(CursorAuthStatus {
                    authenticated: false,
                    error: Some(
                        "Cursor auth check timed out. Try again or run `agent login`.".to_string(),
                    ),
                    timed_out: true,
                });
            }
            Err(error) => {
                log::warn!(
                    "Failed to execute Cursor CLI auth check {:?}: {error}",
                    args
                );
                continue;
            }
        };

        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let cleaned = strip_ansi(&combined);
        if looks_authenticated(&cleaned) {
            return Ok(CursorAuthStatus {
                authenticated: true,
                error: None,
                timed_out: false,
            });
        }

        if !output.status.success() {
            let stderr = cleaned.trim().to_string();
            return Ok(CursorAuthStatus {
                authenticated: false,
                error: Some(if stderr.is_empty() {
                    "Not authenticated. Run `agent login`.".to_string()
                } else {
                    stderr
                }),
                timed_out: false,
            });
        }
    }

    Ok(CursorAuthStatus {
        authenticated: false,
        error: Some("Not authenticated. Run `agent login`.".to_string()),
        timed_out: false,
    })
}

pub async fn detect_cursor_in_path(_app: AppHandle) -> Result<CursorPathDetection, String> {
    log::trace!("Detecting Cursor CLI in system PATH");

    let detection = crate::platform::detect_cli_in_path(super::config::CLI_TOOL_NAME, None, None);

    if !detection.found {
        return Ok(CursorPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    }

    let version = detection.version.and_then(|v| parse_version(v.as_bytes()));

    Ok(CursorPathDetection {
        found: true,
        path: detection.path,
        version,
        package_manager: detection.package_manager,
    })
}

pub async fn list_cursor_models(app: AppHandle) -> Result<Vec<CursorModelInfo>, String> {
    log::trace!("Listing Cursor models");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_cli_binary(&app);
    let binary_str = binary_path.to_string_lossy().to_string();
    if !wsl.enabled && !binary_path.exists() {
        return Err("Cursor CLI not found in PATH".to_string());
    }
    if wsl.enabled && !crate::platform::check_wsl_tool(&wsl.distro, &binary_str) {
        return Err("Cursor CLI not installed inside WSL".to_string());
    }

    let command_attempts: [&[&str]; 2] = [&["models"], &["--list-models"]];
    let mut errors = Vec::new();
    let mut had_successful_listing = false;

    for args in command_attempts {
        let output = crate::platform::wsl_aware_command(&binary_str, None)
            .args(args)
            .output()
            .map_err(|e| format!("Failed to run Cursor models command {:?}: {e}", args))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            errors.push(format!("{:?}: {}", args, stderr));
            continue;
        }

        had_successful_listing = true;
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let models = parse_cursor_models_output(&combined);
        if !models.is_empty() {
            return Ok(models);
        }

        errors.push(format!("{:?}: no parseable models", args));
    }

    if had_successful_listing {
        Ok(vec![CursorModelInfo {
            id: "auto".to_string(),
            label: "Auto".to_string(),
            is_default: false,
            is_current: false,
        }])
    } else {
        Err(format!(
            "Cursor model listing failed. Tried `models` and `--list-models`: {}",
            errors.join("; ")
        ))
    }
}

pub async fn get_cursor_install_command(_app: AppHandle) -> Result<CursorInstallCommand, String> {
    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        // Run Cursor's Linux installer inside the WSL distro so the binary
        // ends up on the distro-side $PATH rather than on Windows.
        return Ok(CursorInstallCommand {
            command: "wsl.exe".to_string(),
            args: vec![
                "-d".to_string(),
                wsl.distro,
                "--".to_string(),
                "bash".to_string(),
                "-lc".to_string(),
                "curl -fsSL https://cursor.com/install | bash".to_string(),
            ],
            description:
                "Installs Cursor Agent inside your WSL distro using Cursor's official installer"
                    .to_string(),
        });
    }

    #[cfg(target_os = "windows")]
    {
        Ok(CursorInstallCommand {
            command: "powershell".to_string(),
            args: vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "irm https://cursor.com/install | iex".to_string(),
            ],
            description: "Installs Cursor Agent using Cursor's official installer".to_string(),
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(CursorInstallCommand {
            command: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                "curl -fsSL https://cursor.com/install | bash".to_string(),
            ],
            description: "Installs Cursor Agent using Cursor's official installer".to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_escape_sequences() {
        let input = "\u{1b}[2K\u{1b}[G✓ Logged in as test@example.com";
        assert_eq!(strip_ansi(input), "✓ Logged in as test@example.com");
    }

    #[test]
    fn auth_parser_accepts_user_email_lines() {
        assert!(looks_authenticated(
            "About Cursor CLI\nUser Email          test@example.com"
        ));
        assert!(!looks_authenticated(
            "About Cursor CLI\nUser Email          unknown"
        ));
    }

    #[test]
    fn parses_current_cursor_model_list_output() {
        let output = r#"
Available models

auto - Auto
composer-2-fast - Composer 2 Fast (default)
composer-2 - Composer 2 (current)
composer-2.5 - Composer 2.5
composer-2.5-fast - Composer 2.5 Fast
gpt-5.4-high - GPT-5.4 1M High
gpt-5.5-high-fast - GPT-5.5 High Fast
claude-4.6-sonnet-medium - Sonnet 4.6 1M
claude-opus-4-7-thinking-high - Opus 4.7 1M High Thinking
gemini-3.1-pro - Gemini 3.1 Pro
grok-4.3 - Grok 4.3 1M

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
"#;

        let models = parse_cursor_models_output(output);

        assert_eq!(models.len(), 11);
        assert_eq!(models[0].id, "composer-2.5-fast");
        assert_eq!(models[0].label, "Composer 2.5 Fast");
        assert!(!models[0].is_default);
        assert!(!models[0].is_current);
        assert_eq!(models[1].id, "composer-2.5");
        assert_eq!(models[1].label, "Composer 2.5");
        assert_eq!(models[2].id, "composer-2-fast");
        assert_eq!(models[2].label, "Composer 2 Fast");
        assert!(models[2].is_default);
        assert!(!models[2].is_current);
        assert_eq!(models[3].id, "composer-2");
        assert_eq!(models[3].label, "Composer 2");
        assert!(models[3].is_current);
        assert_eq!(models[4].id, "gpt-5.5-high-fast");
        assert_eq!(models[5].id, "gpt-5.4-high");
        assert_eq!(models[6].id, "claude-opus-4-7-thinking-high");
        assert_eq!(models[7].id, "claude-4.6-sonnet-medium");
        assert_eq!(models[8].id, "auto");
    }

    #[test]
    fn cursor_model_parser_ignores_unparseable_lines_and_strips_ansi() {
        let output = "\u{1b}[2KLoading models...\nnot a model\nkimi-k2.5 - Kimi K2.5\n";

        let models = parse_cursor_models_output(output);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "kimi-k2.5");
        assert_eq!(models[0].label, "Kimi K2.5");
    }
}
