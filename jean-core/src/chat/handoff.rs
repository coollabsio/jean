use super::types::{
    Backend, ChatMessage, ContentBlock, MessageRole, RunEntry, RunStatus, SessionMetadata,
};

const HANDOFF_OPEN_TAG: &str = "<jean_provider_switch_handoff>";
const HANDOFF_CLOSE_TAG: &str = "</jean_provider_switch_handoff>";
const TRUNCATED_HISTORY_MARKER: &str = "[truncated older Jean history]";
const HANDOFF_HISTORY_RUN_LIMIT: usize = 40;
const HANDOFF_HISTORY_MAX_CHARS: usize = 60_000;

/// Return the last `max_chars` characters of `input` (char-safe, never panics on multibyte).
fn tail_chars(input: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let count = input.chars().count();
    if count <= max_chars {
        return input.to_string();
    }
    input.chars().skip(count - max_chars).collect()
}

fn backend_label(backend: &Backend) -> &'static str {
    match backend {
        Backend::Claude => "claude",
        Backend::Codex => "codex",
        Backend::Opencode => "opencode",
        Backend::Cursor => "cursor",
        Backend::Pi => "pi",
        Backend::Commandcode => "commandcode",
        Backend::Grok => "grok",
        Backend::Kimi => "kimi",
        Backend::Antigravity => "antigravity",
    }
}

pub(crate) fn should_inject_handoff(
    previous_backend: Option<&Backend>,
    current_backend: &Backend,
) -> bool {
    previous_backend.is_some_and(|previous| previous != current_backend)
}

pub(crate) fn latest_completed_backend(metadata: &SessionMetadata) -> Option<Backend> {
    metadata
        .runs
        .iter()
        .rev()
        .find(|run| {
            matches!(
                run.status,
                RunStatus::Completed | RunStatus::Cancelled | RunStatus::Crashed
            )
        })
        .and_then(|run| {
            if let Some(backend) = &run.backend {
                return Some(backend.clone());
            }
            if run.cursor_chat_id.is_some()
                || run.model.as_deref().is_some_and(crate::is_cursor_model)
            {
                return Some(Backend::Cursor);
            }
            if run.codex_thread_id.is_some()
                || run.model.as_deref().is_some_and(crate::is_codex_model)
            {
                return Some(Backend::Codex);
            }
            if run.model.as_deref().is_some_and(crate::is_opencode_model) {
                return Some(Backend::Opencode);
            }
            if run.model.as_deref().is_some_and(crate::is_pi_model) {
                return Some(Backend::Pi);
            }
            if run
                .model
                .as_deref()
                .is_some_and(|model| model.starts_with("commandcode/"))
            {
                return Some(Backend::Commandcode);
            }
            if run.grok_session_id.is_some()
                || run.model.as_deref().is_some_and(crate::is_grok_model)
            {
                return Some(Backend::Grok);
            }
            if run.kimi_session_id.is_some()
                || run.model.as_deref().is_some_and(crate::is_kimi_model)
            {
                return Some(Backend::Kimi);
            }
            if run.antigravity_session_id.is_some()
                || run
                    .model
                    .as_deref()
                    .is_some_and(crate::is_antigravity_model)
            {
                return Some(Backend::Antigravity);
            }
            if run.claude_session_id.is_some() {
                return Some(Backend::Claude);
            }
            None
        })
}

pub(crate) fn latest_completed_custom_profile(metadata: &SessionMetadata) -> Option<String> {
    metadata
        .runs
        .iter()
        .rev()
        .find(|run| {
            matches!(
                run.status,
                RunStatus::Completed | RunStatus::Cancelled | RunStatus::Crashed
            ) && matches!(run.backend, Some(Backend::Claude))
        })
        .and_then(|run| run.custom_profile_name.clone())
}

pub(crate) fn should_inject_claude_profile_handoff(
    current_backend: &Backend,
    previous_backend: Option<&Backend>,
    previous_profile: Option<&str>,
    current_profile: Option<&str>,
) -> bool {
    current_backend == &Backend::Claude
        && previous_backend == Some(&Backend::Claude)
        && previous_profile != current_profile
}

