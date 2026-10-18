//! Detached Claude CLI host used for mid-turn steering.
//!
//! Jean re-launches itself with [`CLAUDE_HOST_ARG`]. The host owns the
//! `claude --print --input-format stream-json --replay-user-messages` child,
//! keeps its stdin open, appends child stdout/stderr to the run JSONL, and
//! accepts `steer` requests on a short Unix socket. The host survives Jean
//! quitting, like the plain `cat | claude` pipeline it replaces.
//!
//! Finish rule (see [`ClaudeHostState`]): on a `result` line the host closes
//! child stdin (the CLI then exits) unless a steer was written that the CLI
//! has not echoed yet. Echo filtering: the replayed initial prompt is dropped
//! and each replayed steer is written as `steered_user_message`, so no parser
//! sees a replayed `user` text line.

use serde_json::Value;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub const CLAUDE_HOST_ARG: &str = "--jean-claude-host";
/// CLI flag the host needs to know when a steer was consumed.
pub(crate) const REPLAY_USER_MESSAGES_FLAG: &str = "--replay-user-messages";
/// First line the host writes to the run JSONL. Tells the tailer that the
/// run is host-backed (do not stop on the first `result`).
pub(crate) const HOST_START_TYPE: &str = "jean_claude_host_start";
/// Last line the host writes, after the Claude child exits.
pub(crate) const HOST_EXIT_TYPE: &str = "jean_claude_host_exit";
/// Close stdin when a pending steer is not consumed within this time after
/// a `result` (safety net; the CLI normally starts the next turn at once).
const PENDING_STEER_GRACE: Duration = Duration::from_secs(30);

/// Run JSONL line type written by the host / used by Claude marker lines.
pub(crate) fn host_marker_type(line: &str) -> Option<&'static str> {
    if !line.contains("jean_claude_host_") {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    match value.get("type").and_then(Value::as_str)? {
        HOST_START_TYPE => Some(HOST_START_TYPE),
        HOST_EXIT_TYPE => Some(HOST_EXIT_TYPE),
        _ => None,
    }
}

/// stream-json stdin line for one user message.
pub(crate) fn user_input_line(text: &str) -> String {
    serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    })
    .to_string()
}

/// Text of a replayed (`isReplay: true`) user message, or None for any
/// other line (tool results, assistant output, ...).
fn replayed_user_text(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("user")
        || value.get("isReplay").and_then(Value::as_bool) != Some(true)
    {
        return None;
    }
    match value.get("message")?.get("content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let mut text = String::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        text.push_str(block.get("text").and_then(Value::as_str).unwrap_or(""))
                    }
                    Some("tool_result") => return None,
                    _ => {}
                }
            }
            Some(text)
        }
        _ => None,
    }
}

/// What the host does with one child stdout line.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct StdoutDecision {
    /// Line to append to the run JSONL (None = drop the line).
    pub write: Option<String>,
    /// Close child stdin now (the turn is finished, no steer pending).
    pub close_stdin: bool,
}

/// Pure finish-rule / echo-filter state, kept free of IO for tests.
#[derive(Debug, Default)]
pub(crate) struct ClaudeHostState {
    stdin_closed: bool,
    initial_echo_seen: bool,
    pending_steers: VecDeque<String>,
    /// Set when a `result` arrived while a steer was still pending.
    result_with_pending_at: Option<Instant>,
}

