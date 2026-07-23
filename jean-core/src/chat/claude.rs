use super::coalesce::ChunkCoalescer;
use super::run_log::tool_result_content_to_string;
use super::types::{
    is_claude_compaction_summary_text, CompactMetadata, ContentBlock, EffortLevel,
    PermissionDenial, PermissionDeniedEvent, ThinkingLevel, ToolCall, UsageData,
};
use crate::http_server::EmitExt;
use crate::projects::github_issues::{
    get_github_contexts_dir, get_session_advisory_refs, get_session_issue_refs,
    get_session_pr_refs, get_session_security_refs,
};
use crate::projects::linear_issues::get_session_linear_refs;
use crate::projects::sentry_issues::get_session_sentry_refs;
use crate::projects::storage::load_projects_data;

// =============================================================================
// Constants
// =============================================================================

/// Default global system prompt (must match DEFAULT_GLOBAL_SYSTEM_PROMPT in preferences.ts)
const DEFAULT_GLOBAL_SYSTEM_PROMPT: &str = "\
### 1. Planning Guidance\n\
- For non-trivial tasks (3+ steps or architectural decisions), prefer planning before implementation when the current execution mode has not already authorized execution.\n\
- If something goes sideways, STOP and re-plan immediately - don't keep pushing\n\
- Use plan mode for verification steps when the current execution mode is plan; in build/yolo, verify directly after implementing.\n\
- Write detailed specs upfront to reduce ambiguity\n\
- Keep plans concise but complete enough for zero-context handoff (YOLO/Build in a new worktree must not require re-scanning the repo). Prefer short wording over thin checklists.\n\
- When the current execution mode is plan, use the backend's native plan tool/UI call when available (Claude ExitPlanMode, Codex `<proposed_plan>` / collaboration Plan mode, Cursor/OpenCode equivalent), not plain text only.\n\
- For unresolved questions while planning, prefer the backend-native interactive question UI instead of plain text when available: Claude AskUserQuestion, Codex request_user_input, OpenCode question. If no such interactive question tool is present in your current tool set (headless/`--print` runs may omit Claude AskUserQuestion), do NOT skip the question and do NOT dead-end on a tool search — instead ask inline as a short numbered list of options (1, 2, 3...) and tell the user to reply with a number.\n\
- For Codex specifically, when the current execution mode is plan: do not write plan files or code; when the plan is ready wrap it in `<proposed_plan>...</proposed_plan>` so Jean can show the approval UI. Do not use the `update_plan` checklist tool in plan mode.\n\
- Every Codex response that contains or revises a plan while the current execution mode is plan must use a complete `<proposed_plan>` block (or a native plan item); do not provide plain-text-only plans, and do not attempt file writes.\n\
- Use a plain-text Unresolved Questions section only for non-actionable notes or when the backend cannot ask interactively.\n\
\n\
### 2. Documentation First\n\
- Before designing or coding against any external library/framework/SDK/API/CLI, run WebSearch for current docs.\n\
- Verify version, API shape, and breaking changes — training data may be stale.\n\
- Cite the source URL in your plan or commit reasoning when behavior is non-obvious.\n\
- Skip only for trivial edits to code already read this session.\n\
- Do NOT use Context7 — WebSearch only.\n\
\n\
### 3. Subagent Strategy to keep main context window clean\n\
- Offload research, exploration, and parallel analysis to subagents\n\
- For complex problems, throw more compute at it via subagents\n\
- One task per subagent for focused execution\n\
\n\
### 4. Self-Improvement Loop\n\
- After ANY correction from the user: update '.ai/lessons.md' with the pattern\n\
- Write rules for yourself that prevent the same mistake\n\
- Ruthlessly iterate on these lessons until mistake rate drops\n\
- Review lessons at session start for relevant project\n\
\n\
### 5. Verification Before Done\n\
- Never mark a task complete without proving it works\n\
- Diff behavior between main and your changes when relevant\n\
- Ask yourself: \"Would a staff engineer approve this?\"\n\
- Run tests, check logs, demonstrate correctness\n\
\n\
### 6. Demand Elegance (Balanced)\n\
- For non-trivial changes: pause and ask \"is there a more elegant way?\"\n\
- If a fix feels hacky: \"Knowing everything I know now, implement the elegant solution\"\n\
- Skip this for simple, obvious fixes - don't over-engineer\n\
- Challenge your own work before presenting it\n\
\n\
### 7. Autonomous Bug Fixing\n\
- When given a bug report: just fix it. Don't ask for hand-holding\n\
- Point at logs, errors, failing tests -> then resolve them\n\
- Zero context switching required from the user\n\
- Go fix failing CI tests without being told how\n\
\n\
## Task Management\n\
1. **Plan First**: Write plan to '.ai/todo.md' with checkable items\n\
2. **Verify Plan**: Check in before starting implementation\n\
3. **Track Progress**: Mark items complete as you go\n\
4. **Explain Changes**: High-level summary at each step\n\
5. **Document Results**: Add review to '.ai/todo.md'\n\
6. **Capture Lessons**: Update '.ai/lessons.md' after corrections\n\
\n\
## Core Principles\n\
- **Simplicity First**: Make every change as simple as possible. Impact minimal code.\n\
- **VERY IMPORTANT: Keep Code Simple**: Do not over-engineer. Always implement the simplest maintainable solution. Avoid extra abstractions, frameworks, configuration, or future-proofing unless clearly required.\n\
- **Clickable References**: When output mentions issues, PRs, security advisories/alerts, Linear issues, or other external resources, include clickable links when available so users can open them directly.\n\
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.\n\
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.\n\
\n\
## GitHub Issue and Discussion Discovery\n\
- After making changes and before the final response, search the current repository's existing GitHub issues and discussions for items completely fixed by the changes, related items, and similar reports or discussions.\n\
- Include the results in both the main response and the `## Recap`, with clickable links when available, and label each item as fully fixed, related, or similar. If no matches are found or the search is unavailable, say so explicitly.\n\
- Do not claim an issue is fixed unless the changes fully satisfy it. Do not close or update issues or discussions unless the user explicitly asks.\n\
\n\
## Jean Worktree Policy\n\
- Do NOT create git worktrees manually (`git worktree add`, Superpowers `using-git-worktrees`, or similar) unless the user explicitly asks for a new worktree.\n\
- If a new worktree is explicitly required, use Jean's worktree features through Jean MCP/tools, not raw git worktree commands.\n\
- If already in a Jean worktree or base/main workspace, continue in the current workspace.\n\
\n\
## Important!\n\
\n\
- After each finished task, please write a few bullet points on how to test the changes.";

fn execution_mode_instruction(execution_mode: Option<&str>) -> Option<&'static str> {
    match execution_mode.unwrap_or("plan") {
        "build" => Some(
            "You are in BUILD MODE. Start implementing immediately. \
             Do NOT enter plan mode and do NOT use ExitPlanMode unless the user explicitly asks \
             for a new plan. If a required decision is missing, use AskUserQuestion instead of \
             ExitPlanMode; if AskUserQuestion is not in your tool set, ask inline with a short \
             numbered list of options and have the user reply with a number.",
        ),
        "yolo" => Some(
            "You are in YOLO EXECUTION MODE. Start implementing immediately. \
             Do NOT enter plan mode and do NOT use ExitPlanMode unless the user explicitly asks \
             for a new plan. Do not ask for confirmation before routine implementation steps. \
             If a required decision is missing, use AskUserQuestion instead of ExitPlanMode; \
             if AskUserQuestion is not in your tool set, ask inline with a short numbered list \
             of options and have the user reply with a number.",
        ),
        _ => None,
    }
}

// =============================================================================
// Claude CLI execution
// =============================================================================

/// Response from Claude CLI execution
pub struct ClaudeResponse {
    /// The text response from Claude
    pub content: String,
    /// The session ID (for resuming conversations)
    pub session_id: String,
    /// Tool calls made during this response
    pub tool_calls: Vec<ToolCall>,
    /// Ordered content blocks preserving tool position in response
    pub content_blocks: Vec<ContentBlock>,
    /// Whether the response was cancelled by the user
    pub cancelled: bool,
    /// Token usage for this response
    pub usage: Option<UsageData>,
}

/// Payload for text chunk events sent to frontend
#[derive(serde::Serialize, Clone)]
struct ChunkEvent {
    session_id: String,
    worktree_id: String, // Kept for backward compatibility
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
}

/// Payload for tool use events sent to frontend
#[derive(serde::Serialize, Clone)]
struct ToolUseEvent {
    session_id: String,
    worktree_id: String, // Kept for backward compatibility
    id: String,
    name: String,
    input: serde_json::Value,
    /// Parent tool use ID for sub-agent tool calls (for parallel task attribution)
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
}

/// Payload for done events sent to frontend
#[derive(serde::Serialize, Clone)]
struct DoneEvent {
    session_id: String,
    worktree_id: String, // Kept for backward compatibility
    /// Always false for Claude (uses ExitPlanMode tool calls instead)
    waiting_for_plan: bool,
}

/// Payload for error events sent to frontend
#[derive(serde::Serialize, Clone)]
pub struct ErrorEvent {
    pub session_id: String,
    pub worktree_id: String, // Kept for backward compatibility
    pub error: String,
}