/// Extract the best available plain-text body for handoff history.
/// Prefer `content`, then text/user-input content blocks, then a brief tool summary.
pub(crate) fn message_text_for_handoff(message: &ChatMessage) -> String {
    let content = message.content.trim();
    if !content.is_empty() {
        return content.to_string();
    }

    let mut parts: Vec<String> = Vec::new();
    for block in &message.content_blocks {
        match block {
            ContentBlock::Text { text } => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
            }
            ContentBlock::UserInput { text } => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(format!("[steered user input] {trimmed}"));
                }
            }
            ContentBlock::Thinking { .. } | ContentBlock::ToolUse { .. } => {}
        }
    }

    if !message.tool_calls.is_empty() {
        let tools: Vec<&str> = message
            .tool_calls
            .iter()
            .map(|tc| tc.name.as_str())
            .filter(|name| !name.is_empty())
            .collect();
        if !tools.is_empty() {
            parts.push(format!("[tools used: {}]", tools.join(", ")));
        }
    }

    parts.join("\n")
}

pub(crate) fn format_handoff_history(messages: &[ChatMessage], max_chars: usize) -> String {
    let rendered: Vec<String> = messages
        .iter()
        .filter_map(|message| {
            let body = message_text_for_handoff(message);
            if body.trim().is_empty() {
                return None;
            }
            let role = match message.role {
                MessageRole::User => "User",
                MessageRole::Assistant => "Assistant",
            };
            Some(format!("{role}: {}", body.trim()))
        })
        .collect();

    let mut selected = Vec::new();
    let mut total_chars = 0usize;
    let mut truncated = false;

    for line in rendered.iter().rev() {
        let line_chars = line.chars().count();
        let next_chars = if selected.is_empty() {
            line_chars
        } else {
            line_chars + 2
        };
        if !selected.is_empty() && total_chars + next_chars > max_chars {
            truncated = true;
            break;
        }
        if selected.is_empty() && next_chars > max_chars {
            selected.push(tail_chars(line, max_chars));
            truncated = true;
            break;
        }
        total_chars += next_chars;
        selected.push(line.clone());
    }

    selected.reverse();
    let mut history = selected.join("\n\n");
    if truncated {
        if history.is_empty() {
            history = tail_chars(TRUNCATED_HISTORY_MARKER, max_chars);
        } else {
            let prefix = format!("{TRUNCATED_HISTORY_MARKER}\n\n");
            let prefix_chars = prefix.chars().count();
            if prefix_chars >= max_chars {
                history = prefix.chars().take(max_chars).collect();
            } else {
                let remaining = max_chars - prefix_chars;
                history = format!("{prefix}{}", tail_chars(&history, remaining));
            }
        }
    }
    history
}

/// Fallback when full run-log parsing fails: use user messages (and optional model notes)
/// from run metadata so backend switches still carry conversation context.
pub(crate) fn format_handoff_history_from_runs(runs: &[RunEntry], max_chars: usize) -> String {
    let mut pseudo_messages: Vec<ChatMessage> = Vec::new();
    let end = runs.len();
    let start = end.saturating_sub(HANDOFF_HISTORY_RUN_LIMIT);

    for (idx, run) in runs.iter().enumerate().skip(start) {
        if !run.is_renderable_in_chat_history() {
            continue;
        }
        let user_text = run.user_message.trim();
        if !user_text.is_empty() {
            pseudo_messages.push(ChatMessage {
                id: run.user_message_id.clone(),
                session_id: String::new(),
                role: MessageRole::User,
                content: user_text.to_string(),
                timestamp: run.started_at,
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: false,
                plan_approved: false,
                model: run.model.clone(),
                backend: None,
                execution_mode: run.execution_mode.clone(),
                thinking_level: run.thinking_level.clone(),
                effort_level: run.effort_level.clone(),
                recovered: false,
                usage: None,
            });
        }

        if run.renders_assistant_message() {
            let backend_note = run.backend.as_ref().map(backend_label).unwrap_or("unknown");
            let model_note = run.model.as_deref().unwrap_or("unknown-model");
            let status_note = match run.status {
                RunStatus::Completed => "completed",
                RunStatus::Cancelled => "cancelled",
                RunStatus::Crashed => "crashed",
                RunStatus::Running => "running",
                RunStatus::Resumable => "resumable",
            };
            pseudo_messages.push(ChatMessage {
                id: format!("handoff-assistant-{idx}"),
                session_id: String::new(),
                role: MessageRole::Assistant,
                content: format!(
                    "[assistant reply via {backend_note}/{model_note}; status={status_note}; full body unavailable in handoff fallback]"
                ),
                timestamp: run.ended_at.unwrap_or(run.started_at),
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: run.cancelled,
                plan_approved: false,
                model: run.model.clone(),
                backend: None,
                execution_mode: run.execution_mode.clone(),
                thinking_level: run.thinking_level.clone(),
                effort_level: run.effort_level.clone(),
                recovered: false,
                usage: None,
            });
        }
    }

    format_handoff_history(&pseudo_messages, max_chars)
}

