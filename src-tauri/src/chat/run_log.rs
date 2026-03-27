//! Run log storage for JSONL-based persistence
//!
//! This module handles writing and reading JSONL log files that contain
//! the raw Claude CLI output. Each run (Claude execution) gets its own file.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use super::storage::{
    get_session_dir, list_all_session_ids, load_metadata, save_metadata, with_metadata_mut,
};
use super::types::{
    Backend, ChatMessage, ContentBlock, MessageRole, RunEntry, RunStatus, ToolCall, UsageData,
};

// ============================================================================
// Run Log Writer
// ============================================================================

/// Writer for streaming JSONL log output
pub struct RunLogWriter {
    app: tauri::AppHandle,
    session_id: String,
    worktree_id: String,
    session_name: String,
    order: u32,
    run_id: String,
    #[allow(dead_code)] // Will be used when detached streaming is fully connected
    file: File,
}

impl RunLogWriter {
    /// Get the run ID
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Write a line to the JSONL log file (sync, immediate)
    #[allow(dead_code)] // Will be used when detached streaming is fully connected
    pub fn write_line(&mut self, line: &str) -> Result<(), String> {
        log::trace!(
            "RunLogWriter: writing line ({} bytes) to run {}",
            line.len(),
            self.run_id
        );

        writeln!(self.file, "{line}").map_err(|e| format!("Failed to write to run log: {e}"))?;

        // Flush immediately for crash safety
        self.file
            .flush()
            .map_err(|e| format!("Failed to flush run log: {e}"))?;

        Ok(())
    }

    /// Mark the run as completed and update the metadata
    pub fn complete(
        &mut self,
        assistant_message_id: &str,
        claude_session_id: Option<&str>,
        usage: Option<UsageData>,
    ) -> Result<(), String> {
        let now = now_timestamp();
        let run_id = self.run_id.clone();
        let claude_sid = claude_session_id.map(|s| s.to_string());

        with_metadata_mut(
            &self.app,
            &self.session_id,
            &self.worktree_id,
            &self.session_name,
            self.order,
            |metadata| {
                if let Some(run) = metadata.find_run_mut(&run_id) {
                    run.status = RunStatus::Completed;
                    run.ended_at = Some(now);
                    run.assistant_message_id = Some(assistant_message_id.to_string());
                    run.claude_session_id = claude_sid.clone();
                    run.usage = usage.clone();
                }

                // Update metadata's claude_session_id for resumption
                if let Some(sid) = claude_sid {
                    metadata.claude_session_id = Some(sid);
                }

                Ok(())
            },
        )?;

        log::trace!("Run completed: {}", self.run_id);
        Ok(())
    }

    /// Mark the run as cancelled and update the metadata.
    /// If a `claude_session_id` is provided, persist it so the next run can resume context.
    pub fn cancel(
        &mut self,
        assistant_message_id: Option<&str>,
        claude_session_id: Option<&str>,
    ) -> Result<(), String> {
        let now = now_timestamp();
        let run_id = self.run_id.clone();
        let asst_id = assistant_message_id.map(|s| s.to_string());
        let claude_sid = claude_session_id.map(|s| s.to_string());

        with_metadata_mut(
            &self.app,
            &self.session_id,
            &self.worktree_id,
            &self.session_name,
            self.order,
            |metadata| {
                if let Some(run) = metadata.find_run_mut(&run_id) {
                    run.status = RunStatus::Cancelled;
                    run.ended_at = Some(now);
                    run.cancelled = true;
                    run.assistant_message_id = asst_id;
                    run.claude_session_id = claude_sid.clone();
                }

                // Persist session ID so the next run can --resume with full context
                if let Some(sid) = claude_sid {
                    metadata.claude_session_id = Some(sid);
                }

                Ok(())
            },
        )?;

        log::trace!("Run cancelled: {}", self.run_id);
        Ok(())
    }

    /// Mark the run as crashed (for recovery)
    #[allow(dead_code)]
    pub fn mark_crashed(&mut self) -> Result<(), String> {
        let now = now_timestamp();
        let run_id = self.run_id.clone();

        with_metadata_mut(
            &self.app,
            &self.session_id,
            &self.worktree_id,
            &self.session_name,
            self.order,
            |metadata| {
                if let Some(run) = metadata.find_run_mut(&run_id) {
                    run.status = RunStatus::Crashed;
                    run.ended_at = Some(now);
                    run.recovered = true;
                }
                Ok(())
            },
        )?;

        log::trace!("Run marked as crashed: {}", self.run_id);
        Ok(())
    }

