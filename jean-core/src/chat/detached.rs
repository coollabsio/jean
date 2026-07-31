//! Detached Claude CLI execution
//!
//! This module handles spawning Claude CLI as a fully detached process that
//! survives Jean quitting. The process writes directly to a JSONL file,
//! which Jean tails for real-time updates.

use std::path::{Path, PathBuf};
use std::process::Stdio;

#[cfg(unix)]
use std::io::{BufRead, BufReader};

// Re-export is_process_alive from platform module
pub use crate::platform::is_process_alive;
#[cfg(unix)]
use crate::platform::shell_escape;
use crate::platform::silent_command;

pub(crate) fn current_executable_for_detached_host() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Failed to get Jean executable: {error}"))?;
    resolve_detached_host_executable(executable)
}

fn resolve_detached_host_executable(executable: PathBuf) -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    {
        const DELETED_SUFFIX: &str = " (deleted)";
        let path = executable.to_string_lossy();
        if let Some(replacement) = path.strip_suffix(DELETED_SUFFIX) {
            let replacement = PathBuf::from(replacement);
            if replacement.is_file() {
                return Ok(replacement);
            }
        }
    }
    Ok(executable)
}

#[cfg(any(windows, test))]
fn wsl_shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Claude flags whose following argument is a filesystem path that Claude will
/// open. When Claude runs inside WSL these must be WSL paths — a Windows-form
/// value (e.g. `C:\Users\..`) is resolved relative to the Linux cwd and fails
/// (notably `--append-system-prompt-file`, which aborts the whole run).
#[cfg(any(windows, test))]
const WSL_PATH_VALUE_FLAGS: &[&str] = &["--add-dir", "--append-system-prompt-file", "--settings"];

#[cfg(any(windows, test))]
fn looks_like_windows_path(value: &str) -> bool {
    // UNC (`\\..`) or drive path (`C:\..` / `C:/..`). Anything else is left
    // untouched so non-path values (models, inline `--settings` JSON) are never
    // mangled.
    value.starts_with("\\\\")
        || (value.len() >= 3
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':'
            && matches!(value.as_bytes()[2], b'\\' | b'/'))
}

/// Translate Windows-form path values that follow known path flags into WSL
/// paths, leaving every other argument untouched.
#[cfg(any(windows, test))]
fn wslify_path_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut translate_next = false;
    for arg in args {
        if translate_next {
            translate_next = false;
            if looks_like_windows_path(arg) {
                out.push(crate::platform::win_to_wsl_path(arg));
                continue;
            }
        }
        if WSL_PATH_VALUE_FLAGS.contains(&arg.as_str()) {
            translate_next = true;
        }
        out.push(arg.clone());
    }
    out
}

