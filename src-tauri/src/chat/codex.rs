//! Codex CLI execution engine
//!
//! Mirrors the Claude CLI execution pattern (claude.rs) but adapted for
//! OpenAI's Codex CLI. Key differences:
//! - Codex uses `exec --json` instead of `--print --output-format stream-json`
//! - Prompt is passed as a positional argument, not piped via stdin
//! - Resume uses `resume <thread_id>` positional args
//! - Different JSONL event format (item.started/completed vs assistant/user/result)
//! - No thinking/effort levels, no --settings, no --add-dir, no MCP config

use super::types::{ContentBlock, PermissionDenial, PermissionDeniedEvent, ToolCall, UsageData};
use crate::http_server::EmitExt;

use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;

// =============================================================================
// Approval channel registry (for attached Codex processes in build mode)
// =============================================================================

/// Approval response sender per session. The Tauri command writes here,
/// the tailer thread blocks on the receiver.
#[allow(clippy::type_complexity)]
static CODEX_APPROVAL_SENDERS: Mutex<
    Option<HashMap<String, std::sync::mpsc::Sender<(u64, String)>>>,
> = Mutex::new(None);

/// Stdin handles for attached Codex processes, keyed by session_id.
static CODEX_STDIN_HANDLES: Mutex<Option<HashMap<String, std::process::ChildStdin>>> =
    Mutex::new(None);

fn register_approval_channel(
    session_id: &str,
    sender: std::sync::mpsc::Sender<(u64, String)>,
    stdin: std::process::ChildStdin,
) {
    let mut senders = CODEX_APPROVAL_SENDERS.lock().unwrap();
    senders
        .get_or_insert_with(HashMap::new)
        .insert(session_id.to_string(), sender);
    let mut handles = CODEX_STDIN_HANDLES.lock().unwrap();
    handles
        .get_or_insert_with(HashMap::new)
        .insert(session_id.to_string(), stdin);
}

fn cleanup_approval_channel(session_id: &str) {
    if let Ok(mut senders) = CODEX_APPROVAL_SENDERS.lock() {
        if let Some(map) = senders.as_mut() {
            map.remove(session_id);
        }
    }
    if let Ok(mut handles) = CODEX_STDIN_HANDLES.lock() {
        if let Some(map) = handles.as_mut() {
            map.remove(session_id);
        }
    }
}

/// Send an approval decision to a waiting Codex process.
/// Called from the `approve_codex_command` Tauri command.
pub fn send_approval(session_id: &str, rpc_id: u64, decision: &str) -> Result<(), String> {
    // Write the JSON-RPC response directly to stdin
    let response = format!("{{\"id\":{rpc_id},\"result\":\"{decision}\"}}\n");
    let mut handles = CODEX_STDIN_HANDLES
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    let map = handles.as_mut().ok_or("No stdin handles registered")?;
    let stdin = map
        .get_mut(session_id)
        .ok_or_else(|| format!("No stdin handle for session {session_id}"))?;
    stdin
        .write_all(response.as_bytes())
        .map_err(|e| format!("Failed to write to Codex stdin: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush Codex stdin: {e}"))?;

    // Signal the tailer thread to resume
    let senders = CODEX_APPROVAL_SENDERS
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    if let Some(map) = senders.as_ref() {
        if let Some(sender) = map.get(session_id) {
            let _ = sender.send((rpc_id, decision.to_string()));
        }
    }

    log::trace!("Sent approval for session {session_id}: rpc_id={rpc_id}, decision={decision}");
    Ok(())
}

// =============================================================================
// Response type (same shape as ClaudeResponse)
// =============================================================================

/// Response from Codex CLI execution
pub struct CodexResponse {
    /// The text response content
    pub content: String,
    /// The thread ID (for resuming conversations)
    pub thread_id: String,
    /// Tool calls made during this response
    pub tool_calls: Vec<ToolCall>,
    /// Ordered content blocks preserving tool position in response
    pub content_blocks: Vec<ContentBlock>,
    /// Whether the response was cancelled by the user
    pub cancelled: bool,
    /// Whether a chat:error event was emitted during execution
    pub error_emitted: bool,
    /// Token usage for this response
    pub usage: Option<UsageData>,
}

// =============================================================================
// Event structs (reuse same Tauri event names as Claude for frontend compat)
// =============================================================================

#[derive(serde::Serialize, Clone)]
struct ChunkEvent {
    session_id: String,
    worktree_id: String,
    content: String,
}