    /// Set the PID of the detached Claude CLI process
    #[allow(dead_code)] // PID is now set via pid_callback, but kept for potential future use
    pub fn set_pid(&mut self, pid: u32) -> Result<(), String> {
        let run_id = self.run_id.clone();

        with_metadata_mut(
            &self.app,
            &self.session_id,
            &self.worktree_id,
            &self.session_name,
            self.order,
            |metadata| {
                if let Some(run) = metadata.find_run_mut(&run_id) {
                    run.pid = Some(pid);
                }
                Ok(())
            },
        )?;

        log::trace!("Set PID {} for run: {}", pid, self.run_id);
        Ok(())
    }

    /// Get the path to the JSONL output file for this run
    pub fn output_file_path(&self) -> Result<PathBuf, String> {
        let session_dir = get_session_dir(&self.app, &self.session_id)?;
        Ok(session_dir.join(format!("{}.jsonl", self.run_id)))
    }

    /// Get the path to the input file for this run
    pub fn input_file_path(&self) -> Result<PathBuf, String> {
        let session_dir = get_session_dir(&self.app, &self.session_id)?;
        Ok(session_dir.join(format!("{}.input.jsonl", self.run_id)))
    }

    /// Get the session ID
    #[allow(dead_code)] // Will be used when detached streaming is fully connected
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Resume an existing run - opens the run for updating its metadata.
    ///
    /// This is used when resuming a detached process that was still running
    /// after the app restarted.
    pub fn resume(app: &tauri::AppHandle, session_id: &str, run_id: &str) -> Result<Self, String> {
        let session_dir = get_session_dir(app, session_id)?;
        let jsonl_path = session_dir.join(format!("{run_id}.jsonl"));

        // Open existing file in append mode
        let file = OpenOptions::new()
            .append(true)
            .open(&jsonl_path)
            .map_err(|e| format!("Failed to open run log file for resume: {e}"))?;

        // Load metadata
        let metadata = load_metadata(app, session_id)?
            .ok_or_else(|| format!("No metadata found for session: {session_id}"))?;

        log::trace!("Resumed RunLogWriter for run: {run_id}");

        Ok(Self {
            app: app.clone(),
            session_id: session_id.to_string(),
            worktree_id: metadata.worktree_id.clone(),
            session_name: metadata.name.clone(),
            order: metadata.order,
            run_id: run_id.to_string(),
            file,
        })
    }

    /// Mark the run as crashed (used when resume fails)
    pub fn crash(&mut self) -> Result<(), String> {
        let now = now_timestamp();
        let run_id = self.run_id.clone();

        with_metadata_mut(
            &self.app,
            &self.session_id,
            &self.worktree_id,
            &self.session_name,
            self.order,
            |metadata| {
                if let Some(run) = metadata.find_run_mut(&run_id) {
                    run.status = RunStatus::Crashed;
                    run.ended_at = Some(now);
                    run.recovered = true;
                    run.assistant_message_id = Some(uuid::Uuid::new_v4().to_string());
                }
                Ok(())
            },
        )?;

        log::trace!("Run marked as crashed: {}", self.run_id);
        Ok(())
    }
}

