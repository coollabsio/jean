//! Antigravity CLI execution engine.

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use tauri::AppHandle;

#[derive(serde::Serialize, Clone)]
struct ChunkEvent {
    session_id: String,
    worktree_id: String,
    content: String,
}

#[derive(serde::Serialize, Clone)]
struct DoneEvent {
    session_id: String,
    worktree_id: String,
    waiting_for_plan: bool,
}

pub struct AntigravityResponse {
    pub content: String,
    pub conversation_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
}

pub fn execute_antigravity(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    working_dir: &Path,
    existing_conversation_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    message: &str,
    pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
) -> Result<AntigravityResponse, String> {
    let cli_path = crate::antigravity_cli::resolve_cli_binary(app);
    if !crate::antigravity_cli::binary_exists(&cli_path) {
        return Err("Antigravity CLI not installed".to_string());
    }

    // Auto-trust the workspace directory
    crate::antigravity_cli::auto_trust_workspace(app, working_dir);

    let mut cmd =
        crate::platform::cli_command(cli_path.to_str().unwrap_or("agy"), Some(working_dir));
    cmd.arg("--print")
        .arg(message)
        .args(["--output-format", "json"]);

    // Clear any parent agent workspace env variables so the CLI resolves CWD correctly
    cmd.env_remove("ANTIGRAVITY_PROJECT_ID")
        .env_remove("ANTIGRAVITY_CONVERSATION_ID")
        .env_remove("ANTIGRAVITY_LS_ADDRESS")
        .env_remove("ANTIGRAVITY_TRAJECTORY_ID")
        .env_remove("ANTIGRAVITY_AGENT")
        .env_remove("ANTIGRAVITY_SOURCE_METADATA");

    if let Some(conv_id) = existing_conversation_id {
        if !conv_id.is_empty() {
            cmd.args(["--conversation", conv_id]);
        } else {
            cmd.arg("--new-project");
        }
    } else {
        cmd.arg("--new-project");
    }

    if let Some(m) = model {
        if !m.is_empty() {
            cmd.args(["--model", m]);
        }
    }

    let is_plan = execution_mode.unwrap_or("plan") == "plan";
    if is_plan {
        cmd.args(["--sandbox", "enabled"]);
    } else {
        cmd.arg("--dangerously-skip-permissions");
    }

    log::info!("[Antigravity] Spawning CLI: {:?}", cmd);

    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Antigravity CLI: {e}"))?;

    let pid = child.id();
    if let Some(cb) = pid_callback {
        cb(pid);
    }

    if !super::registry::register_process(session_id.to_string(), pid) {
        let _ = child.kill();
        return Ok(AntigravityResponse {
            content: String::new(),
            conversation_id: existing_conversation_id.unwrap_or_default().to_string(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            usage: None,
        });
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Antigravity CLI: {e}"))?;

    super::registry::unregister_process(session_id);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("Antigravity CLI exited with error: {stderr}"));
    }

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(stdout_str.trim()).map_err(|e| {
        format!("Failed to parse Antigravity JSON output: {e}. Output was: {stdout_str}")
    })?;

    let response_text = parsed
        .get("response")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let conversation_id = parsed
        .get("conversation_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let usage = parsed.get("usage").map(|u| UsageData {
        input_tokens: u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
        output_tokens: u.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    });

    // Final-output CLI: emit one synthetic chunk and a done event so the
    // frontend finalizes the assistant message.
    let chunk_event = ChunkEvent {
        session_id: session_id.to_string(),
        worktree_id: worktree_id.to_string(),
        content: response_text.clone(),
    };
    let _ = app.emit_all("chat:chunk", &chunk_event);

    let done_event = DoneEvent {
        session_id: session_id.to_string(),
        worktree_id: worktree_id.to_string(),
        waiting_for_plan: false,
    };
    let _ = app.emit_all("chat:done", &done_event);

    let text_block = ContentBlock::Text {
        text: response_text.clone(),
    };

    Ok(AntigravityResponse {
        content: response_text,
        conversation_id,
        tool_calls: vec![],
        content_blocks: vec![text_block],
        cancelled: false,
        usage,
    })
}