/// Payload for cancelled events sent to frontend
#[derive(serde::Serialize, Clone)]
pub struct CancelledEvent {
    pub session_id: String,
    pub worktree_id: String, // Kept for backward compatibility
    pub undo_send: bool, // True if user message should be restored to input (instant cancellation)
    pub emitted_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// Payload for tool block position events sent to frontend
/// Signals where a tool_use block appears in the content stream
#[derive(serde::Serialize, Clone)]
struct ToolBlockEvent {
    session_id: String,
    worktree_id: String, // Kept for backward compatibility
    tool_call_id: String,
}

/// Payload for thinking events sent to frontend (extended thinking)
#[derive(serde::Serialize, Clone)]
struct ThinkingEvent {
    session_id: String,
    worktree_id: String, // Kept for backward compatibility
    content: String,
}

/// Payload for tool result events sent to frontend
/// Contains the output from a tool execution
#[derive(serde::Serialize, Clone)]
struct ToolResultEvent {
    session_id: String,
    worktree_id: String, // Kept for backward compatibility
    tool_use_id: String,
    output: String,
}

/// Payload for live tool-event (e.g. Monitor notifications) streamed to frontend.
/// Unlike tool_result which is atomic, this carries incremental events
/// while a long-running tool (like Monitor) is still armed.
#[derive(serde::Serialize, Clone)]
struct ToolEventEvent {
    session_id: String,
    worktree_id: String,
    tool_use_id: String,
    kind: String, // "monitor_event" | "monitor_status" | "monitor_done"
    payload: serde_json::Value,
    ts_ms: u64,
}

// PermissionDenial and PermissionDeniedEvent are in types.rs

/// Payload for compacting-in-progress events sent to frontend
/// Signals that context compaction has started
#[derive(serde::Serialize, Clone)]
struct CompactingEvent {
    session_id: String,
    worktree_id: String,
}

/// Payload for compaction-complete events sent to frontend
/// Contains metadata about the compaction that occurred
#[derive(serde::Serialize, Clone)]
struct CompactedEvent {
    session_id: String,
    worktree_id: String,
    metadata: CompactMetadata,
}

fn compact_metadata_from_system_message(msg: &serde_json::Value) -> Option<CompactMetadata> {
    msg.get("compact_metadata")
        .or_else(|| msg.get("compactMetadata"))
        .and_then(|metadata_val| {
            serde_json::from_value::<CompactMetadata>(metadata_val.clone()).ok()
        })
}

#[derive(Debug, Clone)]
struct StreamToolUse {
    index: usize,
    id: String,
    name: String,
    input: serde_json::Value,
}

fn stream_event_tool_use(msg: &serde_json::Value) -> Option<StreamToolUse> {
    let event = msg.get("event")?;
    if event.get("type").and_then(|v| v.as_str()) != Some("content_block_start") {
        return None;
    }

    let block = event.get("content_block")?;
    if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
        return None;
    }

    Some(StreamToolUse {
        index: event.get("index")?.as_u64()? as usize,
        id: block.get("id")?.as_str()?.to_string(),
        name: block.get("name")?.as_str()?.to_string(),
        input: block
            .get("input")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    })
}

fn stream_event_input_delta(msg: &serde_json::Value) -> Option<(usize, &str)> {
    let event = msg.get("event")?;
    if event.get("type").and_then(|v| v.as_str()) != Some("content_block_delta") {
        return None;
    }

    let index = event.get("index")?.as_u64()? as usize;
    let delta = event.get("delta")?;
    if delta.get("type").and_then(|v| v.as_str()) != Some("input_json_delta") {
        return None;
    }

    Some((index, delta.get("partial_json")?.as_str()?))
}

// =============================================================================
// Detached Claude CLI execution
// =============================================================================

/// Apply custom CLI profile settings to a Command (adds --settings flag if profile exists).
/// Reusable for both main chat sessions and one-shot magic prompt operations.
pub fn apply_custom_profile_settings(cmd: &mut std::process::Command, profile_name: Option<&str>) {
    if let Some(name) = profile_name {
        if !name.is_empty() {
            if let Ok(path) = crate::get_cli_profile_path(name) {
                if path.exists() {
                    cmd.arg("--settings").arg(&path);
                } else {
                    log::warn!(
                        "CLI profile file not found for '{name}': {}",
                        path.display()
                    );
                }
            }
        }
    }
}

fn custom_profile_env_vars_from_settings(settings: &str) -> Result<Vec<(String, String)>, String> {
    let value: serde_json::Value =
        serde_json::from_str(settings).map_err(|e| format!("Invalid CLI profile JSON: {e}"))?;

    let Some(env) = value.get("env").and_then(|env| env.as_object()) else {
        return Ok(Vec::new());
    };

    Ok(env
        .iter()
        .filter_map(|(key, value)| {
            value
                .as_str()
                .map(|value| (key.to_string(), value.to_string()))
        })
        .collect())
}

fn load_custom_profile_env_vars(profile_name: Option<&str>) -> Vec<(String, String)> {
    let Some(name) = profile_name.filter(|name| !name.is_empty()) else {
        return Vec::new();
    };

    let Ok(path) = crate::get_cli_profile_path(name) else {
        return Vec::new();
    };

    if !path.exists() {
        return Vec::new();
    }

    match std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read CLI profile '{}': {e}", path.display()))
        .and_then(|settings| custom_profile_env_vars_from_settings(&settings))
    {
        Ok(env_vars) => env_vars,
        Err(error) => {
            log::warn!("{error}");
            Vec::new()
        }
    }
}

/// Apply custom CLI profile env vars to a Command.
///
/// Newer Claude CLI versions may check authentication before fully applying
/// `--settings` env, so API-compatible providers need their ANTHROPIC_* vars
/// present in the child process environment too.
pub fn apply_custom_profile_env(cmd: &mut std::process::Command, profile_name: Option<&str>) {
    for (key, value) in load_custom_profile_env_vars(profile_name) {
        cmd.env(key, value);
    }
}

fn should_mirror_custom_profile_env_for_detached() -> bool {
    cfg!(windows) && !crate::platform::get_wsl_config().enabled
}

/// Strip a `-fast` suffix from the model string.
/// Returns `(actual_model, is_fast)`.
/// E.g. `"opus-fast"` → `("opus", true)`, `"opus"` → `("opus", false)`.
fn split_fast_model(model: &str) -> (&str, bool) {
    match model.strip_suffix("-fast") {
        Some(base) => (base, true),
        None => (model, false),
    }
}