/// Start a new run - creates JSONL file and updates metadata
#[allow(clippy::too_many_arguments)]
pub fn start_run(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    session_name: &str,
    order: u32,
    user_message_id: &str,
    user_message: &str,
    model: Option<&str>,
    execution_mode: Option<&str>,
    thinking_level: Option<&str>,
    effort_level: Option<&str>,
    backend: Option<Backend>,
) -> Result<RunLogWriter, String> {
    let run_id = Uuid::new_v4().to_string();
    let now = now_timestamp();

    // Ensure session directory exists
    let session_dir = get_session_dir(app, session_id)?;

    // Create JSONL file
    let jsonl_path = session_dir.join(format!("{run_id}.jsonl"));
    log::trace!("Creating run log file at: {jsonl_path:?}");
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&jsonl_path)
        .map_err(|e| format!("Failed to create run log file: {e}"))?;

    // Write metadata header as first line (ensures file is never empty)
    let meta = serde_json::json!({
        "_run_meta": true,
        "run_id": run_id,
        "session_id": session_id,
        "worktree_id": worktree_id,
        "user_message_id": user_message_id,
        "model": model,
        "execution_mode": execution_mode,
        "thinking_level": thinking_level,
        "started_at": now,
    });
    writeln!(file, "{meta}").map_err(|e| format!("Failed to write run log header: {e}"))?;
    file.flush()
        .map_err(|e| format!("Failed to flush run log header: {e}"))?;
    log::trace!("Run log file created with metadata header");

    // Add run entry to metadata
    let run_entry = RunEntry {
        run_id: run_id.clone(),
        user_message_id: user_message_id.to_string(),
        user_message: user_message.to_string(),
        model: model.map(|s| s.to_string()),
        execution_mode: execution_mode.map(|s| s.to_string()),
        thinking_level: thinking_level.map(|s| s.to_string()),
        effort_level: effort_level.map(|s| s.to_string()),
        started_at: now,
        ended_at: None,
        status: RunStatus::Running,
        assistant_message_id: None,
        cancelled: false,
        recovered: false,
        claude_session_id: None,
        pid: None,   // Set later via set_pid() after spawning detached process
        usage: None, // Set on completion via complete()
    };

    with_metadata_mut(
        app,
        session_id,
        worktree_id,
        session_name,
        order,
        |metadata| {
            // Guard: if there's already a Running run, reject to prevent duplicates.
            // This is a safety net — the primary guard is in send_chat_message.
            let has_running = metadata.runs.iter().any(|r| r.status == RunStatus::Running);
            if has_running {
                return Err(format!(
                    "Session {session_id} already has a Running run — refusing to create duplicate"
                ));
            }

            if let Some(ref b) = backend {
                metadata.backend = b.clone();
            }
            metadata.runs.push(run_entry.clone());
            Ok(())
        },
    )?;

    log::trace!(
        "Started run {} for session {} (user_message_id: {})",
        run_id,
        session_id,
        user_message_id
    );

    Ok(RunLogWriter {
        app: app.clone(),
        session_id: session_id.to_string(),
        worktree_id: worktree_id.to_string(),
        session_name: session_name.to_string(),
        order,
        run_id,
        file,
    })
}

/// Write the input file for a detached Claude CLI run.
///
/// The input file contains the user message in stream-json format,
/// which Claude CLI reads via stdin redirection.
pub fn write_input_file(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
    message: &str,
) -> Result<PathBuf, String> {
    let session_dir = get_session_dir(app, session_id)?;
    let input_path = session_dir.join(format!("{run_id}.input.jsonl"));

    log::trace!("Writing input file at: {input_path:?}");

    // Create the stream-json input message format
    let input_message = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": message
        }
    });

    let mut file =
        File::create(&input_path).map_err(|e| format!("Failed to create input file: {e}"))?;

    writeln!(file, "{input_message}").map_err(|e| format!("Failed to write input message: {e}"))?;

    file.flush()
        .map_err(|e| format!("Failed to flush input file: {e}"))?;

    log::trace!("Input file written successfully");

    Ok(input_path)
}

/// Delete the input file for a run (cleanup after completion).
pub fn delete_input_file(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
) -> Result<(), String> {
    let session_dir = get_session_dir(app, session_id)?;
    let input_path = session_dir.join(format!("{run_id}.input.jsonl"));

    if input_path.exists() {
        fs::remove_file(&input_path).map_err(|e| format!("Failed to delete input file: {e}"))?;
        log::trace!("Deleted input file: {input_path:?}");
    }

    Ok(())
}

// ============================================================================
// Run Log Reader & Parser
// ============================================================================

/// Get the path to a run's JSONL file
pub fn get_run_log_path(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
) -> Result<PathBuf, String> {
    let session_dir = get_session_dir(app, session_id)?;
    Ok(session_dir.join(format!("{run_id}.jsonl")))
}

/// Read all lines from a run's JSONL file
pub fn read_run_log(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
) -> Result<Vec<String>, String> {
    let path = get_run_log_path(app, session_id, run_id)?;

    if !path.exists() {
        return Ok(vec![]);
    }

    let file = File::open(&path).map_err(|e| format!("Failed to open run log: {e}"))?;

    let reader = BufReader::new(file);
    let lines: Result<Vec<_>, _> = reader.lines().collect();

    lines.map_err(|e| format!("Failed to read run log: {e}"))
}