#[derive(serde::Serialize, Clone)]
struct ToolUseEvent {
    session_id: String,
    worktree_id: String,
    id: String,
    name: String,
    input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct ToolResultEvent {
    session_id: String,
    worktree_id: String,
    tool_use_id: String,
    output: String,
}

#[derive(serde::Serialize, Clone)]
struct ToolBlockEvent {
    session_id: String,
    worktree_id: String,
    tool_call_id: String,
}

#[derive(serde::Serialize, Clone)]
struct ThinkingEvent {
    session_id: String,
    worktree_id: String,
    content: String,
}

#[derive(serde::Serialize, Clone)]
struct DoneEvent {
    session_id: String,
    worktree_id: String,
}

#[derive(serde::Serialize, Clone)]
struct ErrorEvent {
    session_id: String,
    worktree_id: String,
    error: String,
}

// =============================================================================
// Arg builder
// =============================================================================

/// Build CLI arguments for Codex CLI.
///
/// Returns (args, env_vars).
#[allow(clippy::too_many_arguments)]
pub fn build_codex_args(
    working_dir: &std::path::Path,
    existing_thread_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    reasoning_effort: Option<&str>,
    search_enabled: bool,
    add_dirs: &[String],
    instructions_file: Option<&std::path::Path>,
    multi_agent_enabled: bool,
    max_agent_threads: Option<u32>,
) -> (Vec<String>, Vec<(String, String)>) {
    let mut args = Vec::new();
    let env_vars = Vec::new();

    // Core command
    args.push("exec".to_string());
    args.push("--json".to_string());

    // Working directory
    args.push("--cd".to_string());
    args.push(working_dir.to_string_lossy().to_string());

    // Model
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m.to_string());
    }

    // Permission mode mapping
    match execution_mode.unwrap_or("plan") {
        "build" => {
            // Use untrusted approval mode: Codex pauses for approval before commands.
            // We respond via JSON-RPC on stdin (requires attached process).
            // File changes are auto-accepted; only bash commands prompt the user.
            // `codex exec` doesn't accept --ask-for-approval directly;
            // use -c config override instead.
            args.push("-c".to_string());
            args.push("approval_policy=\"untrusted\"".to_string());
            args.push("--sandbox".to_string());
            args.push("workspace-write".to_string());
        }
        "yolo" => {
            args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
        }
        // "plan" or default: enforce read-only sandbox explicitly
        // (Codex defaults to workspace-write in git repos, NOT read-only)
        _ => {
            args.push("-s".to_string());
            args.push("read-only".to_string());
        }
    }

    // Reasoning effort
    if let Some(effort) = reasoning_effort {
        args.push("-c".to_string());
        args.push(format!("model_reasoning_effort=\"{effort}\""));
    }

    // Web search: use -c config override (--search is interactive-only)
    // Values: "live" (real-time), "cached" (default), "disabled"
    args.push("-c".to_string());
    if search_enabled {
        args.push("web_search=\"live\"".to_string());
    } else {
        args.push("web_search=\"disabled\"".to_string());
    }

    // Additional directories (pasted images, context files, etc.)
    for dir in add_dirs {
        args.push("--add-dir".to_string());
        args.push(dir.clone());
    }

    // Custom instructions file (system prompt equivalent)
    if let Some(path) = instructions_file {
        args.push("-c".to_string());
        args.push(format!(
            "experimental_instructions_file=\"{}\"",
            path.to_string_lossy()
        ));
    }

    // Multi-agent: enable sub-agent collaboration tools
    if multi_agent_enabled {
        args.push("-c".to_string());
        args.push("features.multi_agent=true".to_string());
        if let Some(threads) = max_agent_threads {
            args.push("-c".to_string());
            args.push(format!("agents.max_threads={threads}"));
        }
    }

    // Resume: positional args after all flags
    if let Some(thread_id) = existing_thread_id {
        args.push("resume".to_string());
        args.push(thread_id.to_string());
    }

    (args, env_vars)
}

// =============================================================================
// Execution (detached or attached depending on mode)
// =============================================================================

/// Execute Codex CLI. In build mode, uses an attached process for interactive
/// approval support. In plan/yolo mode, uses a detached process.
#[allow(clippy::too_many_arguments)]
pub fn execute_codex_detached(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &std::path::Path,
    working_dir: &std::path::Path,
    existing_thread_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    reasoning_effort: Option<&str>,
    search_enabled: bool,
    add_dirs: &[String],
    prompt: Option<&str>,
    instructions_file: Option<&std::path::Path>,
    multi_agent_enabled: bool,
    max_agent_threads: Option<u32>,
) -> Result<(u32, CodexResponse), String> {
    use crate::codex_cli::resolve_cli_binary;

    let cli_path = resolve_cli_binary(app);

    if !cli_path.exists() {
        let error_msg = format!(
            "Codex CLI not found at {}. Please install it in Settings > General.",
            cli_path.display()
        );
        log::error!("{error_msg}");
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: error_msg.clone(),
            },
        );
        return Err(error_msg);
    }

    // Build args
    let (args, env_vars) = build_codex_args(
        working_dir,
        existing_thread_id,
        model,
        execution_mode,
        reasoning_effort,
        search_enabled,
        add_dirs,
        instructions_file,
        multi_agent_enabled,
        max_agent_threads,
    );

    log::debug!(
        "Codex CLI command: {} {}",
        cli_path.display(),
        args.join(" ")
    );

    let is_build_mode = execution_mode.unwrap_or("plan") == "build";

    if is_build_mode {
        // Attached process: bidirectional stdin/stdout for approval protocol
        execute_codex_attached(
            app,
            session_id,
            worktree_id,
            output_file,
            &cli_path,
            &args,
            &env_vars,
            working_dir,
            prompt,
            existing_thread_id.is_some(),
        )
    } else {
        // Detached process: file-based tailing (plan/yolo modes)
        execute_codex_detached_inner(
            app,
            session_id,
            worktree_id,
            output_file,
            &cli_path,
            &args,
            &env_vars,
            working_dir,
            prompt,
        )
    }
}

/// Detached execution path (plan/yolo modes).
#[allow(clippy::too_many_arguments)]
fn execute_codex_detached_inner(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &std::path::Path,
    cli_path: &std::path::Path,
    args: &[String],
    env_vars: &[(String, String)],
    working_dir: &std::path::Path,
    prompt: Option<&str>,
) -> Result<(u32, CodexResponse), String> {
    use super::detached::spawn_detached_codex;

    log::trace!("Executing Codex CLI (detached) for session: {session_id}");

    let env_refs: Vec<(&str, &str)> = env_vars
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    let pid = spawn_detached_codex(cli_path, args, prompt, output_file, working_dir, &env_refs)
        .map_err(|e| {
            let error_msg = format!("Failed to start Codex CLI: {e}");
            log::error!("{error_msg}");
            let _ = app.emit_all(
                "chat:error",
                &ErrorEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    error: error_msg.clone(),
                },
            );
            error_msg
        })?;

    log::trace!("Detached Codex CLI spawned with PID: {pid}");

    super::registry::register_process(session_id.to_string(), pid);

    super::increment_tailer_count();
    let response = match tail_codex_output(app, session_id, worktree_id, output_file, pid) {
        Ok(resp) => {
            super::decrement_tailer_count();
            super::registry::unregister_process(session_id);
            resp
        }
        Err(e) => {
            super::decrement_tailer_count();
            super::registry::unregister_process(session_id);
            return Err(e);
        }
    };

    Ok((pid, response))
}