impl ClaudeHostState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Accept a steer. Returns the stdin line to write, or an error when the
    /// turn already finished (stdin closed).
    pub fn accept_steer(&mut self, text: &str) -> Result<String, String> {
        if self.stdin_closed {
            return Err("Claude turn already finished".to_string());
        }
        self.pending_steers.push_back(text.to_string());
        Ok(user_input_line(text))
    }

    /// Undo the last accepted steer when writing it to stdin failed.
    pub fn reject_last_steer(&mut self) {
        self.pending_steers.pop_back();
    }

    pub fn on_stdout_line(&mut self, line: &str) -> StdoutDecision {
        self.result_with_pending_at = None;
        let keep = StdoutDecision {
            write: Some(line.to_string()),
            close_stdin: false,
        };
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return keep;
        };

        if let Some(text) = replayed_user_text(&value) {
            if !self.initial_echo_seen {
                self.initial_echo_seen = true;
                return StdoutDecision {
                    write: None,
                    close_stdin: false,
                };
            }
            self.pending_steers.pop_front();
            return StdoutDecision {
                write: Some(
                    serde_json::json!({ "type": "steered_user_message", "text": text }).to_string(),
                ),
                close_stdin: false,
            };
        }

        if value.get("type").and_then(Value::as_str) == Some("result") && !self.stdin_closed {
            if self.pending_steers.is_empty() {
                self.stdin_closed = true;
                return StdoutDecision {
                    write: keep.write,
                    close_stdin: true,
                };
            }
            self.result_with_pending_at = Some(Instant::now());
        }
        keep
    }

    /// Safety net: close stdin when a steer stays unconsumed after a
    /// `result` with no further output (the CLI would wait forever).
    pub fn should_force_close(&mut self, now: Instant) -> bool {
        match self.result_with_pending_at {
            Some(at) if !self.stdin_closed && now.duration_since(at) >= PENDING_STEER_GRACE => {
                self.stdin_closed = true;
                self.pending_steers.clear();
                self.result_with_pending_at = None;
                true
            }
            _ => false,
        }
    }

    pub fn mark_stdin_closed(&mut self) {
        self.stdin_closed = true;
    }
}

// =============================================================================
// Jean side: spawn + steer client
// =============================================================================

#[cfg(unix)]
pub(crate) fn claude_host_socket_path(
    app_data_dir: &std::path::Path,
    session_id: &str,
    run_id: &str,
) -> std::path::PathBuf {
    super::pi::host_socket_path(app_data_dir, 'c', session_id, run_id)
}

/// Launch the detached Claude host. Returns the host PID (its process group
/// contains the Claude child, so `kill_process_tree(pid)` reaps both).
#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_claude_host(
    app: &tauri::AppHandle,
    session_id: &str,
    cli_path: &std::path::Path,
    claude_args: &[String],
    input_file: &std::path::Path,
    output_file: &std::path::Path,
    working_dir: &std::path::Path,
    env_vars: &[(&str, &str)],
) -> Result<u32, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let run_id = super::pi::run_id_from_output_file(output_file);
    let socket_path = claude_host_socket_path(&app_data, session_id, &run_id);
    if let Some(socket_dir) = socket_path.parent() {
        std::fs::create_dir_all(socket_dir)
            .map_err(|e| format!("Failed to create Claude host socket dir: {e}"))?;
    }
    let _ = std::fs::remove_file(&socket_path);

    let log_dir = app_data.join("claude-hosts");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create Claude host log dir: {e}"))?;
    let log_file = log_dir.join(format!("{session_id}-{run_id}.log"));
    let exe = super::detached::current_executable_for_detached_host()?;

    let mut args = vec![
        CLAUDE_HOST_ARG.to_string(),
        "--socket".to_string(),
        socket_path.to_string_lossy().to_string(),
        "--input".to_string(),
        input_file.to_string_lossy().to_string(),
        "--output".to_string(),
        output_file.to_string_lossy().to_string(),
        "--cwd".to_string(),
        working_dir.to_string_lossy().to_string(),
        "--claude-cli".to_string(),
        cli_path.to_string_lossy().to_string(),
    ];
    for arg in claude_args {
        args.push("--claude-arg".to_string());
        args.push(arg.clone());
    }

    // Env goes to the host process and is inherited by the Claude child.
    let pid = super::detached::spawn_detached_process_with_env(
        &exe,
        &args,
        &log_file,
        working_dir,
        env_vars,
    )?;
    super::pi::wait_for_host_socket(&socket_path, pid, "Claude host")?;
    Ok(pid)
}

