//! Gemini CLI execution module
//!
//! Handles executing Gemini CLI for chat messages with streaming support.

use crate::ai_cli::gemini::config::get_gemini_cli_path;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::Stdio;
use tauri::Emitter;

use super::claude::{ChunkEvent, ClaudeResponse, ErrorEvent};

/// Execute Gemini CLI with streaming output
/// Returns (process_id, response with content)
pub fn execute_gemini_detached(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    input_file: &Path,
    output_file: &Path,
    working_dir: &Path,
    model: Option<&str>,
    execution_mode: Option<&str>,
) -> Result<(u32, ClaudeResponse), String> {
    log::trace!("Executing Gemini CLI for session: {session_id}");
    log::trace!("Execution mode: {execution_mode:?}");
    log::trace!("Input file: {input_file:?}");
    log::trace!("Output file: {output_file:?}");
    log::trace!("Working directory: {working_dir:?}");

    // Get CLI path
    let cli_path = get_gemini_cli_path().map_err(|e| {
        let error_msg = format!(
            "Failed to get Gemini CLI path: {e}. Please install Gemini CLI via 'npm install -g @google/gemini-cli'."
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
            "Gemini CLI not installed. Please install via 'npm install -g @google/gemini-cli'."
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

    // Read input message for the prompt
    let input_message = std::fs::read_to_string(input_file)
        .map_err(|e| format!("Failed to read input file: {e}"))?;

    // Build args for Gemini CLI
    let mut args = Vec::new();

    // Model selection
    if let Some(m) = model {
        args.push("-m".to_string());
        args.push(m.to_string());
    }

    // YOLO mode for non-interactive execution (auto-approve all actions)
    args.push("--yolo".to_string());

    // Use stream-json output format for real-time streaming
    args.push("-o".to_string());
    args.push("stream-json".to_string());

    // Add the prompt as positional argument
    args.push(input_message.clone());

    // Log the command
    log::debug!(
        "Gemini CLI command: {} {}",
        cli_path.display(),
        args.iter().take(args.len() - 1).cloned().collect::<Vec<_>>().join(" ")
    );
    log::debug!("Gemini CLI prompt length: {} chars", input_message.len());

    // Spawn process with piped stdout for streaming
    let mut child = std::process::Command::new(&cli_path)
        .args(&args)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Gemini CLI: {e}"))?;

    let pid = child.id();

    // Register the process for cancellation
    super::registry::register_process(session_id.to_string(), pid);

    // Get stdout handle for streaming
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let reader = BufReader::new(stdout);

    // Accumulate content from streaming response
    let mut full_content = String::new();
    let tool_calls = Vec::new();

    // Process each line as it comes (JSONL format)
    for line_result in reader.lines() {
        // Check for cancellation
        if !super::registry::is_process_running(session_id) {
            log::trace!("Process cancelled for session: {session_id}");
            break;
        }

        let line = match line_result {
            Ok(l) => l,
            Err(e) => {
                log::warn!("Error reading line from Gemini stdout: {e}");
                continue;
            }
        };

        // Skip empty lines
        if line.trim().is_empty() {
            continue;
        }

        log::trace!("Gemini stream line: {}", &line[..std::cmp::min(200, line.len())]);

        // Strip user message JSON prefix if present (Gemini echoes user messages)
        // Pattern: {"message":{"content":"...","role":"user"},"type":"user"} followed by actual response
        let clean_line = if line.contains(r#""type":"user""#) || line.contains(r#""role":"user""#) {
            // Find the end of the JSON object
            if let Some(json_start) = line.find('{') {
                let mut brace_count = 0;
                let mut json_end = json_start;
                let mut in_string = false;
                let mut escape_next = false;

                for (i, c) in line[json_start..].char_indices() {
                    if escape_next {
                        escape_next = false;
                        continue;
                    }
                    match c {
                        '\\' if in_string => escape_next = true,
                        '"' => in_string = !in_string,
                        '{' if !in_string => brace_count += 1,
                        '}' if !in_string => {
                            brace_count -= 1;
                            if brace_count == 0 {
                                json_end = json_start + i + 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                }

                // Get text after the JSON, skip if only JSON
                let after_json = line[json_end..].trim();
                if after_json.is_empty() {
                    log::trace!("Skipping user message echo line");
                    continue;
                }
                after_json.to_string()
            } else {
                line.clone()
            }
        } else {
            line.clone()
        };

        // Skip if nothing left after stripping
        if clean_line.trim().is_empty() {
            continue;
        }

        // Try to parse as JSON
        let msg: serde_json::Value = match serde_json::from_str(&clean_line) {
            Ok(m) => m,
            Err(_) => {
                // Not JSON, treat as plain text content
                full_content.push_str(&clean_line);
                full_content.push('\n');

                let _ = app.emit(
                    "chat:chunk",
                    ChunkEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        content: clean_line.clone(),
                    },
                );
                continue;
            }
        };

        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match msg_type {
            // Skip user messages - they're just echoed back by Gemini CLI
            "user" => {
                log::trace!("Skipping user message echo from Gemini");
                continue;
            }
            // Handle message events with streaming content
            "message" => {
                if let Some(content) = msg.get("content").and_then(|v| v.as_str()) {
                    full_content.push_str(content);

                    // Emit chunk event for real-time streaming
                    let _ = app.emit(
                        "chat:chunk",
                        ChunkEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            content: content.to_string(),
                        },
                    );
                }
            }
            // Handle assistant message blocks (similar to Claude format)
            "assistant" => {
                if let Some(message) = msg.get("message") {
                    if let Some(blocks) = message.get("content").and_then(|c| c.as_array()) {
                        for block in blocks {
                            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");

                            match block_type {
                                "text" => {
                                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
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
                                "tool_use" | "function_call" => {
                                    // Handle tool use events from Gemini
                                    let id = block
                                        .get("id")
                                        .or_else(|| block.get("call_id"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let name = block
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let input = block
                                        .get("input")
                                        .or_else(|| block.get("args"))
                                        .cloned()
                                        .unwrap_or(serde_json::Value::Null);

                                    log::trace!("Gemini tool use: {name} with id {id}");

                                    // Emit tool_use event for frontend
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
                                    log::trace!("Unhandled Gemini block type: {block_type}");
                                }
                            }
                        }
                    }
                }
            }
            // Handle result events (final output)
            "result" => {
                if let Some(result) = msg.get("result").and_then(|v| v.as_str()) {
                    // Only use result if we haven't accumulated content yet
                    if full_content.is_empty() {
                        full_content = result.to_string();

                        let _ = app.emit(
                            "chat:chunk",
                            ChunkEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                content: result.to_string(),
                            },
                        );
                    }
                }
            }
            // Handle tool result events
            "tool_result" | "function_response" => {
                let tool_use_id = msg
                    .get("tool_use_id")
                    .or_else(|| msg.get("call_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let output = msg
                    .get("output")
                    .or_else(|| msg.get("response"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                log::trace!("Gemini tool result for {tool_use_id}: {}", &output[..std::cmp::min(100, output.len())]);

                let _ = app.emit(
                    "chat:tool_result",
                    serde_json::json!({
                        "session_id": session_id,
                        "worktree_id": worktree_id,
                        "tool_use_id": tool_use_id,
                        "output": output,
                    }),
                );
            }
            // Handle error events
            "error" => {
                if let Some(error) = msg.get("error").and_then(|v| v.as_str()) {
                    log::error!("Gemini error event: {error}");
                    let _ = app.emit(
                        "chat:error",
                        ErrorEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            error: error.to_string(),
                        },
                    );
                }
            }
            // Handle other event types we might encounter
            _ => {
                log::trace!("Unhandled Gemini event type: {msg_type}");
            }
        }
    }

    // Wait for process to finish
    let status = child.wait().map_err(|e| format!("Failed to wait for Gemini CLI: {e}"))?;

    // Read any remaining stderr
    if let Some(stderr) = child.stderr.take() {
        let stderr_reader = BufReader::new(stderr);
        for line in stderr_reader.lines().flatten() {
            if !line.is_empty() {
                log::warn!("Gemini CLI stderr: {line}");
            }
        }
    }

    super::registry::unregister_process(session_id);

    log::info!("Gemini CLI completed with status: {status}, content length: {} chars", full_content.len());

    // Check for errors
    if !status.success() && full_content.is_empty() {
        let error_msg = format!("Gemini CLI exited with status: {status}");
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

    // Note: Gemini doesn't support plan mode - UI should force build/yolo mode
    // The execution_mode parameter is kept for API consistency but ignored
    let _ = execution_mode; // Suppress unused warning

    // Write JSONL format to output file (so parse_run_to_message can read it)
    let assistant_json = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "text",
                    "text": response_text
                }
            ]
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
            tool_calls,
            content_blocks: Vec::new(),
            cancelled: false,
            usage: None,
        },
    ))
}