/// Build handoff history for a provider switch: prefer full message window, fall back to run metadata.
pub(crate) fn build_handoff_history_text(
    app: &tauri::AppHandle,
    session_id: &str,
    metadata: Option<&SessionMetadata>,
) -> String {
    match super::run_log::load_session_messages_window(
        app,
        session_id,
        Some(HANDOFF_HISTORY_RUN_LIMIT),
        None,
    ) {
        Ok(loaded) => {
            let history = format_handoff_history(&loaded.messages, HANDOFF_HISTORY_MAX_CHARS);
            if !history.trim().is_empty() {
                return history;
            }
            log::warn!(
                "[Handoff] session={session_id} full message window was empty; falling back to run metadata"
            );
        }
        Err(e) => {
            log::warn!(
                "[Handoff] session={session_id} failed to load message window for handoff: {e}; falling back to run metadata"
            );
        }
    }

    if let Some(meta) = metadata {
        let fallback = format_handoff_history_from_runs(&meta.runs, HANDOFF_HISTORY_MAX_CHARS);
        if fallback.trim().is_empty() {
            log::warn!(
                "[Handoff] session={session_id} run-metadata fallback also produced empty history (runs={})",
                meta.runs.len()
            );
        }
        return fallback;
    }

    String::new()
}

pub(crate) fn build_handoff_prompt(
    template: &str,
    previous_backend: &Backend,
    current_backend: &Backend,
    history: &str,
) -> String {
    template
        .replace("{previous_backend}", backend_label(previous_backend))
        .replace("{current_backend}", backend_label(current_backend))
        .replace("{history}", history)
}

pub(crate) fn build_claude_profile_handoff_prompt(
    template: &str,
    previous_profile: Option<&str>,
    current_profile: Option<&str>,
    history: &str,
) -> String {
    let previous = previous_profile.unwrap_or("anthropic");
    let current = current_profile.unwrap_or("anthropic");
    template
        .replace("{previous_backend}", &format!("claude/{previous}"))
        .replace("{current_backend}", &format!("claude/{current}"))
        .replace("{history}", history)
}

