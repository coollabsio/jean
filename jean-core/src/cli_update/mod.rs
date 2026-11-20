use serde::{Deserialize, Serialize};
use std::fs;
use std::process::{Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::NamedTempFile;

use crate::platform::path_tool_command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliPathUpdateOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

const ALLOWED_CLI_TYPES: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "gh",
    "glab",
    "coderabbit",
    "pi",
    "commandcode",
    "grok",
    "devin",
];
const ALLOWED_COMMANDS: &[&str] = &[
    "brew",
    "npm",
    "bun",
    "winget",
    "scoop",
    "choco",
    "claude",
    "opencode",
    "coderabbit",
    "pi",
    "cmd",
    "command-code",
    "grok",
    "devin",
];

// A self-update that legitimately downloads a new version should finish well
// inside this window. The bound exists so a stuck updater cannot leave the UI
// spinner pending forever.
const UPDATE_COMMAND_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Reduce `command` to the name matched against [`ALLOWED_COMMANDS`].
///
/// Windows CLI paths reach this as launcher shims — npm installs `claude.cmd`,
/// and that `.cmd` is what path detection hands back — so the allowlist has to
/// compare the bare stem or every Windows self-update is refused (issue #675).
/// This gives `.cmd`/`.bat` the same treatment `.exe` already had, and nothing
/// more: the basename must still be an allowlisted updater.
fn allowlist_key(command: &str) -> &str {
    let name = std::path::Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);

    let Some(extension) = std::path::Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
    else {
        return name;
    };

    if ["exe", "cmd", "bat"]
        .iter()
        .any(|launcher| extension.eq_ignore_ascii_case(launcher))
    {
        // Safe slice: `extension()` matched at the end, after a `.`.
        &name[..name.len() - extension.len() - 1]
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::{allowlist_key, ALLOWED_CLI_TYPES, ALLOWED_COMMANDS, UPDATE_COMMAND_TIMEOUT};
    use std::time::Duration;

    #[test]
    fn update_command_timeout_is_bounded() {
        assert!(UPDATE_COMMAND_TIMEOUT <= Duration::from_secs(5 * 60));
        assert!(UPDATE_COMMAND_TIMEOUT > Duration::from_secs(60));
    }

    #[test]
    fn pi_is_an_allowed_cli_type_for_path_updates() {
        assert!(ALLOWED_CLI_TYPES.contains(&"pi"));
    }

    #[test]
    fn pi_is_an_allowed_update_command_for_self_updates() {
        assert!(ALLOWED_COMMANDS.contains(&"pi"));
    }

    #[test]
    fn arbitrary_cli_type_is_not_allowed_for_path_updates() {
        assert!(!ALLOWED_CLI_TYPES.contains(&"definitely-not-a-cli"));
    }

    #[test]
    fn command_code_self_updates_are_allowed() {
        assert!(ALLOWED_CLI_TYPES.contains(&"commandcode"));
        assert!(ALLOWED_COMMANDS.contains(&"cmd"));
        assert!(ALLOWED_COMMANDS.contains(&"command-code"));
    }

    #[test]
    fn grok_self_updates_are_allowed() {
        assert!(ALLOWED_CLI_TYPES.contains(&"grok"));
        assert!(ALLOWED_COMMANDS.contains(&"grok"));
    }

    #[test]
    fn devin_self_updates_are_allowed() {
        assert!(ALLOWED_CLI_TYPES.contains(&"devin"));
        assert!(ALLOWED_COMMANDS.contains(&"devin"));
    }

    #[test]
    fn windows_package_manager_updates_are_allowed() {
        for command in ["winget", "scoop", "choco", "scoop.cmd", "choco.exe"] {
            assert!(
                ALLOWED_COMMANDS.contains(&allowlist_key(command)),
                "{command} should be an allowlisted updater"
            );
        }
    }

    #[test]
    fn windows_cmd_shims_match_their_allowlisted_updater() {
        // What npm leaves on PATH — and what CLI detection returns — on Windows.
        for command in ["claude.cmd", "claude.CMD", "npm.cmd", "opencode.bat"] {
            assert!(
                ALLOWED_COMMANDS.contains(&allowlist_key(command)),
                "{command} should map onto an allowlisted updater"
            );
        }
    }

    #[test]
    fn allowlist_key_keeps_extensionless_and_unix_commands() {
        assert_eq!(allowlist_key("npm"), "npm");
        assert_eq!(allowlist_key("/usr/local/bin/claude"), "claude");
        assert_eq!(allowlist_key("claude.exe"), "claude");
    }

    #[test]
    fn allowlist_key_does_not_smuggle_in_unrelated_binaries() {
        assert!(!ALLOWED_COMMANDS.contains(&allowlist_key("rm.cmd")));
        assert!(!ALLOWED_COMMANDS.contains(&allowlist_key("npm.ps1")));
    }
}