/// Build the shell program fed to `wsl.exe -- sh -s` (via stdin, so wsl.exe
/// never re-parses it) that launches Claude so it OUTLIVES the `wsl.exe`
/// invocation.
///
/// A plain backgrounded child is SIGHUP-reaped when the launcher's session
/// tears down as `wsl.exe` exits — verified empirically on WSL2. `setsid` gives
/// Claude its own session with no controlling terminal, so it survives; the
/// distro keeps the process (adopted by `wslhost.exe`) and Jean tails the
/// output file. This lets `wsl.exe` return immediately instead of blocking for
/// the whole run.
///
/// Why `wsl.exe` exiting does not kill Claude — the WSL process-lifetime model:
/// - Interop: `wsl.exe` does not "contain" the Linux process. Each session
///   leader inside the distro has an interop server — "special Linux processes
///   that act as bridges between Linux and Windows [that] maintain secure
///   communication channels (through hvsocket connections) with Windows
///   processes (wsl.exe or wslhost.exe)" — and that server, not `wsl.exe`, is
///   what tracks the running work.
///   See <https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/interop.md>.
/// - Adoption: when `wsl.exe` exits before the Linux process finishes, Windows
///   transfers responsibility to `wslhost.exe` — "When wsl.exe terminates
///   before the associated Linux process terminates, wslhost.exe takes over the
///   lifetime of the Linux process" — which keeps it (and its interop/terminal
///   access) alive.
///   See <https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/wslhost.exe.md>.
///
/// The catch neither doc spells out: adoption only saves a process that is still
/// alive when `wsl.exe` leaves. A plain backgrounded child sharing the launcher
/// session is SIGHUP-reaped at teardown — before adoption ever applies — which
/// is exactly why `setsid` (own session, no controlling terminal) is required.
///
/// The inner session records its own pid (`echo $$`) to `pid_path`, then runs
/// Claude under that same session shell. The reported pid is the session-leader
/// shell — NOT `$!` of `setsid`, which is a short-lived forking parent that
/// yields a dead or zero pid and wedges recovery. Keeping the shell as leader
/// also lets `kill_process_tree` reap the whole pipeline (cat + claude).
///
/// Stdin must be a pipe (`cat … | claude`), not file redirection: Claude CLI
/// with `--print` does not accept stdin from `< file` (same constraint as the
/// Unix spawn path). The outer launcher waits for the pid file, prints the pid
/// for Jean, then exits.
#[cfg(any(windows, test))]
fn build_wsl_claude_script(
    cli_path: &str,
    args: &[String],
    input_path: &str,
    output_path: &str,
    pid_path: &str,
    env_vars: &[(&str, &str)],
) -> String {
    // Inner command: record the session-leader pid, then pipe input into Claude.
    // (Claude --print requires a pipe; plain `< file` redirection fails.)
    let mut inner = format!(
        "echo $$ > {}; cat {} | ",
        wsl_shell_quote(pid_path),
        wsl_shell_quote(input_path)
    );
    if !env_vars.is_empty() {
        inner.push_str("env ");
        inner.push_str(
            &env_vars
                .iter()
                .map(|(key, value)| format!("{key}={}", wsl_shell_quote(value)))
                .collect::<Vec<_>>()
                .join(" "),
        );
        inner.push(' ');
    }
    inner.push_str(&wsl_shell_quote(cli_path));
    for arg in args {
        inner.push(' ');
        inner.push_str(&wsl_shell_quote(arg));
    }
    inner.push_str(&format!(" >> {} 2>&1", wsl_shell_quote(output_path)));

    // Outer launcher: detach the session, wait for the pid to land (≤2s), print
    // it, then exit — after which `wsl.exe` exits and Claude keeps running.
    let inner_q = wsl_shell_quote(&inner);
    let pid_q = wsl_shell_quote(pid_path);
    format!(
        "setsid sh -c {inner_q} </dev/null &\n\
         i=0; while [ ! -s {pid_q} ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done\n\
         cat {pid_q}\n"
    )
}

/// Spawn an arbitrary CLI as a fully detached background process (Unix).
///
/// Uses `nohup` and shell backgrounding so the process survives Jean quitting:
/// stdin is /dev/null, stdout+stderr are appended to `log_file`.
///
/// Returns the PID of the detached process.
#[cfg(unix)]
pub fn spawn_detached_process(
    cli_path: &Path,
    args: &[String],
    log_file: &Path,
    working_dir: &Path,
) -> Result<u32, String> {
    let cli_path_escaped =
        shell_escape(cli_path.to_str().ok_or("CLI path contains invalid UTF-8")?);
    let log_path_escaped = shell_escape(
        log_file
            .to_str()
            .ok_or("Log file path contains invalid UTF-8")?,
    );

    let args_str = args
        .iter()
        .map(|arg| shell_escape(arg))
        .collect::<Vec<_>>()
        .join(" ");

    // `set -m` puts the background job in its own process group (pgid == pid)
    // so kill_process_tree(pid) reaps the whole tree — important for CLIs that
    // are node wrappers exec'ing a native child (e.g. codex). Without it the
    // job inherits Jean's process group and a group kill would miss children
    // (or hit Jean).
    let shell_cmd = format!(
        "set -m; nohup {cli_path_escaped} {args_str} </dev/null >> {log_path_escaped} 2>&1 & echo $!"
    );

    if !working_dir.exists() {
        return Err(format!(
            "Working directory does not exist: {}",
            working_dir.display()
        ));
    }

    log::trace!("Spawning detached process: {shell_cmd}");

    let mut child = silent_command("sh")
        .arg("-c")
        .arg(&shell_cmd)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

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

    let stderr_handle = child.stderr.take();

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for shell: {e}"))?;

    if !status.success() {
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

    let pid: u32 = pid_str
        .parse()
        .map_err(|e| format!("Failed to parse PID '{pid_str}': {e}"))?;

    // pid 0 means the backgrounded job never started (is_process_alive(0)
    // would report it alive forever). Fail loudly instead.
    if pid == 0 {
        return Err("Detached process spawn returned an invalid pid (0)".to_string());
    }

    log::trace!("Detached process spawned with PID: {pid}");

    Ok(pid)
}

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

    // pid 0 means the backgrounded job never started (is_process_alive(0)
    // would report it alive forever). Fail loudly instead.
    if pid == 0 {
        return Err("Detached Claude CLI spawn returned an invalid pid (0)".to_string());
    }

    log::trace!("Detached Claude CLI spawned with PID: {pid}");

    Ok(pid)
}

