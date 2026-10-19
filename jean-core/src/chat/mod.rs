pub(crate) mod acp_permissions;
pub(crate) mod antigravity;
pub(crate) mod claude;
pub(crate) mod claude_host;
pub(crate) mod claude_permissions;
pub(crate) mod coalesce;
pub(crate) mod codex;
pub(crate) mod codex_server;
pub(crate) mod commandcode;
mod commands;
pub(crate) mod context_instructions;
pub(crate) mod cursor;
pub mod detached;
pub(crate) mod grok;
pub(crate) mod handoff;
pub mod jean_mcp;
pub(crate) mod kimi;
mod mcp_auth;
pub mod mcp_external;
pub(crate) mod muse;
mod naming;
mod native_history;
pub(crate) mod opencode;
pub(crate) mod pi;
pub mod registry;
pub mod run_log;
pub mod search;
pub mod storage;
pub mod tail;
pub mod types;
pub mod wakeup;

pub(crate) use commands::default_model_for_backend;
pub use commands::*;
pub use mcp_auth::*;
pub use native_history::*;
pub use storage::{preserve_base_sessions, restore_base_sessions, with_sessions_mut};

use std::sync::atomic::{AtomicUsize, Ordering};

/// End-of-turn recap instruction. Appended to every backend's system prompt so
/// the assistant terminates multi-step turns with a single `## Recap` markdown
/// block. The compact view in `CompactMessageList.tsx` extracts that block and
/// renders it as the visible summary instead of the full latest assistant text.
pub const RECAP_INSTRUCTION: &str = "## End-of-turn recap

When you finish a turn that involved tool calls, edits, or multi-step work, end your response with a final markdown section like this:

## Recap

[If the user asked a question or requested a specific output, restate the actual answer/result here so the recap stands alone as the deliverable. Use a short paragraph, table, or list — whichever fits the answer best.]

- 2-4 short bullets for context that doesn't fit above: caveats, follow-ups, unresolved questions, or files the user should review.

Tested against local dev env: Yes/No

[Optional `### How to test` subsection — include ONLY when the rules below say to.]

Rules:
- Heading must be the literal string `## Recap` on its own line.
- Place it as the LAST block of the message, after any prose.
- The recap is the user-facing deliverable — it must be self-contained. Include the actual answer/result inline. Do NOT write things like \"I looked it up\" or \"see above\" — restate the answer.
- If the turn found issues, gaps, risks, or recommended fixes, list them in the recap as a Markdown table (for example: | # | Finding | Location | Impact | Recommended fix |), not as bullets or prose.
- Add a `### How to test` subsection ONLY when the turn produced code, config, or behavior changes the user can verify. Make it actionable and specific (commands to run, UI flows to click through, files to inspect); if it makes sense, always include a smoke test that explains how the user can manually verify the main behavior. OMIT the subsection entirely on read-only turns — questions, explanations, research, planning, code review without edits, or any turn where there is nothing meaningful to test. Do NOT include placeholder content like \"N/A\", \"Nothing to test\", \"No tests needed\", or an empty bullet list. If in doubt, leave it out.
- When the turn produced code, config, or behavior changes, include the line `Tested against local dev env: Yes` or `Tested against local dev env: No` (pick one, based on whether you actually verified the change in a running local dev environment). Omit this line on read-only turns.
- In plan mode, when a plan is ready, you MUST still call the native plan tool (Claude ExitPlanMode, Codex `<proposed_plan>` / plan item, Cursor/OpenCode equivalent) to present it. The recap does NOT replace the plan tool — never end a plan-mode turn with only a `## Recap` block in place of the plan tool call.
- Skip the recap entirely if the turn was a single one-line answer with no tool calls.
- Do NOT repeat tool inputs, file diffs, or raw command output verbatim. Summarize.";

pub(crate) fn should_add_recap_instruction(app: &tauri::AppHandle) -> bool {
    should_include_recap_instruction(app, true)
}

/// Whether this send should append `RECAP_INSTRUCTION`.
///
/// `include_recap` is the per-send override. Structured deliverables such as
/// magic release notes set this to `false` so the recap does not replace the
/// actual output.
pub(crate) fn should_include_recap_instruction(
    app: &tauri::AppHandle,
    include_recap: bool,
) -> bool {
    recap_instruction_enabled(
        include_recap,
        crate::load_preferences_sync(app)
            .map(|preferences| preferences.auto_recaps_enabled)
            .unwrap_or(true),
    )
}

pub(crate) fn recap_instruction_enabled(include_recap: bool, auto_recaps_enabled: bool) -> bool {
    include_recap && auto_recaps_enabled
}

/// Injected when the parallel-execution magic prompt is cleared. Omitting the
/// fan-out prompt is not enough: the model still spawns Task sub-agents unless
/// it is told not to.
pub const NO_SUBAGENT_INSTRUCTION: &str = "### Sub-agent policy\n\
- Do NOT spawn sub-agents (Task calls) unless the user explicitly asks for one. Handle research, exploration, and implementation inline in this turn.\n\
- A task that has several parts, or is described as thorough or multi-angle, is still a single inline task — not a reason to fan out.";

/// Fan-out text when parallel prompting is on, otherwise the explicit stop.
/// A non-empty prompt is the user's (or the default) sub-agent policy.
pub(crate) fn subagent_policy_text(parallel_execution_prompt: Option<&str>) -> String {
    parallel_execution_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| NO_SUBAGENT_INSTRUCTION.to_string())
}