/// Send a steer to a running host and wait for its reply.
#[cfg(unix)]
pub(crate) fn send_claude_host_steer(
    socket_path: &std::path::Path,
    message: &str,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket_path)
        .map_err(|e| format!("Claude run is not steerable (host not reachable): {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = serde_json::json!({ "type": "steer", "message": message });
    stream
        .write_all(format!("{request}\n").as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|e| format!("Failed to send steer to Claude host: {e}"))?;

    let mut reply = String::new();
    BufReader::new(&stream)
        .read_line(&mut reply)
        .map_err(|e| format!("No reply from Claude host: {e}"))?;
    let reply: Value = serde_json::from_str(reply.trim())
        .map_err(|e| format!("Invalid reply from Claude host: {e}"))?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Claude host rejected the steer")
            .to_string())
    }
}

// =============================================================================
// Host process
// =============================================================================

#[cfg(unix)]
pub fn run_claude_host_from_args() -> Result<(), String> {
    use crate::platform::silent_command;
    use std::fs::OpenOptions;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::process::{ChildStdin, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    struct Shared {
        state: ClaudeHostState,
        stdin: Option<ChildStdin>,
    }

    let mut socket_path: Option<PathBuf> = None;
    let mut input_file: Option<PathBuf> = None;
    let mut output_file: Option<PathBuf> = None;
    let mut cwd: Option<PathBuf> = None;
    let mut claude_cli: Option<PathBuf> = None;
    let mut claude_args: Vec<String> = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket_path = args.next().map(PathBuf::from),
            "--input" => input_file = args.next().map(PathBuf::from),
            "--output" => output_file = args.next().map(PathBuf::from),
            "--cwd" => cwd = args.next().map(PathBuf::from),
            "--claude-cli" => claude_cli = args.next().map(PathBuf::from),
            "--claude-arg" => {
                if let Some(value) = args.next() {
                    claude_args.push(value);
                }
            }
            _ => {}
        }
    }

    let socket_path = socket_path.ok_or("--socket is required")?;
    let input_file = input_file.ok_or("--input is required")?;
    let output_file = output_file.ok_or("--output is required")?;
    let cwd = cwd.ok_or("--cwd is required")?;
    let claude_cli = claude_cli.ok_or("--claude-cli is required")?;

    let output = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&output_file)
            .map_err(|e| format!("Failed to open Claude output file: {e}"))?,
    ));
    let append = {
        let output = output.clone();
        move |line: &str| {
            if let Ok(mut out) = output.lock() {
                let _ = writeln!(out, "{line}");
                let _ = out.flush();
            }
        }
    };
    append(&serde_json::json!({ "type": HOST_START_TYPE }).to_string());

    let initial_input = std::fs::read_to_string(&input_file)
        .map_err(|e| format!("Failed to read Claude input file: {e}"))?;

    // Bind before spawning: a bind failure must not leave an orphan Claude child.
    let _ = std::fs::remove_file(&socket_path);
    let listener = match UnixListener::bind(&socket_path) {
        Ok(listener) => listener,
        Err(e) => {
            append(&format!("Failed to bind Claude host socket: {e}"));
            append(&serde_json::json!({ "type": HOST_EXIT_TYPE, "code": null }).to_string());
            return Err(format!("Failed to bind Claude host socket: {e}"));
        }
    };

    let mut child = match silent_command(&claude_cli)
        .args(&claude_args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            // Plain text line: the tailer reports non-JSON lines as CLI errors.
            append(&format!("Failed to spawn Claude CLI: {e}"));
            append(&serde_json::json!({ "type": HOST_EXIT_TYPE, "code": null }).to_string());
            return Err(format!("Failed to spawn Claude CLI: {e}"));
        }
    };

    let mut stdin = child.stdin.take().ok_or("Failed to capture Claude stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture Claude stdout")?;
    let mut initial = initial_input.trim_end().to_string();
    initial.push('\n');
    let _ = stdin
        .write_all(initial.as_bytes())
        .and_then(|_| stdin.flush());

    let shared = Arc::new(Mutex::new(Shared {
        state: ClaudeHostState::new(),
        stdin: Some(stdin),
    }));

    // stderr goes to the run JSONL too (same as `2>&1` in the plain pipeline),
    // so "No conversation found" and startup errors still reach the tailer.
    let stderr_thread = child.stderr.take().map(|stderr| {
        let append = append.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                append(&line);
            }
        })
    });

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        let shared = shared.clone();
        std::thread::spawn(move || {
            fn handle_client(stream: UnixStream, shared: Arc<Mutex<Shared>>) {
                let Ok(mut writer) = stream.try_clone() else {
                    return;
                };
                let mut line = String::new();
                if BufReader::new(stream).read_line(&mut line).is_err() || line.trim().is_empty() {
                    return;
                }
                let reply = match serde_json::from_str::<Value>(line.trim()) {
                    Ok(req) if req.get("type").and_then(Value::as_str) == Some("steer") => {
                        let text = req.get("message").and_then(Value::as_str).unwrap_or("");
                        steer(&shared, text)
                    }
                    _ => Err("Unknown Claude host command".to_string()),
                };
                let reply = match reply {
                    Ok(()) => serde_json::json!({ "ok": true }),
                    Err(error) => serde_json::json!({ "ok": false, "error": error }),
                };
                let _ = writer.write_all(format!("{reply}\n").as_bytes());
            }

            fn steer(shared: &Mutex<Shared>, text: &str) -> Result<(), String> {
                if text.trim().is_empty() {
                    return Err("Empty steer message".to_string());
                }
                let mut guard = shared.lock().map_err(|_| "Claude host lock poisoned")?;
                let line = guard.state.accept_steer(text)?;
                let written = match guard.stdin.as_mut() {
                    Some(stdin) => stdin
                        .write_all(format!("{line}\n").as_bytes())
                        .and_then(|_| stdin.flush())
                        .map_err(|e| format!("Failed to write steer to Claude: {e}")),
                    None => Err("Claude turn already finished".to_string()),
                };
                if written.is_err() {
                    guard.state.reject_last_steer();
                }
                written
            }

            // Blocking accept; shutdown wakes it with a dummy self-connect.
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let shared = shared.clone();
                        std::thread::spawn(move || handle_client(stream, shared));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => {
                        eprintln!("[claude-host] listener error: {e}");
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        });
    }

    // Watchdog for the pending-steer safety net.
    {
        let stop = stop.clone();
        let shared = shared.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(500));
                if let Ok(mut guard) = shared.lock() {
                    if guard.state.should_force_close(Instant::now()) {
                        eprintln!("[claude-host] pending steer not consumed; closing stdin");
                        guard.stdin = None;
                    }
                }
            }
        });
    }

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let decision = match shared.lock() {
            Ok(mut guard) => {
                let decision = guard.state.on_stdout_line(&line);
                if decision.close_stdin {
                    // Dropping ChildStdin closes the pipe; the CLI then exits.
                    guard.stdin = None;
                }
                decision
            }
            Err(_) => break,
        };
        if let Some(out) = decision.write {
            append(&out);
        }
    }

    // stdout closed: no more steers can land.
    if let Ok(mut guard) = shared.lock() {
        guard.state.mark_stdin_closed();
        guard.stdin = None;
    }
    let code = child.wait().ok().and_then(|status| status.code());
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }
    append(&serde_json::json!({ "type": HOST_EXIT_TYPE, "code": code }).to_string());

    stop.store(true, Ordering::SeqCst);
    let _ = UnixStream::connect(&socket_path);
    let _ = std::fs::remove_file(&socket_path);
    Ok(())
}