/// Attached execution path (build mode — interactive approvals).
///
/// Spawns Codex with piped stdin/stdout so we can respond to JSON-RPC
/// approval requests. Stdout is also tee'd to the output file for history.
#[allow(clippy::too_many_arguments)]
fn execute_codex_attached(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &std::path::Path,
    cli_path: &std::path::Path,
    args: &[String],
    env_vars: &[(String, String)],
    working_dir: &std::path::Path,
    prompt: Option<&str>,
    is_resume: bool,
) -> Result<(u32, CodexResponse), String> {
    use std::io::BufRead;
    use std::process::Stdio;

    log::trace!("Executing Codex CLI (attached) for session: {session_id}");

    let mut cmd = crate::platform::silent_command(cli_path);
    cmd.args(args)
        .current_dir(working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in env_vars {
        cmd.env(key, value);
    }

    // For first message: add prompt as positional arg (not resume)
    // For resume: prompt is piped via stdin
    if !is_resume {
        if let Some(p) = prompt {
            cmd.arg(p);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Codex CLI (attached): {e}"))?;

    let pid = child.id();
    log::trace!("Attached Codex CLI spawned with PID: {pid}");

    // For resume: write prompt to stdin (but don't close it — keep open for approvals)
    if is_resume {
        if let Some(p) = prompt {
            if let Some(ref mut stdin) = child.stdin {
                stdin
                    .write_all(p.as_bytes())
                    .map_err(|e| format!("Failed to write prompt to stdin: {e}"))?;
                stdin
                    .write_all(b"\n")
                    .map_err(|e| format!("Failed to write newline to stdin: {e}"))?;
                stdin
                    .flush()
                    .map_err(|e| format!("Failed to flush stdin: {e}"))?;
            }
        }
    }

    // Take stdin for the approval channel
    let stdin_handle = child
        .stdin
        .take()
        .ok_or("Failed to take stdin from child process")?;

    // Set up approval channel
    let (approval_tx, approval_rx) = std::sync::mpsc::channel::<(u64, String)>();
    register_approval_channel(session_id, approval_tx, stdin_handle);

    // Register process for cancellation
    super::registry::register_process(session_id.to_string(), pid);

    // Take stdout for reading
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to take stdout from child process")?;
    let reader = std::io::BufReader::new(stdout);

    // Spawn stderr reader to capture errors
    let stderr = child.stderr.take();
    let stderr_session_id = session_id.to_string();
    let stderr_handle = std::thread::spawn(move || {
        let mut error_lines = Vec::new();
        if let Some(stderr) = stderr {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.trim().is_empty() => {
                        log::trace!("Codex stderr ({stderr_session_id}): {l}");
                        error_lines.push(l);
                    }
                    _ => {}
                }
            }
        }
        error_lines
    });

    // Tail stdout directly
    super::increment_tailer_count();
    let response = match tail_codex_attached(
        app,
        session_id,
        worktree_id,
        output_file,
        reader,
        &approval_rx,
    ) {
        Ok(resp) => {
            super::decrement_tailer_count();
            super::registry::unregister_process(session_id);
            cleanup_approval_channel(session_id);
            resp
        }
        Err(e) => {
            super::decrement_tailer_count();
            super::registry::unregister_process(session_id);
            cleanup_approval_channel(session_id);
            return Err(e);
        }
    };

    // Wait for child to finish (non-blocking if already done)
    let _ = child.wait();

    // Check stderr for errors
    if response.content.is_empty() && !response.cancelled {
        if let Ok(error_lines) = stderr_handle.join() {
            if !error_lines.is_empty() {
                let error_text = error_lines.join("\n");
                log::warn!("Codex CLI stderr for session {session_id}: {error_text}");
                let _ = app.emit_all(
                    "chat:error",
                    &ErrorEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        error: format!("Codex CLI failed: {error_text}"),
                    },
                );
            }
        }
    }

    Ok((pid, response))
}

// =============================================================================
// Attached stdout tailing (build mode — with approval support)
// =============================================================================