pub(crate) fn prepend_hidden_handoff(user_message: &str, handoff_prompt: &str) -> String {
    format!(
        "{HANDOFF_OPEN_TAG}\n{}\n{HANDOFF_CLOSE_TAG}\n\n{}",
        handoff_prompt.trim(),
        user_message
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::{
        Backend, ChatMessage, ContentBlock, MessageRole, RunEntry, RunStatus, SessionMetadata,
    };

    fn message(role: MessageRole, content: &str, timestamp: u64) -> ChatMessage {
        ChatMessage {
            id: format!("{timestamp}"),
            session_id: "session-1".to_string(),
            role,
            content: content.to_string(),
            timestamp,
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: false,
            plan_approved: false,
            model: None,
            backend: None,
            execution_mode: None,
            thinking_level: None,
            effort_level: None,
            recovered: false,
            usage: None,
        }
    }

    fn metadata_with_legacy_run(run: RunEntry) -> SessionMetadata {
        let mut metadata = SessionMetadata::new(
            "session-1".to_string(),
            "worktree-1".to_string(),
            "Session".to_string(),
            0,
        );
        metadata.runs.push(run);
        metadata
    }

    #[test]
    fn detects_backend_switch_only_after_previous_backend_exists() {
        assert!(!should_inject_handoff(None, &Backend::Codex));
        assert!(!should_inject_handoff(
            Some(&Backend::Codex),
            &Backend::Codex
        ));
        assert!(should_inject_handoff(
            Some(&Backend::Codex),
            &Backend::Claude
        ));
    }

    #[test]
    fn formats_bounded_history_with_newest_context_preserved() {
        let messages = vec![
            message(MessageRole::User, "old user context that should drop", 1),
            message(
                MessageRole::Assistant,
                "old assistant context that should drop",
                2,
            ),
            message(MessageRole::User, "new user context", 3),
            message(MessageRole::Assistant, "new assistant context", 4),
        ];

        let history = format_handoff_history(&messages, 100);

        assert!(history.chars().count() <= 100);
        assert!(history.contains("[truncated older Jean history]"));
        assert!(!history.contains("old user context"));
        assert!(history.contains("User: new user context"));
        assert!(history.contains("Assistant: new assistant context"));
    }

    #[test]
    fn message_text_for_handoff_uses_content_blocks_when_content_empty() {
        let mut msg = message(MessageRole::Assistant, "", 1);
        msg.content_blocks = vec![ContentBlock::Text {
            text: "  recovered from blocks  ".to_string(),
        }];
        assert_eq!(message_text_for_handoff(&msg), "recovered from blocks");

        let history = format_handoff_history(std::slice::from_ref(&msg), 200);
        assert!(history.contains("Assistant: recovered from blocks"));
    }

    #[test]
    fn formats_handoff_history_from_runs_includes_user_turns() {
        let runs = vec![
            RunEntry {
                run_id: "run-1".to_string(),
                user_message_id: "user-1".to_string(),
                user_message: "first user task".to_string(),
                model: Some("claude-opus-4-8".to_string()),
                execution_mode: None,
                thinking_level: None,
                effort_level: None,
                backend: Some(Backend::Claude),
                custom_profile_name: None,
                started_at: 1,
                ended_at: Some(2),
                status: RunStatus::Completed,
                assistant_message_id: Some("assistant-1".to_string()),
                cancelled: false,
                recovered: false,
                claude_session_id: Some("claude-1".to_string()),
                pid: None,
                usage: None,
                codex_thread_id: None,
                codex_turn_id: None,
                cursor_chat_id: None,
                grok_session_id: None,
                kimi_session_id: None,
                antigravity_session_id: None,
                checkpoint_id: None,
            },
            RunEntry {
                run_id: "run-2".to_string(),
                user_message_id: "user-2".to_string(),
                user_message: "second user task".to_string(),
                model: Some("opencode/moonshotai/kimi-k2.5".to_string()),
                execution_mode: None,
                thinking_level: None,
                effort_level: None,
                backend: Some(Backend::Opencode),
                custom_profile_name: None,
                started_at: 3,
                ended_at: Some(4),
                status: RunStatus::Completed,
                assistant_message_id: Some("assistant-2".to_string()),
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
                antigravity_session_id: None,
                checkpoint_id: None,
            },
        ];

        let history = format_handoff_history_from_runs(&runs, 2_000);
        assert!(history.contains("User: first user task"));
        assert!(history.contains("User: second user task"));
        assert!(history.contains("claude"));
        assert!(history.contains("opencode"));
    }

    #[test]
    fn bounds_history_by_chars_and_handles_multibyte() {
        // Single overlong multibyte line: byte-slicing here would panic.
        let messages = vec![message(MessageRole::User, &"é".repeat(200), 1)];
        let history = format_handoff_history(&messages, 50);
        assert!(history.chars().count() <= 50);
        assert!(history.contains('é'));

        // Truncation banner must not push final output past max_chars.
        let many = (0..20)
            .map(|i| message(MessageRole::User, &format!("líne {i} with unicode ❤"), i))
            .collect::<Vec<_>>();
        let bounded = format_handoff_history(&many, 60);
        assert!(bounded.chars().count() <= 60);
        assert!(bounded.contains("[truncated older Jean history]"));
    }

    #[test]
    fn renders_template_and_wraps_hidden_user_message() {
        let prompt = build_handoff_prompt(
            "Previous={previous_backend}\nCurrent={current_backend}\nHistory:\n{history}",
            &Backend::Codex,
            &Backend::Claude,
            "User: hello",
        );

        assert!(prompt.contains("Previous=codex"));
        assert!(prompt.contains("Current=claude"));
        assert!(prompt.contains("User: hello"));

        let wrapped = prepend_hidden_handoff("continue please", &prompt);
        assert!(wrapped.contains("<jean_provider_switch_handoff>"));
        assert!(wrapped.contains("</jean_provider_switch_handoff>"));
        assert!(wrapped.ends_with("continue please"));
    }

    #[test]
    fn infers_previous_backend_from_legacy_run_resume_fields() {
        let metadata = metadata_with_legacy_run(RunEntry {
            run_id: "run-1".to_string(),
            user_message_id: "user-1".to_string(),
            user_message: "hello".to_string(),
            model: None,
            execution_mode: None,
            thinking_level: None,
            effort_level: None,
            backend: None,
            custom_profile_name: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Completed,
            assistant_message_id: Some("assistant-1".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: Some("claude-session".to_string()),
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
            grok_session_id: None,
            kimi_session_id: None,
            antigravity_session_id: None,
            checkpoint_id: None,
        });

        assert_eq!(latest_completed_backend(&metadata), Some(Backend::Claude));
    }

    #[test]
    fn detects_claude_custom_profile_switch() {
        assert!(should_inject_claude_profile_handoff(
            &Backend::Claude,
            Some(&Backend::Claude),
            None,
            Some("OpenRouter")
        ));
        assert!(should_inject_claude_profile_handoff(
            &Backend::Claude,
            Some(&Backend::Claude),
            Some("OpenRouter"),
            None
        ));
        assert!(!should_inject_claude_profile_handoff(
            &Backend::Claude,
            Some(&Backend::Claude),
            Some("OpenRouter"),
            Some("OpenRouter")
        ));
        assert!(!should_inject_claude_profile_handoff(
            &Backend::Codex,
            Some(&Backend::Claude),
            Some("OpenRouter"),
            Some("MiniMax")
        ));
    }

    #[test]
    fn tracks_latest_completed_claude_custom_profile() {
        let mut metadata = metadata_with_legacy_run(RunEntry {
            run_id: "run-1".to_string(),
            user_message_id: "user-1".to_string(),
            user_message: "hi".to_string(),
            model: Some("sonnet".to_string()),
            execution_mode: None,
            thinking_level: None,
            effort_level: None,
            backend: Some(Backend::Claude),
            custom_profile_name: Some("OpenRouter".to_string()),
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Completed,
            assistant_message_id: None,
            cancelled: false,
            recovered: false,
            claude_session_id: Some("claude-1".to_string()),
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
            grok_session_id: None,
            kimi_session_id: None,
            antigravity_session_id: None,
            checkpoint_id: None,
        });
        metadata.runs.push(RunEntry {
            run_id: "run-2".to_string(),
            user_message_id: "user-2".to_string(),
            user_message: "hi".to_string(),
            model: Some("gpt-5.5".to_string()),
            execution_mode: None,
            thinking_level: None,
            effort_level: None,
            backend: Some(Backend::Codex),
            custom_profile_name: None,
            started_at: 3,
            ended_at: Some(4),
            status: RunStatus::Completed,
            assistant_message_id: None,
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: Some("codex-1".to_string()),
            codex_turn_id: None,
            cursor_chat_id: None,
            grok_session_id: None,
            kimi_session_id: None,
            antigravity_session_id: None,
            checkpoint_id: None,
        });

        assert_eq!(
            latest_completed_custom_profile(&metadata),
            Some("OpenRouter".to_string())
        );
    }
}
