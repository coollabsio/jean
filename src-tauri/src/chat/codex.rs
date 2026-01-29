//! Codex CLI execution module
//!
//! Handles executing OpenAI Codex CLI for chat messages with streaming support.

use crate::ai_cli::codex::config::get_codex_cli_path;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::Stdio;
use tauri::Emitter;

use super::claude::{ChunkEvent, ClaudeResponse, ErrorEvent};

/// Get Codex sandbox and approval flags based on execution mode
/// - build -> workspace-write sandbox (can edit files in repo)
/// - yolo -> full-auto (no approvals, workspace-write)
/// Note: Codex doesn't support plan mode - UI forces build/yolo mode
fn get_codex_sandbox_args(execution_mode: Option<&str>) -> Vec<&'static str> {
    match execution_mode {
        Some("build") => vec!["--sandbox", "workspace-write"],
        _ => vec!["--full-auto"], // yolo or default
    }
}

/// Map thinking level to Codex reasoning effort
/// - off -> low
/// - think -> medium
/// - megathink -> high
/// - ultrathink -> xhigh
fn get_codex_reasoning_effort(thinking_level: Option<&str>) -> &'static str {
    match thinking_level {
        Some("off") => "low",
        Some("think") => "medium",
        Some("megathink") => "high",
        Some("ultrathink") => "xhigh",
        _ => "medium", // default
    }
}