/// Parse JSONL lines and build a ChatMessage
/// This replicates the parsing logic from execute_claude_streaming
pub fn parse_run_to_message(lines: &[String], run: &RunEntry) -> Result<ChatMessage, String> {
    let mut content = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();
    // Track tool IDs that received error responses (is_error: true).
    // Used to filter out denied blocking tools (AskUserQuestion/ExitPlanMode)
    // that Claude retried multiple times.
    let mut errored_tool_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }

        let msg: serde_json::Value = match serde_json::from_str(line) {
            Ok(m) => m,
            Err(_) => continue,
        };

        // Skip metadata header line (has _run_meta: true)
        if msg
            .get("_run_meta")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }

        // Track parent_tool_use_id for sub-agent tool calls
        // Must reset to None for root-level messages, otherwise parallel Tasks get wrong parent
        let current_parent_tool_use_id = msg
            .get("parent_tool_use_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match msg_type {
            "assistant" => {
                if let Some(message) = msg.get("message") {
                    if let Some(blocks) = message.get("content").and_then(|c| c.as_array()) {
                        for block in blocks {
                            let block_type =
                                block.get("type").and_then(|v| v.as_str()).unwrap_or("");

                            match block_type {
                                "text" => {
                                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                        // Skip CLI placeholder text emitted when extended
                                        // thinking starts before any real text content
                                        if text == "(no content)" {
                                            continue;
                                        }
                                        content.push_str(text);
                                        content_blocks.push(ContentBlock::Text {
                                            text: text.to_string(),
                                        });
                                    }
                                }
                                "tool_use" => {
                                    let id = block
                                        .get("id")
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
                                        .cloned()
                                        .unwrap_or(serde_json::Value::Null);

                                    tool_calls.push(ToolCall {
                                        id: id.clone(),
                                        name,
                                        input,
                                        output: None,
                                        parent_tool_use_id: current_parent_tool_use_id.clone(),
                                    });

                                    content_blocks.push(ContentBlock::ToolUse { tool_call_id: id });
                                }
                                "thinking" => {
                                    if let Some(thinking) =
                                        block.get("thinking").and_then(|v| v.as_str())
                                    {
                                        content_blocks.push(ContentBlock::Thinking {
                                            thinking: thinking.to_string(),
                                        });
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            "user" => {
                // User messages contain tool results
                if let Some(message) = msg.get("message") {
                    if let Some(blocks) = message.get("content").and_then(|c| c.as_array()) {
                        for block in blocks {
                            let block_type =
                                block.get("type").and_then(|v| v.as_str()).unwrap_or("");

                            if block_type == "tool_result" {
                                let tool_id = block
                                    .get("tool_use_id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let output =
                                    block.get("content").and_then(|v| v.as_str()).unwrap_or("");
                                let is_error = block
                                    .get("is_error")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);

                                // Track errored tool results for filtering
                                if is_error && !tool_id.is_empty() {
                                    errored_tool_ids.insert(tool_id.to_string());
                                }

                                // Update matching tool call's output
                                if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                    tc.output = Some(output.to_string());
                                }
                            }
                        }
                    }
                }
            }
            "result" => {
                // Use result if we somehow missed content
                if content.is_empty() {
                    if let Some(result) = msg.get("result").and_then(|v| v.as_str()) {
                        content = result.to_string();
                    }
                }
            }
            _ => {}
        }
    }

    // Filter out blocking tool calls (AskUserQuestion/ExitPlanMode) that received
    // error responses. When Jean denies a blocking tool, it sends back an error
    // tool_result. Claude may retry the same tool multiple times, producing duplicate
    // question/plan UIs on recovery. Only filter errored blocking tools when
    // non-errored blocking tools of the same type remain — never remove ALL blocking
    // tools, as the last one is the legitimate pending one.
    if !errored_tool_ids.is_empty() {
        let errored_blocking: std::collections::HashSet<String> = tool_calls
            .iter()
            .filter(|tc| {
                (tc.name == "AskUserQuestion" || tc.name == "ExitPlanMode")
                    && errored_tool_ids.contains(&tc.id)
            })
            .map(|tc| tc.id.clone())
            .collect();

        if !errored_blocking.is_empty() {
            // Only filter if non-errored blocking tools remain — never remove all
            let has_non_errored_blocking = tool_calls.iter().any(|tc| {
                (tc.name == "AskUserQuestion" || tc.name == "ExitPlanMode")
                    && !errored_tool_ids.contains(&tc.id)
            });

            if has_non_errored_blocking {
                tool_calls.retain(|tc| !errored_blocking.contains(&tc.id));
                content_blocks.retain(|cb| {
                    if let ContentBlock::ToolUse { tool_call_id } = cb {
                        !errored_blocking.contains(tool_call_id)
                    } else {
                        true
                    }
                });
            }
        }
    }

    Ok(ChatMessage {
        id: run
            .assistant_message_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        session_id: String::new(), // Will be set by caller
        role: MessageRole::Assistant,
        content,
        timestamp: run.ended_at.unwrap_or(run.started_at),
        tool_calls,
        content_blocks,
        cancelled: run.cancelled,
        plan_approved: false,
        model: None,
        execution_mode: None,
        thinking_level: None,
        effort_level: None,
        recovered: run.recovered,
        usage: run.usage.clone(), // Token usage from metadata
    })
}

// ============================================================================
// Message Loading
// ============================================================================

/// Load all messages for a session by parsing JSONL files
/// Returns messages in chronological order (user message, then assistant response)
pub fn load_session_messages(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Vec<ChatMessage>, String> {
    let metadata = match load_metadata(app, session_id)? {
        Some(m) => m,
        None => {
            log::debug!("[LoadMessages] session={session_id} no metadata found");
            return Ok(vec![]);
        }
    };

    log::debug!(
        "[LoadMessages] session={session_id} metadata has {} runs (backend={:?})",
        metadata.runs.len(),
        metadata.backend
    );

    let mut messages = Vec::new();

    for run in &metadata.runs {
        // Skip user message for instant-cancelled runs (undo_send)
        // These have Cancelled status but no assistant_message_id
        let is_undo_send = run.status == RunStatus::Cancelled && run.assistant_message_id.is_none();

        if !is_undo_send {
            // Add user message
            messages.push(ChatMessage {
                id: run.user_message_id.clone(),
                session_id: session_id.to_string(),
                role: MessageRole::User,
                content: run.user_message.clone(),
                timestamp: run.started_at,
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: false,
                plan_approved: false,
                model: run.model.clone(),
                execution_mode: run.execution_mode.clone(),
                thinking_level: run.thinking_level.clone(),
                effort_level: run.effort_level.clone(),
                recovered: false,
                usage: None, // User messages don't have token usage
            });
        }

        // Add assistant message for every non-undo run, including Running runs.
        // Running logs contain partial JSONL snapshots that we can surface on reload.
        if !is_undo_send {
            let lines = read_run_log(app, session_id, &run.run_id)?;

            // Parse JSONL content — route by backend.
            // Per-run model is authoritative when present. Only fall back to
            // session-level metadata.backend for legacy runs with no model stored.
            let run_is_codex = run
                .model
                .as_deref()
                .map(crate::is_codex_model)
                .unwrap_or(false);
            let run_is_opencode = run
                .model
                .as_deref()
                .map(crate::is_opencode_model)
                .unwrap_or(false);
            let use_codex_parser = if run.model.is_some() {
                // Model stored per-run: use it directly (prevents misrouting
                // when metadata.backend was overwritten by a later run).
                run_is_codex || run_is_opencode
            } else {
                // Legacy run without model field: fall back to session backend.
                metadata.backend == Backend::Codex || metadata.backend == Backend::Opencode
            };
            let mut assistant_msg = if use_codex_parser {
                super::codex::parse_codex_run_to_message(&lines, run)?
            } else {
                parse_run_to_message(&lines, run)?
            };
            assistant_msg.session_id = session_id.to_string();
            if run.status == RunStatus::Running {
                assistant_msg.id = format!("running-{}", run.run_id);
            }

            // For crashed runs with no content (only metadata header), add placeholder
            if run.status == RunStatus::Crashed
                && assistant_msg.content.is_empty()
                && assistant_msg.tool_calls.is_empty()
            {
                assistant_msg.content =
                    "*Response lost - Jean was closed before receiving a response.*".to_string();
            }

            // For completed runs with no content, add placeholder so the
            // assistant message isn't rendered as invisible/empty (#188).
            if run.status == RunStatus::Completed
                && assistant_msg.content.is_empty()
                && assistant_msg.tool_calls.is_empty()
            {
                log::warn!(
                    "Completed run {} for session {} has empty JSONL content",
                    run.run_id,
                    session_id
                );
                assistant_msg.content =
                    "*Response content was not captured for this completed run.*".to_string();
            }

            // Skip cancelled runs with no content (instant cancel race window).
            // During the brief period between mark_running_run_cancelled() setting
            // a placeholder assistant_message_id and the command handler setting it
            // to None, the JSONL may be empty. Don't show an empty message.
            if run.status == RunStatus::Cancelled
                && assistant_msg.content.is_empty()
                && assistant_msg.tool_calls.is_empty()
            {
                continue;
            }

            messages.push(assistant_msg);
        }
    }

    Ok(messages)
}

/// Mark any running run for this session as cancelled (called by cancel_process)
/// This is called synchronously when the user cancels, before emitting chat:cancelled event.
/// This ensures the metadata is updated immediately, not after tail_claude_output times out.
pub fn mark_running_run_cancelled(app: &tauri::AppHandle, session_id: &str) -> Result<(), String> {
    let mut metadata = match load_metadata(app, session_id)? {
        Some(m) => m,
        None => return Ok(()), // No metadata = nothing to cancel
    };

    let now = now_timestamp();
    let mut modified = false;

    for run in &mut metadata.runs {
        if run.status == RunStatus::Running {
            run.status = RunStatus::Cancelled;
            run.ended_at = Some(now);
            run.cancelled = true;
            // Set a placeholder assistant_message_id so this run is NOT treated
            // as undo_send during the race window between this immediate metadata
            // write and the deferred run_log_writer.cancel() in commands.rs.
            // The command handler will overwrite with the real ID (or None for
            // instant cancel with no content).
            run.assistant_message_id = Some(format!("pending-{}", run.run_id));
            modified = true;
            log::trace!(
                "Marked run {} as cancelled for session {}",
                run.run_id,
                session_id
            );
        }
    }

    if modified {
        save_metadata(app, &metadata)?;
    }

    Ok(())
}

/// Persist partial assistant content to the latest cancelled run's JSONL file.
/// Called by the frontend when a stream is cancelled but partial content was visible.
/// This ensures the content survives app reload (the command handler may not have
/// finished writing the synthetic JSONL line yet).
pub fn persist_partial_cancelled_content(
    app: &tauri::AppHandle,
    session_id: &str,
    content: &str,
    tool_calls: &[ToolCall],
    content_blocks: &[ContentBlock],
) -> Result<(), String> {
    let metadata = match load_metadata(app, session_id)? {
        Some(m) => m,
        None => return Err("No metadata for session".to_string()),
    };

    // Find the latest cancelled run
    let run = metadata
        .runs
        .iter()
        .rev()
        .find(|r| r.status == RunStatus::Cancelled)
        .ok_or("No cancelled run found")?;

    let path = get_run_log_path(app, session_id, &run.run_id)?;

    // Only write if the file doesn't already have content (avoid double-write
    // if the command handler already wrote the synthetic line)
    let existing_lines = read_run_log(app, session_id, &run.run_id).unwrap_or_default();
    let has_assistant_content = existing_lines.iter().any(|line| {
        line.contains("\"type\":\"assistant\"") || line.contains("\"type\": \"assistant\"")
    });
    if has_assistant_content {
        log::trace!(
            "JSONL already has assistant content, skipping persist for session {session_id}"
        );
        return Ok(());
    }

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open run log for partial content: {e}"))?;

    // Build assistant message with structured content blocks if available,
    // matching the format parse_run_to_message() expects
    if !content_blocks.is_empty() {
        let blocks: Vec<serde_json::Value> = content_blocks
            .iter()
            .map(|cb| match cb {
                ContentBlock::Text { text } => {
                    serde_json::json!({"type": "text", "text": text})
                }
                ContentBlock::ToolUse { tool_call_id } => {
                    if let Some(tc) = tool_calls.iter().find(|t| t.id == *tool_call_id) {
                        serde_json::json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": tc.input
                        })
                    } else {
                        serde_json::json!({
                            "type": "tool_use",
                            "id": tool_call_id,
                            "name": "",
                            "input": null
                        })
                    }
                }
                ContentBlock::Thinking { thinking } => {
                    serde_json::json!({"type": "thinking", "thinking": thinking})
                }
            })
            .collect();

        let synthetic = serde_json::json!({
            "type": "assistant",
            "message": { "content": blocks }
        });
        writeln!(file, "{synthetic}")
            .map_err(|e| format!("Failed to write partial content: {e}"))?;

        // Write tool results as user messages so parse_run_to_message() can
        // associate outputs with tool calls
        for tc in tool_calls {
            if let Some(output) = &tc.output {
                let tool_result = serde_json::json!({
                    "type": "user",
                    "message": {
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": tc.id,
                            "content": output
                        }]
                    }
                });
                writeln!(file, "{tool_result}")
                    .map_err(|e| format!("Failed to write tool result: {e}"))?;
            }
        }
    } else {
        // Fallback: text-only (no structured blocks available)
        let synthetic = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": content}]
            }
        });
        writeln!(file, "{synthetic}")
            .map_err(|e| format!("Failed to write partial content: {e}"))?;
    }

    file.flush()
        .map_err(|e| format!("Failed to flush partial content: {e}"))?;

    log::trace!(
        "Persisted partial cancelled content ({} chars, {} blocks, {} tool calls) for session {session_id}",
        content.len(),
        content_blocks.len(),
        tool_calls.len(),
    );
    Ok(())
}

