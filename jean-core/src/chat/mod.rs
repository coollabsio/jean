pub(crate) mod claude;
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
mod naming;
mod native_history;
pub(crate) mod opencode;
pub(crate) mod pi;
pub mod registry;
pub mod run_log;
pub mod storage;
pub mod tail;
pub mod types;
pub mod wakeup;

pub use commands::*;
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

[Optional `### How to test` subsection — include ONLY when the rules below say to.]

Rules:
- Heading must be the literal string `## Recap` on its own line.
- Place it as the LAST block of the message, after any prose.
- The recap is the user-facing deliverable — it must be self-contained. Include the actual answer/result inline. Do NOT write things like \"I looked it up\" or \"see above\" — restate the answer.
- Add a `### How to test` subsection ONLY when the turn produced code, config, or behavior changes the user can verify. Make it actionable and specific (commands to run, UI flows to click through, files to inspect); if it makes sense, always include a smoke test that explains how the user can manually verify the main behavior. OMIT the subsection entirely on read-only turns — questions, explanations, research, planning, code review without edits, or any turn where there is nothing meaningful to test. Do NOT include placeholder content like \"N/A\", \"Nothing to test\", \"No tests needed\", or an empty bullet list. If in doubt, leave it out.
- In plan mode, when a plan is ready, you MUST still call the native plan tool (Claude ExitPlanMode, Codex update_plan/CodexPlan, Cursor/OpenCode equivalent) to present it. The recap does NOT replace the plan tool — never end a plan-mode turn with only a `## Recap` block in place of the plan tool call.
- Skip the recap entirely if the turn was a single one-line answer with no tool calls.
- Do NOT repeat tool inputs, file diffs, or raw command output verbatim. Summarize.";

pub(crate) fn should_add_recap_instruction(app: &tauri::AppHandle) -> bool {
    crate::load_preferences_sync(app)
        .map(|preferences| preferences.auto_recaps_enabled)
        .unwrap_or(true)
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
