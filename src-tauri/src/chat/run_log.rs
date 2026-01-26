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
    ChatMessage, ContentBlock, MessageRole, RunEntry, RunStatus, ToolCall, UsageData,
};

// ============================================================================
// Run Log Writer
// ============================================================================

/// Writer for streaming JSONL log output
pub struct RunLogWriter {
    app: tauri::AppHandle,
    session_id: String,
    worktree_id: String,
    worktree_path: String,
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

        // Capture git diff for revert functionality
        let git_patch = capture_git_diff(&self.worktree_path);

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
                    run.git_patch = git_patch.clone();
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

    /// Mark the run as cancelled and update the metadata
    pub fn cancel(&mut self, assistant_message_id: Option<&str>) -> Result<(), String> {
        let now = now_timestamp();
        let run_id = self.run_id.clone();
        let asst_id = assistant_message_id.map(|s| s.to_string());

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
    pub fn resume(
        app: &tauri::AppHandle,
        session_id: &str,
        run_id: &str,
        worktree_path: &str,
    ) -> Result<Self, String> {
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
            worktree_path: worktree_path.to_string(),
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
    worktree_path: &str,
    session_name: &str,
    order: u32,
    user_message_id: &str,
    user_message: &str,
    model: Option<&str>,
    execution_mode: Option<&str>,
    thinking_level: Option<&str>,
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
        started_at: now,
        ended_at: None,
        status: RunStatus::Running,
        assistant_message_id: None,
        cancelled: false,
        recovered: false,
        claude_session_id: None,
        pid: None,      // Set later via set_pid() after spawning detached process
        usage: None,    // Set on completion via complete()
        git_patch: None, // Set on completion via complete()
    };

    with_metadata_mut(
        app,
        session_id,
        worktree_id,
        session_name,
        order,
        |metadata| {
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
        worktree_path: worktree_path.to_string(),
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
    let mut current_parent_tool_use_id: Option<String> = None;

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
        if let Some(parent_id) = msg.get("parent_tool_use_id").and_then(|v| v.as_str()) {
            current_parent_tool_use_id = Some(parent_id.to_string());
        }

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

    Ok(ChatMessage {
        id: run
            .assistant_message_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        session_id: String::new(), // Will be set by caller
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
        None => return Ok(vec![]),
    };

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
                recovered: false,
                usage: None, // User messages don't have token usage
            });
        }

        // Add assistant message if run has completed/cancelled/crashed
        if run.status != RunStatus::Running && !is_undo_send {
            let lines = read_run_log(app, session_id, &run.run_id)?;

            // Parse JSONL content (may only have metadata header if crashed early)
            let mut assistant_msg = parse_run_to_message(&lines, run)?;
            assistant_msg.session_id = session_id.to_string();

            // For crashed runs with no content (only metadata header), add placeholder
            if run.status == RunStatus::Crashed
                && assistant_msg.content.is_empty()
                && assistant_msg.tool_calls.is_empty()
            {
                assistant_msg.content =
                    "*Response lost - Jean was closed before receiving a response.*".to_string();
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
            // Leave assistant_message_id as None (undo_send case)
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
}

/// Check for and recover incomplete runs across all sessions
/// Called on app startup to handle crashed runs from previous session
pub fn recover_incomplete_runs(app: &tauri::AppHandle) -> Result<Vec<RecoveredRun>, String> {
    use super::detached::is_process_alive;

    let session_ids = list_all_session_ids(app)?;
    let mut recovered = Vec::new();

    for session_id in session_ids {
        let mut metadata = match load_metadata(app, &session_id)? {
            Some(m) => m,
            None => continue,
        };

        let mut modified = false;

        for run in &mut metadata.runs {
            if run.status == RunStatus::Running {
                // Check if the detached process is still running
                let process_alive = run.pid.map(is_process_alive).unwrap_or(false);

                if process_alive {
                    // Process is still running - mark as resumable so we can tail it
                    run.status = RunStatus::Resumable;
                    modified = true;

                    recovered.push(RecoveredRun {
                        session_id: session_id.clone(),
                        worktree_id: metadata.worktree_id.clone(),
                        run_id: run.run_id.clone(),
                        user_message: run.user_message.clone(),
                        resumable: true,
                    });

                    log::trace!(
                        "Found resumable run: {} in session {} (PID: {:?})",
                        run.run_id,
                        session_id,
                        run.pid
                    );
                } else {
                    // Process is dead - mark as crashed
                    run.status = RunStatus::Crashed;
                    run.ended_at = Some(now_timestamp());
                    run.recovered = true;
                    run.assistant_message_id = Some(Uuid::new_v4().to_string());
                    modified = true;

                    recovered.push(RecoveredRun {
                        session_id: session_id.clone(),
                        worktree_id: metadata.worktree_id.clone(),
                        run_id: run.run_id.clone(),
                        user_message: run.user_message.clone(),
                        resumable: false,
                    });

                    log::trace!(
                        "Recovered crashed run: {} in session {} (user message: {})",
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
        log::trace!(
            "Recovered {} crashed run(s) from previous session",
            recovered.len()
        );
    }

    Ok(recovered)
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
// Fork / Copy Functions
// ============================================================================

/// Copy runs from source session to target session up to and including a specific assistant message.
/// This is used for conversation forking - creating a new session with history up to a point.
pub fn copy_runs_to_session(
    app: &tauri::AppHandle,
    source_session_id: &str,
    target_session_id: &str,
    target_worktree_id: &str,
    target_session_name: &str,
    target_order: u32,
    up_to_assistant_message_id: &str,
) -> Result<u32, String> {
    use super::storage::{get_session_dir, load_metadata, with_metadata_mut};

    // Load source metadata to get the runs list
    let source_metadata = load_metadata(app, source_session_id)?
        .ok_or_else(|| format!("Source session {source_session_id} not found"))?;

    // Find which runs to copy (up to and including the one with the target assistant message)
    let mut runs_to_copy: Vec<&RunEntry> = Vec::new();
    let mut found_target = false;

    for run in &source_metadata.runs {
        runs_to_copy.push(run);

        // Check if this run contains the target assistant message
        if let Some(ref asst_id) = run.assistant_message_id {
            if asst_id == up_to_assistant_message_id {
                found_target = true;
                break;
            }
        }
    }

    if !found_target {
        return Err(format!(
            "Assistant message {up_to_assistant_message_id} not found in session {source_session_id}"
        ));
    }

    // Get source and target session directories
    let source_dir = get_session_dir(app, source_session_id)?;
    let target_dir = get_session_dir(app, target_session_id)?;

    // Copy each run's JSONL file and create metadata entries
    let mut copied_count = 0u32;

    for run in &runs_to_copy {
        // Copy the JSONL file
        let source_jsonl = source_dir.join(format!("{}.jsonl", run.run_id));
        let target_jsonl = target_dir.join(format!("{}.jsonl", run.run_id));

        if source_jsonl.exists() {
            fs::copy(&source_jsonl, &target_jsonl)
                .map_err(|e| format!("Failed to copy JSONL file {}: {e}", run.run_id))?;
        }

        // Add run entry to target metadata
        let run_entry = RunEntry {
            run_id: run.run_id.clone(),
            user_message_id: run.user_message_id.clone(),
            user_message: run.user_message.clone(),
            model: run.model.clone(),
            execution_mode: run.execution_mode.clone(),
            thinking_level: run.thinking_level.clone(),
            started_at: run.started_at,
            ended_at: run.ended_at,
            status: run.status.clone(),
            assistant_message_id: run.assistant_message_id.clone(),
            cancelled: run.cancelled,
            recovered: run.recovered,
            claude_session_id: None, // Don't copy Claude session ID - fork starts fresh
            pid: None,
            usage: run.usage.clone(),
            git_patch: run.git_patch.clone(), // Copy git patch for revert functionality
        };

        with_metadata_mut(
            app,
            target_session_id,
            target_worktree_id,
            target_session_name,
            target_order,
            |metadata| {
                metadata.runs.push(run_entry.clone());
                Ok(())
            },
        )?;

        copied_count += 1;
    }

    log::trace!(
        "Copied {copied_count} runs from session {source_session_id} to {target_session_id}"
    );

    Ok(copied_count)
}

/// Truncate a session to a specific assistant message, removing all subsequent runs
///
/// This deletes all runs (and their JSONL files) that come after the specified
/// assistant message, effectively "reverting" the conversation to that point.
/// If `worktree_path` is provided and runs have git patches, the code changes
/// will also be reverted using `git apply -R`.
pub fn truncate_session_to_message(
    app: &tauri::AppHandle,
    session_id: &str,
    up_to_assistant_message_id: &str,
    worktree_path: Option<&str>,
) -> Result<u32, String> {
    use super::storage::{get_session_dir, load_metadata, save_metadata};

    // Load session metadata
    let mut metadata = load_metadata(app, session_id)?
        .ok_or_else(|| format!("Session {session_id} not found"))?;

    // Find the index of the run containing the target assistant message
    let target_run_index = metadata
        .runs
        .iter()
        .position(|run| {
            run.assistant_message_id
                .as_ref()
                .map(|id| id == up_to_assistant_message_id)
                .unwrap_or(false)
        })
        .ok_or_else(|| {
            format!("Assistant message {up_to_assistant_message_id} not found in session {session_id}")
        })?;

    // If this is already the last run, nothing to truncate
    if target_run_index >= metadata.runs.len() - 1 {
        log::trace!("No runs to truncate - message is already the last one");
        return Ok(0);
    }

    // Get the session directory for deleting JSONL files
    let session_dir = get_session_dir(app, session_id)?;

    // Collect runs to delete (everything after target_run_index)
    let runs_to_delete: Vec<RunEntry> = metadata.runs.drain(target_run_index + 1..).collect();
    let deleted_count = runs_to_delete.len() as u32;

    // Apply reverse patches in reverse order (most recent first)
    // This undoes the code changes made by each run
    if let Some(path) = worktree_path {
        for run in runs_to_delete.iter().rev() {
            if let Some(ref patch) = run.git_patch {
                log::trace!(
                    "Applying reverse patch for run {} ({} bytes)",
                    run.run_id,
                    patch.len()
                );
                if let Err(e) = apply_reverse_patch(path, patch) {
                    log::warn!(
                        "Failed to apply reverse patch for run {}: {e}",
                        run.run_id
                    );
                    // Continue with other patches even if one fails
                }
            }
        }
    }

    // Delete the JSONL files for removed runs
    for run in &runs_to_delete {
        let jsonl_path = session_dir.join(format!("{}.jsonl", run.run_id));
        if jsonl_path.exists() {
            if let Err(e) = fs::remove_file(&jsonl_path) {
                log::warn!("Failed to delete JSONL file {}: {e}", run.run_id);
            }
        }
    }

    // Save updated metadata
    save_metadata(app, &metadata)?;

    log::trace!(
        "Truncated session {session_id} to message {up_to_assistant_message_id}, deleted {deleted_count} runs"
    );

    Ok(deleted_count)
}

// ============================================================================
// Git Patch Functions
// ============================================================================

/// Capture the current git diff (staged and unstaged changes) for a worktree.
/// Returns the patch content if there are changes, None otherwise.
fn capture_git_diff(worktree_path: &str) -> Option<String> {
    use std::process::Command;

    // Run git diff to capture all unstaged changes
    let output = Command::new("git")
        .args(["diff", "HEAD"])
        .current_dir(worktree_path)
        .output();

    match output {
        Ok(output) => {
            if output.status.success() {
                let diff = String::from_utf8_lossy(&output.stdout).to_string();
                if diff.trim().is_empty() {
                    None
                } else {
                    log::trace!(
                        "Captured git diff ({} bytes) for worktree: {}",
                        diff.len(),
                        worktree_path
                    );
                    Some(diff)
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log::warn!("git diff failed for {}: {}", worktree_path, stderr);
                None
            }
        }
        Err(e) => {
            log::warn!("Failed to run git diff for {}: {}", worktree_path, e);
            None
        }
    }
}

/// Apply a git patch in reverse to undo changes.
/// Returns Ok(()) if successful or if the patch is empty.
pub fn apply_reverse_patch(worktree_path: &str, patch: &str) -> Result<(), String> {
    use std::process::Command;

    if patch.trim().is_empty() {
        return Ok(());
    }

    // Use git apply -R to reverse the patch
    let mut child = Command::new("git")
        .args(["apply", "-R", "--3way"])
        .current_dir(worktree_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn git apply: {e}"))?;

    // Write the patch to stdin
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| format!("Failed to write patch to git apply: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for git apply: {e}"))?;

    if output.status.success() {
        log::trace!(
            "Successfully applied reverse patch ({} bytes) in {}",
            patch.len(),
            worktree_path
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git apply -R failed: {stderr}"))
    }
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
