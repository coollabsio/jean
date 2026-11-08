pub(crate) mod acp_permissions;
pub(crate) mod antigravity;
pub(crate) mod auth_failure;
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
pub mod delegation;
pub mod detached;
pub(crate) mod devin;
mod devin_permissions;
mod devin_protocol;
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
pub mod secrets;
pub mod storage;
pub mod tail;
pub mod types;
pub mod wakeup;

pub(crate) use commands::default_model_for_backend;
pub(crate) use commands::purge_session;
pub use commands::*;
pub use mcp_auth::*;
pub use native_history::*;
pub use storage::{preserve_base_sessions, restore_base_sessions};

use std::sync::atomic::{AtomicUsize, Ordering};

/// End-of-turn recap instruction. Appended to every backend's system prompt so
/// the assistant terminates multi-step turns with a single `## Recap` markdown
/// block. The compact view in `CompactMessageList.tsx` extracts that block and
/// renders it as the visible summary instead of the full latest assistant text.
pub const RECAP_INSTRUCTION: &str = "## End-of-turn recap

End every turn that used tools, edited files, or did multi-step work with one final `## Recap` block. It is the deliverable: a reader who skips the rest of the message must get every fact that matters. Write it dense: facts only, no filler, no narration of your process, no restating the request.

Format:

## Recap

[The answer or result in 1-3 short lines, or a table/list if that fits better. Include every finding, every fix or change made (what changed and where, `file:line` when useful), and every decision, caveat, or open item the user must know.]

Tested against local dev env: Yes/No

[`### Possible regressions` — only when the rules below say to.]

[`### How to test` — only when the rules below say to.]

Rules:
- Heading is the literal `## Recap` on its own line, and it is the LAST block of the message.
- Brief wording, complete content: cut words, never items: do not drop items to make the recap shorter. No \"see above\" or \"I looked it up\" — restate the result.
- Findings, issues, risks, ideas, or fixes go in one Markdown table (for example: | # | Finding | Location | Impact | Fix / status |), not prose. The table must include EVERY item from the turn, one row per item, across all groups and priorities. Keep the numbers or letters used earlier. Do not merge rows or hide items in a bullet like \"smaller ideas\". Shorten cells instead.
- Keep links: write every issue, PR, commit, advisory, Linear/Sentry issue, or URL with a known link as a Markdown link (for example `[#123](https://github.com/owner/repo/pull/123)`). Do not invent URLs.
- `Tested against local dev env: Yes` or `Tested against local dev env: No`: include it only when the turn changed code, config, or behavior; Yes only if you verified it in a running local dev env.
- `### How to test`: only when the turn made changes the user can verify. Max 5 numbered steps, each one plain action with the exact URL or command and the expected result — a manual smoke test of the main behavior if it makes sense. Omit it on read-only turns; never write placeholders like \"N/A\".
- `### Possible regressions`: only when the turn changed functional behavior (logic, data flow, state, persistence, APIs, commands, parsing, shared code). Omit it for visual-only, docs, comments, prompt text, tests-only, and read-only turns. Table, riskiest first: | # | What the user would see | Cause in this change | Proof it still works | Check it yourself |.
  - `What the user would see`: an action and its wrong result (for example `Delete server with \"remove SSH key\" → key stays`), not the code change.
  - `Proof it still works` starts with one label: `Old test:` <name>, `New test:` <name> (weak proof), `Ran in dev env:` <what>, `Callers read:` <which>, or `Not verified`.
  - `Check it yourself`: one short manual step; `—` only for `Old test:` or `Ran in dev env:`.
  - Check callers, shared types, persistence, other backends, web access, and mobile. Only real failure paths. If none, write `No possible regressions found` and the reason.
- If the turn ends with a question for the user, put the question at the end of the recap: one line with the question, then `Reply with a number:`, then 2-8 numbered short options. Jean shows them as buttons. Ask the question exactly once: never before the `## Recap` heading, not even in an earlier message of the same turn or when a skill says so.
- Screenshots or images the user should see: list them in a fenced code block with the language `screenshots`, one absolute path or URL per line, in viewing order. Do not also link them.
- Plan mode: still call the native plan tool (Claude ExitPlanMode, Codex `<proposed_plan>`, Cursor/OpenCode equivalent). The recap never replaces it.
- Skip the recap for a single one-line answer with no tool calls.
- Never paste tool inputs, diffs, or raw command output. Summarize.";

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
    fn recap_holds_inline_question() {
        assert!(RECAP_INSTRUCTION.contains("put the question at the end of the recap"));
        assert!(RECAP_INSTRUCTION.contains("`Reply with a number:`"));
        assert!(RECAP_INSTRUCTION.contains("Ask the question exactly once"));
    }

    #[test]
    fn recap_findings_table_lists_every_item() {
        assert!(RECAP_INSTRUCTION.contains("The table must include EVERY item from the turn"));
        assert!(RECAP_INSTRUCTION.contains("do not drop items to make the recap shorter"));
    }

    #[test]
    fn recap_shows_screenshots_as_gallery_block() {
        assert!(RECAP_INSTRUCTION.contains("fenced code block with the language `screenshots`"));
    }

    #[test]
    fn recap_requests_local_dev_env_tested_line() {
        assert!(RECAP_INSTRUCTION.contains("Tested against local dev env: Yes"));
        assert!(RECAP_INSTRUCTION.contains("Tested against local dev env: No"));
    }

    #[test]
    fn recap_requests_possible_regressions_table() {
        assert!(RECAP_INSTRUCTION.contains("### Possible regressions"));
        assert!(
            RECAP_INSTRUCTION.contains("| # | What the user would see | Cause in this change |")
        );
        assert!(RECAP_INSTRUCTION.contains("`New test:`"));
        assert!(RECAP_INSTRUCTION.contains("Check it yourself"));
        assert!(RECAP_INSTRUCTION.contains("No possible regressions found"));
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