#[cfg(not(unix))]
pub fn run_claude_host_from_args() -> Result<(), String> {
    Err("Claude host is only supported on Unix-like systems".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const INITIAL_ECHO: &str = r#"{"type":"user","message":{"role":"user","content":"run tools"},"session_id":"s","parent_tool_use_id":null,"isReplay":true}"#;
    const STEER_ECHO: &str = r#"{"type":"user","message":{"role":"user","content":"also echo"},"session_id":"s","parent_tool_use_id":null,"isReplay":true}"#;
    const TOOL_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"A"}]},"session_id":"s"}"#;
    const RESULT: &str = r#"{"type":"result","subtype":"success","usage":{"input_tokens":1}}"#;

    fn written(d: &StdoutDecision) -> Value {
        serde_json::from_str(d.write.as_deref().unwrap()).unwrap()
    }

    #[test]
    fn closes_stdin_on_result_without_steer() {
        let mut s = ClaudeHostState::new();
        assert_eq!(s.on_stdout_line(INITIAL_ECHO).write, None);
        let d = s.on_stdout_line(RESULT);
        assert!(d.close_stdin);
        assert_eq!(d.write.as_deref(), Some(RESULT));
    }

    #[test]
    fn consumed_steer_becomes_steered_user_message_then_closes() {
        let mut s = ClaudeHostState::new();
        s.on_stdout_line(INITIAL_ECHO);
        let line = s.accept_steer("also echo").unwrap();
        assert!(line.contains(r#""type":"user""#));
        assert!(!s.on_stdout_line(TOOL_RESULT).close_stdin);
        let d = s.on_stdout_line(STEER_ECHO);
        assert_eq!(
            written(&d),
            serde_json::json!({"type":"steered_user_message","text":"also echo"})
        );
        assert!(s.on_stdout_line(RESULT).close_stdin);
    }

    #[test]
    fn pending_steer_keeps_stdin_open_until_next_result() {
        let mut s = ClaudeHostState::new();
        s.on_stdout_line(INITIAL_ECHO);
        s.accept_steer("also echo").unwrap();
        assert!(!s.on_stdout_line(RESULT).close_stdin);
        // CLI starts a 2nd turn for the steer.
        s.on_stdout_line(r#"{"type":"system","subtype":"init"}"#);
        s.on_stdout_line(STEER_ECHO);
        assert!(s.on_stdout_line(RESULT).close_stdin);
    }

    #[test]
    fn steer_after_stdin_closed_is_rejected() {
        let mut s = ClaudeHostState::new();
        s.on_stdout_line(INITIAL_ECHO);
        s.on_stdout_line(RESULT);
        assert!(s.accept_steer("late").is_err());
    }

    #[test]
    fn tool_results_and_text_blocks_are_not_echoes() {
        let mut s = ClaudeHostState::new();
        // tool_result before the initial echo must pass through unchanged.
        assert_eq!(
            s.on_stdout_line(TOOL_RESULT).write.as_deref(),
            Some(TOOL_RESULT)
        );
        let block_echo = r#"{"type":"user","isReplay":true,"message":{"content":[{"type":"text","text":"hi"}]}}"#;
        assert_eq!(s.on_stdout_line(block_echo).write, None);
        let non_replay =
            r#"{"type":"user","message":{"content":[{"type":"text","text":"monitor"}]}}"#;
        assert_eq!(
            s.on_stdout_line(non_replay).write.as_deref(),
            Some(non_replay)
        );
        assert_eq!(
            s.on_stdout_line("not json").write.as_deref(),
            Some("not json")
        );
    }

    #[test]
    fn force_close_after_grace_when_steer_never_consumed() {
        let mut s = ClaudeHostState::new();
        s.on_stdout_line(INITIAL_ECHO);
        s.accept_steer("lost").unwrap();
        s.on_stdout_line(RESULT);
        assert!(!s.should_force_close(Instant::now()));
        assert!(s.should_force_close(Instant::now() + PENDING_STEER_GRACE));
        assert!(s.accept_steer("late").is_err());
    }

    #[test]
    fn rejected_write_removes_pending_steer() {
        let mut s = ClaudeHostState::new();
        s.on_stdout_line(INITIAL_ECHO);
        s.accept_steer("x").unwrap();
        s.reject_last_steer();
        assert!(s.on_stdout_line(RESULT).close_stdin);
    }

    #[test]
    fn host_marker_type_detects_only_host_lines() {
        assert_eq!(
            host_marker_type(r#"{"type":"jean_claude_host_exit","code":0}"#),
            Some(HOST_EXIT_TYPE)
        );
        assert_eq!(
            host_marker_type(r#"{"type":"jean_claude_host_start"}"#),
            Some(HOST_START_TYPE)
        );
        assert_eq!(
            host_marker_type(r#"{"type":"assistant","text":"jean_claude_host_exit"}"#),
            None
        );
    }
}
