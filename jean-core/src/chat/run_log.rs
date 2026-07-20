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
    is_claude_compaction_summary_text, Backend, ChatMessage, ContentBlock, LoadedMessages,
    MessageRole, RunEntry, RunStatus, ToolCall, UsageData,
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

    /// Set the Codex thread ID and (optionally) turn ID on the run entry.
    /// Called after thread/start or thread/resume returns the thread ID,
    /// and again after turn/started returns the turn ID.
    pub fn set_codex_ids(&mut self, thread_id: &str, turn_id: Option<&str>) -> Result<(), String> {
        let run_id = self.run_id.clone();
        let tid = thread_id.to_string();
        let tuid = turn_id.map(|s| s.to_string());

        with_metadata_mut(
            &self.app,
            &self.session_id,
            &self.worktree_id,
            &self.session_name,
            self.order,
            |metadata| {
                if let Some(run) = metadata.find_run_mut(&run_id) {
                    run.codex_thread_id = Some(tid);
                    run.codex_turn_id = tuid;
                }
                metadata.codex_thread_id = Some(thread_id.to_string());
                Ok(())
            },
        )?;

        log::trace!(
            "Set codex IDs for run {}: thread={thread_id}, turn={turn_id:?}",
            self.run_id
        );
        Ok(())
    }

    /// Clear the Codex turn ID (turn completed successfully).
    pub fn clear_codex_turn_id(&mut self) -> Result<(), String> {
        let run_id = self.run_id.clone();

        with_metadata_mut(
            &self.app,
            &self.session_id,
            &self.worktree_id,
            &self.session_name,
            self.order,
            |metadata| {
                if let Some(run) = metadata.find_run_mut(&run_id) {
                    run.codex_turn_id = None;
                }
                Ok(())
            },
        )?;

        Ok(())
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
    custom_profile_name: Option<&str>,
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
        backend: backend.clone(),
        custom_profile_name: custom_profile_name.map(|s| s.to_string()),
        started_at: now,
        ended_at: None,
        status: RunStatus::Running,
        assistant_message_id: None,
        cancelled: false,
        recovered: false,
        claude_session_id: None,
        pid: None,   // Set later via set_pid() after spawning detached process
        usage: None, // Set on completion via complete()
        codex_thread_id: None,
        codex_turn_id: None,
        cursor_chat_id: None,
        grok_session_id: None,
        kimi_session_id: None,
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
    let mut errored_tool_outputs: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    // OpenCode echoes the user prompt as the first text block in assistant messages.
    // Skip it during replay so the prompt doesn't appear twice.
    let mut skipped_prompt_echo = false;

    // Mirror live-stream Monitor gating (see claude.rs): while a Monitor tool
    // call is armed and its initial post-arm result has fired, subsequent
    // assistant text is a per-notification wake-up and must NOT be written
    // into the chat message `content` — otherwise all tick text lands in the
    // persisted chat blob when the run completes.
    struct MonitorArm {
        initial_turn_finished: bool,
    }
    let mut armed_monitors: std::collections::HashMap<String, MonitorArm> =
        std::collections::HashMap::new();
    // Reconstruct per-tool Monitor event logs so they survive session reload.
    // Frontend MonitorExpanded consumes `tool_call.output` when in-memory
    // `events` are empty (after reload). Each entry encodes
    // `<unix_ms>|<text>` so the UI can render real relative timestamps.
    let mut monitor_event_log: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    // Track the most recent timestamp seen in the stream (from user-msg
    // ISO 8601 `timestamp` field). System and assistant messages don't
    // carry explicit timestamps, so we fall back to this.
    let mut last_ms: u64 = (run.started_at as u64).saturating_mul(1000);
    fn parse_iso8601_ms(s: &str) -> Option<u64> {
        // Very small ISO 8601 parser: "YYYY-MM-DDTHH:MM:SS(.fff)?Z".
        // Good enough for Claude CLI's output; avoids pulling a date lib.
        use std::num::ParseIntError;
        fn part(s: &str, a: usize, b: usize) -> Result<i64, ParseIntError> {
            s[a..b].parse::<i64>()
        }
        if s.len() < 19 {
            return None;
        }
        let year = part(s, 0, 4).ok()?;
        let month = part(s, 5, 7).ok()?;
        let day = part(s, 8, 10).ok()?;
        let hour = part(s, 11, 13).ok()?;
        let minute = part(s, 14, 16).ok()?;
        let second = part(s, 17, 19).ok()?;
        // Optional .fff
        let mut ms: i64 = 0;
        let mut idx = 19;
        if s.as_bytes().get(idx) == Some(&b'.') {
            idx += 1;
            let end = s[idx..]
                .find(|c: char| !c.is_ascii_digit())
                .map(|n| idx + n)
                .unwrap_or(s.len());
            if let Ok(frac) = part(s, idx, end) {
                let digits = (end - idx) as u32;
                ms = match digits {
                    1 => frac * 100,
                    2 => frac * 10,
                    3 => frac,
                    _ => frac / 10i64.pow(digits - 3),
                };
            }
        }
        // Days-since-epoch via civil_from_days (no leap-second concerns here).
        let y = if month <= 2 { year - 1 } else { year };
        let era = y.div_euclid(400);
        let yoe = (y - era * 400) as i64;
        let doy = (153 * (month + (if month > 2 { -3 } else { 9 })) + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146097 + doe - 719468;
        let total_secs = days * 86400 + hour * 3600 + minute * 60 + second;
        Some((total_secs * 1000 + ms) as u64)
    }

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

        // Update last-seen absolute timestamp from message's `timestamp` field.
        if let Some(ts_str) = msg.get("timestamp").and_then(|v| v.as_str()) {
            if let Some(ms) = parse_iso8601_ms(ts_str) {
                last_ms = ms;
            }
        }

        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match msg_type {
            "steered_user_message" => {
                if let Some(text) = msg.get("text").and_then(|v| v.as_str()) {
                    content_blocks.push(ContentBlock::UserInput {
                        text: text.to_string(),
                    });
                }
            }
            "assistant" => {
                // Text-routing gate (mirrors live-stream logic): if ANY armed
                // Monitor has initial_turn_finished=true, this assistant turn
                // is a per-notification wake-up, so skip its text from chat.
                let in_monitor_wakeup = armed_monitors.values().any(|a| a.initial_turn_finished);

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
                                        if text == "(no content)"
                                            || is_claude_compaction_summary_text(text)
                                        {
                                            continue;
                                        }
                                        if !skipped_prompt_echo
                                            && content_blocks.is_empty()
                                            && text.trim() == run.user_message.trim()
                                        {
                                            skipped_prompt_echo = true;
                                            continue;
                                        }
                                        // Route this block's text to either chat or
                                        // Monitor event log. We split on lines so we
                                        // can peel off `[Monitor notification...]`
                                        // fragments that the CLI bakes into Claude's
                                        // assistant text when Monitor output drains
                                        // mid-turn. CLI emits multiple shapes
                                        // (`[Monitor notification]`,
                                        // `[Monitor notification: <payload>]`, …);
                                        // prefix match without closing bracket catches all.
                                        let monitor_target = if !armed_monitors.is_empty()
                                            || in_monitor_wakeup
                                        {
                                            armed_monitors.iter().next().map(|(id, _)| id.clone())
                                        } else {
                                            None
                                        };

                                        let mut chat_buf = String::new();
                                        for raw_line in text.split_inclusive('\n') {
                                            let trimmed = raw_line.trim_end_matches('\n');
                                            let is_notification = trimmed
                                                .trim_start()
                                                .starts_with("[Monitor notification");
                                            if is_notification || in_monitor_wakeup {
                                                // Flush any queued chat text first.
                                                if !chat_buf.is_empty() {
                                                    content.push_str(&chat_buf);
                                                    content_blocks.push(ContentBlock::Text {
                                                        text: chat_buf.clone(),
                                                    });
                                                    chat_buf.clear();
                                                }
                                                if let Some(ref id) = monitor_target {
                                                    let line = trimmed.trim();
                                                    if !line.is_empty() {
                                                        monitor_event_log
                                                            .entry(id.clone())
                                                            .or_default()
                                                            .push(format!("{last_ms}|{line}"));
                                                    }
                                                }
                                            } else {
                                                chat_buf.push_str(raw_line);
                                            }
                                        }
                                        if !chat_buf.is_empty() {
                                            content.push_str(&chat_buf);
                                            content_blocks
                                                .push(ContentBlock::Text { text: chat_buf });
                                        }
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

                                    // Track armed Monitors so we can gate subsequent text.
                                    if name == "Monitor" {
                                        armed_monitors.insert(
                                            id.clone(),
                                            MonitorArm {
                                                initial_turn_finished: false,
                                            },
                                        );
                                    }

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
                                    errored_tool_outputs
                                        .insert(tool_id.to_string(), output.to_string());
                                }

                                // For armed Monitors, capture the tool_result text
                                // into the event log instead of overwriting .output
                                // (which we'll fill with the event log at the end).
                                if armed_monitors.contains_key(tool_id) {
                                    if !output.is_empty() {
                                        monitor_event_log
                                            .entry(tool_id.to_string())
                                            .or_default()
                                            .push(format!("{last_ms}|{output}"));
                                    }
                                } else if let Some(tc) =
                                    tool_calls.iter_mut().find(|t| t.id == tool_id)
                                {
                                    // Non-Monitor tool: normal output update
                                    tc.output = Some(output.to_string());
                                }
                            }
                        }
                    }
                }
            }
            "result" => {
                // Each `result` closes a turn; flip the post-arm flag on every
                // armed Monitor so subsequent assistant text is gated out.
                for arm in armed_monitors.values_mut() {
                    arm.initial_turn_finished = true;
                }
                // Advance wall-clock cursor by this turn's duration so
                // Monitor event timestamps within the next turn are distinct.
                if let Some(dur) = msg.get("duration_ms").and_then(|v| v.as_u64()) {
                    last_ms = last_ms.saturating_add(dur);
                }
                // Use result if we somehow missed content
                if content.is_empty() {
                    if let Some(result) = msg.get("result").and_then(|v| v.as_str()) {
                        content = result.to_string();
                    }
                }
            }
            "system" => {
                let subtype = msg.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                let tool_id = msg.get("tool_use_id").and_then(|v| v.as_str());

                // Capture Monitor lifecycle events into its event log.
                if matches!(
                    subtype,
                    "task_started" | "task_updated" | "task_notification"
                ) {
                    if let Some(id) = tool_id.filter(|id| armed_monitors.contains_key(*id)) {
                        let line = match subtype {
                            "task_started" => {
                                let desc = msg
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                if desc.is_empty() {
                                    "task started".to_string()
                                } else {
                                    format!("task started — {desc}")
                                }
                            }
                            "task_updated" => {
                                let s = msg
                                    .get("patch")
                                    .and_then(|p| p.get("status"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("updated");
                                format!("task {s}")
                            }
                            "task_notification" => {
                                let s = msg
                                    .get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("update");
                                let summary =
                                    msg.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                                if summary.is_empty() {
                                    s.to_string()
                                } else {
                                    format!("{s} — {summary}")
                                }
                            }
                            _ => String::new(),
                        };
                        if !line.is_empty() {
                            monitor_event_log
                                .entry(id.to_string())
                                .or_default()
                                .push(format!("{last_ms}|{line}"));
                        }
                    }
                }

                // Disarm Monitor on task_notification { status: "completed" |
                // "error" | "timeout" } so any final summary turn after it
                // lands in chat (as intended).
                if subtype == "task_notification" {
                    let status = msg.get("status").and_then(|v| v.as_str());
                    if matches!(status, Some("completed") | Some("error") | Some("timeout")) {
                        if let Some(id) = tool_id {
                            armed_monitors.remove(id);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // Materialize Monitor event logs onto each Monitor tool_call.output.
    // Frontend MonitorExpanded falls back to parsing `output` line-by-line
    // when in-memory `events` is empty (after session reload).
    for tc in tool_calls.iter_mut() {
        if tc.name == "Monitor" {
            if let Some(events) = monitor_event_log.remove(&tc.id) {
                if !events.is_empty() {
                    tc.output = Some(events.join("\n"));
                }
            }
        }
    }

    // Filter out blocking tool calls (AskUserQuestion/plan approval) that received
    // error responses. When Jean denies a blocking tool, it sends back an error
    // tool_result. Claude may retry the same tool multiple times, producing duplicate
    // question/plan UIs on recovery. Only filter generic errored blocking tools when
    // non-errored blocking tools of the same type remain — never remove ALL blocking
    // tools, as the last one may be the legitimate pending one.
    //
    // Exception: if Claude CLI says the tool is unavailable/not enabled, there is
    // no pending UI to answer. Drop it unconditionally so Jean does not park the
    // session on an impossible AskUserQuestion/ExitPlanMode approval.
    if !errored_tool_ids.is_empty() {
        let is_unavailable_error = |id: &str| {
            errored_tool_outputs.get(id).is_some_and(|output| {
                output.contains("No such tool available")
                    || output.contains("not enabled in this context")
            })
        };

        let errored_blocking: std::collections::HashSet<String> = tool_calls
            .iter()
            .filter(|tc| {
                (tc.name == "AskUserQuestion"
                    || tc.name == "ExitPlanMode"
                    || tc.name == "CodexPlan"
                    || tc.name == "question")
                    && errored_tool_ids.contains(&tc.id)
            })
            .map(|tc| tc.id.clone())
            .collect();

        let unavailable_blocking: std::collections::HashSet<String> = errored_blocking
            .iter()
            .filter(|id| is_unavailable_error(id))
            .cloned()
            .collect();

        if !unavailable_blocking.is_empty() {
            tool_calls.retain(|tc| !unavailable_blocking.contains(&tc.id));
            content_blocks.retain(|cb| {
                if let ContentBlock::ToolUse { tool_call_id } = cb {
                    !unavailable_blocking.contains(tool_call_id)
                } else {
                    true
                }
            });
        }

        let errored_blocking: std::collections::HashSet<String> = errored_blocking
            .difference(&unavailable_blocking)
            .cloned()
            .collect();

        if !errored_blocking.is_empty() {
            // Only filter if non-errored blocking tools remain — never remove all
            let has_non_errored_blocking = tool_calls.iter().any(|tc| {
                (tc.name == "AskUserQuestion"
                    || tc.name == "ExitPlanMode"
                    || tc.name == "CodexPlan"
                    || tc.name == "question")
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

fn should_inject_synthetic_exit_plan(
    backend: &Backend,
    run: &RunEntry,
    assistant_msg: &ChatMessage,
) -> bool {
    // Codex history recovery is handled in parse_codex_run_to_message(), which
    // now covers both structured plan events and plain-text final answers.
    let base_match = run.status == RunStatus::Completed
        && run.execution_mode.as_deref() == Some("plan")
        && !assistant_msg.cancelled
        && !assistant_msg.content.trim().is_empty()
        && !assistant_msg
            .tool_calls
            .iter()
            .any(|tc| tc.name == "ExitPlanMode" || tc.name == "CodexPlan");

    match backend {
        Backend::Opencode | Backend::Pi | Backend::Commandcode | Backend::Kimi => base_match,
        Backend::Cursor => false, // Plan approval only on real createPlanToolCall / interaction_query
        _ => false,
    }
}

fn should_inject_synthetic_enter_plan(
    _backend: &Backend,
    _run: &RunEntry,
    _assistant_msg: &ChatMessage,
) -> bool {
    false
}

fn inject_synthetic_enter_plan(_run_id: &str, _assistant_msg: &mut ChatMessage) {}

fn inject_synthetic_exit_plan(backend: &Backend, run_id: &str, assistant_msg: &mut ChatMessage) {
    let synthetic_id = format!("synthetic-exit-plan-{run_id}");
    // Codex uses CodexPlan with plan content; OpenCode uses ExitPlanMode (empty input)
    let (tool_name, input) = if matches!(backend, Backend::Codex) {
        // Only remove text blocks whose content is part of the plan text
        let plan_text = &assistant_msg.content;
        assistant_msg.content_blocks.retain(|cb| match cb {
            ContentBlock::Text { text } => !plan_text.contains(text.as_str()),
            _ => true,
        });
        (
            "CodexPlan",
            serde_json::json!({
                "plan": assistant_msg.content,
                "source": "codex",
            }),
        )
    } else if matches!(backend, Backend::Kimi) {
        (
            "ExitPlanMode",
            serde_json::json!({
                "plan": assistant_msg.content,
                "source": "kimi",
            }),
        )
    } else {
        ("ExitPlanMode", serde_json::json!({}))
    };
    assistant_msg.tool_calls.push(ToolCall {
        id: synthetic_id.clone(),
        name: tool_name.to_string(),
        input,
        output: None,
        parent_tool_use_id: None,
    });
    assistant_msg.content_blocks.push(ContentBlock::ToolUse {
        tool_call_id: synthetic_id,
    });
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
    Ok(load_session_messages_window(app, session_id, None, None)?.messages)
}

struct RenderableRunWindow {
    run_indices: Vec<usize>,
    start_index: usize,
}

fn select_renderable_run_window<F>(
    runs: &[RunEntry],
    limit: Option<usize>,
    before_run_index: Option<usize>,
    is_renderable: F,
) -> RenderableRunWindow
where
    F: FnMut(usize, &RunEntry) -> bool,
{
    let end = before_run_index.unwrap_or(runs.len()).min(runs.len());
    let max_renderable = limit.unwrap_or(usize::MAX);
    let mut run_indices = Vec::new();
    let mut is_renderable = is_renderable;

    if max_renderable > 0 {
        for index in (0..end).rev() {
            if is_renderable(index, &runs[index]) {
                run_indices.push(index);
                if run_indices.len() >= max_renderable {
                    break;
                }
            }
        }
    }

    run_indices.reverse();
    let start_index = run_indices.first().copied().unwrap_or(0);

    RenderableRunWindow {
        run_indices,
        start_index,
    }
}

fn run_uses_codex_history_parser(metadata_backend: &Backend, run: &RunEntry) -> bool {
    if run.model.is_some() {
        run.model
            .as_deref()
            .map(crate::is_codex_model)
            .unwrap_or(false)
    } else {
        metadata_backend == &Backend::Codex
    }
}

fn run_uses_pi_history_parser(metadata_backend: &Backend, run: &RunEntry) -> bool {
    run.backend.as_ref() == Some(&Backend::Pi)
        || run
            .model
            .as_deref()
            .map(crate::is_pi_model)
            .unwrap_or(false)
        || (run.model.is_none() && metadata_backend == &Backend::Pi)
}

fn run_uses_grok_history_parser(metadata_backend: &Backend, run: &RunEntry) -> bool {
    run.backend.as_ref() == Some(&Backend::Grok)
        || run
            .model
            .as_deref()
            .map(crate::is_grok_model)
            .unwrap_or(false)
        || (run.model.is_none() && metadata_backend == &Backend::Grok)
}

fn run_uses_kimi_history_parser(metadata_backend: &Backend, run: &RunEntry) -> bool {
    run.backend.as_ref() == Some(&Backend::Kimi)
        || run
            .model
            .as_deref()
            .map(crate::is_kimi_model)
            .unwrap_or(false)
        || (run.model.is_none() && metadata_backend == &Backend::Kimi)
}

fn cancelled_codex_run_has_visible_artifacts(
    app: &tauri::AppHandle,
    session_id: &str,
    metadata_backend: &Backend,
    run: &RunEntry,
) -> bool {
    if run.status != RunStatus::Cancelled || run.assistant_message_id.is_some() {
        return false;
    }
    if !run_uses_codex_history_parser(metadata_backend, run) {
        return false;
    }

    let Ok(lines) = read_run_log(app, session_id, &run.run_id) else {
        return false;
    };

    super::codex::codex_run_log_has_visible_assistant_artifacts(
        &lines,
        run.execution_mode.as_deref() == Some("plan"),
    )
}

/// Load a window of messages for a session by parsing JSONL files.
///
/// - `limit`: max number of renderable runs (most recent within window) to parse. `None` = all.
/// - `before_run_index`: only parse runs strictly before this index. `None` = up to end.
///
/// Returned `LoadedMessages.loaded_run_start_index` is the index of the first run actually
/// parsed; subsequent paginated loads should pass that value as `before_run_index`.
pub fn load_session_messages_window(
    app: &tauri::AppHandle,
    session_id: &str,
    limit: Option<usize>,
    before_run_index: Option<usize>,
) -> Result<LoadedMessages, String> {
    let metadata = match load_metadata(app, session_id)? {
        Some(m) => m,
        None => {
            log::debug!("[LoadMessages] session={session_id} no metadata found");
            return Ok(LoadedMessages {
                messages: vec![],
                total_runs: 0,
                loaded_run_start_index: 0,
            });
        }
    };

    let total_runs = metadata.runs.len();
    let cancelled_artifact_run_indices = std::cell::RefCell::new(std::collections::HashSet::new());
    let mut is_renderable = |index: usize, run: &RunEntry| {
        if run.is_renderable_in_chat_history() {
            return true;
        }
        if cancelled_codex_run_has_visible_artifacts(app, session_id, &metadata.backend, run) {
            cancelled_artifact_run_indices.borrow_mut().insert(index);
            return true;
        }
        false
    };
    let window =
        select_renderable_run_window(&metadata.runs, limit, before_run_index, &mut is_renderable);

    log::debug!(
        "[LoadMessages] session={session_id} metadata has {} runs (backend={:?}) — renderable window start={} count={}",
        total_runs,
        metadata.backend,
        window.start_index,
        window.run_indices.len(),
    );

    let mut messages = Vec::new();

    for run_index in &window.run_indices {
        let run = &metadata.runs[*run_index];

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

        // Add assistant message for every run that should render assistant output.
        // Running logs contain partial JSONL snapshots that we can surface on reload.
        if run.renders_assistant_message()
            || cancelled_artifact_run_indices.borrow().contains(run_index)
        {
            let lines = read_run_log(app, session_id, &run.run_id)?;

            // Parse JSONL content — route by backend.
            // Per-run model is authoritative when present. Only fall back to
            // session-level metadata.backend for legacy runs with no model stored.
            let use_codex_parser = run_uses_codex_history_parser(&metadata.backend, run);
            let mut assistant_msg = if use_codex_parser {
                super::codex::parse_codex_run_to_message(&lines, run)?
            } else if run_uses_pi_history_parser(&metadata.backend, run) {
                super::pi::parse_pi_run_to_message(&lines, run)?
            } else if run_uses_grok_history_parser(&metadata.backend, run) {
                super::grok::parse_grok_run_to_message(&lines, run)?
            } else if run_uses_kimi_history_parser(&metadata.backend, run) {
                super::kimi::parse_kimi_run_to_message(&lines, run)?
            } else {
                parse_run_to_message(&lines, run)?
            };
            let is_cursor_run = run
                .model
                .as_deref()
                .map(crate::is_cursor_model)
                .unwrap_or(metadata.backend == Backend::Cursor);
            if is_cursor_run {
                let original_content = assistant_msg.content.clone();
                let normalized_content = super::cursor::normalize_cursor_content(&original_content);
                if normalized_content != assistant_msg.content {
                    assistant_msg.content = normalized_content.clone();
                    if let Some(ContentBlock::Text { text }) = assistant_msg
                        .content_blocks
                        .iter_mut()
                        .find(|block| matches!(block, ContentBlock::Text { text } if text == &original_content))
                    {
                        *text = normalized_content;
                    }
                }
            }
            let run_backend = run.backend.as_ref().unwrap_or(&metadata.backend);
            assistant_msg.session_id = session_id.to_string();
            if run.status == RunStatus::Running {
                assistant_msg.id = format!("running-{}", run.run_id);
            } else if run.status == RunStatus::Cancelled && run.assistant_message_id.is_none() {
                assistant_msg.id = format!("cancelled-{}", run.run_id);
            }

            if should_inject_synthetic_enter_plan(run_backend, run, &assistant_msg) {
                inject_synthetic_enter_plan(&run.run_id, &mut assistant_msg);
            }

            // OpenCode/Codex can complete plan-mode runs without a native
            // ExitPlanMode/CodexPlan tool. Recreate the synthetic marker so
            // recovered sessions render the same approval affordances.
            if should_inject_synthetic_exit_plan(run_backend, run, &assistant_msg) {
                inject_synthetic_exit_plan(run_backend, &run.run_id, &mut assistant_msg);
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

            messages.push(assistant_msg);
        }
    }

    Ok(LoadedMessages {
        messages,
        total_runs,
        loaded_run_start_index: window.start_index,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_run() -> RunEntry {
        RunEntry {
            run_id: "run-123".to_string(),
            user_message_id: "user-123".to_string(),
            user_message: "continue".to_string(),
            model: Some("gpt-5.4".to_string()),
            execution_mode: Some("plan".to_string()),
            thinking_level: None,
            effort_level: None,
            backend: Some(Backend::Codex),
            custom_profile_name: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Completed,
            assistant_message_id: Some("assistant-123".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
            grok_session_id: None,
            kimi_session_id: None,
        }
    }

    fn sample_assistant_message() -> ChatMessage {
        ChatMessage {
            id: "assistant-123".to_string(),
            session_id: "session-123".to_string(),
            role: MessageRole::Assistant,
            content: "Here is the plan".to_string(),
            timestamp: 2,
            tool_calls: vec![],
            content_blocks: vec![ContentBlock::Text {
                text: "Here is the plan".to_string(),
            }],
            cancelled: false,
            plan_approved: false,
            model: None,
            execution_mode: None,
            thinking_level: None,
            effort_level: None,
            recovered: false,
            usage: None,
        }
    }

    #[test]
    fn injects_synthetic_exit_plan_for_completed_opencode_plan_runs() {
        let run = sample_run();
        let mut msg = sample_assistant_message();

        assert!(should_inject_synthetic_exit_plan(
            &Backend::Opencode,
            &run,
            &msg,
        ));

        inject_synthetic_exit_plan(&Backend::Opencode, &run.run_id, &mut msg);

        assert_eq!(msg.tool_calls.len(), 1);
        assert_eq!(msg.tool_calls[0].name, "ExitPlanMode");
        assert_eq!(msg.tool_calls[0].id, "synthetic-exit-plan-run-123");
    }

    #[test]
    fn injects_synthetic_exit_plan_for_completed_commandcode_plan_runs() {
        let run = sample_run();
        let mut msg = sample_assistant_message();

        assert!(should_inject_synthetic_exit_plan(
            &Backend::Commandcode,
            &run,
            &msg,
        ));

        inject_synthetic_exit_plan(&Backend::Commandcode, &run.run_id, &mut msg);

        assert_eq!(msg.tool_calls.len(), 1);
        assert_eq!(msg.tool_calls[0].name, "ExitPlanMode");
        assert_eq!(msg.tool_calls[0].id, "synthetic-exit-plan-run-123");
    }

    #[test]
    fn injects_synthetic_exit_plan_for_completed_pi_plan_runs() {
        let run = sample_run();
        let mut msg = sample_assistant_message();

        assert!(should_inject_synthetic_exit_plan(&Backend::Pi, &run, &msg));

        inject_synthetic_exit_plan(&Backend::Pi, &run.run_id, &mut msg);

        assert_eq!(msg.tool_calls.len(), 1);
        assert_eq!(msg.tool_calls[0].name, "ExitPlanMode");
        assert_eq!(msg.tool_calls[0].id, "synthetic-exit-plan-run-123");
    }

    #[test]
    fn injects_synthetic_exit_plan_for_recovered_kimi_plan_runs() {
        let run = sample_run();
        let mut msg = sample_assistant_message();

        assert!(should_inject_synthetic_exit_plan(
            &Backend::Kimi,
            &run,
            &msg
        ));

        inject_synthetic_exit_plan(&Backend::Kimi, &run.run_id, &mut msg);

        assert_eq!(msg.tool_calls[0].name, "ExitPlanMode");
        assert_eq!(msg.tool_calls[0].input["source"], "kimi");
        assert_eq!(msg.tool_calls[0].input["plan"], "Here is the plan");
    }

    #[test]
    fn does_not_inject_for_codex_backend() {
        // Codex handles plan events via its own schema-based parser,
        // so no synthetic injection is needed.
        let run = sample_run();
        let msg = sample_assistant_message();

        assert!(!should_inject_synthetic_exit_plan(
            &Backend::Codex,
            &run,
            &msg,
        ));
    }

    #[test]
    fn does_not_inject_when_exit_plan_mode_already_exists() {
        let run = sample_run();
        let mut msg = sample_assistant_message();
        msg.tool_calls.push(ToolCall {
            id: "existing-exit".to_string(),
            name: "ExitPlanMode".to_string(),
            input: serde_json::json!({"plan": "keep existing"}),
            output: None,
            parent_tool_use_id: None,
        });

        assert!(!should_inject_synthetic_exit_plan(
            &Backend::Opencode,
            &run,
            &msg,
        ));
    }

    #[test]
    fn does_not_inject_for_cursor_when_text_is_not_a_plan() {
        let run = sample_run();
        let msg = ChatMessage {
            content: "Hi — what would you like me to plan?".to_string(),
            ..sample_assistant_message()
        };

        assert!(!should_inject_synthetic_exit_plan(
            &Backend::Cursor,
            &run,
            &msg,
        ));
    }

    #[test]
    fn should_inject_synthetic_enter_plan_always_returns_false() {
        let run = sample_run();
        let msg = sample_assistant_message();

        assert!(!should_inject_synthetic_enter_plan(
            &Backend::Cursor,
            &run,
            &msg,
        ));
    }

    #[test]
    fn inject_synthetic_enter_plan_is_noop_for_cursor() {
        let mut msg = sample_assistant_message();
        let before_tool_count = msg.tool_calls.len();

        inject_synthetic_enter_plan("run-123", &mut msg);

        assert_eq!(msg.tool_calls.len(), before_tool_count);
    }

    #[test]
    fn renderable_window_backfills_past_recent_cancelled_runs() {
        let mut runs = Vec::new();
        for index in 0..3 {
            runs.push(RunEntry {
                run_id: format!("completed-{index}"),
                user_message_id: format!("user-completed-{index}"),
                user_message: format!("completed prompt {index}"),
                started_at: index as u64,
                ended_at: Some(index as u64 + 1),
                ..sample_run()
            });
        }
        for index in 0..10 {
            runs.push(RunEntry {
                run_id: format!("cancelled-{index}"),
                user_message_id: format!("user-cancelled-{index}"),
                user_message: format!("cancelled prompt {index}"),
                started_at: 100 + index as u64,
                ended_at: Some(101 + index as u64),
                status: RunStatus::Cancelled,
                assistant_message_id: None,
                cancelled: true,
                ..sample_run()
            });
        }

        let window = select_renderable_run_window(&runs, Some(10), None, |_, run| {
            run.is_renderable_in_chat_history()
        });

        assert_eq!(window.start_index, 0);
        assert_eq!(window.run_indices, vec![0, 1, 2]);
    }

    #[test]
    fn renderable_window_includes_cancelled_runs_with_assistant_id() {
        let runs = vec![RunEntry {
            run_id: "cancelled-with-assistant".to_string(),
            user_message_id: "user-cancelled".to_string(),
            user_message: "cancelled prompt".to_string(),
            status: RunStatus::Cancelled,
            assistant_message_id: Some("assistant-cancelled".to_string()),
            cancelled: true,
            ..sample_run()
        }];

        let window = select_renderable_run_window(&runs, Some(10), None, |_, run| {
            run.is_renderable_in_chat_history()
        });

        assert_eq!(window.run_indices, vec![0]);
    }

    #[test]
    fn renderable_window_can_include_cancelled_codex_runs_with_persisted_artifacts() {
        let runs = vec![RunEntry {
            run_id: "cancelled-with-artifacts".to_string(),
            user_message_id: "user-cancelled".to_string(),
            user_message: "continue".to_string(),
            status: RunStatus::Cancelled,
            assistant_message_id: None,
            cancelled: true,
            ..sample_run()
        }];

        let window = select_renderable_run_window(&runs, Some(10), None, |_, run| {
            run.is_renderable_in_chat_history() || run.run_id == "cancelled-with-artifacts"
        });

        assert_eq!(window.run_indices, vec![0]);
    }

    #[test]
    fn parse_run_preserves_steered_user_messages() {
        let run = sample_run();
        let lines = vec![
            r#"{"_run_meta":true}"#.to_string(),
            r#"{"type":"steered_user_message","text":"2"}"#.to_string(),
            r#"{"type":"steered_user_message","text":"3"}"#.to_string(),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}"#
                .to_string(),
        ];

        let message = parse_run_to_message(&lines, &run).unwrap();

        assert!(matches!(
            &message.content_blocks[0],
            ContentBlock::UserInput { text } if text == "2"
        ));
        assert!(matches!(
            &message.content_blocks[1],
            ContentBlock::UserInput { text } if text == "3"
        ));
        assert!(matches!(
            &message.content_blocks[2],
            ContentBlock::Text { text } if text == "done"
        ));
    }

    #[test]
    fn parse_run_drops_unavailable_ask_user_question_errors() {
        let run = sample_run();
        let tool_id = "toolu_unavailable_question";
        let lines = vec![
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "content": [{
                        "type": "tool_use",
                        "id": tool_id,
                        "name": "AskUserQuestion",
                        "input": {
                            "questions": "[{\"question\":\"Pick one\",\"options\":[{\"label\":\"A\"}]}]"
                        }
                    }]
                }
            })
            .to_string(),
            serde_json::json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "is_error": true,
                        "content": "<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion exists but is not enabled in this context. Use one of the available tools instead.</tool_use_error>"
                    }]
                }
            })
            .to_string(),
        ];

        let msg = parse_run_to_message(&lines, &run).unwrap();

        assert!(msg.tool_calls.is_empty());
        assert!(msg.content_blocks.is_empty());
    }

    #[test]
    fn parse_run_skips_claude_compaction_summary_text() {
        let run = RunEntry {
            run_id: "run-compact".to_string(),
            user_message_id: "user-compact".to_string(),
            user_message: "continue".to_string(),
            model: Some("claude-sonnet-4-6".to_string()),
            execution_mode: Some("yolo".to_string()),
            thinking_level: None,
            effort_level: None,
            backend: Some(Backend::Claude),
            custom_profile_name: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Cancelled,
            assistant_message_id: Some("assistant-compact".to_string()),
            cancelled: true,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
            grok_session_id: None,
            kimi_session_id: None,
        };

        let lines = vec![
            r#"{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":170298}}"#.to_string(),
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "content": [{
                        "type": "text",
                        "text": "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n- old compacted work\n\nContinue the conversation from where it left off without asking the user any further questions."
                    }]
                }
            })
            .to_string(),
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "content": [{
                        "type": "text",
                        "text": "Actual partial response."
                    }]
                }
            })
            .to_string(),
        ];

        let msg = parse_run_to_message(&lines, &run).unwrap();

        assert_eq!(msg.content, "Actual partial response.");
        assert_eq!(msg.content_blocks.len(), 1);
        assert!(matches!(
            &msg.content_blocks[0],
            ContentBlock::Text { text } if text == "Actual partial response."
        ));
    }
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

    // Reconcile the frontend's authoritative streaming view with whatever the
    // backend already managed to flush before the kill. The previous "skip if
    // any assistant content exists" logic dropped tool calls in web access mode
    // where the backend's incremental writes lagged behind frontend Zustand state.
    //
    // We scan the existing JSONL for tool_use ids, tool_result ids, and whether
    // any text-bearing assistant block is present. Then we append only the
    // pieces the disk is missing. parse_run_to_message() accumulates tool_calls
    // and text across multiple assistant lines, so appending will not duplicate.
    let existing_lines = read_run_log(app, session_id, &run.run_id).unwrap_or_default();
    let mut existing_tool_use_ids: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut existing_tool_result_ids: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut existing_has_text = false;

    for line in &existing_lines {
        let msg: serde_json::Value = match serde_json::from_str(line) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let blocks = msg
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array());
        let Some(blocks) = blocks else { continue };
        for block in blocks {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match (msg_type, block_type) {
                ("assistant", "tool_use") => {
                    if let Some(id) = block.get("id").and_then(|v| v.as_str()) {
                        existing_tool_use_ids.insert(id.to_string());
                    }
                }
                ("assistant", "text") => {
                    let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if !text.trim().is_empty() && !is_claude_compaction_summary_text(text) {
                        existing_has_text = true;
                    }
                }
                ("user", "tool_result") => {
                    if let Some(id) = block.get("tool_use_id").and_then(|v| v.as_str()) {
                        existing_tool_result_ids.insert(id.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    // Determine what's missing from disk
    let missing_tool_calls: Vec<&ToolCall> = tool_calls
        .iter()
        .filter(|tc| !existing_tool_use_ids.contains(&tc.id))
        .collect();
    let missing_tool_results: Vec<&ToolCall> = tool_calls
        .iter()
        .filter(|tc| tc.output.is_some() && !existing_tool_result_ids.contains(&tc.id))
        .collect();
    let needs_text = !existing_has_text
        && !content.trim().is_empty()
        && !is_claude_compaction_summary_text(content);

    if missing_tool_calls.is_empty() && missing_tool_results.is_empty() && !needs_text {
        log::trace!(
            "JSONL already in sync with frontend payload for session {session_id}, skipping persist"
        );
        return Ok(());
    }

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open run log for partial content: {e}"))?;

    // Build a single synthetic assistant line containing only the blocks the
    // disk is missing. We prefer the order from `content_blocks` when present
    // so text/tool_use interleaving roughly matches the original stream.
    let mut blocks: Vec<serde_json::Value> = Vec::new();
    let mut wrote_text = !needs_text;

    if !content_blocks.is_empty() {
        for cb in content_blocks {
            match cb {
                ContentBlock::Text { text } => {
                    if !wrote_text
                        && !text.trim().is_empty()
                        && !is_claude_compaction_summary_text(text)
                    {
                        blocks.push(serde_json::json!({"type": "text", "text": text}));
                        wrote_text = true;
                    }
                }
                ContentBlock::ToolUse { tool_call_id } => {
                    if existing_tool_use_ids.contains(tool_call_id) {
                        continue;
                    }
                    if let Some(tc) = tool_calls.iter().find(|t| t.id == *tool_call_id) {
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": tc.input
                        }));
                    } else {
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": tool_call_id,
                            "name": "",
                            "input": null
                        }));
                    }
                }
                ContentBlock::Thinking { thinking } => {
                    blocks.push(serde_json::json!({"type": "thinking", "thinking": thinking}));
                }
                ContentBlock::UserInput { text } => {
                    blocks.push(serde_json::json!({"type": "user_input", "text": text}));
                }
            }
        }
    }

    // Append any tool_calls that weren't represented in content_blocks (e.g.,
    // when the frontend payload had tool_calls without matching ToolUse blocks).
    for tc in &missing_tool_calls {
        let already_in_blocks = blocks.iter().any(|b| {
            b.get("type").and_then(|v| v.as_str()) == Some("tool_use")
                && b.get("id").and_then(|v| v.as_str()) == Some(tc.id.as_str())
        });
        if already_in_blocks {
            continue;
        }
        blocks.push(serde_json::json!({
            "type": "tool_use",
            "id": tc.id,
            "name": tc.name,
            "input": tc.input
        }));
    }

    // Fallback: text-only when no structured blocks were supplied.
    if blocks.is_empty() && !wrote_text && !content.trim().is_empty() {
        blocks.push(serde_json::json!({"type": "text", "text": content}));
        wrote_text = true;
    }

    if !blocks.is_empty() {
        let synthetic = serde_json::json!({
            "type": "assistant",
            "message": { "content": blocks }
        });
        writeln!(file, "{synthetic}")
            .map_err(|e| format!("Failed to write partial content: {e}"))?;
    }

    // Write any tool_results the disk is missing as separate user messages so
    // parse_run_to_message() can associate outputs with their tool calls.
    for tc in &missing_tool_results {
        let output = tc.output.as_deref().unwrap_or("");
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
        writeln!(file, "{tool_result}").map_err(|e| format!("Failed to write tool result: {e}"))?;
    }

    file.flush()
        .map_err(|e| format!("Failed to flush partial content: {e}"))?;

    log::trace!(
        "Reconciled partial cancelled content for session {session_id} \
         (added {} tool_uses, {} tool_results, text_added={}; total payload: {} chars, {} blocks, {} tool calls)",
        missing_tool_calls.len(),
        missing_tool_results.len(),
        wrote_text && needs_text,
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
        let metadata_backend = metadata.backend.clone();

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
                        metadata.is_reviewing = false;

                        // Recover the provider-owned session id from JSONL so a
                        // turn that completed while Jean was closed keeps its context.
                        if let Some(sid) =
                            extract_session_id_from_jsonl(app, &session_id, &run.run_id)
                        {
                            if run.backend.as_ref().unwrap_or(&metadata_backend) == &Backend::Kimi {
                                run.kimi_session_id = Some(sid.clone());
                                metadata.kimi_session_id = Some(sid);
                            } else if run.claude_session_id.is_none() {
                                run.claude_session_id = Some(sid.clone());
                                metadata.claude_session_id = Some(sid);
                            }
                        }
                    } else if run.codex_thread_id.is_some() {
                        // Codex sessions can be resumed via thread/resume even after
                        // Jean crashes — threads are persisted to disk by app-server.
                        // Mark as Resumable so resume_session can recover them.
                        run.status = RunStatus::Resumable;

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
                            "Found resumable Codex run: {} in session {} (thread_id: {:?})",
                            run.run_id,
                            session_id,
                            run.codex_thread_id
                        );

                        modified = true;
                        continue;
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