/// Run an updater while capturing output through files rather than pipes.
///
/// `Command::output()` waits for stdout/stderr EOF. Windows self-updaters often
/// spawn a detached helper that inherits those handles, so the parent CLI can
/// print "up to date" and exit while `output()` still waits forever. Files have
/// no EOF dependency on child handles, and the explicit timeout bounds a truly
/// stuck command instead of leaving the frontend spinner pending indefinitely.
fn run_update_command(command: &str, args: &[String]) -> Result<Output, String> {
    let stdout_file =
        NamedTempFile::new().map_err(|e| format!("Failed to create stdout file: {e}"))?;
    let stderr_file =
        NamedTempFile::new().map_err(|e| format!("Failed to create stderr file: {e}"))?;

    let mut child = path_tool_command(command)
        .args(args)
        .stdout(Stdio::from(
            stdout_file
                .reopen()
                .map_err(|e| format!("Failed to open stdout file: {e}"))?,
        ))
        .stderr(Stdio::from(
            stderr_file
                .reopen()
                .map_err(|e| format!("Failed to open stderr file: {e}"))?,
        ))
        .spawn()
        .map_err(|e| format!("Failed to spawn update command '{command}': {e}"))?;

    let start = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to poll update command '{command}': {e}"))?
        {
            break status;
        }

        if start.elapsed() >= UPDATE_COMMAND_TIMEOUT {
            // As with auth checks, a Windows shim can leave descendants behind.
            #[cfg(windows)]
            {
                let _ = crate::platform::kill_process_tree(child.id());
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Update command '{command}' timed out after {} seconds",
                UPDATE_COMMAND_TIMEOUT.as_secs()
            ));
        }

        thread::sleep(Duration::from_millis(100));
    };

    Ok(Output {
        status,
        stdout: fs::read(stdout_file.path()).unwrap_or_default(),
        stderr: fs::read(stderr_file.path()).unwrap_or_default(),
    })
}

/// Run a CLI update command silently in the background.
/// Captures stdout/stderr and returns the result without opening a terminal window.
///
/// The set of allowed `command` values is restricted to package managers and self-update
/// CLIs to prevent abuse. The `cli_type` is used to apply the active-session guard.
pub async fn run_cli_path_update(
    command: String,
    args: Vec<String>,
    cli_type: String,
) -> Result<CliPathUpdateOutput, String> {
    log::trace!("run_cli_path_update: cli_type={cli_type} command={command} args={args:?}");

    if !ALLOWED_CLI_TYPES.contains(&cli_type.as_str()) {
        return Err(format!("Unknown CLI type: {cli_type}"));
    }

    // Bare-binary check: command must be a known updater (no path traversal, no arbitrary binaries).
    let bare_command = allowlist_key(&command);
    if !ALLOWED_COMMANDS.contains(&bare_command) {
        return Err(format!("Disallowed update command: {command}"));
    }

    // Reuse the existing active-session guard pattern (see install_claude_cli).
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        let count = running_sessions.len();
        return Err(format!(
            "Cannot update {} CLI while {} {} running. Please stop all active sessions first.",
            cli_type,
            count,
            if count == 1 {
                "session is"
            } else {
                "sessions are"
            }
        ));
    }

    // `command` is either a package manager on PATH (`npm`, `bun`, `brew`) or the
    // detected CLI path for a self-update; both reach Windows as `.cmd` shims, so
    // resolve and launch through the shared helper. The allowlist above is checked
    // against the caller's value, never against what resolution turns it into.
    let result = tokio::task::spawn_blocking(move || run_update_command(&command, &args))
        .await
        .map_err(|e| format!("Background task join error: {e}"))??;

    let stdout = String::from_utf8_lossy(&result.stdout).to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).to_string();
    let exit_code = result.status.code();
    let success = result.status.success();

    log::trace!(
        "run_cli_path_update finished: success={success} exit={exit_code:?} stderr_len={}",
        stderr.len()
    );

    if success {
        Ok(CliPathUpdateOutput {
            success: true,
            stdout,
            stderr,
            exit_code,
        })
    } else {
        let trimmed = stderr.trim();
        let detail = if trimmed.is_empty() {
            stdout.trim().to_string()
        } else {
            trimmed.to_string()
        };
        let detail = if detail.is_empty() {
            format!("exit code {}", exit_code.unwrap_or(-1))
        } else {
            detail
        };
        Err(format!("Update failed: {detail}"))
    }
}