/// Spawn Claude CLI as a detached native Windows process.
///
/// Runs claude.exe directly with stdout/stderr redirected to the output file.
/// When WSL is enabled, routes through `wsl.exe` with proper path translation.
/// Returns the PID of the detached process.
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

    let wsl_config = crate::platform::get_wsl_config();

    if wsl_config.enabled {
        // WSL mode: launch Claude in its own session (setsid) so it survives
        // wsl.exe exiting, then let wsl.exe return immediately.
        use std::io::{BufRead, BufReader};

        let unix_cwd = crate::platform::win_to_wsl_path(&working_dir.to_string_lossy());
        // If the resolved path is a Unix absolute path (Jean-managed install
        // inside the distro), invoke it by full path. Otherwise it's a bare
        // tool name that should be looked up via the distro's $PATH.
        let cli_path_str = cli_path.to_string_lossy();
        let cli_name_owned = if cli_path_str.starts_with('/') {
            cli_path_str.to_string()
        } else {
            cli_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("claude")
                .to_string()
        };
        let cli_name = cli_name_owned.as_str();

        // Input/output files are on the Windows side — convert to /mnt/c/... paths
        let unix_input = crate::platform::win_to_wsl_path(&input_file.to_string_lossy());
        let unix_output = crate::platform::win_to_wsl_path(&output_file.to_string_lossy());
        // Windows path args (e.g. --add-dir, --append-system-prompt-file) must be
        // WSL paths so Claude, running inside the distro, can open them.
        let wsl_args = wslify_path_args(args);
        // The detached session writes its pid to a sibling file that both WSL
        // (via a /mnt/c path) and Jean can see. Clear any stale file first so a
        // failed spawn can't hand back a previous run's pid.
        let pid_file = output_file.with_extension("pid");
        let _ = std::fs::remove_file(&pid_file);
        let unix_pid = crate::platform::win_to_wsl_path(&pid_file.to_string_lossy());
        // Feeding the script through stdin avoids Windows-to-WSL argument
        // rewriting. Only the run path lands in the pid file (deleted below);
        // the MCP token stays in Claude's argv/env, never on disk.
        let shell_cmd = build_wsl_claude_script(
            cli_name,
            &wsl_args,
            &unix_input,
            &unix_output,
            &unix_pid,
            env_vars,
        );

        log::debug!(
            "WSL Claude spawn: distro={} cwd={unix_cwd:?} input={unix_input:?} output={unix_output:?}",
            wsl_config.distro,
        );
        let launcher_err = OpenOptions::new()
            .create(true)
            .append(true)
            .open(output_file)
            .map_err(|e| format!("Failed to open WSL output file: {e}"))?;

        let mut child = silent_command("wsl.exe")
            .args([
                "-d",
                &wsl_config.distro,
                "--cd",
                &unix_cwd,
                "--",
                "sh",
                "-s",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(launcher_err)
            .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to spawn WSL shell: {e}"))?;

        let write_result = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open WSL shell stdin".to_string())
            .and_then(|mut stdin| {
                stdin
                    .write_all(shell_cmd.as_bytes())
                    .map_err(|e| format!("Failed to write WSL launch command: {e}"))
            });
        if let Err(error) = write_result {
            let _ = child.kill();
            return Err(error);
        }

        // The launcher prints Claude's session pid (read from the pid file) once
        // the detached session is up, then exits.
        let mut pid_str = String::new();
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            if let Err(e) = reader.read_line(&mut pid_str) {
                let _ = child.kill();
                let _ = std::fs::remove_file(&pid_file);
                return Err(format!("Failed to read WSL PID: {e}"));
            }
        }
        let pid_str = pid_str.trim();

        let pid: u32 = match pid_str.parse::<u32>() {
            Ok(pid) => pid,
            Err(e) => {
                // No pid printed: the session never came up (e.g. the working
                // directory could not be entered). Fail loudly.
                let _ = child.kill();
                let _ = std::fs::remove_file(&pid_file);
                return Err(format!("Failed to parse WSL PID '{pid_str}': {e}"));
            }
        };

        // `kill -0 0` targets the current process group and can falsely report
        // success, so never allow an invalid PID into recovery state.
        if pid == 0 {
            let _ = child.kill();
            let _ = std::fs::remove_file(&pid_file);
            return Err(
                "WSL spawn produced no process (pid 0) — the working directory \
                 may not exist inside the distro."
                    .to_string(),
            );
        }

        // The pid is captured; the file has served its purpose.
        let _ = std::fs::remove_file(&pid_file);

        // Claude runs in its own session (setsid) and no longer needs wsl.exe.
        // Wait for the short-lived launcher so handles are reaped cleanly; a
        // non-zero exit after a valid pid is logged but not fatal (Claude may
        // already be running under wslhost.exe).
        match child.wait() {
            Ok(status) if !status.success() => {
                log::warn!("WSL launcher exited with status {status} after reporting pid {pid}");
            }
            Err(e) => log::warn!("Failed to wait for WSL launcher: {e}"),
            _ => {}
        }

        log::debug!("Detached Claude CLI running in WSL with pid {pid}");
        Ok(pid)
    } else {
        // Native Windows mode
        let out_file = OpenOptions::new()
            .append(true)
            .open(output_file)
            .map_err(|e| format!("Failed to open output file: {e}"))?;

        let err_file = out_file
            .try_clone()
            .map_err(|e| format!("Failed to clone output file handle: {e}"))?;

        // NOTE: silent_command sets CREATE_NO_WINDOW, but creation_flags() replaces
        // (doesn't merge), so we must re-specify both flags here.
        let mut cmd = silent_command(cli_path);
        cmd.args(args)
            .current_dir(working_dir)
            .stdin(Stdio::piped())
            .stdout(out_file)
            .stderr(err_file)
            .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);

        for (key, value) in env_vars {
            cmd.env(key, value);
        }

        log::trace!("Spawning detached Claude CLI natively on Windows");
        log::trace!("CLI path: {cli_path:?}");
        log::trace!("Working directory: {working_dir:?}");

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;

        let pid = child.id();
        if pid == 0 {
            return Err("Claude CLI spawn returned an invalid pid (0)".to_string());
        }

        let input_data =
            std::fs::read(input_file).map_err(|e| format!("Failed to read input file: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(&input_data)
                .map_err(|e| format!("Failed to write to stdin: {e}"))?;
        }

        log::trace!("Detached Claude CLI spawned with Windows PID: {pid}");
        Ok(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "linux")]
    fn detached_host_uses_replacement_path_after_self_update() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let executable = tmp.path().join("jean-server");
        std::fs::write(&executable, b"replacement").expect("write replacement");
        let deleted_path = std::path::PathBuf::from(format!("{} (deleted)", executable.display()));

        assert_eq!(
            resolve_detached_host_executable(deleted_path).expect("resolve executable"),
            executable
        );
    }

    #[test]
    #[cfg(unix)]
    fn test_shell_escape() {
        assert_eq!(shell_escape("hello"), "'hello'");
        assert_eq!(shell_escape("hello world"), "'hello world'");
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
        assert_eq!(shell_escape(""), "''");
    }

    #[test]
    fn test_wsl_shell_quote_escapes_single_quotes() {
        assert_eq!(
            wsl_shell_quote("/mnt/c/Users/O'Brien/input.jsonl"),
            "'/mnt/c/Users/O'\\''Brien/input.jsonl'"
        );
    }

    #[test]
    #[cfg(unix)]
    fn test_spawn_detached_process() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let log_file = tmp.path().join("out.log");

        let pid = spawn_detached_process(
            Path::new("/bin/sleep"),
            &["30".to_string()],
            &log_file,
            tmp.path(),
        )
        .expect("spawn detached");

        assert!(is_process_alive(pid));
        // ppid should be 1 (or at least not us) once the shell exits, but the
        // key property is it stays alive without us holding a Child handle.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }

    #[test]
    fn test_is_process_alive() {
        // Current process should be alive
        let pid = std::process::id();
        assert!(is_process_alive(pid));

        // Non-existent PID should not be alive
        assert!(!is_process_alive(999999));

        // pid 0 must never read as alive. In WSL mode this maps to `kill -0 0`,
        // which targets the process group and always succeeds — a failed spawn
        // (pid 0) would otherwise look alive forever and wedge the tailer.
        assert!(!is_process_alive(0));
    }

    #[test]
    fn test_wslify_path_args_translates_path_flag_values() {
        let args = vec![
            "--print".to_string(),
            "--add-dir".to_string(),
            r"C:\Users\foo\proj".to_string(),
            "--append-system-prompt-file".to_string(),
            r"\\wsl.localhost\Ubuntu-22.04\home\u\ctx.md".to_string(),
            "--model".to_string(),
            "claude-opus-4-8[1m]".to_string(),
            "--settings".to_string(),
            r"C:\Users\foo\.claude\settings.json".to_string(),
        ];
        let out = wslify_path_args(&args);
        assert_eq!(out[2], "/mnt/c/Users/foo/proj");
        assert_eq!(out[4], "/home/u/ctx.md");
        // A non-path flag's value must be left untouched.
        assert_eq!(out[6], "claude-opus-4-8[1m]");
        assert_eq!(out[8], "/mnt/c/Users/foo/.claude/settings.json");
    }

    #[test]
    fn test_wslify_path_args_leaves_non_windows_values() {
        // Path flag whose value is already a unix path (or not a Windows path).
        let args = vec!["--add-dir".to_string(), "/home/u/x".to_string()];
        assert_eq!(wslify_path_args(&args), args);
    }

    #[test]
    fn test_wslify_path_args_translates_forward_slash_drive_paths() {
        let args = vec![
            "--add-dir".to_string(),
            "C:/Users/foo/proj".to_string(),
            "--settings".to_string(),
            r"C:\Users\foo\.claude\settings.json".to_string(),
        ];
        let out = wslify_path_args(&args);
        assert_eq!(out[1], "/mnt/c/Users/foo/proj");
        assert_eq!(out[3], "/mnt/c/Users/foo/.claude/settings.json");
    }

    #[test]
    fn test_wslify_path_args_leaves_inline_settings_json_unchanged() {
        let args = vec![
            "--settings".to_string(),
            r#"{"permissions":{"allow":["Read"]}}"#.to_string(),
        ];

        assert_eq!(wslify_path_args(&args), args);
    }

    #[test]
    fn test_wsl_claude_script_detaches_with_setsid() {
        let script = build_wsl_claude_script(
            "/usr/bin/claude",
            &["--print".to_string(), "hello world".to_string()],
            "/mnt/c/tmp/input.jsonl",
            "/mnt/c/tmp/output.jsonl",
            "/mnt/c/tmp/output.pid",
            &[("JEAN_MCP_TOKEN", "secret")],
        );

        // New session so Claude survives wsl.exe exiting, detached from stdin.
        assert!(script.starts_with("setsid sh -c "));
        assert!(script.contains("</dev/null &"));
        // Inner command records the session-leader pid, then pipes input into
        // Claude. (Inner single quotes are re-escaped by the outer `sh -c '...'`
        // wrap, so match on the unquoted fragments that survive escaping.)
        assert!(script.contains("echo $$ >"));
        assert!(script.contains("cat "));
        assert!(script.contains(" | "));
        assert!(script.contains("env JEAN_MCP_TOKEN="));
        assert!(script.contains("secret"));
        assert!(script.contains("/usr/bin/claude"));
        assert!(script.contains("--print"));
        assert!(script.contains("hello world"));
        assert!(script.contains("input.jsonl"));
        assert!(script.contains("output.jsonl"));
        assert!(script.contains("2>&1"));
        // Must not use file redirection for Claude stdin (CLI --print rejects it).
        assert!(!script.contains(" < '/mnt/c/tmp/input.jsonl'"));
        // Launcher waits for the pid file (outer, unescaped), then prints it.
        assert!(script.contains("while [ ! -s '/mnt/c/tmp/output.pid' ]"));
        assert!(script.contains("cat '/mnt/c/tmp/output.pid'"));
        // Never rely on `$!` of setsid (a short-lived forking parent).
        assert!(!script.contains("echo $!"));
        // Do not exec-over the session shell: the shell must stay as leader so
        // the cat|claude pipeline remains killable as one process group.
        assert!(!script.contains("exec "));
    }

    #[test]
    fn test_looks_like_windows_path_accepts_slash_and_backslash() {
        assert!(looks_like_windows_path(r"C:\Users\foo"));
        assert!(looks_like_windows_path("C:/Users/foo"));
        assert!(looks_like_windows_path(r"\\wsl.localhost\Ubuntu\home\u"));
        assert!(!looks_like_windows_path("/home/u"));
        assert!(!looks_like_windows_path(r#"{"permissions":{}}"#));
        assert!(!looks_like_windows_path("claude-opus-4-8[1m]"));
    }
}