/// Build CLI arguments for Claude CLI.
///
/// Returns a tuple of (args, env_vars) where env_vars are (key, value) pairs.
#[allow(clippy::too_many_arguments)]
fn build_claude_args(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    existing_claude_session_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    thinking_level: Option<&ThinkingLevel>,
    effort_level: Option<&EffortLevel>,
    allowed_tools: Option<&[String]>,
    parallel_execution_prompt: Option<&str>,
    ai_language: Option<&str>,
    mcp_config: Option<&str>,
    chrome_enabled: bool,
    custom_profile_name: Option<&str>,
) -> (Vec<String>, Vec<(String, String)>) {
    let mut args = Vec::new();
    let mut env_vars = Vec::new();

    // Core args
    args.push("--print".to_string());
    args.push("--output-format".to_string());
    args.push("stream-json".to_string());
    args.push("--input-format".to_string());
    args.push("stream-json".to_string());
    args.push("--verbose".to_string());
    args.push("--tools".to_string());
    args.push("default".to_string());
    // Stream partial messages so long-running tools (Monitor, etc.) can push events
    // to the UI without waiting for message boundaries.
    args.push("--include-partial-messages".to_string());

    // Add app data directories
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        if cfg!(debug_assertions) {
            args.push("--add-dir".to_string());
            args.push(app_data_dir.to_string_lossy().to_string());
        } else {
            for subdir in [
                "pasted-images",
                "pasted-texts",
                "session-context",
                "git-context",
                "combined-contexts",
            ] {
                args.push("--add-dir".to_string());
                args.push(app_data_dir.join(subdir).to_string_lossy().to_string());
            }
            // Add session-specific runs directory
            let session_runs_dir = app_data_dir.join("runs").join(session_id);
            args.push("--add-dir".to_string());
            args.push(session_runs_dir.to_string_lossy().to_string());
        }
    }

    // Add linked project directories for read access
    let linked_project_paths: Vec<String> = crate::projects::storage::load_projects_data(app)
        .ok()
        .and_then(|data| {
            let worktree = data.find_worktree(worktree_id)?;
            let project = data.find_project(&worktree.project_id)?;
            Some(
                project
                    .linked_project_ids
                    .iter()
                    .filter_map(|id| data.find_project(id))
                    .filter(|p| !p.path.trim().is_empty())
                    .map(|p| p.path.clone())
                    .collect(),
            )
        })
        .unwrap_or_default();
    for dir in &linked_project_paths {
        args.push("--add-dir".to_string());
        args.push(dir.clone());
    }

    // Add Claude CLI skills and commands directories (~/.claude/skills and ~/.claude/commands)
    if let Some(home_dir) = dirs::home_dir() {
        let claude_dir = home_dir.join(".claude");
        for subdir in ["skills", "commands"] {
            let dir_path = claude_dir.join(subdir);
            if dir_path.exists() {
                args.push("--add-dir".to_string());
                args.push(dir_path.to_string_lossy().to_string());
            }
        }
    }

    // Model (strip "-fast" suffix: "opus-fast" → model="opus" + fastMode setting)
    let (is_fast, fast_base_model) = if let Some(m) = model {
        let (actual_model, fast) = split_fast_model(m);
        args.push("--model".to_string());
        args.push(actual_model.to_string());
        (fast, fast.then(|| actual_model.to_string()))
    } else {
        (false, None)
    };

    // Permission mode
    let perm_mode = match execution_mode.unwrap_or("plan") {
        "build" => "acceptEdits",
        "yolo" => "bypassPermissions",
        _ => "plan",
    };
    args.push("--permission-mode".to_string());
    args.push(perm_mode.to_string());

    // In build/yolo, remove ExitPlanMode entirely so Claude can't loop back
    // into plan-approval after the user already approved one.
    if matches!(execution_mode.unwrap_or("plan"), "build" | "yolo") {
        args.push("--disallowedTools".to_string());
        args.push("ExitPlanMode".to_string());
    }

    // Custom profile settings: resolve name → file path, pass to --settings (secrets stay in file, not in ps)
    if let Some(name) = custom_profile_name {
        if !name.is_empty() {
            if let Ok(path) = crate::get_cli_profile_path(name) {
                if path.exists() {
                    args.push("--settings".to_string());
                    args.push(path.to_string_lossy().to_string());
                } else {
                    log::warn!(
                        "CLI profile file not found for '{name}': {}",
                        path.display()
                    );
                }
            }
        }
    }
    if should_mirror_custom_profile_env_for_detached() {
        env_vars.extend(load_custom_profile_env_vars(custom_profile_name));
    }

    // Thinking/effort settings: passed as separate --settings JSON (no secrets here)
    let mut settings_json: Option<serde_json::Value> = None;

    if let Some(effort) = effort_level {
        // Opus 4.6 adaptive thinking: use effort parameter via --settings JSON
        if let Some(effort_value) = effort.effort_value() {
            let obj = settings_json.get_or_insert_with(|| serde_json::json!({}));
            if let Some(map) = obj.as_object_mut() {
                map.insert(
                    "effortLevel".to_string(),
                    serde_json::Value::String(effort_value.to_string()),
                );
            }
        }
        // If Off, don't send any thinking/effort settings (but still send custom profile if present)
    } else {
        // Traditional thinking levels (Sonnet, Haiku)
        if let Some(level) = thinking_level {
            let obj = settings_json.get_or_insert_with(|| serde_json::json!({}));
            if let Some(map) = obj.as_object_mut() {
                map.insert(
                    "alwaysThinkingEnabled".to_string(),
                    serde_json::Value::Bool(level.is_enabled()),
                );
            }

            if let Some(tokens) = level.thinking_tokens() {
                env_vars.push(("MAX_THINKING_TOKENS".to_string(), tokens.to_string()));
            }
        }
    }

    // Fast mode: inject "fastMode": true into settings JSON
    if is_fast {
        let obj = settings_json.get_or_insert_with(|| serde_json::json!({}));
        if let Some(map) = obj.as_object_mut() {
            map.insert("fastMode".to_string(), serde_json::Value::Bool(true));
        }
    }

    // Fast mode picks the CLI's default fast Opus version (4.8 in Claude Code
    // v2.1.154+), ignoring --model for the Opus version. Pin to 4.6 when the
    // user explicitly selected the 4.6 fast variant.
    if fast_base_model.as_deref() == Some("claude-opus-4-6[1m]") {
        env_vars.push((
            "CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE".to_string(),
            "1".to_string(),
        ));
    }

    // Emit --settings if we have any settings to pass
    if let Some(settings) = &settings_json {
        args.push("--settings".to_string());
        args.push(settings.to_string());
    }

    // Allowed tools
    if let Some(tools) = allowed_tools {
        for tool in tools {
            args.push("--allowedTools".to_string());
            args.push(tool.clone());
        }
    }

    // Allow embedded/resolved CLI binaries without approval via --allowedTools
    // Claude wraps paths with spaces in quotes, so use glob patterns to match
    let gh_binary = crate::gh_cli::config::resolve_gh_binary(app);
    let gh_path_str = gh_binary.to_string_lossy();
    args.push("--allowedTools".to_string());
    args.push(format!("Bash(*{gh_path_str}*)"));
    // Also allow the Jean-managed path pattern when user configured system PATH gh
    if !gh_path_str.contains("gh-cli/gh") {
        args.push("--allowedTools".to_string());
        args.push("Bash(*gh-cli/gh*)".to_string());
    }
    args.push("--allowedTools".to_string());
    args.push("Bash(*claude-cli/claude*)".to_string());

    append_mcp_config_args(&mut args, mcp_config);

    // Chrome browser integration (beta)
    if chrome_enabled {
        args.push("--chrome".to_string());
    }

    // Build combined system prompt parts
    // Claude CLI only uses the LAST --append-system-prompt, so we must combine all prompts
    let mut system_prompt_parts: Vec<String> = Vec::new();

    // AI language preference - user's preferred response language
    if let Some(lang) = ai_language {
        let lang = lang.trim();
        if !lang.is_empty() {
            system_prompt_parts.push(format!("Respond to the user in {}.", lang));
        }
    }

    // Global system prompt from preferences (like ~/.claude/CLAUDE.md)
    // Falls back to DEFAULT_GLOBAL_SYSTEM_PROMPT when not set (null = use default)
    if let Ok(prefs_path) = crate::get_preferences_path(app) {
        if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
            if let Ok(prefs) = serde_json::from_str::<crate::AppPreferences>(&contents) {
                let prompt = prefs
                    .magic_prompts
                    .global_system_prompt
                    .as_deref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(DEFAULT_GLOBAL_SYSTEM_PROMPT);
                system_prompt_parts.push(prompt.to_string());
            }
        }
    }

    if let Some(mode_instruction) = execution_mode_instruction(execution_mode) {
        system_prompt_parts.push(mode_instruction.to_string());
    }

    // Parallel execution prompt - encourages sub-agent parallelization
    if let Some(prompt) = parallel_execution_prompt {
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            system_prompt_parts.push(prompt.to_string());
        }
    }

    // Per-project custom system prompt + linked project instructions
    if let Ok(data) = load_projects_data(app) {
        if let Some(worktree) = data.find_worktree(worktree_id) {
            if let Some(project) = data.find_project(&worktree.project_id) {
                if let Some(prompt) = &project.custom_system_prompt {
                    let prompt = prompt.trim();
                    if !prompt.is_empty() {
                        system_prompt_parts.push(prompt.to_string());
                    }
                }

                // Linked projects: inject instruction to check their directories
                if !linked_project_paths.is_empty() {
                    let dirs_list = linked_project_paths
                        .iter()
                        .map(|p| format!("- {p}"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    system_prompt_parts.push(format!(
                        "This project is linked to other projects for cross-project context. \
                         Check the following directories for additional instructions and documentation \
                         (e.g., CLAUDE.md, AGENTS.md, docs/):\n{dirs_list}"
                    ));
                }
            }
        }
    }

    // Embedded gh CLI path - tell Claude to use the app's bundled binary
    let gh_binary = crate::gh_cli::config::resolve_gh_binary(app);
    if gh_binary != std::path::PathBuf::from("gh") {
        system_prompt_parts.push(format!(
            "When running GitHub CLI commands, use the full path to the embedded binary: {}\n\
             Do NOT use bare `gh` — always use the full path above.",
            gh_binary.display()
        ));
    }

    // Embedded Claude CLI path - tell Claude to use the app's bundled binary
    if let Ok(claude_binary) = crate::claude_cli::get_cli_binary_path(app) {
        if claude_binary.exists() {
            system_prompt_parts.push(format!(
                "When running Claude CLI commands, use the full path to the embedded binary: {}\n\
                 Do NOT use bare `claude` — always use the full path above.",
                claude_binary.display()
            ));
        }
    }

    // Embedded Codex CLI path - tell Claude to use the app's bundled binary
    if let Ok(codex_binary) = crate::codex_cli::get_cli_binary_path(app) {
        if codex_binary.exists() {
            system_prompt_parts.push(format!(
                "When running Codex CLI commands, use the full path to the embedded binary: {}\n\
                 Do NOT use bare `codex` — always use the full path above.",
                codex_binary.display()
            ));
        }
    }

    // End-of-turn recap instruction (compact view surfaces this block)
    if super::should_add_recap_instruction(app) {
        system_prompt_parts.push(super::RECAP_INSTRUCTION.to_string());
    }

    // Collect all context files (issues and PRs) and concatenate into a single file
    let mut all_context_paths: Vec<std::path::PathBuf> = Vec::new();

    // Check for issue context files (shared storage)
    // Merge session_id refs + worktree_id refs (worktree refs cover PR/issue-based worktrees
    // where the background thread may not have copied refs to the session yet)
    let mut issue_keys = get_session_issue_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_issue_refs(app, worktree_id) {
        for key in wt_keys {
            if !issue_keys.contains(&key) {
                issue_keys.push(key);
            }
        }
    }
    if !issue_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            log::debug!(
                "Checking for issue context files in {:?} for session {}",
                contexts_dir,
                session_id
            );
            for key in issue_keys {
                // key format: "{owner}-{repo}-{number}"
                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                if parts.len() == 2 {
                    let number = parts[0];
                    let repo_key = parts[1];
                    let file_path = contexts_dir.join(format!("{repo_key}-issue-{number}.md"));
                    if file_path.exists() {
                        log::trace!("Adding issue context file: {:?}", file_path);
                        all_context_paths.push(file_path);
                    }
                }
            }
        }
    }

    // Check for PR context files (shared storage)
    let mut pr_keys = get_session_pr_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_pr_refs(app, worktree_id) {
        for key in wt_keys {
            if !pr_keys.contains(&key) {
                pr_keys.push(key);
            }
        }
    }
    if !pr_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            for key in pr_keys {
                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                if parts.len() == 2 {
                    let number = parts[0];
                    let repo_key = parts[1];
                    let file_path = contexts_dir.join(format!("{repo_key}-pr-{number}.md"));
                    if file_path.exists() {
                        log::trace!("Adding PR context file: {:?}", file_path);
                        all_context_paths.push(file_path);
                    }
                }
            }
        }
    }

    // Check for security alert context files (shared storage)
    let mut security_keys = get_session_security_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_security_refs(app, worktree_id) {
        for key in wt_keys {
            if !security_keys.contains(&key) {
                security_keys.push(key);
            }
        }
    }
    if !security_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            for key in security_keys {
                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                if parts.len() == 2 {
                    let number = parts[0];
                    let repo_key = parts[1];
                    let file_path = contexts_dir.join(format!("{repo_key}-security-{number}.md"));
                    if file_path.exists() {
                        log::trace!("Adding security context file: {:?}", file_path);
                        all_context_paths.push(file_path);
                    }
                }
            }
        }
    }

    // Check repository advisory context files (shared storage)
    let mut advisory_keys = get_session_advisory_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_advisory_refs(app, worktree_id) {
        for key in wt_keys {
            if !advisory_keys.contains(&key) {
                advisory_keys.push(key);
            }
        }
    }
    if !advisory_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            for key in advisory_keys {
                if let Some((repo_key, ghsa_id)) = key.split_once("::") {
                    let file_path = contexts_dir.join(format!("{repo_key}-advisory-{ghsa_id}.md"));
                    if file_path.exists() {
                        log::trace!("Adding advisory context file: {:?}", file_path);
                        all_context_paths.push(file_path);
                    }
                }
            }
        }
    }

    // Check for Linear issue context files (shared storage)
    let mut linear_keys = get_session_linear_refs(app, session_id).unwrap_or_default();
    if let Ok(wt_keys) = get_session_linear_refs(app, worktree_id) {
        for key in wt_keys {
            if !linear_keys.contains(&key) {
                linear_keys.push(key);
            }
        }
    }
    if !linear_keys.is_empty() {
        if let Ok(contexts_dir) = get_github_contexts_dir(app) {
            for key in linear_keys {
                // key format: "{project_name}-{identifier}" where identifier is "TEAM-123"
                // context file format: "{project_name}-linear-{identifier_lower}.md"
                // Linear identifiers always have exactly one dash (e.g. "ENG-123"),
                // so rsplitn(3, '-') safely separates the number, team key, and project name.
                let parts: Vec<&str> = key.rsplitn(3, '-').collect();
                if parts.len() == 3 {
                    let project_name_part = parts[2];
                    let identifier_lower = format!("{}-{}", parts[1].to_lowercase(), parts[0]);
                    let file_path = contexts_dir
                        .join(format!("{project_name_part}-linear-{identifier_lower}.md"));
                    if file_path.exists() {
                        log::trace!("Adding Linear issue context file: {:?}", file_path);
                        all_context_paths.push(file_path);
                    }
                }
            }
        }
    }

    // Check for Sentry issue context files (shared storage)
    let mut sentry_keys = get_session_sentry_refs(app, session_id).unwrap_or_default();
    if let Ok(worktree_keys) = get_session_sentry_refs(app, worktree_id) {
        for key in worktree_keys {
            if !sentry_keys.contains(&key) {
                sentry_keys.push(key);
            }
        }
    }
    if let Ok(contexts_dir) = get_github_contexts_dir(app) {
        for key in sentry_keys {
            if let Some((project_name, issue_id)) = key.split_once("::") {
                let path = contexts_dir.join(format!("{project_name}-sentry-{issue_id}.md"));
                if path.exists() {
                    log::trace!("Adding Sentry issue context file: {:?}", path);
                    all_context_paths.push(path);
                }
            }
        }
    }

    // Check for attached saved context files
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let saved_contexts_dir = app_data_dir.join("session-context");
        if saved_contexts_dir.exists() {
            let prefix = format!("{session_id}-context-");
            if let Ok(entries) = std::fs::read_dir(&saved_contexts_dir) {
                let mut context_files: Vec<_> = entries
                    .flatten()
                    .filter(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        name.starts_with(&prefix) && name.ends_with(".md")
                    })
                    .collect();

                context_files.sort_by_key(|e| e.file_name());
                log::debug!(
                    "Found {} saved context files for session {}",
                    context_files.len(),
                    session_id
                );

                for entry in context_files {
                    all_context_paths.push(entry.path());
                }
            }
        }
    }

    // If we have context files OR system prompt parts, create a combined context file
    let has_system_prompts = !system_prompt_parts.is_empty();
    if !all_context_paths.is_empty() || has_system_prompts {
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            let combined_contexts_dir = app_data_dir.join("combined-contexts");
            let _ = std::fs::create_dir_all(&combined_contexts_dir);

            let combined_file = combined_contexts_dir.join(format!("{session_id}-combined.md"));

            // Count issues, PRs, and saved contexts for the header
            let issue_count = all_context_paths
                .iter()
                .filter(|p| {
                    let s = p.to_string_lossy();
                    s.contains("git-context") && s.contains("-issue-")
                })
                .count();
            let pr_count = all_context_paths
                .iter()
                .filter(|p| {
                    let s = p.to_string_lossy();
                    s.contains("git-context") && s.contains("-pr-")
                })
                .count();
            let security_count = all_context_paths
                .iter()
                .filter(|p| {
                    let s = p.to_string_lossy();
                    s.contains("git-context") && s.contains("-security-")
                })
                .count();
            let advisory_count = all_context_paths
                .iter()
                .filter(|p| {
                    let s = p.to_string_lossy();
                    s.contains("git-context") && s.contains("-advisory-")
                })
                .count();
            let linear_count = all_context_paths
                .iter()
                .filter(|p| {
                    let s = p.to_string_lossy();
                    s.contains("git-context") && s.contains("-linear-")
                })
                .count();
            let saved_context_count = all_context_paths
                .iter()
                .filter(|p| {
                    let s = p.to_string_lossy();
                    s.contains("session-context") && s.contains("-context-")
                })
                .count();

            // Build combined content with header
            let mut combined_content = String::new();

            // Add system prompt parts first (language preference, parallel execution)
            if !system_prompt_parts.is_empty() {
                combined_content.push_str("# Instructions\n\n");
                for part in &system_prompt_parts {
                    combined_content.push_str(part);
                    combined_content.push('\n');
                }
                combined_content.push_str("\n---\n\n");
            }

            // Add context header if we have context files
            if !all_context_paths.is_empty() {
                combined_content.push_str("# Loaded Context\n\n");
                combined_content.push_str("The following context has been loaded. ");
                combined_content
                    .push_str("You should be aware of this when working on this task.\n\n");

                if issue_count > 0
                    || pr_count > 0
                    || security_count > 0
                    || advisory_count > 0
                    || linear_count > 0
                    || saved_context_count > 0
                {
                    combined_content.push_str("**Summary:**\n");
                    if issue_count > 0 {
                        combined_content.push_str(&format!("- {} GitHub Issue(s)\n", issue_count));
                    }
                    if pr_count > 0 {
                        combined_content
                            .push_str(&format!("- {} GitHub Pull Request(s)\n", pr_count));
                    }
                    if security_count > 0 {
                        combined_content
                            .push_str(&format!("- {} Security Alert(s)\n", security_count));
                    }
                    if advisory_count > 0 {
                        combined_content
                            .push_str(&format!("- {} Security Advisory(s)\n", advisory_count));
                    }
                    if linear_count > 0 {
                        combined_content.push_str(&format!("- {} Linear Issue(s)\n", linear_count));
                    }
                    if saved_context_count > 0 {
                        combined_content
                            .push_str(&format!("- {} Saved Context(s)\n", saved_context_count));
                    }
                    combined_content.push_str("\n---\n\n");
                }
            }

            for path in &all_context_paths {
                if let Ok(content) = std::fs::read_to_string(path) {
                    log::debug!("Adding context file to combined: {:?}", path);
                    combined_content.push_str(&content);
                    combined_content.push_str("\n\n---\n\n");
                }
            }

            // Write combined file
            if let Err(e) = std::fs::write(&combined_file, &combined_content) {
                log::error!("Failed to write combined context file: {e}");
            } else {
                log::debug!(
                    "Created combined context file with {} sources: {:?}",
                    all_context_paths.len(),
                    combined_file
                );
                args.push("--append-system-prompt-file".to_string());
                args.push(combined_file.to_string_lossy().to_string());
            }
        }
    }

    // Resume existing session
    if let Some(claude_sid) = existing_claude_session_id {
        args.push("--resume".to_string());
        args.push(claude_sid.to_string());
    }

    // Disable background tasks - forces all Task subagents to run in foreground.
    // Background tasks are killed when --print mode exits the CLI process.
    // Foreground tasks still run in parallel when called in the same message.
    env_vars.push((
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS".to_string(),
        "1".to_string(),
    ));

    // Debug env vars
    env_vars.push(("JEAN_SESSION_ID".to_string(), session_id.to_string()));
    env_vars.push(("JEAN_WORKTREE_ID".to_string(), worktree_id.to_string()));
    // Jean MCP recursion-depth chain. Always set so a Claude spawned by another
    // Jean-spawned Claude can be capped at the configured depth.
    let (depth_key, depth_val) = super::jean_mcp::child_depth_env();
    env_vars.push((depth_key, depth_val));
    env_vars.push((
        "JEAN_MODEL".to_string(),
        model.unwrap_or("default").to_string(),
    ));
    env_vars.push((
        "JEAN_EXECUTION_MODE".to_string(),
        execution_mode.unwrap_or("plan").to_string(),
    ));
    if let Some(claude_sid) = existing_claude_session_id {
        env_vars.push(("JEAN_CLAUDE_SESSION_ID".to_string(), claude_sid.to_string()));
    }

    (args, env_vars)
}