/// Tail Codex stdout from an attached process, handling JSON-RPC approval requests.
///
/// Reads JSONL line-by-line from stdout. When an approval request arrives:
/// - `item/fileChange/requestApproval` → auto-accept (build mode = acceptEdits)
/// - `item/commandExecution/requestApproval` → emit `chat:permission_denied`, block until response
///
/// Also writes each line to the output file for history/replay.
fn tail_codex_attached(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &std::path::Path,
    reader: std::io::BufReader<std::process::ChildStdout>,
    approval_rx: &std::sync::mpsc::Receiver<(u64, String)>,
) -> Result<CodexResponse, String> {
    use std::io::BufRead;
    use std::time::Duration;

    log::trace!("Starting attached Codex tailing for session: {session_id}");

    let mut output_writer = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(output_file)
        .map_err(|e| format!("Failed to open output file for writing: {e}"))?;

    let mut full_content = String::new();
    let mut thread_id = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();
    let mut completed = false;
    let mut cancelled = false;
    let mut error_emitted = false;
    let mut usage: Option<UsageData> = None;
    let mut pending_tool_ids: HashMap<String, String> = HashMap::new();

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(e) => {
                log::trace!("Error reading Codex stdout: {e}");
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        // Write to output file for history
        let _ = writeln!(output_writer, "{line}");

        if line.contains("\"_run_meta\"") {
            continue;
        }

        let msg: serde_json::Value = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                log::trace!("Failed to parse Codex line as JSON: {e}");
                continue;
            }
        };

        // Check for cancellation
        if !super::registry::is_process_running(session_id) {
            log::trace!("Session {session_id} cancelled externally, stopping attached tail");
            cancelled = true;
            break;
        }

        // Check for JSON-RPC approval requests (have "method" field, no "type" field)
        if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
            let rpc_id = msg.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
            let params = msg.get("params").unwrap_or(&serde_json::Value::Null);

            match method {
                "item/fileChange/requestApproval" => {
                    // Auto-accept file changes in build mode
                    log::trace!("Auto-accepting file change (rpc_id={rpc_id})");
                    send_approval(session_id, rpc_id, "accept").unwrap_or_else(|e| {
                        log::error!("Failed to auto-accept file change: {e}");
                    });
                }
                "item/commandExecution/requestApproval" => {
                    let command_parts = params
                        .get("command")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str())
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    let item_id = params
                        .get("itemId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    log::trace!("Command approval requested (rpc_id={rpc_id}): {command_parts}");

                    let denial = PermissionDenial {
                        tool_name: "Bash".to_string(),
                        tool_use_id: item_id,
                        tool_input: serde_json::json!({ "command": command_parts }),
                        rpc_id: Some(rpc_id),
                    };

                    let event = PermissionDeniedEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        denials: vec![denial],
                    };

                    if let Err(e) = app.emit_all("chat:permission_denied", &event) {
                        log::error!("Failed to emit permission_denied: {e}");
                    }

                    // Block until frontend responds via approve_codex_command
                    log::trace!("Blocking on approval response for rpc_id={rpc_id}...");
                    loop {
                        if !super::registry::is_process_running(session_id) {
                            log::trace!("Session cancelled while waiting for approval");
                            cancelled = true;
                            break;
                        }
                        match approval_rx.recv_timeout(Duration::from_millis(200)) {
                            Ok((id, _decision)) => {
                                log::trace!("Received approval response: rpc_id={id}");
                                break;
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                                log::trace!("Approval channel disconnected");
                                cancelled = true;
                                break;
                            }
                        }
                    }

                    if cancelled {
                        break;
                    }
                }
                _ => {
                    log::trace!("Unknown JSON-RPC method: {method}");
                }
            }
            continue;
        }

        // Standard event processing
        let event_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "thread.started" => {
                if let Some(tid) = msg.get("thread_id").and_then(|v| v.as_str()) {
                    thread_id = tid.to_string();
                    log::trace!("Codex thread started: {thread_id}");
                }
            }

            "item.started" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                match item_type {
                    "command_execution" => {
                        let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                        let tool_id = if item_id.is_empty() {
                            uuid::Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: "Bash".to_string(),
                            input: serde_json::json!({ "command": command }),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_use",
                            &ToolUseEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                id: tool_id.clone(),
                                name: "Bash".to_string(),
                                input: serde_json::json!({ "command": command }),
                                parent_tool_use_id: None,
                            },
                        );
                        let _ = app.emit_all(
                            "chat:tool_block",
                            &ToolBlockEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_call_id: tool_id,
                            },
                        );
                    }
                    "file_change" => {
                        let tool_id = if item_id.is_empty() {
                            uuid::Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        let changes = item
                            .get("changes")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: "FileChange".to_string(),
                            input: changes.clone(),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_use",
                            &ToolUseEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                id: tool_id.clone(),
                                name: "FileChange".to_string(),
                                input: changes,
                                parent_tool_use_id: None,
                            },
                        );
                        let _ = app.emit_all(
                            "chat:tool_block",
                            &ToolBlockEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_call_id: tool_id,
                            },
                        );
                    }
                    "mcp_tool_call" => {
                        let server = item
                            .get("server")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let tool = item
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let arguments = item
                            .get("arguments")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let tool_id = if item_id.is_empty() {
                            uuid::Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        let name = format!("mcp:{server}:{tool}");
                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: name.clone(),
                            input: arguments.clone(),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_use",
                            &ToolUseEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                id: tool_id.clone(),
                                name,
                                input: arguments,
                                parent_tool_use_id: None,
                            },
                        );
                        let _ = app.emit_all(
                            "chat:tool_block",
                            &ToolBlockEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_call_id: tool_id,
                            },
                        );
                    }
                    // Multi-agent collab tools (spawn_agent, send_input, wait, close_agent)
                    "collab_tool_call" => {
                        let collab_tool = item
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let tool_name = match collab_tool {
                            "spawn_agent" => "SpawnAgent",
                            "send_input" => "SendInput",
                            "wait" => "WaitForAgents",
                            "close_agent" => "CloseAgent",
                            _ => collab_tool,
                        };
                        let tool_id = if item_id.is_empty() {
                            uuid::Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        let input = item.clone();
                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: tool_name.to_string(),
                            input: input.clone(),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_use",
                            &ToolUseEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                id: tool_id.clone(),
                                name: tool_name.to_string(),
                                input,
                                parent_tool_use_id: None,
                            },
                        );
                        let _ = app.emit_all(
                            "chat:tool_block",
                            &ToolBlockEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_call_id: tool_id,
                            },
                        );
                    }
                    // Codex todo/plan list
                    "todo_list" => {
                        let tool_id = if item_id.is_empty() {
                            uuid::Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        let input = item.clone();
                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: "CodexTodoList".to_string(),
                            input: input.clone(),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_use",
                            &ToolUseEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                id: tool_id.clone(),
                                name: "CodexTodoList".to_string(),
                                input,
                                parent_tool_use_id: None,
                            },
                        );
                        let _ = app.emit_all(
                            "chat:tool_block",
                            &ToolBlockEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_call_id: tool_id,
                            },
                        );
                    }
                    other => {
                        log::debug!("Unknown Codex item.started type: {other}");
                    }
                }
            }

            "item.completed" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                match item_type {
                    "agent_message" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                full_content.push_str(text);
                                content_blocks.push(ContentBlock::Text {
                                    text: text.to_string(),
                                });
                                let _ = app.emit_all(
                                    "chat:chunk",
                                    &ChunkEvent {
                                        session_id: session_id.to_string(),
                                        worktree_id: worktree_id.to_string(),
                                        content: text.to_string(),
                                    },
                                );
                            }
                        }
                    }
                    "command_execution" => {
                        let output = item
                            .get("aggregated_output")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(output.clone());
                            }
                            let _ = app.emit_all(
                                "chat:tool_result",
                                &ToolResultEvent {
                                    session_id: session_id.to_string(),
                                    worktree_id: worktree_id.to_string(),
                                    tool_use_id: tool_id,
                                    output,
                                },
                            );
                        }
                    }
                    "file_change" => {
                        let changes = item
                            .get("changes")
                            .map(|v| serde_json::to_string(v).unwrap_or_default())
                            .unwrap_or_default();
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(changes.clone());
                            }
                            let _ = app.emit_all(
                                "chat:tool_result",
                                &ToolResultEvent {
                                    session_id: session_id.to_string(),
                                    worktree_id: worktree_id.to_string(),
                                    tool_use_id: tool_id,
                                    output: changes,
                                },
                            );
                        }
                    }
                    "reasoning" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            content_blocks.push(ContentBlock::Thinking {
                                thinking: text.to_string(),
                            });
                            let _ = app.emit_all(
                                "chat:thinking",
                                &ThinkingEvent {
                                    session_id: session_id.to_string(),
                                    worktree_id: worktree_id.to_string(),
                                    content: text.to_string(),
                                },
                            );
                        }
                    }
                    "mcp_tool_call" => {
                        let output = item
                            .get("output")
                            .map(|v| {
                                if let Some(s) = v.as_str() {
                                    s.to_string()
                                } else {
                                    serde_json::to_string(v).unwrap_or_default()
                                }
                            })
                            .unwrap_or_default();
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(output.clone());
                            }
                            let _ = app.emit_all(
                                "chat:tool_result",
                                &ToolResultEvent {
                                    session_id: session_id.to_string(),
                                    worktree_id: worktree_id.to_string(),
                                    tool_use_id: tool_id,
                                    output,
                                },
                            );
                        }
                    }
                    // Multi-agent collab tool completions
                    "collab_tool_call" => {
                        // Build output from agents_states (per-agent status + message)
                        let output = if let Some(states) = item.get("agents_states") {
                            if let Some(obj) = states.as_object() {
                                let parts: Vec<String> = obj
                                    .iter()
                                    .map(|(tid, state)| {
                                        let status = state
                                            .get("status")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("unknown");
                                        let msg = state
                                            .get("message")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        if msg.is_empty() {
                                            format!("{tid}: {status}")
                                        } else {
                                            format!("{tid}: {status} — {msg}")
                                        }
                                    })
                                    .collect();
                                if parts.is_empty() {
                                    item.get("status")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("completed")
                                        .to_string()
                                } else {
                                    parts.join("\n")
                                }
                            } else {
                                "completed".to_string()
                            }
                        } else {
                            item.get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("completed")
                                .to_string()
                        };
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            // Also update the input with final data (receiver_thread_ids, agents_states)
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(output.clone());
                                tc.input = item.clone();
                            }
                            let _ = app.emit_all(
                                "chat:tool_result",
                                &ToolResultEvent {
                                    session_id: session_id.to_string(),
                                    worktree_id: worktree_id.to_string(),
                                    tool_use_id: tool_id,
                                    output,
                                },
                            );
                        }
                    }
                    other => {
                        log::debug!("Unknown Codex item.completed type: {other}");
                    }
                }
            }

            // item.updated — only emitted for todo_list per Codex source
            "item.updated" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                if item_type == "todo_list" {
                    // Update existing CodexTodoList tool_call input with new items
                    if let Some(tool_id) = pending_tool_ids.get(item_id) {
                        let updated_input = item.clone();
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == *tool_id) {
                            tc.input = updated_input.clone();
                        }
                        // Re-emit tool_use so frontend updates
                        let _ = app.emit_all(
                            "chat:tool_use",
                            &ToolUseEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                id: tool_id.clone(),
                                name: "CodexTodoList".to_string(),
                                input: updated_input,
                                parent_tool_use_id: None,
                            },
                        );
                    }
                }
            }

            "turn.completed" => {
                if let Some(usage_obj) = msg.get("usage") {
                    usage = Some(UsageData {
                        input_tokens: usage_obj
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        output_tokens: usage_obj
                            .get("output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_read_input_tokens: usage_obj
                            .get("cached_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_creation_input_tokens: 0,
                    });
                }
                completed = true;
                log::trace!("Codex turn completed for session: {session_id}");
            }

            "turn.failed" => {
                let error_msg = extract_codex_error_message(&msg)
                    .unwrap_or_else(|| "Unknown error".to_string());
                let user_error = format_codex_user_error(&error_msg);
                let _ = app.emit_all(
                    "chat:error",
                    &ErrorEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        error: user_error,
                    },
                );
                completed = true;
                error_emitted = true;
            }

            _ => {
                // Check for unrecognized JSON with error fields (e.g., API error responses)
                if let Some(error_msg) = extract_codex_error_message(&msg) {
                    let user_error = format_codex_user_error(&error_msg);
                    log::error!("Codex error (unrecognized event) for session {session_id}: {error_msg}");
                    let _ = app.emit_all(
                        "chat:error",
                        &ErrorEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            error: user_error,
                        },
                    );
                    completed = true;
                    error_emitted = true;
                }
            }
        }

        if completed {
            break;
        }
    }

    // Fallback: process exited with no content and no error was emitted
    if !error_emitted && !completed && full_content.is_empty() && cancelled {
        log::warn!("Attached Codex process died silently for session {session_id} with no output");
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: "Codex CLI exited unexpectedly without producing output. Check your API key and usage limits.".to_string(),
            },
        );
        error_emitted = true;
    }

    // Don't emit chat:done if an error was emitted — the frontend chat:done
    // handler clears errors, which would hide the error message from the user
    if !cancelled && !error_emitted {
        let _ = app.emit_all(
            "chat:done",
            &DoneEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
            },
        );
    }

    log::trace!(
        "Attached Codex tailing complete: {} chars, {} tool calls, cancelled: {cancelled}",
        full_content.len(),
        tool_calls.len()
    );

    Ok(CodexResponse {
        content: full_content,
        thread_id,
        tool_calls,
        content_blocks,
        cancelled,
        error_emitted,
        usage,
    })
}