// ============================================================================
// Recovery Functions
// ============================================================================

/// Info about a recovered run
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecoveredRun {
    pub session_id: String,
    pub worktree_id: String,
    pub run_id: String,
    pub user_message: String,
    /// True if the process is still running and can be resumed
    pub resumable: bool,
    /// Execution mode of the run (plan/build/yolo) for UI status restoration
    pub execution_mode: Option<String>,
    /// Unix timestamp (seconds) when the run started — used to restore elapsed time on reload
    pub started_at: u64,
}

/// Check for and recover incomplete runs across all sessions
/// Called on app startup to handle crashed runs from previous session
pub fn recover_incomplete_runs(app: &tauri::AppHandle) -> Result<Vec<RecoveredRun>, String> {
    use super::detached::is_process_alive;

    let session_ids = list_all_session_ids(app)?;
    let mut recovered = Vec::new();

    // Sessions with active process/cancel-flag registrations are currently
    // being managed by send_chat_message — skip them entirely. Without this
    // guard, a web-access client refresh would call check_resumable_sessions,
    // mark an already-tailed run as Resumable, and resume_session would start
    // a second tail from the beginning of the file — duplicating every event.
    let actively_managed = super::registry::get_actively_managed_sessions();

    for session_id in session_ids {
        if actively_managed.contains(&session_id) {
            continue;
        }
        let mut metadata = match load_metadata(app, &session_id)? {
            Some(m) => m,
            None => continue,
        };

        let mut modified = false;

        for run in &mut metadata.runs {
            // Handle both Running (normal crash recovery) and Resumable (stale from
            // a previous recovery that never completed — e.g. app crashed twice)
            if run.status == RunStatus::Running || run.status == RunStatus::Resumable {
                let process_alive = run.pid.map(is_process_alive).unwrap_or(false);

                if process_alive {
                    run.status = RunStatus::Resumable;
                    modified = true;

                    recovered.push(RecoveredRun {
                        session_id: session_id.clone(),
                        worktree_id: metadata.worktree_id.clone(),
                        run_id: run.run_id.clone(),
                        user_message: run.user_message.clone(),
                        resumable: true,
                        execution_mode: run.execution_mode.clone(),
                        started_at: run.started_at,
                    });

                    log::trace!(
                        "Found resumable run: {} in session {} (PID: {:?})",
                        run.run_id,
                        session_id,
                        run.pid
                    );
                } else {
                    // Process is dead - check if it completed successfully
                    let completed = jsonl_has_result_line(app, &session_id, &run.run_id);

                    if completed {
                        run.status = RunStatus::Completed;
                        metadata.is_reviewing = true;

                        // Recover claude_session_id from JSONL so the session can
                        // resume with full context (#209). This handles the case
                        // where send_chat_message errored before persisting the
                        // resume ID to the session index.
                        if run.claude_session_id.is_none() {
                            if let Some(sid) =
                                extract_session_id_from_jsonl(app, &session_id, &run.run_id)
                            {
                                log::trace!(
                                    "Recovered claude_session_id from JSONL for run {} in session {}",
                                    run.run_id,
                                    session_id
                                );
                                run.claude_session_id = Some(sid.clone());
                                metadata.claude_session_id = Some(sid);
                            }
                        }
                    } else {
                        run.status = RunStatus::Crashed;
                    }
                    if run.ended_at.is_none() {
                        run.ended_at = Some(now_timestamp());
                    }
                    run.recovered = true;
                    if run.assistant_message_id.is_none() {
                        run.assistant_message_id = Some(Uuid::new_v4().to_string());
                    }
                    modified = true;

                    recovered.push(RecoveredRun {
                        session_id: session_id.clone(),
                        worktree_id: metadata.worktree_id.clone(),
                        run_id: run.run_id.clone(),
                        user_message: run.user_message.clone(),
                        resumable: false,
                        execution_mode: run.execution_mode.clone(),
                        started_at: run.started_at,
                    });

                    log::trace!(
                        "Recovered {} run: {} in session {} (user message: {})",
                        if completed { "completed" } else { "crashed" },
                        run.run_id,
                        session_id,
                        run.user_message.chars().take(50).collect::<String>()
                    );
                }
            }
        }

        if modified {
            save_metadata(app, &metadata)?;
        }
    }

    if !recovered.is_empty() {
        log::trace!("Recovered {} run(s) from previous session", recovered.len());
    }

    Ok(recovered)
}

