//! Detached Claude CLI execution
//!
//! This module handles spawning Claude CLI as a fully detached process that
//! survives Jean quitting. The process writes directly to a JSONL file,
//! which Jean tails for real-time updates.

use std::path::Path;
use std::process::Stdio;

#[cfg(unix)]
use std::io::{BufRead, BufReader};

// Re-export is_process_alive from platform module
pub use crate::platform::is_process_alive;
#[cfg(unix)]
use crate::platform::shell_escape;
use crate::platform::silent_command;

/// Spawn Claude CLI as a detached process that survives Jean quitting (Unix).
///
/// Uses `nohup` and shell backgrounding to fully detach the process.
/// The process reads input from a file and writes output to the NDJSON file.
///
/// Returns the PID of the detached Claude CLI process.
#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
pub fn spawn_detached_claude(
    cli_path: &Path,
    args: &[String],
    input_file: &Path,
    output_file: &Path,
    working_dir: &Path,
    env_vars: &[(&str, &str)],
) -> Result<u32, String> {
    // Build the shell command:
    // cat input.jsonl | nohup /path/to/claude [args] >> output.jsonl 2>&1 & echo $!
    //
    // NOTE: We use `cat file | nohup claude` instead of `nohup claude < file` because
    // Claude CLI with --print doesn't accept stdin from file redirection, only from pipes.
    //
    // - cat: Reads input file and pipes to stdin
    // - nohup: Makes the process immune to SIGHUP (sent when terminal closes)
    // - >> output.jsonl: Appends output to file (Claude writes here)
    // - 2>&1: Redirect stderr to stdout (both go to output file)
    // - &: Run in background
    // - echo $!: Print the PID of the background process

    // Escape ALL paths for safe shell usage (paths may contain spaces like "Application Support")
    let cli_path_escaped =
        shell_escape(cli_path.to_str().ok_or("CLI path contains invalid UTF-8")?);
    let input_path_escaped = shell_escape(
        input_file
            .to_str()
            .ok_or("Input file path contains invalid UTF-8")?,
    );
    let output_path_escaped = shell_escape(
        output_file
            .to_str()
            .ok_or("Output file path contains invalid UTF-8")?,
    );

    // Build args string with proper escaping
    let args_str = args
        .iter()
        .map(|arg| shell_escape(arg))
        .collect::<Vec<_>>()
        .join(" ");

    // Build environment variable exports
    let env_exports = env_vars
        .iter()
        .map(|(k, v)| format!("{}={}", k, shell_escape(v)))
        .collect::<Vec<_>>()
        .join(" ");

    // The full shell command - use cat pipe instead of file redirection
    // Claude CLI with --print requires piped stdin, not file redirection
    // NOTE: env vars must be placed AFTER the pipe so they apply to Claude, not cat
    let shell_cmd = if env_exports.is_empty() {
        format!(
            "cat {input_path_escaped} | nohup {cli_path_escaped} {args_str} >> {output_path_escaped} 2>&1 & echo $!"
        )
    } else {
        format!(
            "cat {input_path_escaped} | {env_exports} nohup {cli_path_escaped} {args_str} >> {output_path_escaped} 2>&1 & echo $!"
        )
    };

    log::trace!("Spawning detached Claude CLI");
    log::trace!("Shell command: {shell_cmd}");
    log::trace!("Working directory: {working_dir:?}");

    // Verify working directory exists before spawn (otherwise sh returns
    // a cryptic "No such file or directory" from current_dir).
    if !working_dir.exists() {
        return Err(format!(
            "Working directory does not exist: {}. The worktree may still be initializing.",
            working_dir.display()
        ));
    }

    // Spawn the shell command
    let mut child = silent_command("sh")
        .arg("-c")
        .arg(&shell_cmd)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    // Read the PID from stdout (the `echo $!` part)
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture shell stdout")?;
    let reader = BufReader::new(stdout);

    let mut pid_str = String::new();
    for line in reader.lines() {
        match line {
            Ok(l) => {
                pid_str = l.trim().to_string();
                break;
            }
            Err(e) => {
                log::warn!("Error reading PID from shell: {e}");
            }
        }
    }

    // Capture stderr for error reporting
    let stderr_handle = child.stderr.take();

    // Wait for shell to finish (it returns immediately after backgrounding)
    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for shell: {e}"))?;

    if !status.success() {
        // Read stderr to provide better error messages
        let stderr_output = stderr_handle
            .map(|stderr| {
                BufReader::new(stderr)
                    .lines()
                    .map_while(Result::ok)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();

        return Err(format!(
            "Shell command failed with status: {status}\nStderr: {stderr_output}"
        ));
    }

    // Parse the PID
    let pid: u32 = pid_str
        .parse()
        .map_err(|e| format!("Failed to parse PID '{pid_str}': {e}"))?;

    log::trace!("Detached Claude CLI spawned with PID: {pid}");

    Ok(pid)
}

/// Spawn Claude CLI as a detached native Windows process.
///
/// Runs claude.exe directly with stdout/stderr redirected to the output file.
/// Returns the Windows PID of the Claude CLI process.
#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
pub fn spawn_detached_claude(
    cli_path: &Path,
    args: &[String],
    input_file: &Path,
    output_file: &Path,
    working_dir: &Path,
    env_vars: &[(&str, &str)],
) -> Result<u32, String> {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Open output file in append mode (metadata header already written)
    let out_file = OpenOptions::new()
        .append(true)
        .open(output_file)
        .map_err(|e| format!("Failed to open output file: {e}"))?;

    // Clone for stderr
    let err_file = out_file
        .try_clone()
        .map_err(|e| format!("Failed to clone output file handle: {e}"))?;

    // Build command - run claude.exe directly
    // NOTE: silent_command sets CREATE_NO_WINDOW, but creation_flags() replaces
    // (doesn't merge), so we must re-specify both flags here.
    let mut cmd = silent_command(cli_path);
    cmd.args(args)
        .current_dir(working_dir)
        .stdin(Stdio::piped())
        .stdout(out_file)
        .stderr(err_file)
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);

    // Set environment variables
    for (key, value) in env_vars {
        cmd.env(key, value);
    }

    log::trace!("Spawning detached Claude CLI natively on Windows");
    log::trace!("CLI path: {cli_path:?}");
    log::trace!("Working directory: {working_dir:?}");

    // Spawn the process
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;

    let pid = child.id();

    // Read input file and write to stdin, then close stdin to signal EOF
    let input_data =
        std::fs::read(input_file).map_err(|e| format!("Failed to read input file: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&input_data)
            .map_err(|e| format!("Failed to write to stdin: {e}"))?;
        // stdin dropped here, closing the pipe (signals EOF to Claude CLI)
    }

    log::trace!("Detached Claude CLI spawned with Windows PID: {pid}");

    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn test_shell_escape() {
        assert_eq!(shell_escape("hello"), "'hello'");
        assert_eq!(shell_escape("hello world"), "'hello world'");
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
        assert_eq!(shell_escape(""), "''");
    }

    #[test]
    fn test_is_process_alive() {
        // Current process should be alive
        let pid = std::process::id();
        assert!(is_process_alive(pid));

        // Non-existent PID should not be alive
        assert!(!is_process_alive(999999));
    }
}