/// Extract an error message from a Codex JSON value, handling both formats:
/// - String format: `{"error": "message"}`
/// - Object format: `{"error": {"message": "..."}}`
fn extract_codex_error_message(msg: &serde_json::Value) -> Option<String> {
    let error = msg.get("error")?;
    // Try string format first
    if let Some(s) = error.as_str() {
        return Some(s.to_string());
    }
    // Try object format: {"error": {"message": "..."}}
    if let Some(s) = error.get("message").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    // Error field exists but in unknown format — stringify it
    Some(error.to_string())
}

/// Format a raw Codex error message into a user-friendly string.
/// Handles auth/session errors with specific guidance.
fn format_codex_user_error(error_msg: &str) -> String {
    if error_msg.contains("refresh_token_invalidated")
        || error_msg.contains("refresh token has been invalidated")
    {
        "Your Codex login session has expired. Please sign in again in Settings > General."
            .to_string()
    } else if error_msg.contains("401 Unauthorized")
        || error_msg.contains("invalidated oauth token")
    {
        "Codex authentication failed. Please sign in again in Settings > General.".to_string()
    } else {
        format!("Codex error: {error_msg}")
    }
}

/// Process a single Codex JSONL event. Shared between attached and detached tailers.
#[allow(clippy::too_many_arguments)]
fn process_codex_event(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    msg: &serde_json::Value,
    event_type: &str,
    full_content: &mut String,
    thread_id: &mut String,
    tool_calls: &mut Vec<ToolCall>,
    content_blocks: &mut Vec<ContentBlock>,
    pending_tool_ids: &mut HashMap<String, String>,
    completed: &mut bool,
    usage: &mut Option<UsageData>,
    error_emitted: &mut bool,
) {
    match event_type {
        "thread.started" => {
            if let Some(tid) = msg.get("thread_id").and_then(|v| v.as_str()) {
                *thread_id = tid.to_string();
                log::trace!("Codex thread started: {tid}");
            }
        }
        "item.started" => {
            let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

            match item_type {
                "command_execution" => {
                    let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: "Bash".to_string(),
                        input: serde_json::json!({ "command": command }),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: "Bash".to_string(),
                            input: serde_json::json!({ "command": command }),
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                "file_change" => {
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let changes = item
                        .get("changes")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: "FileChange".to_string(),
                        input: changes.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: "FileChange".to_string(),
                            input: changes,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                "mcp_tool_call" => {
                    let server = item
                        .get("server")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let tool = item
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let arguments = item
                        .get("arguments")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let name = format!("mcp:{server}:{tool}");
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: name.clone(),
                        input: arguments.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name,
                            input: arguments,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                "collab_tool_call" => {
                    let collab_tool = item
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let tool_name = match collab_tool {
                        "spawn_agent" => "SpawnAgent",
                        "send_input" => "SendInput",
                        "wait" => "WaitForAgents",
                        "close_agent" => "CloseAgent",
                        _ => collab_tool,
                    };
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let input = item.clone();
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: tool_name.to_string(),
                        input: input.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: tool_name.to_string(),
                            input,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                "todo_list" => {
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let input = item.clone();
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: "CodexTodoList".to_string(),
                        input: input.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: "CodexTodoList".to_string(),
                            input,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                other => {
                    log::debug!("Unknown Codex item.started type: {other}");
                }
            }
        }
        "item.completed" => {
            let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

            match item_type {
                "agent_message" => {
                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            full_content.push_str(text);
                            content_blocks.push(ContentBlock::Text {
                                text: text.to_string(),
                            });
                            let _ = app.emit_all(
                                "chat:chunk",
                                &ChunkEvent {
                                    session_id: session_id.to_string(),
                                    worktree_id: worktree_id.to_string(),
                                    content: text.to_string(),
                                },
                            );
                        }
                    }
                }
                "command_execution" => {
                    let output = item
                        .get("aggregated_output")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(output.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output,
                            },
                        );
                    }
                }
                "file_change" => {
                    let changes = item
                        .get("changes")
                        .map(|v| serde_json::to_string(v).unwrap_or_default())
                        .unwrap_or_default();
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(changes.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output: changes,
                            },
                        );
                    }
                }
                "reasoning" => {
                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                        content_blocks.push(ContentBlock::Thinking {
                            thinking: text.to_string(),
                        });
                        let _ = app.emit_all(
                            "chat:thinking",
                            &ThinkingEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                content: text.to_string(),
                            },
                        );
                    }
                }
                "mcp_tool_call" => {
                    let output = item
                        .get("output")
                        .map(|v| {
                            if let Some(s) = v.as_str() {
                                s.to_string()
                            } else {
                                serde_json::to_string(v).unwrap_or_default()
                            }
                        })
                        .unwrap_or_default();
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(output.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output,
                            },
                        );
                    }
                }
                "collab_tool_call" => {
                    let output = if let Some(states) = item.get("agents_states") {
                        if let Some(obj) = states.as_object() {
                            let parts: Vec<String> = obj
                                .iter()
                                .map(|(tid, state)| {
                                    let status = state
                                        .get("status")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown");
                                    let msg =
                                        state.get("message").and_then(|v| v.as_str()).unwrap_or("");
                                    if msg.is_empty() {
                                        format!("{tid}: {status}")
                                    } else {
                                        format!("{tid}: {status} — {msg}")
                                    }
                                })
                                .collect();
                            if parts.is_empty() {
                                item.get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("completed")
                                    .to_string()
                            } else {
                                parts.join("\n")
                            }
                        } else {
                            "completed".to_string()
                        }
                    } else {
                        item.get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("completed")
                            .to_string()
                    };
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(output.clone());
                            tc.input = item.clone();
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output,
                            },
                        );
                    }
                }
                other => {
                    log::debug!("Unknown Codex item.completed type: {other}");
                }
            }
        }
        // item.updated — only emitted for todo_list per Codex source
        "item.updated" => {
            let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

            if item_type == "todo_list" {
                if let Some(tool_id) = pending_tool_ids.get(item_id) {
                    let updated_input = item.clone();
                    if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == *tool_id) {
                        tc.input = updated_input.clone();
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: "CodexTodoList".to_string(),
                            input: updated_input,
                            parent_tool_use_id: None,
                        },
                    );
                }
            }
        }
        "turn.completed" => {
            if let Some(usage_obj) = msg.get("usage") {
                *usage = Some(UsageData {
                    input_tokens: usage_obj
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    output_tokens: usage_obj
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_read_input_tokens: usage_obj
                        .get("cached_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_creation_input_tokens: 0,
                });
            }
            *completed = true;
            log::trace!("Codex turn completed for session: {session_id}");
        }
        "turn.failed" => {
            let error_msg = extract_codex_error_message(msg)
                .unwrap_or_else(|| "Unknown Codex error".to_string());
            let user_error = format_codex_user_error(&error_msg);
            let _ = app.emit_all(
                "chat:error",
                &ErrorEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    error: user_error,
                },
            );
            *completed = true;
            *error_emitted = true;
            log::error!("Codex turn failed for session {session_id}: {error_msg}");
        }
        _ => {
            // Check for unrecognized JSON with error fields (e.g., API error responses)
            if let Some(error_msg) = extract_codex_error_message(msg) {
                let user_error = format_codex_user_error(&error_msg);
                log::error!("Codex error (unrecognized event) for session {session_id}: {error_msg}");
                let _ = app.emit_all(
                    "chat:error",
                    &ErrorEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        error: user_error,
                    },
                );
                *completed = true;
                *error_emitted = true;
            } else {
                log::trace!("Unknown Codex event type: {event_type}");
            }
        }
    }
}