/// Check if a run's JSONL file contains a "type":"result" line,
/// indicating the CLI process completed successfully (vs crashing).
pub fn jsonl_has_result_line(app: &tauri::AppHandle, session_id: &str, run_id: &str) -> bool {
    let session_dir = match get_session_dir(app, session_id) {
        Ok(d) => d,
        Err(_) => return false,
    };
    let jsonl_path = session_dir.join(format!("{run_id}.jsonl"));
    let file = match File::open(&jsonl_path) {
        Ok(f) => f,
        Err(_) => return false,
    };

    // Read from the end — the result line is always the last line.
    // For efficiency, read the last 8KB which is more than enough for the result JSON.
    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let reader = if file_len > 8192 {
        use std::io::{Seek, SeekFrom};
        let mut f = file;
        let _ = f.seek(SeekFrom::End(-8192));
        BufReader::new(f)
    } else {
        BufReader::new(file)
    };

    for line in reader.lines() {
        if let Ok(line) = line {
            if line.contains("\"type\":\"result\"") {
                return true;
            }
        }
    }
    false
}

/// Extract the Claude session ID from a run's JSONL file.
/// Looks for the `"session_id"` field in the result line (last ~8KB of file).
/// Returns None if the file doesn't exist, can't be read, or has no session ID.
pub fn extract_session_id_from_jsonl(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
) -> Option<String> {
    let session_dir = get_session_dir(app, session_id).ok()?;
    let jsonl_path = session_dir.join(format!("{run_id}.jsonl"));
    let file = File::open(&jsonl_path).ok()?;

    // Read from the end — the session_id is typically in the result line near EOF.
    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let reader = if file_len > 8192 {
        use std::io::{Seek, SeekFrom};
        let mut f = file;
        let _ = f.seek(SeekFrom::End(-8192));
        BufReader::new(f)
    } else {
        BufReader::new(file)
    };

    let mut last_session_id = None;
    for line in reader.lines().flatten() {
        // Look for session_id in JSON lines (typically in result or system lines)
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(sid) = val.get("session_id").and_then(|v| v.as_str()) {
                if !sid.is_empty() {
                    last_session_id = Some(sid.to_string());
                }
            }
        }
    }

    last_session_id
}