pub(crate) fn push_trimmed_prompt(parts: &mut Vec<String>, prompt: Option<&str>) {
    if let Some(prompt) = prompt.map(str::trim).filter(|prompt| !prompt.is_empty()) {
        parts.push(prompt.to_string());
    }
}

/// Sub-agent policy, then the global prompt. User-authored global text is later
/// in the assembled instructions, so it has the last word.
pub(crate) fn push_subagent_policy_before_global(
    parts: &mut Vec<String>,
    parallel_execution_prompt: Option<&str>,
    global_prompt: String,
) {
    parts.push(subagent_policy_text(parallel_execution_prompt));
    if !global_prompt.trim().is_empty() {
        parts.push(global_prompt);
    }
}

#[cfg(test)]
mod tests {
    use super::RECAP_INSTRUCTION;

    #[test]
    fn recap_how_to_test_rule_requests_manual_smoke_test_when_useful() {
        assert!(RECAP_INSTRUCTION.contains("smoke test"));
        assert!(RECAP_INSTRUCTION.contains("manual"));
        assert!(RECAP_INSTRUCTION.contains("if it makes sense"));
    }

    #[test]
    fn recap_requests_local_dev_env_tested_line() {
        assert!(RECAP_INSTRUCTION.contains("Tested against local dev env: Yes"));
        assert!(RECAP_INSTRUCTION.contains("Tested against local dev env: No"));
    }

    #[test]
    fn recap_instruction_is_skipped_when_send_disables_it() {
        assert!(!super::recap_instruction_enabled(false, true));
        assert!(!super::recap_instruction_enabled(false, false));
        assert!(!super::recap_instruction_enabled(true, false));
        assert!(super::recap_instruction_enabled(true, true));
    }

    #[test]
    fn disabled_subagent_prompting_forbids_unrequested_task_calls() {
        let policy = super::subagent_policy_text(None);
        assert!(policy.contains("Do NOT spawn sub-agents"));
        assert!(policy.contains("unless the user explicitly asks"));
        assert_eq!(policy, super::subagent_policy_text(Some("  ")));
        assert_eq!(policy, super::NO_SUBAGENT_INSTRUCTION);
    }

    #[test]
    fn enabled_subagent_prompting_uses_the_parallel_prompt_verbatim() {
        let prompt = "Use two Task agents for this research.";
        assert_eq!(super::subagent_policy_text(Some(prompt)), prompt);
        assert_eq!(
            super::subagent_policy_text(Some("  Use two Task agents.  ")),
            "Use two Task agents."
        );
    }

    #[test]
    fn subagent_policy_is_emitted_before_a_custom_global_prompt() {
        let mut off = vec!["Respond to the user in French.".to_string()];
        super::push_subagent_policy_before_global(
            &mut off,
            None,
            "Custom rule: do spawn a Task agent for research.".to_string(),
        );
        let off_text = off.join("\n\n");
        let policy = off_text.find("Do NOT spawn sub-agents").unwrap();
        let custom = off_text.find("Custom rule: do spawn a Task agent").unwrap();
        assert!(policy < custom);

        let mut on = Vec::new();
        super::push_subagent_policy_before_global(
            &mut on,
            Some("Fan out with Task agents."),
            "Custom global prompt.".to_string(),
        );
        assert_eq!(on[0], "Fan out with Task agents.");
        assert_eq!(on[1], "Custom global prompt.");
    }
}

/// Global counter for active file tailers (sessions being streamed)
static ACTIVE_TAILER_COUNT: once_cell::sync::Lazy<AtomicUsize> =
    once_cell::sync::Lazy::new(|| AtomicUsize::new(0));

pub fn increment_tailer_count() {
    ACTIVE_TAILER_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub fn decrement_tailer_count() {
    ACTIVE_TAILER_COUNT.fetch_sub(1, Ordering::Relaxed);
}