fn append_mcp_config_args(args: &mut Vec<String>, mcp_config: Option<&str>) {
    let Some(config) = mcp_config else {
        return;
    };
    if config.is_empty() {
        return;
    }

    args.push("--mcp-config".to_string());
    args.push(config.to_string());
    args.push("--strict-mcp-config".to_string());

    // Auto-allow all tools from configured MCP servers. Claude CLI has accepted
    // both the server-level form and the wildcard form across releases; include
    // both so non-interactive `--print` runs can actually execute MCP calls
    // instead of stopping after emitting a tool_use that Jean cannot approve.
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(config) {
        if let Some(servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
            for server_name in servers.keys() {
                args.push("--allowedTools".to_string());
                args.push(format!("mcp__{server_name}"));
                args.push("--allowedTools".to_string());
                args.push(format!("mcp__{server_name}__*"));
            }
        }
    }
}

/// Execute Claude CLI in detached mode.
///
/// Spawns Claude CLI as a fully detached process that survives Jean quitting.
/// The process reads from an input file and writes to an output file.
/// Jean tails the output file for real-time updates.
#[allow(clippy::too_many_arguments)]
pub fn execute_claude_detached(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    input_file: &std::path::Path,
    output_file: &std::path::Path,
    working_dir: &std::path::Path,
    existing_claude_session_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    thinking_level: Option<&ThinkingLevel>,
    effort_level: Option<&EffortLevel>,
    allowed_tools: Option<&[String]>,
    parallel_execution_prompt: Option<&str>,
    ai_language: Option<&str>,
    mcp_config: Option<&str>,
    chrome_enabled: bool,
    custom_profile_name: Option<&str>,
    pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
) -> Result<(u32, ClaudeResponse), String> {
    use super::detached::spawn_detached_claude;
    use crate::claude_cli::resolve_cli_binary;

    log::trace!("Executing Claude CLI (detached) for session: {session_id}");
    log::trace!("Input file: {input_file:?}");
    log::trace!("Output file: {output_file:?}");
    log::trace!("Working directory: {working_dir:?}");

    // Get CLI path
    let cli_path = resolve_cli_binary(app);

    if !crate::platform::resolved_cli_exists(&cli_path) {
        let error_msg = format!(
            "Claude CLI not found at {}. Please complete setup in Settings > Advanced.",
            cli_path.display()
        );
        log::error!("{error_msg}");
        let error_event = ErrorEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            error: error_msg.clone(),
        };
        let _ = app.emit_all("chat:error", &error_event);
        return Err(error_msg);
    }

    // Build args
    let (args, env_vars) = build_claude_args(
        app,
        session_id,
        worktree_id,
        existing_claude_session_id,
        model,
        execution_mode,
        thinking_level,
        effort_level,
        allowed_tools,
        parallel_execution_prompt,
        ai_language,
        mcp_config,
        chrome_enabled,
        custom_profile_name,
    );

    // Log the full Claude CLI command for debugging
    log::debug!(
        "Claude CLI command: {} {}",
        cli_path.display(),
        args.join(" ")
    );
    if !env_vars.is_empty() {
        // Log env var keys only (not values, which may contain secrets)
        let env_keys: Vec<&str> = env_vars.iter().map(|(k, _)| k.as_str()).collect();
        log::debug!("Claude CLI env vars: {}", env_keys.join(", "));
    }

    // Convert env_vars to &str references for spawn_detached_claude
    let env_refs: Vec<(&str, &str)> = env_vars
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    // Spawn detached process
    let pid = spawn_detached_claude(
        &cli_path,
        &args,
        input_file,
        output_file,
        working_dir,
        &env_refs,
    )
    .map_err(|e| {
        let error_msg = format!("Failed to start Claude CLI: {e}");
        log::error!("{error_msg}");
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: error_msg.clone(),
            },
        );
        error_msg
    })?;

    log::trace!("Detached Claude CLI spawned with PID: {pid}");

    // Persist PID to metadata immediately (before tailing) for crash recovery
    if let Some(cb) = pid_callback {
        cb(pid);
    }

    // Register the process for cancellation (returns false if pending cancel exists)
    if !super::registry::register_detached_process(session_id.to_string(), pid) {
        // Process was killed by pending cancel — return cancelled response
        return Ok((
            pid,
            ClaudeResponse {
                content: String::new(),
                session_id: String::new(),
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: true,
                usage: None,
            },
        ));
    }

    // Tail the output file for real-time updates
    // Use match to ensure unregister_process is always called, even on error
    super::increment_tailer_count();
    let response = match tail_claude_output(app, session_id, worktree_id, output_file, pid) {
        Ok(resp) => {
            super::decrement_tailer_count();
            super::registry::unregister_process(session_id);
            resp
        }
        Err(e) => {
            super::decrement_tailer_count();
            super::registry::unregister_process(session_id);
            return Err(e);
        }
    };

    Ok((pid, response))
}