/// Find all runs with status = Running (incomplete runs that need recovery)
#[allow(dead_code)]
pub fn find_incomplete_runs(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Vec<RunEntry>, String> {
    let metadata = match load_metadata(app, session_id)? {
        Some(m) => m,
        None => return Ok(vec![]),
    };

    let incomplete: Vec<RunEntry> = metadata
        .runs
        .into_iter()
        .filter(|r| r.status == RunStatus::Running)
        .collect();

    Ok(incomplete)
}

/// Mark a run as crashed and recovered
#[allow(dead_code)]
pub fn mark_run_as_crashed(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
) -> Result<(), String> {
    let mut metadata = load_metadata(app, session_id)?
        .ok_or_else(|| format!("Metadata not found for session: {session_id}"))?;

    let now = now_timestamp();

    if let Some(run) = metadata.find_run_mut(run_id) {
        run.status = RunStatus::Crashed;
        run.ended_at = Some(now);
        run.recovered = true;
        run.assistant_message_id = Some(Uuid::new_v4().to_string());
    }

    save_metadata(app, &metadata)?;
    Ok(())
}

// ============================================================================
// Cleanup Functions
// ============================================================================

/// Delete all JSONL files for a session (called when deleting session)
#[allow(dead_code)]
pub fn delete_run_logs(app: &tauri::AppHandle, session_id: &str) -> Result<usize, String> {
    let session_dir = get_session_dir(app, session_id)?;

    let mut deleted = 0;

    if session_dir.exists() {
        for entry in fs::read_dir(&session_dir)
            .map_err(|e| format!("Failed to read session directory: {e}"))?
            .flatten()
        {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "jsonl") {
                fs::remove_file(&path).map_err(|e| format!("Failed to delete run log: {e}"))?;
                deleted += 1;
            }
        }
    }

    Ok(deleted)
}

// ============================================================================
// Utility Functions
// ============================================================================

fn now_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