// =============================================================================
// File-based tailing for detached Codex CLI
// =============================================================================

/// Tail a Codex JSONL output file and emit events as new lines appear.
///
/// Maps Codex events to the same Tauri events used by Claude, so the
/// frontend streaming infrastructure works unchanged.
pub fn tail_codex_output(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &std::path::Path,
    pid: u32,
) -> Result<CodexResponse, String> {
    use super::detached::is_process_alive;
    use super::tail::{NdjsonTailer, POLL_INTERVAL, POLL_INTERVAL_FAST};
    use std::time::{Duration, Instant};

    log::trace!("Starting to tail Codex NDJSON output for session: {session_id}");

    let mut tailer = NdjsonTailer::new_from_start(output_file)?;

    let mut full_content = String::new();
    let mut thread_id = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();
    let mut completed = false;
    let mut cancelled = false;
    let mut error_emitted = false;
    let mut usage: Option<UsageData> = None;
    let mut error_lines: Vec<String> = Vec::new();

    // Track tool IDs for matching started/completed pairs
    let mut pending_tool_ids: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    let startup_timeout = Duration::from_secs(120);
    let dead_process_timeout = Duration::from_secs(2);
    let started_at = Instant::now();
    let mut last_output_time = Instant::now();
    let mut received_codex_output = false;

    loop {
        let lines = tailer.poll()?;
        let had_output = !lines.is_empty();

        if had_output {
            last_output_time = Instant::now();
        }

        for line in lines {
            if line.trim().is_empty() {
                continue;
            }

            // Skip our metadata header
            if line.contains("\"_run_meta\"") {
                continue;
            }

            if !received_codex_output {
                log::trace!("Received first Codex output for session: {session_id}");
                received_codex_output = true;
            }

            let msg: serde_json::Value = match serde_json::from_str(&line) {
                Ok(m) => m,
                Err(e) => {
                    log::trace!("Failed to parse Codex line as JSON: {e}");
                    let trimmed = line.trim().to_string();
                    if !trimmed.is_empty() {
                        error_lines.push(trimmed);
                    }
                    continue;
                }
            };

            let event_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

            process_codex_event(
                app,
                session_id,
                worktree_id,
                &msg,
                event_type,
                &mut full_content,
                &mut thread_id,
                &mut tool_calls,
                &mut content_blocks,
                &mut pending_tool_ids,
                &mut completed,
                &mut usage,
                &mut error_emitted,
            );
        }

        if completed {
            break;
        }

        // Check if externally cancelled
        if !super::registry::is_process_running(session_id) {
            log::trace!("Session {session_id} cancelled externally, stopping Codex tail");
            cancelled = true;
            break;
        }

        // Timeout logic
        let process_alive = is_process_alive(pid);

        if received_codex_output {
            if !process_alive && last_output_time.elapsed() > dead_process_timeout {
                log::trace!("Codex process {pid} is no longer running and no new output");
                cancelled = true;
                break;
            }
        } else {
            let elapsed = started_at.elapsed();

            if !process_alive && elapsed > Duration::from_secs(5) {
                log::warn!(
                    "Codex process {pid} died during startup after {:.1}s with no output",
                    elapsed.as_secs_f64()
                );
                cancelled = true;
                break;
            }

            if elapsed > startup_timeout {
                log::warn!("Startup timeout exceeded waiting for Codex output");
                cancelled = true;
                break;
            }
        }

        // Adaptive sleep: poll faster when actively receiving data (5ms)
        // to reduce per-event latency, back off to 50ms when idle.
        if had_output {
            std::thread::sleep(POLL_INTERVAL_FAST);
        } else {
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    // Surface errors
    if cancelled || (full_content.is_empty() && !received_codex_output) {
        if let Ok(remaining) = tailer.poll() {
            for line in remaining {
                let trimmed = line.trim();
                if !trimmed.is_empty()
                    && !trimmed.contains("\"_run_meta\"")
                    && serde_json::from_str::<serde_json::Value>(trimmed).is_err()
                {
                    error_lines.push(trimmed.to_string());
                }
            }
        }
        let drained = tailer.drain_buffer();
        if !drained.trim().is_empty() {
            error_lines.push(drained.trim().to_string());
        }
    }

    if !error_emitted && !error_lines.is_empty() && full_content.is_empty() {
        let error_text = error_lines.join("\n");
        log::warn!("Codex CLI error output for session {session_id}: {error_text}");

        let user_error = format_codex_user_error(&error_text);
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: user_error,
            },
        );
        error_emitted = true;
    }

    // Fallback: process died silently with no content and no error emitted
    if !error_emitted && !completed && full_content.is_empty() && cancelled {
        log::warn!("Codex process died silently for session {session_id} with no output");
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: "Codex CLI exited unexpectedly without producing output. Check your API key and usage limits.".to_string(),
            },
        );
        error_emitted = true;
    }

    // Don't emit chat:done if an error was emitted — the frontend chat:done
    // handler clears errors, which would hide the error message from the user
    if !cancelled && !error_emitted {
        let _ = app.emit_all(
            "chat:done",
            &DoneEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
            },
        );
    }

    log::trace!(
        "Codex tailing complete: {} chars, {} tool calls, cancelled: {cancelled}",
        full_content.len(),
        tool_calls.len()
    );

    Ok(CodexResponse {
        content: full_content,
        thread_id,
        tool_calls,
        content_blocks,
        cancelled,
        error_emitted,
        usage,
    })
}