// =============================================================================
// File-based tailing for detached Claude CLI
// =============================================================================

/// Emit a (possibly coalesced) `chat:chunk` batch.
fn emit_chunk_batch(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &Option<String>,
    content: String,
) {
    let chunk = ChunkEvent {
        session_id: session_id.to_string(),
        worktree_id: worktree_id.to_string(),
        content,
        run_id: run_id.clone(),
    };
    if let Err(e) = app.emit_all("chat:chunk", &chunk) {
        log::error!("Failed to emit chunk: {e}");
    }
}

/// Flush buffered text deltas. Must run before any other event is emitted
/// for this session and before terminal events (done/cancel/error) so event
/// ordering and content integrity are preserved.
fn flush_pending_chunks(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &Option<String>,
    coalescer: &mut ChunkCoalescer,
) {
    if let Some(content) = coalescer.flush() {
        emit_chunk_batch(app, session_id, worktree_id, run_id, content);
    }
}

/// Tail an NDJSON output file and emit events as new lines appear.
///
/// This is used for detached Claude CLI processes where the CLI writes
/// directly to a file and Jean tails it for real-time updates.
///
/// Returns when:
/// - A "result" message is received (completion)
/// - The process is no longer running and no new output (timeout)
/// - An error occurs
pub fn tail_claude_output(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &std::path::Path,
    pid: u32,
) -> Result<ClaudeResponse, String> {
    use super::detached::is_process_alive;
    use super::tail::{next_poll_interval, NdjsonTailer};
    use std::time::{Duration, Instant};

    log::trace!("Starting to tail NDJSON output for session: {session_id}");
    log::trace!("Output file: {output_file:?}, PID: {pid}");
    let run_id = output_file
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.to_string());

    // Create tailer starting from beginning (we want all content)
    let mut tailer = NdjsonTailer::new_from_start(output_file)?;

    // Coalesce consecutive text blocks into fewer, larger chat:chunk events.
    // Flushed before any other event is emitted and after each drained batch.
    let mut chunk_coalescer = ChunkCoalescer::new();

    let mut full_content = String::new();
    let mut claude_session_id = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();
    let mut seen_tool_use_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut pending_stream_tools: std::collections::HashMap<usize, StreamToolUse> =
        std::collections::HashMap::new();
    let mut pending_stream_tool_inputs: std::collections::HashMap<usize, String> =
        std::collections::HashMap::new();
    let mut completed = false;
    let mut cancelled = false;
    let mut user_cancelled = false; // True only for explicit user cancel (not process death)
    let mut usage: Option<UsageData> = None;
    let mut error_lines: Vec<String> = Vec::new();

    // Track Monitor tool_use_ids that are currently armed along with their
    // arm-time and declared timeout_ms. Claude CLI keeps the stream open
    // (sending notifications) until all Monitors resolve; we only break on
    // "result" once this map is empty. We disarm either on process death,
    // user cancellation, or when wall-clock elapsed > timeout_ms + grace —
    // NEVER on arbitrary tool_result (which Monitor may emit multiple times,
    // once per event or once for start + once for end).
    struct MonitorArm {
        armed_at: Instant,
        timeout_ms: u64,
        /// Have we seen the first `result` turn AFTER arming?
        /// The first such turn is Claude's reply to the user's original
        /// request (goes to main chat). Subsequent turns while the Monitor
        /// is armed are per-notification wake-ups (route to tool_event).
        initial_turn_finished: bool,
        /// task_id assigned by CLI (from `system.task_started`), if seen.
        task_id: Option<String>,
    }
    let mut armed_monitors: std::collections::HashMap<String, MonitorArm> =
        std::collections::HashMap::new();
    let mut saw_final_result = false;

    // Optional raw-stream dump for diagnosing new event shapes (Monitor, etc.).
    // Enable with JEAN_DUMP_STREAM=1.
    let stream_dump_path = if std::env::var("JEAN_DUMP_STREAM").ok().as_deref() == Some("1") {
        app.path().app_data_dir().ok().map(|dir| {
            let p = dir.join("debug");
            let _ = std::fs::create_dir_all(&p);
            p.join(format!("stream-{session_id}.jsonl"))
        })
    } else {
        None
    };

    // Timeout configuration:
    // - Startup timeout: Wait up to 120 seconds for first Claude output (API connection time)
    // - Dead process timeout: After receiving output, wait 2 seconds for more if process seems dead
    //   (Reduced from 10s since registry check now provides faster cancellation detection)
    let startup_timeout = Duration::from_secs(120);
    let dead_process_timeout = Duration::from_secs(2);
    let started_at = Instant::now();
    let mut last_output_time = Instant::now();
    let mut received_claude_output = false; // Track if we've received any Claude output (not our metadata)

    loop {
        // Poll for new lines
        let lines = tailer.poll()?;
        let had_data = !lines.is_empty();

        if had_data {
            last_output_time = Instant::now();
        }

        for line in lines {
            // Skip empty lines
            if line.trim().is_empty() {
                continue;
            }

            // Skip metadata header (our own, not Claude output)
            if line.contains("\"_run_meta\"") {
                continue;
            }

            // We've received actual Claude output
            if !received_claude_output {
                log::trace!("Received first Claude output for session: {session_id}");
                received_claude_output = true;
            }

            // Optionally dump every raw line for offline analysis.
            if let Some(path) = stream_dump_path.as_ref() {
                use std::io::Write;
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                {
                    let _ = writeln!(f, "{line}");
                }
            }

            // Parse the JSON line
            let msg: serde_json::Value = match serde_json::from_str(&line) {
                Ok(m) => m,
                Err(e) => {
                    log::trace!("Failed to parse line as JSON: {e}");
                    let trimmed = line.trim().to_string();
                    if !trimmed.is_empty() {
                        error_lines.push(trimmed);
                    }
                    continue;
                }
            };

            // Capture session_id from any message that has it
            if let Some(sid) = msg.get("session_id").and_then(|v| v.as_str()) {
                if !sid.is_empty() {
                    claude_session_id = sid.to_string();
                }
            }

            // Track parent_tool_use_id for sub-agent tool calls
            // Must reset to None for root-level messages, otherwise parallel Tasks get wrong parent
            let current_parent_tool_use_id = msg
                .get("parent_tool_use_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

            // Non-assistant lines can emit non-chunk events or terminate the
            // stream — flush buffered text first to preserve event ordering.
            if msg_type != "assistant" {
                flush_pending_chunks(app, session_id, worktree_id, &run_id, &mut chunk_coalescer);
            }

            if msg_type == "stream_event" {
                if let Some(tool) = stream_event_tool_use(&msg) {
                    pending_stream_tool_inputs.remove(&tool.index);
                    pending_stream_tools.insert(tool.index, tool);
                    continue;
                }

                if let Some((index, partial_json)) = stream_event_input_delta(&msg) {
                    let Some(pending_tool) = pending_stream_tools.get(&index).cloned() else {
                        continue;
                    };

                    if seen_tool_use_ids.contains(&pending_tool.id) {
                        continue;
                    }

                    let input_buf = pending_stream_tool_inputs.entry(index).or_default();
                    input_buf.push_str(partial_json);

                    let input = if input_buf.trim().is_empty() {
                        pending_tool.input.clone()
                    } else {
                        match serde_json::from_str::<serde_json::Value>(input_buf) {
                            Ok(value) => value,
                            Err(_) => continue,
                        }
                    };

                    if pending_tool.name == "AskUserQuestion" || pending_tool.name == "ExitPlanMode"
                    {
                        let id = pending_tool.id.clone();
                        let name = pending_tool.name.clone();
                        seen_tool_use_ids.insert(id.clone());
                        tool_calls.push(ToolCall {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                            output: None,
                            parent_tool_use_id: current_parent_tool_use_id.clone(),
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: id.clone(),
                        });

                        let event = ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                            parent_tool_use_id: current_parent_tool_use_id.clone(),
                        };
                        if let Err(e) = app.emit_all("chat:tool_use", &event) {
                            log::error!("Failed to emit tool_use: {e}");
                        }

                        let block_event = ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: id,
                        };
                        if let Err(e) = app.emit_all("chat:tool_block", &block_event) {
                            log::error!("Failed to emit tool_block: {e}");
                        }

                        log::trace!(
                            "Detected blocking tool {name} from stream_event, killing detached process"
                        );
                        #[cfg(unix)]
                        unsafe {
                            libc::kill(pid as i32, libc::SIGKILL);
                        }
                        #[cfg(windows)]
                        {
                            let _ = crate::platform::silent_command("taskkill")
                                .args(["/F", "/PID", &pid.to_string()])
                                .output();
                        }

                        let done_event = DoneEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            waiting_for_plan: false,
                        };
                        if let Err(e) = app.emit_all("chat:done", &done_event) {
                            log::error!("Failed to emit done event: {e}");
                        }

                        return Ok(ClaudeResponse {
                            content: full_content,
                            session_id: claude_session_id,
                            tool_calls,
                            content_blocks,
                            cancelled: false,
                            usage: None,
                        });
                    }

                    continue;
                }
            }

            match msg_type {
                "assistant" => {
                    // Route assistant text to a Monitor's event log when this
                    // turn is a per-notification wake-up:
                    //   - at least one Monitor is armed
                    //   - its initial post-arm result has already fired (so
                    //     this is a *subsequent* turn, not Claude's reply to
                    //     the user's original Monitor-triggering request).
                    // Monitor wake-up turns don't carry parent_tool_use_id,
                    // so the window is bounded by initial_turn_finished on
                    // each armed Monitor.
                    let monitor_text_target: Option<String> = armed_monitors
                        .iter()
                        .find(|(_, arm)| arm.initial_turn_finished)
                        .map(|(id, _)| id.clone());

                    if let Some(message) = msg.get("message") {
                        if let Some(blocks) = message.get("content").and_then(|c| c.as_array()) {
                            for block in blocks {
                                let block_type =
                                    block.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                match block_type {
                                    "text" => {
                                        if let Some(text) =
                                            block.get("text").and_then(|v| v.as_str())
                                        {
                                            // Skip CLI placeholder text emitted when extended
                                            // thinking starts before any real text content
                                            if text == "(no content)"
                                                || is_claude_compaction_summary_text(text)
                                            {
                                                continue;
                                            }

                                            // Pick a Monitor target for routing any
                                            // Monitor-ish lines inside this text block.
                                            let monitor_target: Option<String> =
                                                monitor_text_target.clone().or_else(|| {
                                                    armed_monitors.keys().next().cloned()
                                                });

                                            // Walk lines: `[Monitor notification...]`
                                            // fragments are CLI-baked Monitor stdout
                                            // mixed into Claude's text — strip them out
                                            // of chat and route to the Monitor event log.
                                            // CLI emits multiple shapes: `[Monitor notification]`,
                                            // `[Monitor notification: <payload>]`, etc. Prefix
                                            // match without the closing bracket catches all.
                                            // Also route the whole block when this is a
                                            // pure wake-up turn (monitor_text_target).
                                            let now_ms = std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .map(|d| d.as_millis() as u64)
                                                .unwrap_or(0);
                                            let mut chat_buf = String::new();
                                            for raw_line in text.split_inclusive('\n') {
                                                let trimmed = raw_line.trim_end_matches('\n');
                                                let is_notification = trimmed
                                                    .trim_start()
                                                    .starts_with("[Monitor notification");
                                                let route_to_monitor = is_notification
                                                    || monitor_text_target.is_some();
                                                if route_to_monitor {
                                                    if !chat_buf.is_empty() {
                                                        full_content.push_str(&chat_buf);
                                                        content_blocks.push(ContentBlock::Text {
                                                            text: chat_buf.clone(),
                                                        });
                                                        if let Some(content) =
                                                            chunk_coalescer.push(&chat_buf)
                                                        {
                                                            emit_chunk_batch(
                                                                app,
                                                                session_id,
                                                                worktree_id,
                                                                &run_id,
                                                                content,
                                                            );
                                                        }
                                                        chat_buf.clear();
                                                    }
                                                    if let Some(ref mon_id) = monitor_target {
                                                        let line = trimmed.trim();
                                                        if !line.is_empty() {
                                                            // Monitor events must not overtake
                                                            // buffered text.
                                                            flush_pending_chunks(
                                                                app,
                                                                session_id,
                                                                worktree_id,
                                                                &run_id,
                                                                &mut chunk_coalescer,
                                                            );
                                                            let evt = ToolEventEvent {
                                                                session_id: session_id.to_string(),
                                                                worktree_id: worktree_id
                                                                    .to_string(),
                                                                tool_use_id: mon_id.clone(),
                                                                kind: "monitor_event".to_string(),
                                                                payload: serde_json::json!({
                                                                    "type": "text",
                                                                    "text": line,
                                                                }),
                                                                ts_ms: now_ms,
                                                            };
                                                            if let Err(e) = app
                                                                .emit_all("chat:tool_event", &evt)
                                                            {
                                                                log::error!(
                                                                    "Failed to emit tool_event (assistant-line): {e}"
                                                                );
                                                            }
                                                        }
                                                    }
                                                } else {
                                                    chat_buf.push_str(raw_line);
                                                }
                                            }
                                            if !chat_buf.is_empty() {
                                                full_content.push_str(&chat_buf);
                                                content_blocks.push(ContentBlock::Text {
                                                    text: chat_buf.clone(),
                                                });
                                                if let Some(content) =
                                                    chunk_coalescer.push(&chat_buf)
                                                {
                                                    emit_chunk_batch(
                                                        app,
                                                        session_id,
                                                        worktree_id,
                                                        &run_id,
                                                        content,
                                                    );
                                                }
                                            }
                                            continue;
                                        }
                                    }
                                    "tool_use" => {
                                        // Tool events must not overtake buffered text.
                                        flush_pending_chunks(
                                            app,
                                            session_id,
                                            worktree_id,
                                            &run_id,
                                            &mut chunk_coalescer,
                                        );

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

                                        if seen_tool_use_ids.contains(&id) {
                                            continue;
                                        }
                                        seen_tool_use_ids.insert(id.clone());

                                        tool_calls.push(ToolCall {
                                            id: id.clone(),
                                            name: name.clone(),
                                            input: input.clone(),
                                            output: None,
                                            parent_tool_use_id: current_parent_tool_use_id.clone(),
                                        });

                                        content_blocks.push(ContentBlock::ToolUse {
                                            tool_call_id: id.clone(),
                                        });

                                        // Emit tool_use event
                                        let event = ToolUseEvent {
                                            session_id: session_id.to_string(),
                                            worktree_id: worktree_id.to_string(),
                                            id: id.clone(),
                                            name: name.clone(),
                                            input: input.clone(),
                                            parent_tool_use_id: current_parent_tool_use_id.clone(),
                                        };
                                        if let Err(e) = app.emit_all("chat:tool_use", &event) {
                                            log::error!("Failed to emit tool_use: {e}");
                                        }

                                        // Track armed Monitors so we don't close the
                                        // stream on the first "result" message.
                                        if name == "Monitor" {
                                            let timeout_ms = input
                                                .get("timeout_ms")
                                                .and_then(|v| v.as_u64())
                                                .unwrap_or(60_000);
                                            armed_monitors.insert(
                                                id.clone(),
                                                MonitorArm {
                                                    armed_at: Instant::now(),
                                                    timeout_ms,
                                                    initial_turn_finished: false,
                                                    task_id: None,
                                                },
                                            );
                                            let now_ms = std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .map(|d| d.as_millis() as u64)
                                                .unwrap_or(0);
                                            let event = ToolEventEvent {
                                                session_id: session_id.to_string(),
                                                worktree_id: worktree_id.to_string(),
                                                tool_use_id: id.clone(),
                                                kind: "monitor_status".to_string(),
                                                payload: serde_json::json!({
                                                    "status": "armed",
                                                    "input": input,
                                                }),
                                                ts_ms: now_ms,
                                            };
                                            if let Err(e) = app.emit_all("chat:tool_event", &event)
                                            {
                                                log::error!(
                                                    "Failed to emit tool_event (armed): {e}"
                                                );
                                            }
                                        }

                                        // Register ScheduleWakeup so the stored prompt
                                        // fires back into this session after delaySeconds.
                                        if name == "ScheduleWakeup" {
                                            if let Err(e) = super::wakeup::schedule_from_tool_input(
                                                app,
                                                session_id,
                                                worktree_id,
                                                &id,
                                                &input,
                                            ) {
                                                log::error!(
                                                    "ScheduleWakeup schedule failed (session={session_id}): {e}"
                                                );
                                            }
                                        }

                                        // Emit tool_block event
                                        let block_event = ToolBlockEvent {
                                            session_id: session_id.to_string(),
                                            worktree_id: worktree_id.to_string(),
                                            tool_call_id: id.clone(),
                                        };
                                        if let Err(e) =
                                            app.emit_all("chat:tool_block", &block_event)
                                        {
                                            log::error!("Failed to emit tool_block: {e}");
                                        }

                                        // Check for blocking tools - kill process and return
                                        if name == "AskUserQuestion" || name == "ExitPlanMode" {
                                            log::trace!("Detected blocking tool {name}, killing detached process");

                                            // Kill the detached process
                                            #[cfg(unix)]
                                            unsafe {
                                                libc::kill(pid as i32, libc::SIGKILL);
                                            }
                                            #[cfg(windows)]
                                            {
                                                let _ = crate::platform::silent_command("taskkill")
                                                    .args(["/F", "/PID", &pid.to_string()])
                                                    .output();
                                            }

                                            // Emit done event so frontend knows streaming is complete
                                            let done_event = DoneEvent {
                                                session_id: session_id.to_string(),
                                                worktree_id: worktree_id.to_string(),
                                                waiting_for_plan: false,
                                            };
                                            if let Err(e) = app.emit_all("chat:done", &done_event) {
                                                log::error!("Failed to emit done event: {e}");
                                            }

                                            // Return partial response (blocking tool is already in tool_calls)
                                            return Ok(ClaudeResponse {
                                                content: full_content,
                                                session_id: claude_session_id,
                                                tool_calls,
                                                content_blocks,
                                                cancelled: false,
                                                usage: None, // No usage for partial responses
                                            });
                                        }
                                    }
                                    "thinking" => {
                                        if let Some(thinking) =
                                            block.get("thinking").and_then(|v| v.as_str())
                                        {
                                            // Thinking events must not overtake buffered text.
                                            flush_pending_chunks(
                                                app,
                                                session_id,
                                                worktree_id,
                                                &run_id,
                                                &mut chunk_coalescer,
                                            );
                                            content_blocks.push(ContentBlock::Thinking {
                                                thinking: thinking.to_string(),
                                            });

                                            let event = ThinkingEvent {
                                                session_id: session_id.to_string(),
                                                worktree_id: worktree_id.to_string(),
                                                content: thinking.to_string(),
                                            };
                                            if let Err(e) = app.emit_all("chat:thinking", &event) {
                                                log::error!("Failed to emit thinking: {e}");
                                            }
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

                                // While Monitors are armed, forward *any* non-tool_result
                                // user-block as a live monitor_event. Monitor notifications
                                // may arrive as plain text blocks, system-reminder blocks,
                                // or other shapes without an explicit tool_use_id reference
                                // — so we broadcast to whichever Monitor(s) are armed.
                                if !armed_monitors.is_empty() && block_type != "tool_result" {
                                    let referenced_id = block
                                        .get("tool_use_id")
                                        .and_then(|v| v.as_str())
                                        .filter(|s| armed_monitors.contains_key(*s))
                                        .map(|s| s.to_string());
                                    let targets: Vec<String> = match referenced_id {
                                        Some(id) => vec![id],
                                        None => armed_monitors.keys().cloned().collect(),
                                    };
                                    let now_ms = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_millis() as u64)
                                        .unwrap_or(0);
                                    for target in targets {
                                        let evt = ToolEventEvent {
                                            session_id: session_id.to_string(),
                                            worktree_id: worktree_id.to_string(),
                                            tool_use_id: target,
                                            kind: "monitor_event".to_string(),
                                            payload: block.clone(),
                                            ts_ms: now_ms,
                                        };
                                        if let Err(e) = app.emit_all("chat:tool_event", &evt) {
                                            log::error!(
                                                "Failed to emit tool_event (user-block): {e}"
                                            );
                                        }
                                    }
                                    // Drop out of block loop — don't fall through to
                                    // tool_result handler (wrong branch) or let this
                                    // leak as chat content elsewhere.
                                    continue;
                                }

                                if block_type == "tool_result" {
                                    let tool_id = block
                                        .get("tool_use_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    // For armed Monitors, *also* forward tool_result
                                    // content as a live monitor_event so each delivery
                                    // surfaces immediately — Monitor may emit many
                                    // tool_results (one per notification) before the
                                    // tool truly ends. We do NOT disarm here; disarm
                                    // is driven by timeout_ms / cancel / process death.
                                    if armed_monitors.contains_key(tool_id) {
                                        let now_ms = std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .map(|d| d.as_millis() as u64)
                                            .unwrap_or(0);
                                        let evt = ToolEventEvent {
                                            session_id: session_id.to_string(),
                                            worktree_id: worktree_id.to_string(),
                                            tool_use_id: tool_id.to_string(),
                                            kind: "monitor_event".to_string(),
                                            payload: block.clone(),
                                            ts_ms: now_ms,
                                        };
                                        if let Err(e) = app.emit_all("chat:tool_event", &evt) {
                                            log::error!(
                                                "Failed to emit tool_event (tool_result): {e}"
                                            );
                                        }
                                        // Skip regular tool_result emit for armed
                                        // Monitors — the event log already shows it;
                                        // mirroring to .output would render it twice.
                                        continue;
                                    }
                                    // Content can be a string OR an array of content blocks
                                    // (Task/Agent subagent reports use the array shape).
                                    let output = block
                                        .get("content")
                                        .map(tool_result_content_to_string)
                                        .unwrap_or_default();

                                    // Update matching tool call's output
                                    if let Some(tc) =
                                        tool_calls.iter_mut().find(|t| t.id == tool_id)
                                    {
                                        tc.output = Some(output.clone());
                                    }

                                    // Emit tool_result event
                                    let event = ToolResultEvent {
                                        session_id: session_id.to_string(),
                                        worktree_id: worktree_id.to_string(),
                                        tool_use_id: tool_id.to_string(),
                                        output,
                                    };
                                    if let Err(e) = app.emit_all("chat:tool_result", &event) {
                                        log::error!("Failed to emit tool_result: {e}");
                                    }
                                }
                            }
                        }
                    }
                }
                "result" => {
                    // Final result - Claude CLI completed
                    if full_content.is_empty() {
                        if let Some(result) = msg.get("result").and_then(|v| v.as_str()) {
                            full_content = result.to_string();
                        }
                    }

                    // Extract token usage data
                    if let Some(usage_obj) = msg.get("usage") {
                        usage = Some(UsageData {
                            input_tokens: usage_obj
                                .get("input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0),
                            output_tokens: usage_obj
                                .get("output_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0),
                            cache_read_input_tokens: usage_obj
                                .get("cache_read_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0),
                            cache_creation_input_tokens: usage_obj
                                .get("cache_creation_input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0),
                        });
                        log::trace!(
                            "Token usage: input={}, output={}, cache_read={}, cache_create={}",
                            usage.as_ref().map(|u| u.input_tokens).unwrap_or(0),
                            usage.as_ref().map(|u| u.output_tokens).unwrap_or(0),
                            usage
                                .as_ref()
                                .map(|u| u.cache_read_input_tokens)
                                .unwrap_or(0),
                            usage
                                .as_ref()
                                .map(|u| u.cache_creation_input_tokens)
                                .unwrap_or(0),
                        );
                    }

                    // Check for permission denials and emit event
                    if let Some(denials) = msg.get("permission_denials").and_then(|v| v.as_array())
                    {
                        if !denials.is_empty() {
                            let denial_events: Vec<PermissionDenial> = denials
                                .iter()
                                .filter_map(|d| {
                                    let tool_name = d.get("tool_name")?.as_str()?;
                                    let tool_input = d.get("tool_input")?;

                                    // Skip plan file cleanup denials (benign Claude housekeeping)
                                    if tool_name == "Bash" {
                                        if let Some(cmd) =
                                            tool_input.get("command").and_then(|c| c.as_str())
                                        {
                                            if cmd.contains(".claude/plans/")
                                                && cmd.starts_with("rm ")
                                            {
                                                log::trace!(
                                                    "Ignoring plan cleanup denial: {}",
                                                    cmd
                                                );
                                                return None;
                                            }
                                        }
                                    }

                                    Some(PermissionDenial {
                                        tool_name: tool_name.to_string(),
                                        tool_use_id: d.get("tool_use_id")?.as_str()?.to_string(),
                                        tool_input: tool_input.clone(),
                                        rpc_id: None,
                                    })
                                })
                                .collect();

                            if !denial_events.is_empty() {
                                log::trace!(
                                    "Emitting permission_denied event with {} denials",
                                    denial_events.len()
                                );
                                let event = PermissionDeniedEvent {
                                    session_id: session_id.to_string(),
                                    worktree_id: worktree_id.to_string(),
                                    denials: denial_events,
                                };
                                if let Err(e) = app.emit_all("chat:permission_denied", &event) {
                                    log::error!("Failed to emit permission_denied: {e}");
                                }
                            }
                        }
                    }

                    saw_final_result = true;
                    // For each armed Monitor, flip initial_turn_finished so
                    // subsequent assistant text is routed to that Monitor's
                    // event log (per-notification wake-up turns).
                    for arm in armed_monitors.values_mut() {
                        arm.initial_turn_finished = true;
                    }
                    if armed_monitors.is_empty() {
                        completed = true;
                        log::trace!("Received result message - Claude CLI completed");
                    } else {
                        log::trace!(
                            "Received result message but {} Monitor(s) still armed; keeping stream open",
                            armed_monitors.len()
                        );
                    }
                }
                "system" => {
                    let subtype = msg.get("subtype").and_then(|v| v.as_str()).unwrap_or("");

                    // Monitor lifecycle events from Claude CLI:
                    //   task_started      → arms confirmed, carries task_id
                    //   task_updated      → status patch (queued/running/completed)
                    //   task_notification → per-notification summary / end-of-stream
                    if matches!(
                        subtype,
                        "task_started" | "task_updated" | "task_notification"
                    ) {
                        // task_started / task_notification carry tool_use_id directly;
                        // task_updated carries task_id only, so map via task_id.
                        let direct_tool_id = msg
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .filter(|s| armed_monitors.contains_key(*s))
                            .map(|s| s.to_string());
                        let via_task_id =
                            msg.get("task_id").and_then(|v| v.as_str()).and_then(|tid| {
                                armed_monitors
                                    .iter()
                                    .find(|(_, a)| a.task_id.as_deref() == Some(tid))
                                    .map(|(id, _)| id.clone())
                            });
                        let target_tool_id = direct_tool_id.or(via_task_id);

                        if let Some(tool_id) = target_tool_id {
                            // Record task_id on the first task_started.
                            if subtype == "task_started" {
                                if let Some(tid) = msg.get("task_id").and_then(|v| v.as_str()) {
                                    if let Some(arm) = armed_monitors.get_mut(&tool_id) {
                                        arm.task_id = Some(tid.to_string());
                                    }
                                }
                            }

                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);

                            let status_val =
                                msg.get("status").and_then(|v| v.as_str()).or_else(|| {
                                    msg.get("patch")
                                        .and_then(|p| p.get("status"))
                                        .and_then(|v| v.as_str())
                                });
                            let is_final = subtype == "task_notification"
                                && matches!(
                                    status_val,
                                    Some("completed") | Some("error") | Some("timeout")
                                );

                            let kind = if is_final {
                                "monitor_done"
                            } else if subtype == "task_started" {
                                "monitor_status"
                            } else {
                                "monitor_event"
                            };

                            let evt = ToolEventEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id.clone(),
                                kind: kind.to_string(),
                                payload: msg.clone(),
                                ts_ms: now_ms,
                            };
                            if let Err(e) = app.emit_all("chat:tool_event", &evt) {
                                log::error!("Failed to emit tool_event (system): {e}");
                            }

                            if is_final {
                                armed_monitors.remove(&tool_id);
                                if saw_final_result && armed_monitors.is_empty() {
                                    completed = true;
                                }
                            }
                        }
                        // Fall through to skip the compact_boundary branch.
                    } else if subtype == "compact_boundary" {
                        log::trace!("Detected compact_boundary system message");

                        // Signal UI that compaction is in progress
                        let compacting_event = CompactingEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                        };
                        if let Err(e) = app.emit_all("chat:compacting", &compacting_event) {
                            log::error!("Failed to emit compacting: {e}");
                        }

                        // Emit compacted event with metadata if available
                        if let Some(metadata) = compact_metadata_from_system_message(&msg) {
                            let compacted_event = CompactedEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                metadata,
                            };
                            if let Err(e) = app.emit_all("chat:compacted", &compacted_event) {
                                log::error!("Failed to emit compacted: {e}");
                            }
                        }
                    }
                }
                _ => {
                    // Unknown msg_type. Only forward if it explicitly references an
                    // armed Monitor by tool_use_id — avoids flooding the UI with
                    // unrelated partial-message / stream_event deltas.
                    if !armed_monitors.is_empty() {
                        let referenced_id = msg
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .or_else(|| {
                                msg.get("message")
                                    .and_then(|m| m.get("tool_use_id"))
                                    .and_then(|v| v.as_str())
                            })
                            .filter(|s| armed_monitors.contains_key(*s))
                            .map(|s| s.to_string());
                        if let Some(target) = referenced_id {
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            let evt = ToolEventEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: target,
                                kind: "monitor_event".to_string(),
                                payload: msg.clone(),
                                ts_ms: now_ms,
                            };
                            if let Err(e) = app.emit_all("chat:tool_event", &evt) {
                                log::error!("Failed to emit tool_event (unknown): {e}");
                            }
                        } else {
                            log::trace!(
                                "Unknown msg_type '{msg_type}' while Monitors armed (no id ref)"
                            );
                        }
                    }
                }
            }
        }

        // Batch drained — flush buffered text before the monitor sweep,
        // completion checks, and sleep so text is not held while idle.
        flush_pending_chunks(app, session_id, worktree_id, &run_id, &mut chunk_coalescer);

        // Disarm Monitors whose declared timeout (+5s grace) has elapsed.
        if !armed_monitors.is_empty() {
            let now = Instant::now();
            let expired: Vec<String> = armed_monitors
                .iter()
                .filter(|(_, arm)| {
                    now.saturating_duration_since(arm.armed_at)
                        > Duration::from_millis(arm.timeout_ms.saturating_add(5_000))
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in expired {
                armed_monitors.remove(&id);
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let evt = ToolEventEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    tool_use_id: id,
                    kind: "monitor_done".to_string(),
                    payload: serde_json::json!({ "status": "timeout" }),
                    ts_ms: now_ms,
                };
                if let Err(e) = app.emit_all("chat:tool_event", &evt) {
                    log::error!("Failed to emit tool_event (timeout): {e}");
                }
            }
            if saw_final_result && armed_monitors.is_empty() {
                completed = true;
            }
        }

        // Check if completed
        if completed {
            break;
        }

        // Check if externally cancelled (process removed from registry by cancel_process)
        // This allows the tailer to exit quickly when user cancels, instead of waiting
        // for the dead_process_timeout
        if !super::registry::is_process_running(session_id) {
            log::trace!("Session {session_id} cancelled externally, stopping tail");
            user_cancelled = true;
            cancelled = true;
            break;
        }

        // Timeout logic depends on whether we've received Claude output yet
        let process_alive = is_process_alive(pid);

        if received_claude_output {
            // After receiving output, use shorter timeout for detecting dead process
            if !process_alive && last_output_time.elapsed() > dead_process_timeout {
                log::trace!(
                    "Process {pid} is no longer running and no new output after receiving content"
                );
                cancelled = true;
                break;
            }
        } else {
            // During startup, wait longer but check for complete failure
            let elapsed = started_at.elapsed();

            // Early exit if process died during startup (5s grace for slow spawning)
            if !process_alive && elapsed > Duration::from_secs(5) {
                log::warn!(
                    "Process {pid} died during startup after {:.1}s with no Claude output",
                    elapsed.as_secs_f64()
                );
                cancelled = true;
                break;
            }

            if elapsed > startup_timeout {
                log::warn!(
                    "Startup timeout ({:?}) exceeded waiting for Claude output, process_alive: {process_alive}",
                    startup_timeout
                );
                cancelled = true;
                break;
            }

            // Log progress every 10 seconds during startup (only log once per 10-second mark)
            // Use subsec_millis to only log in the first 100ms of each 10-second window
            let secs = elapsed.as_secs();
            if secs > 0 && secs % 10 == 0 && elapsed.subsec_millis() < 100 {
                log::trace!(
                    "Waiting for Claude output... {secs}s elapsed, process_alive: {process_alive}"
                );
            }
        }

        // Adaptive sleep: poll fast (5ms) while data flows to reduce
        // per-event latency, 50ms when briefly idle, and back off to 250ms
        // after a sustained quiet period (e.g. long thinking phases).
        std::thread::sleep(next_poll_interval(had_data, last_output_time.elapsed()));
    }

    // Flush any text still buffered when the loop exited before the
    // terminal events below (defensive: every break follows a batch flush).
    flush_pending_chunks(app, session_id, worktree_id, &run_id, &mut chunk_coalescer);

    // Drain any still-armed Monitors (process died / user cancel / completed)
    // so the UI flips their status pill away from "armed".
    if !armed_monitors.is_empty() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let final_kind = if user_cancelled || cancelled {
            "error"
        } else {
            "done"
        };
        for (id, _) in armed_monitors.drain() {
            let evt = ToolEventEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                tool_use_id: id,
                kind: "monitor_done".to_string(),
                payload: serde_json::json!({ "status": final_kind }),
                ts_ms: now_ms,
            };
            if let Err(e) = app.emit_all("chat:tool_event", &evt) {
                log::error!("Failed to emit tool_event (drain): {e}");
            }
        }
    }

    // Surface CLI errors when process failed with no meaningful output
    if cancelled || (full_content.is_empty() && !received_claude_output) {
        // Drain any remaining buffered content from the output file
        if let Ok(remaining) = tailer.poll() {
            for line in remaining {
                let trimmed = line.trim();
                if !trimmed.is_empty()
                    && !trimmed.contains("\"_run_meta\"")
                    && serde_json::from_str::<serde_json::Value>(trimmed).is_err()
                {
                    error_lines.push(trimmed.to_string());
                }
            }
        }
        let drained = tailer.drain_buffer();
        if !drained.trim().is_empty() {
            error_lines.push(drained.trim().to_string());
        }
    }

    if !error_lines.is_empty() && full_content.is_empty() {
        let error_text = error_lines.join("\n");
        log::warn!("CLI error output for session {session_id}: {error_text}");
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: format!("Claude CLI failed: {error_text}"),
            },
        );
    }

    // Emit done event unless the user explicitly cancelled (cancel_process
    // already emitted chat:cancelled in that case, avoid double event).
    // When the process died naturally (not user cancel) but produced content,
    // we still emit chat:done so the frontend properly transitions from
    // streaming to persisted state (#209).
    if !user_cancelled {
        let done_event = DoneEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            waiting_for_plan: false,
        };
        if let Err(e) = app.emit_all("chat:done", &done_event) {
            log::error!("Failed to emit done event: {e}");
        }
    }

    log::trace!(
        "Tailing complete: {} chars, {} tool calls, cancelled: {cancelled}",
        full_content.len(),
        tool_calls.len()
    );

    Ok(ClaudeResponse {
        content: full_content,
        session_id: claude_session_id,
        tool_calls,
        content_blocks,
        cancelled,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_metadata_accepts_snake_case_from_claude_cli() {
        let msg = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary",
            "compact_metadata": {
                "trigger": "auto",
                "pre_tokens": 170298
            }
        });

        let metadata = compact_metadata_from_system_message(&msg).unwrap();

        assert_eq!(metadata.trigger, "auto");
        assert_eq!(metadata.pre_tokens, 170298);
    }

    #[test]
    fn split_fast_model_strips_suffix() {
        assert_eq!(split_fast_model("opus-fast"), ("opus", true));
        assert_eq!(
            split_fast_model("claude-opus-4-6[1m]-fast"),
            ("claude-opus-4-6[1m]", true)
        );
    }

    #[test]
    fn split_fast_model_passes_through_normal_models() {
        assert_eq!(split_fast_model("opus"), ("opus", false));
        assert_eq!(
            split_fast_model("claude-opus-4-6[1m]"),
            ("claude-opus-4-6[1m]", false)
        );
        assert_eq!(split_fast_model("sonnet"), ("sonnet", false));
        assert_eq!(split_fast_model("haiku"), ("haiku", false));
        assert_eq!(
            split_fast_model("claude-fable-5"),
            ("claude-fable-5", false)
        );
    }

    #[test]
    fn custom_profile_env_vars_reads_string_env_entries() {
        let settings = r#"{
            "env": {
                "ANTHROPIC_BASE_URL": "https://api.minimax.io/anthropic",
                "ANTHROPIC_AUTH_TOKEN": "secret",
                "IGNORED_NON_STRING": 123
            }
        }"#;

        let env_vars = custom_profile_env_vars_from_settings(settings).unwrap();

        assert!(env_vars.contains(&(
            "ANTHROPIC_BASE_URL".to_string(),
            "https://api.minimax.io/anthropic".to_string()
        )));
        assert!(env_vars.contains(&("ANTHROPIC_AUTH_TOKEN".to_string(), "secret".to_string())));
        assert!(!env_vars.iter().any(|(key, _)| key == "IGNORED_NON_STRING"));
    }

    #[test]
    fn default_global_system_prompt_prefers_interactive_plan_questions() {
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("backend-native interactive question UI"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("Claude AskUserQuestion"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("Codex request_user_input"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT
            .contains("when the current execution mode is plan: do not write plan files or code"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("<proposed_plan>"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("Every Codex response that contains or revises a plan while the current execution mode is plan"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("OpenCode question"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("Jean Worktree Policy"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("Do NOT create git worktrees manually"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("Jean MCP/tools"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("VERY IMPORTANT: Keep Code Simple"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT
            .contains("Always implement the simplest maintainable solution"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("Clickable References"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("include clickable links when available"));
    }

    #[test]
    fn default_global_system_prompt_requires_github_discovery_after_changes() {
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT.contains("GitHub Issue and Discussion Discovery"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT
            .contains("search the current repository's existing GitHub issues and discussions"));
        assert!(DEFAULT_GLOBAL_SYSTEM_PROMPT
            .contains("Include the results in both the main response and the `## Recap`"));
    }

    #[test]
    fn extracts_tool_use_from_stream_event_content_block_start() {
        let msg = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 2,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_question",
                    "name": "AskUserQuestion",
                    "input": {
                        "questions": "[{\"question\":\"Pick one\",\"options\":[{\"label\":\"A\"}]}]"
                    }
                }
            }
        });

        let tool = stream_event_tool_use(&msg).expect("tool_use should be extracted");

        assert_eq!(tool.id, "toolu_question");
        assert_eq!(tool.name, "AskUserQuestion");
        assert_eq!(
            tool.input.get("questions").and_then(|value| value.as_str()),
            Some("[{\"question\":\"Pick one\",\"options\":[{\"label\":\"A\"}]}]")
        );
    }

    #[test]
    fn extracts_stream_event_input_json_delta() {
        let msg = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 2,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": "{\"questions\":"
                }
            }
        });

        assert_eq!(stream_event_input_delta(&msg), Some((2, "{\"questions\":")));
    }

    #[test]
    fn mcp_config_auto_allows_server_and_wildcard_tools() {
        let config = r#"{
            "mcpServers": {
                "jean-dev": { "type": "stdio", "command": "jean" },
                "github": { "type": "stdio", "command": "github-mcp" }
            }
        }"#;
        let mut args = Vec::new();

        append_mcp_config_args(&mut args, Some(config));

        assert!(args.contains(&"--mcp-config".to_string()));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(args.contains(&"mcp__jean-dev".to_string()));
        assert!(args.contains(&"mcp__jean-dev__*".to_string()));
        assert!(args.contains(&"mcp__github".to_string()));
        assert!(args.contains(&"mcp__github__*".to_string()));
    }
}