/// Execute Codex CLI and wait for completion (like Claude)
/// Returns (process_id, response with content)
pub fn execute_codex_detached(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    input_file: &Path,
    output_file: &Path,
    working_dir: &Path,
    model: Option<&str>,
    execution_mode: Option<&str>,
    thinking_level: Option<&str>,
) -> Result<(u32, ClaudeResponse), String> {
    log::trace!("Executing Codex CLI for session: {session_id}");
    log::trace!("Input file: {input_file:?}");
    log::trace!("Output file: {output_file:?}");
    log::trace!("Working directory: {working_dir:?}");
    log::trace!("Execution mode: {execution_mode:?}");
    log::trace!("Thinking level: {thinking_level:?}");

    // Get CLI path
    let cli_path = get_codex_cli_path().map_err(|e| {
        let error_msg = format!(
            "Failed to get Codex CLI path: {e}. Please install Codex CLI via 'npm install -g @openai/codex'."
        );
        log::error!("{error_msg}");
        let error_event = ErrorEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            error: error_msg.clone(),
        };
        let _ = app.emit("chat:error", &error_event);
        error_msg
    })?;

    if !cli_path.exists() {
        let error_msg =
            "Codex CLI not installed. Please install via 'npm install -g @openai/codex'."
                .to_string();
        log::error!("{error_msg}");
        let error_event = ErrorEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            error: error_msg.clone(),
        };
        let _ = app.emit("chat:error", &error_event);
        return Err(error_msg);
    }

    // Read input message
    let input_message = std::fs::read_to_string(input_file)
        .map_err(|e| format!("Failed to read input file: {e}"))?;

    // Build args for Codex CLI using 'exec' subcommand for non-interactive mode
    let mut args = Vec::new();

    // Use exec subcommand for non-interactive execution
    args.push("exec".to_string());

    // Model selection
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m.to_string());
    }

    // Enable JSON streaming output for native streaming support
    args.push("--json".to_string());

    // Sandbox/approval mode based on execution mode (build/yolo only)
    for arg in get_codex_sandbox_args(execution_mode) {
        args.push(arg.to_string());
    }

    // Note: --reasoning-effort is not supported by codex exec subcommand
    // The reasoning effort is configured via config.toml or environment variables
    // For now, we skip this parameter
    log::trace!("Thinking level for Codex: {thinking_level:?} (not passed to exec, use config.toml)");

    // Add the prompt as the last argument
    args.push(input_message.clone());

    // Log the command
    log::debug!(
        "Codex CLI command: {} {}",
        cli_path.display(),
        args.iter().take(args.len() - 1).cloned().collect::<Vec<_>>().join(" ")
    );
    log::debug!("Codex CLI prompt length: {} chars", input_message.len());

    // Spawn process with piped stdout for streaming
    let mut child = std::process::Command::new(&cli_path)
        .args(&args)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Codex CLI: {e}"))?;

    let pid = child.id();

    // Register the process for cancellation
    super::registry::register_process(session_id.to_string(), pid);

    // Get stdout handle for streaming
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let reader = BufReader::new(stdout);

    // Accumulate content from streaming response
    let mut full_content = String::new();

    // Process each line as it comes (JSONL format with --json flag)
    for line_result in reader.lines() {
        // Check for cancellation
        if !super::registry::is_process_running(session_id) {
            log::trace!("Process cancelled for session: {session_id}");
            break;
        }

        let line = match line_result {
            Ok(l) => l,
            Err(e) => {
                log::warn!("Error reading line from Codex stdout: {e}");
                continue;
            }
        };

        // Skip empty lines
        if line.trim().is_empty() {
            continue;
        }

        log::trace!("Codex stream line: {}", &line[..std::cmp::min(200, line.len())]);

        // Try to parse as JSON (with --json flag, output is JSONL)
        let msg: serde_json::Value = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(_) => {
                // Not JSON, treat as plain text content
                full_content.push_str(&line);
                full_content.push('\n');

                let _ = app.emit(
                    "chat:chunk",
                    ChunkEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        content: format!("{line}\n"),
                    },
                );
                continue;
            }
        };

        // Extract event type from JSON (OpenAI Responses API format)
        let event_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        log::debug!("Codex event type: {event_type}");

        match event_type {
            // Handle streaming text deltas (main content stream)
            "response.output_text.delta" => {
                if let Some(delta) = msg.get("delta").and_then(|v| v.as_str()) {
                    full_content.push_str(delta);

                    let _ = app.emit(
                        "chat:chunk",
                        ChunkEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            content: delta.to_string(),
                        },
                    );
                }
            }
            // Handle content part deltas (alternative format)
            "response.content_part.delta" => {
                if let Some(delta) = msg.get("delta").and_then(|d| d.get("text")).and_then(|v| v.as_str()) {
                    full_content.push_str(delta);

                    let _ = app.emit(
                        "chat:chunk",
                        ChunkEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            content: delta.to_string(),
                        },
                    );
                }
            }
            // Handle completed output items (function calls, final text)
            "response.output_item.done" => {
                if let Some(item) = msg.get("item") {
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");

                    match item_type {
                        "message" => {
                            // Extract text from message content
                            if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                                for block in content {
                                    if block.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                            // Only emit if we haven't already streamed this content
                                            if !full_content.contains(text) {
                                                full_content.push_str(text);
                                                let _ = app.emit(
                                                    "chat:chunk",
                                                    ChunkEvent {
                                                        session_id: session_id.to_string(),
                                                        worktree_id: worktree_id.to_string(),
                                                        content: text.to_string(),
                                                    },
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        "function_call" => {
                            let id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let arguments = item.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                            let input: serde_json::Value = serde_json::from_str(arguments).unwrap_or(serde_json::Value::Null);

                            log::trace!("Codex tool use: {name} with id {id}");

                            let _ = app.emit(
                                "chat:tool_use",
                                serde_json::json!({
                                    "session_id": session_id,
                                    "worktree_id": worktree_id,
                                    "id": id,
                                    "name": name,
                                    "input": input,
                                }),
                            );
                        }
                        _ => {
                            // Try to get text from item directly
                            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() && !full_content.contains(text) {
                                    full_content.push_str(text);
                                    let _ = app.emit(
                                        "chat:chunk",
                                        ChunkEvent {
                                            session_id: session_id.to_string(),
                                            worktree_id: worktree_id.to_string(),
                                            content: text.to_string(),
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
            }
            // Handle response completion
            "response.done" | "response.completed" => {
                log::trace!("Codex response completed");
                // Response is done, content should already be accumulated
            }
            // Handle error events
            "error" => {
                let error_msg = msg.get("error")
                    .and_then(|e| e.get("message").and_then(|m| m.as_str()))
                    .or_else(|| msg.get("error").and_then(|e| e.as_str()))
                    .or_else(|| msg.get("message").and_then(|m| m.as_str()))
                    .unwrap_or("Unknown error");

                log::error!("Codex error event: {error_msg}");
                let _ = app.emit(
                    "chat:error",
                    ErrorEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        error: error_msg.to_string(),
                    },
                );
            }
            // Handle message events (legacy/alternative format)
            "message" | "assistant" => {
                let content = msg
                    .get("content")
                    .and_then(|v| v.as_str())
                    .or_else(|| {
                        msg.get("message")
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_str())
                    });

                if let Some(text) = content {
                    full_content.push_str(text);

                    let _ = app.emit(
                        "chat:chunk",
                        ChunkEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            content: text.to_string(),
                        },
                    );
                }
            }
            // Skip non-content events
            "response.created" | "response.in_progress" | "response.output_item.added"
            | "response.content_part.added" | "rate_limits.updated" => {
                log::trace!("Skipping Codex event: {event_type}");
            }
            // Handle other/unknown event types - try to extract any content
            _ => {
                // Try common content fields
                let content = msg
                    .get("delta")
                    .and_then(|v| v.as_str())
                    .or_else(|| msg.get("text").and_then(|v| v.as_str()))
                    .or_else(|| msg.get("content").and_then(|v| v.as_str()))
                    .or_else(|| msg.get("output").and_then(|v| v.as_str()));

                if let Some(text) = content {
                    full_content.push_str(text);

                    let _ = app.emit(
                        "chat:chunk",
                        ChunkEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            content: text.to_string(),
                        },
                    );
                } else {
                    log::trace!("Unhandled Codex event type: {event_type}");
                }
            }
        }
    }

    // Wait for process to finish
    let status = child.wait().map_err(|e| format!("Failed to wait for Codex CLI: {e}"))?;

    // Read any remaining stderr
    if let Some(stderr) = child.stderr.take() {
        let stderr_reader = BufReader::new(stderr);
        for line in stderr_reader.lines().flatten() {
            if !line.is_empty() {
                log::warn!("Codex CLI stderr: {line}");
            }
        }
    }

    super::registry::unregister_process(session_id);

    log::info!("Codex CLI completed with status: {status}, content length: {} chars", full_content.len());

    // Check for errors
    if !status.success() && full_content.is_empty() {
        let error_msg = format!("Codex CLI exited with status: {status}");
        let _ = app.emit(
            "chat:error",
            ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: error_msg.clone(),
            },
        );
        return Err(error_msg);
    }

    let response_text = full_content.trim().to_string();

    // Note: Codex doesn't support plan mode - UI forces build/yolo mode
    // The execution_mode parameter is kept for API consistency but ignored
    let _ = execution_mode; // Suppress unused warning

    // Write JSONL format to output file (so parse_run_to_message can read it)
    let assistant_content = serde_json::json!([
        {
            "type": "text",
            "text": response_text
        }
    ]);

    let assistant_json = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": assistant_content
        }
    });
    let result_json = serde_json::json!({
        "type": "result",
        "result": response_text
    });

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .append(true)
        .open(output_file)
    {
        let _ = writeln!(file, "{assistant_json}");
        let _ = writeln!(file, "{result_json}");
    }

    // Emit done event
    let _ = app.emit(
        "chat:done",
        serde_json::json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
            "success": status.success(),
        }),
    );

    // Return response with actual content
    Ok((
        pid,
        ClaudeResponse {
            content: response_text,
            session_id: session_id.to_string(),
            tool_calls: Vec::new(),
            content_blocks: Vec::new(),
            cancelled: false,
            usage: None,
        },
    ))
}
