use tauri::Manager;

use super::types::{
    CompactMetadata, ContentBlock, EffortLevel, PermissionDenial, PermissionDeniedEvent,
    ThinkingLevel, ToolCall, UsageData,
};
use crate::http_server::EmitExt;
use crate::projects::github_issues::{
    get_github_contexts_dir, get_session_issue_refs, get_session_pr_refs,
};
use crate::projects::linear_issues::get_session_linear_refs;
use crate::projects::storage::load_projects_data;

// =============================================================================
// Constants
// =============================================================================

/// Default global system prompt (must match DEFAULT_GLOBAL_SYSTEM_PROMPT in preferences.ts)
const DEFAULT_GLOBAL_SYSTEM_PROMPT: &str = "\
### 1. Plan Mode Default\n\
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)\n\
- If something goes sideways, STOP and re-plan immediately - don't keep pushing\n\
- Use plan mode for verification steps, not just building\n\
- Write detailed specs upfront to reduce ambiguity\n\
- Make the plan extremely concise. Sacrifice grammar for the sake of concision.\n\
- At the end of each plan, give me a list of unresolved questions to answer, if any.\n\
\n\
### 2. Subagent Strategy to keep main context window clean\n\
- Offload research, exploration, and parallel analysis to subagents\n\
- For complex problems, throw more compute at it via subagents\n\
- One task per subagent for focused execution\n\
\n\
### 3. Self-Improvement Loop\n\
- After ANY correction from the user: update '.ai/lessons.md' with the pattern\n\
- Write rules for yourself that prevent the same mistake\n\
- Ruthlessly iterate on these lessons until mistake rate drops\n\
- Review lessons at session start for relevant project\n\
\n\
### 4. Verification Before Done\n\
- Never mark a task complete without proving it works\n\
- Diff behavior between main and your changes when relevant\n\
- Ask yourself: \"Would a staff engineer approve this?\"\n\
- Run tests, check logs, demonstrate correctness\n\
\n\
### 5. Demand Elegance (Balanced)\n\
- For non-trivial changes: pause and ask \"is there a more elegant way?\"\n\
- If a fix feels hacky: \"Knowing everything I know now, implement the elegant solution\"\n\
- Skip this for simple, obvious fixes - don't over-engineer\n\
- Challenge your own work before presenting it\n\
\n\
### 6. Autonomous Bug Fixing\n\
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
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.\n\
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.\n\
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
             ExitPlanMode.",
        ),
        "yolo" => Some(
            "You are in YOLO EXECUTION MODE. Start implementing immediately. \
             Do NOT enter plan mode and do NOT use ExitPlanMode unless the user explicitly asks \
             for a new plan. Do not ask for confirmation before routine implementation steps. \
             If a required decision is missing, use AskUserQuestion instead of ExitPlanMode.",
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

    // Model
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m.to_string());
    }

    // Permission mode
    let perm_mode = match execution_mode.unwrap_or("plan") {
        "build" => "acceptEdits",
        "yolo" => "bypassPermissions",
        _ => "plan",
    };
    args.push("--permission-mode".to_string());
    args.push(perm_mode.to_string());

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
        // Traditional thinking levels (Opus 4.5, Sonnet, Haiku)
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

    // Allow embedded CLI binaries without approval via --allowedTools
    // Claude wraps paths with spaces in quotes, so the actual command is:
    // "/Users/.../Application Support/.../gh-cli/gh" --version
    // Use *gh-cli/gh* to match regardless of quoting
    args.push("--allowedTools".to_string());
    args.push("Bash(*gh-cli/gh*)".to_string());
    args.push("--allowedTools".to_string());
    args.push("Bash(*claude-cli/claude*)".to_string());

    // MCP server configuration
    if let Some(config) = mcp_config {
        if !config.is_empty() {
            args.push("--mcp-config".to_string());
            args.push(config.to_string());
            args.push("--strict-mcp-config".to_string());

            // Auto-allow all tools from configured MCP servers
            // Pattern "mcp__<name>" matches all tools from that server
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(config) {
                if let Some(servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                    for server_name in servers.keys() {
                        args.push("--allowedTools".to_string());
                        args.push(format!("mcp__{server_name}"));
                    }
                }
            }
        }
    }

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

    // Explicit mode override for Claude so build/yolo do not fall back into plan mode
    // due to the default global prompt.
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

    // Per-project custom system prompt
    if let Ok(data) = load_projects_data(app) {
        if let Some(worktree) = data.find_worktree(worktree_id) {
            if let Some(project) = data.find_project(&worktree.project_id) {
                if let Some(prompt) = &project.custom_system_prompt {
                    let prompt = prompt.trim();
                    if !prompt.is_empty() {
                        system_prompt_parts.push(prompt.to_string());
                    }
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

                if issue_count > 0 || pr_count > 0 || linear_count > 0 || saved_context_count > 0 {
                    combined_content.push_str("**Summary:**\n");
                    if issue_count > 0 {
                        combined_content.push_str(&format!("- {} GitHub Issue(s)\n", issue_count));
                    }
                    if pr_count > 0 {
                        combined_content
                            .push_str(&format!("- {} GitHub Pull Request(s)\n", pr_count));
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

    if !cli_path.exists() {
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
    if !super::registry::register_process(session_id.to_string(), pid) {
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
    use super::tail::{NdjsonTailer, POLL_INTERVAL, POLL_INTERVAL_FAST};
    use std::time::{Duration, Instant};

    log::trace!("Starting to tail NDJSON output for session: {session_id}");
    log::trace!("Output file: {output_file:?}, PID: {pid}");

    // Create tailer starting from beginning (we want all content)
    let mut tailer = NdjsonTailer::new_from_start(output_file)?;

    let mut full_content = String::new();
    let mut claude_session_id = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();
    let mut completed = false;
    let mut cancelled = false;
    let mut usage: Option<UsageData> = None;
    let mut error_lines: Vec<String> = Vec::new();

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

            match msg_type {
                "assistant" => {
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
                                            if text == "(no content)" {
                                                continue;
                                            }
                                            full_content.push_str(text);
                                            content_blocks.push(ContentBlock::Text {
                                                text: text.to_string(),
                                            });

                                            // Emit chunk event
                                            let event = ChunkEvent {
                                                session_id: session_id.to_string(),
                                                worktree_id: worktree_id.to_string(),
                                                content: text.to_string(),
                                            };
                                            if let Err(e) = app.emit_all("chat:chunk", &event) {
                                                log::error!("Failed to emit chunk: {e}");
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

                                if block_type == "tool_result" {
                                    let tool_id = block
                                        .get("tool_use_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    // Content can be a string OR an array of content blocks
                                    let output = block
                                        .get("content")
                                        .map(|v| {
                                            if let Some(s) = v.as_str() {
                                                s.to_string()
                                            } else if let Some(arr) = v.as_array() {
                                                arr.iter()
                                                    .filter_map(|item| {
                                                        if item.get("type").and_then(|t| t.as_str())
                                                            == Some("text")
                                                        {
                                                            item.get("text")
                                                                .and_then(|t| t.as_str())
                                                                .map(|s| s.to_string())
                                                        } else {
                                                            None
                                                        }
                                                    })
                                                    .collect::<Vec<_>>()
                                                    .join("\n")
                                            } else {
                                                String::new()
                                            }
                                        })
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

                    completed = true;
                    log::trace!("Received result message - Claude CLI completed");
                }
                "system" => {
                    let subtype = msg.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                    if subtype == "compact_boundary" {
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
                        if let Some(metadata_val) = msg.get("compactMetadata") {
                            if let Ok(metadata) =
                                serde_json::from_value::<CompactMetadata>(metadata_val.clone())
                            {
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
                }
                _ => {}
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

        // Adaptive sleep: poll faster when actively receiving data (5ms)
        // to reduce per-event latency, back off to 50ms when idle.
        std::thread::sleep(if had_data {
            POLL_INTERVAL_FAST
        } else {
            POLL_INTERVAL
        });
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

    // Emit done event only if not cancelled
    // (cancel_process already emitted chat:cancelled, avoid double event)
    if !cancelled {
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