// =============================================================================
// JSONL history parser (for loading saved sessions)
// =============================================================================

/// Parse stored Codex JSONL into a ChatMessage (for loading history).
///
/// Maps Codex events to the same ChatMessage format used by Claude sessions.
pub fn parse_codex_run_to_message(
    lines: &[String],
    run: &super::types::RunEntry,
) -> Result<super::types::ChatMessage, String> {
    use super::types::{ChatMessage, MessageRole};
    use uuid::Uuid;

    let mut content = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();
    let mut pending_tool_ids: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }

        let msg: serde_json::Value = match serde_json::from_str(line) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if msg
            .get("_run_meta")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }

        let event_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "item.started" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                match item_type {
                    "command_execution" => {
                        let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };

                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: "Bash".to_string(),
                            input: serde_json::json!({ "command": command }),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    "file_change" => {
                        let changes = item
                            .get("changes")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };

                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: "FileChange".to_string(),
                            input: changes,
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    "mcp_tool_call" => {
                        let server = item
                            .get("server")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let tool = item
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let arguments = item
                            .get("arguments")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };

                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: format!("mcp:{server}:{tool}"),
                            input: arguments,
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    // Multi-agent collab tools (history)
                    "collab_tool_call" => {
                        let collab_tool = item
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let tool_name = match collab_tool {
                            "spawn_agent" => "SpawnAgent",
                            "send_input" => "SendInput",
                            "wait" => "WaitForAgents",
                            "close_agent" => "CloseAgent",
                            _ => collab_tool,
                        };
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: tool_name.to_string(),
                            input: item.clone(),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    // Codex todo/plan list (history)
                    "todo_list" => {
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: "CodexTodoList".to_string(),
                            input: item.clone(),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    _ => {}
                }
            }
            "item.completed" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                match item_type {
                    "agent_message" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            content.push_str(text);
                            content_blocks.push(ContentBlock::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                    "command_execution" => {
                        let output = item
                            .get("aggregated_output")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(output);
                            }
                        }
                    }
                    "file_change" => {
                        let changes = item
                            .get("changes")
                            .map(|v| serde_json::to_string(v).unwrap_or_default())
                            .unwrap_or_default();
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(changes);
                            }
                        }
                    }
                    "reasoning" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            content_blocks.push(ContentBlock::Thinking {
                                thinking: text.to_string(),
                            });
                        }
                    }
                    "mcp_tool_call" => {
                        let output = item
                            .get("output")
                            .map(|v| {
                                if let Some(s) = v.as_str() {
                                    s.to_string()
                                } else {
                                    serde_json::to_string(v).unwrap_or_default()
                                }
                            })
                            .unwrap_or_default();
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(output);
                            }
                        }
                    }
                    // Multi-agent collab tool completions (history)
                    "collab_tool_call" => {
                        let output = if let Some(states) = item.get("agents_states") {
                            if let Some(obj) = states.as_object() {
                                let parts: Vec<String> = obj
                                    .iter()
                                    .map(|(tid, state)| {
                                        let status = state
                                            .get("status")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("unknown");
                                        let msg = state
                                            .get("message")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        if msg.is_empty() {
                                            format!("{tid}: {status}")
                                        } else {
                                            format!("{tid}: {status} — {msg}")
                                        }
                                    })
                                    .collect();
                                if parts.is_empty() {
                                    "completed".to_string()
                                } else {
                                    parts.join("\n")
                                }
                            } else {
                                "completed".to_string()
                            }
                        } else {
                            "completed".to_string()
                        };
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(output);
                                tc.input = item.clone();
                            }
                        }
                    }
                    _ => {}
                }
            }
            // item.updated — only for todo_list (history)
            "item.updated" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                if item_type == "todo_list" {
                    if let Some(tool_id) = pending_tool_ids.get(item_id) {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == *tool_id) {
                            tc.input = item.clone();
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Ok(ChatMessage {
        id: run
            .assistant_message_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        session_id: String::new(), // Set by caller
        role: MessageRole::Assistant,
        content,
        timestamp: run.started_at,
        tool_calls,
        content_blocks,
        cancelled: run.cancelled,
        plan_approved: false,
        model: None,
        execution_mode: None,
        thinking_level: None,
        effort_level: None,
        recovered: run.recovered,
        usage: run.usage.clone(),
    })
}

// =============================================================================
// One-shot Codex execution (for magic prompts with --output-schema)
// =============================================================================

/// Execute a one-shot Codex CLI call with `--output-schema` for structured JSON output.
///
/// Equivalent to Claude's `--json-schema` pattern but for Codex:
///   `codex exec --json --model <model> --full-auto --output-schema <schema> -`
///
/// Returns the raw JSON string of the structured output.
pub fn execute_one_shot_codex(
    app: &tauri::AppHandle,
    prompt: &str,
    model: &str,
    output_schema: &str,
    working_dir: Option<&std::path::Path>,
) -> Result<String, String> {
    let cli_path = crate::codex_cli::resolve_cli_binary(app);

    if !cli_path.exists() {
        return Err("Codex CLI not installed".to_string());
    }

    log::trace!("Executing one-shot Codex CLI with output-schema, model: {model}");

    // Write schema to a temp file since --output-schema expects a file path
    let schema_file =
        std::env::temp_dir().join(format!("jean-codex-schema-{}.json", std::process::id()));
    std::fs::write(&schema_file, output_schema)
        .map_err(|e| format!("Failed to write schema file: {e}"))?;

    let mut cmd = crate::platform::silent_command(&cli_path);
    cmd.args([
        "exec",
        "--json",
        "--model",
        model,
        "--full-auto",
        "--output-schema",
    ]);
    cmd.arg(&schema_file);
    if let Some(dir) = working_dir {
        cmd.arg("--cd");
        cmd.arg(dir);
    } else {
        // One-shot calls that don't know a repository path should still run.
        cmd.arg("--skip-git-repo-check");
    }
    cmd.arg("-"); // Read prompt from stdin
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Codex CLI: {e}"))?;

    // Write prompt to stdin
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(prompt.as_bytes());
        // stdin is dropped here, closing the pipe
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Codex CLI: {e}"))?;

    // Clean up temp schema file
    let _ = std::fs::remove_file(&schema_file);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Codex CLI failed (exit {}): stderr={}, stdout={}",
            output.status,
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    log::trace!("Codex one-shot stdout length: {} bytes", stdout.len());

    extract_codex_structured_output(&stdout)
}

/// Parse Codex NDJSON output to extract structured JSON from --output-schema response.
///
/// Codex emits newline-delimited JSON events. We look for the structured output
/// in several possible locations:
/// - `item.completed` with type `agent_message` containing JSON text
/// - `turn.completed` with an `output` field
fn extract_codex_structured_output(output: &str) -> Result<String, String> {
    let mut last_agent_message = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            "item.completed" => {
                // Check for agent_message with text content
                if let Some(item) = parsed.get("item") {
                    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if item_type == "agent_message" {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            last_agent_message = Some(text.to_string());
                        }
                        // Also check content array
                        if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                            for block in content {
                                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        last_agent_message = Some(text.to_string());
                                    }
                                }
                                // Check for output_text type (structured output)
                                if block.get("type").and_then(|t| t.as_str()) == Some("output_text")
                                {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        // Try to parse as JSON — if it works, it's our structured output
                                        if serde_json::from_str::<serde_json::Value>(text).is_ok() {
                                            return Ok(text.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "turn.completed" => {
                // Check for output field directly
                if let Some(output_val) = parsed.get("output") {
                    if !output_val.is_null() {
                        return Ok(output_val.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    // Fall back to last agent message if it parses as JSON
    if let Some(msg) = last_agent_message {
        if serde_json::from_str::<serde_json::Value>(&msg).is_ok() {
            return Ok(msg);
        }
    }

    Err("No structured output found in Codex response".to_string())
}
