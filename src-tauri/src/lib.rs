use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

mod background_tasks;
mod chat;
mod claude_cli;
mod codex_cli;
mod gh_cli;
pub mod http_server;
mod opencode_cli;
mod opencode_server;
mod platform;
mod projects;
mod terminal;

// Validation functions
fn validate_filename(filename: &str) -> Result<(), String> {
    // Regex pattern: only alphanumeric, dash, underscore, dot
    let filename_pattern = Regex::new(r"^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$")
        .map_err(|e| format!("Regex compilation error: {e}"))?;

    if filename.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }

    if filename.len() > 100 {
        return Err("Filename too long (max 100 characters)".to_string());
    }

    if !filename_pattern.is_match(filename) {
        return Err(
            "Invalid filename: only alphanumeric characters, dashes, underscores, and dots allowed"
                .to_string(),
        );
    }

    Ok(())
}

fn validate_string_input(input: &str, max_len: usize, field_name: &str) -> Result<(), String> {
    if input.len() > max_len {
        return Err(format!("{field_name} too long (max {max_len} characters)"));
    }
    Ok(())
}

fn validate_theme(theme: &str) -> Result<(), String> {
    match theme {
        "light" | "dark" | "system" => Ok(()),
        _ => Err("Invalid theme: must be 'light', 'dark', or 'system'".to_string()),
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    // Input validation
    if let Err(e) = validate_string_input(name, 100, "Name") {
        log::warn!("Invalid greet input: {e}");
        return format!("Error: {e}");
    }

    log::trace!("Greeting user: {name}");
    format!("Hello, {name}! You've been greeted from Rust!")
}

// Preferences data structure
// Only contains settings that should be persisted to disk
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppPreferences {
    pub theme: String,
    #[serde(default = "default_model")]
    pub selected_model: String, // Claude model: opus, sonnet, haiku
    #[serde(default = "default_thinking_level")]
    pub thinking_level: String, // Thinking level: off, think, megathink, ultrathink
    #[serde(default = "default_effort_level")]
    pub default_effort_level: String, // Effort level for Opus 4.6: low, medium, high, max
    #[serde(default = "default_terminal")]
    pub terminal: String, // Terminal app: terminal, warp, ghostty
    #[serde(default = "default_editor")]
    pub editor: String, // Editor app: zed, vscode, cursor, xcode
    #[serde(default = "default_open_in")]
    pub open_in: String, // Default Open In action: editor, terminal, finder, github
    #[serde(default = "default_auto_branch_naming")]
    pub auto_branch_naming: bool, // Automatically generate branch names from first message
    #[serde(default = "default_branch_naming_model")]
    pub branch_naming_model: String, // Model for generating branch names: haiku, sonnet, opus
    #[serde(default = "default_auto_session_naming")]
    pub auto_session_naming: bool, // Automatically generate session names from first message
    #[serde(default = "default_session_naming_model")]
    pub session_naming_model: String, // Model for generating session names: haiku, sonnet, opus
    #[serde(default = "default_font_size")]
    pub ui_font_size: u32, // Font size for UI text in pixels (10-24)
    #[serde(default = "default_font_size")]
    pub chat_font_size: u32, // Font size for chat text in pixels (10-24)
    #[serde(default = "default_ui_font")]
    pub ui_font: String, // Font family for UI: inter, geist, system
    #[serde(default = "default_chat_font")]
    pub chat_font: String, // Font family for chat: jetbrains-mono, fira-code, source-code-pro, inter, geist, roboto, lato
    #[serde(default = "default_git_poll_interval")]
    pub git_poll_interval: u64, // Git status polling interval in seconds (10-600)
    #[serde(default = "default_remote_poll_interval")]
    pub remote_poll_interval: u64, // Remote API polling interval in seconds (30-600)
    #[serde(default = "default_keybindings")]
    pub keybindings: std::collections::HashMap<String, String>, // User-configurable keyboard shortcuts
    #[serde(default = "default_archive_retention_days")]
    pub archive_retention_days: u32, // Days to keep archived items before auto-cleanup (0 = disabled)
    #[serde(default = "default_syntax_theme_dark")]
    pub syntax_theme_dark: String, // Syntax highlighting theme for dark mode
    #[serde(default = "default_syntax_theme_light")]
    pub syntax_theme_light: String, // Syntax highlighting theme for light mode
    #[serde(default = "default_session_recap_enabled")]
    pub session_recap_enabled: bool, // Show session recap when returning to unfocused sessions
    #[serde(default = "default_parallel_execution_prompt_enabled")]
    pub parallel_execution_prompt_enabled: bool, // Add system prompt to encourage parallel sub-agent execution
    #[serde(default)]
    pub magic_prompts: MagicPrompts, // Customizable prompts for AI-powered features
    #[serde(default)]
    pub magic_prompt_models: MagicPromptModels, // Per-prompt model overrides
    #[serde(default)]
    pub magic_prompt_providers: MagicPromptProviders, // Per-prompt provider overrides (None = use default_provider)
    #[serde(default = "default_file_edit_mode")]
    pub file_edit_mode: String, // How to edit files: inline (CodeMirror) or external (VS Code, etc.)
    #[serde(default)]
    pub ai_language: String, // Preferred language for AI responses (empty = default)
    #[serde(default = "default_allow_web_tools_in_plan_mode")]
    pub allow_web_tools_in_plan_mode: bool, // Allow WebFetch/WebSearch in plan mode without prompts
    #[serde(default = "default_waiting_sound")]
    pub waiting_sound: String, // Sound when session is waiting for input: none, ding, chime, pop, choochoo
    #[serde(default = "default_review_sound")]
    pub review_sound: String, // Sound when session finishes reviewing: none, ding, chime, pop, choochoo
    #[serde(default)]
    pub http_server_enabled: bool, // Whether HTTP server is enabled
    #[serde(default)]
    pub http_server_auto_start: bool, // Auto-start HTTP server on app launch
    #[serde(default = "default_http_server_port")]
    pub http_server_port: u16, // HTTP server port (default: 3456)
    #[serde(default)]
    pub http_server_token: Option<String>, // Persisted auth token (generated once)
    #[serde(default)]
    pub http_server_localhost_only: bool, // Bind to localhost only (more secure)
    #[serde(default = "default_http_server_token_required")]
    pub http_server_token_required: bool, // Require token for web access (default true)
    #[serde(default = "default_removal_behavior")]
    pub removal_behavior: String, // What happens when closing sessions/worktrees: archive, delete
    #[serde(default = "default_auto_pull_base_branch")]
    pub auto_pull_base_branch: bool, // Auto-pull base branch before creating a new worktree
    #[serde(default = "default_auto_archive_on_pr_merged")]
    pub auto_archive_on_pr_merged: bool, // Auto-archive worktrees when their PR is merged
    #[serde(default = "default_show_keybinding_hints")]
    pub show_keybinding_hints: bool, // Show keyboard shortcut hints at bottom of canvas views
    #[serde(default)]
    pub debug_mode_enabled: bool, // Show debug panel in chat sessions (default: false)
    #[serde(default)]
    pub default_enabled_mcp_servers: Vec<String>, // MCP server names enabled by default (empty = none)
    #[serde(default)]
    pub known_mcp_servers: Vec<String>, // All MCP server names ever seen (prevents re-enabling user-disabled servers)
    #[serde(default)]
    pub has_seen_feature_tour: bool, // Whether user has seen the feature tour onboarding
    #[serde(default)]
    pub has_seen_jean_config_wizard: bool, // Whether user has seen the jean.json setup wizard
    #[serde(default = "default_chrome_enabled")]
    pub chrome_enabled: bool, // Enable browser automation via Chrome extension
    #[serde(default = "default_zoom_level")]
    pub zoom_level: u32, // Zoom level percentage (50-200, default 100)
    #[serde(default)]
    pub custom_cli_profiles: Vec<CustomCliProfile>, // Custom CLI settings profiles (e.g., OpenRouter, MiniMax)
    #[serde(default)]
    pub default_provider: Option<String>, // Default provider profile name (None = Anthropic direct)
    #[serde(default = "default_canvas_layout")]
    pub canvas_layout: String, // Canvas display mode: grid or list
    #[serde(default = "default_confirm_session_close")]
    pub confirm_session_close: bool, // Show confirmation dialog before closing sessions/worktrees
    #[serde(default = "default_backend")]
    pub default_backend: String, // Default CLI backend: "claude", "codex", or "opencode"
    #[serde(default = "default_codex_model")]
    pub selected_codex_model: String, // Default Codex model
    #[serde(default = "default_opencode_model")]
    pub selected_opencode_model: String, // Default OpenCode model (provider/model)
    #[serde(default = "default_codex_reasoning_effort")]
    pub default_codex_reasoning_effort: String, // Codex reasoning effort: low, medium, high, xhigh
    #[serde(default)]
    pub codex_multi_agent_enabled: bool, // Enable multi-agent collaboration (experimental)
    #[serde(default = "default_codex_max_agent_threads")]
    pub codex_max_agent_threads: u32, // Max concurrent agent threads (1-8)
    #[serde(default)]
    pub restore_last_session: bool, // Restore last session when switching projects (default: false)
}

fn default_true() -> Option<bool> {
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomCliProfile {
    pub name: String,
    #[serde(default)]
    pub settings_json: String,
    #[serde(default, skip_serializing)]
    pub file_path: String,
    #[serde(default = "default_true")]
    pub supports_thinking: Option<bool>,
}

fn slugify_profile_name(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    slug.trim_matches('-').to_string()
}

pub fn get_cli_profile_path(name: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home directory found")?;
    let slug = slugify_profile_name(name);
    if slug.is_empty() {
        return Err("Profile name is empty".to_string());
    }
    Ok(home
        .join(".claude")
        .join(format!("settings.jean.{slug}.json")))
}

fn default_auto_branch_naming() -> bool {
    true // Enabled by default
}

fn default_branch_naming_model() -> String {
    "haiku".to_string() // Use Haiku by default for fast, cheap branch name generation
}

fn default_auto_session_naming() -> bool {
    true // Enabled by default
}

fn default_session_naming_model() -> String {
    "haiku".to_string() // Use Haiku by default for fast, cheap session name generation
}

fn default_font_size() -> u32 {
    16 // Default font size in pixels
}

fn default_ui_font() -> String {
    "geist".to_string()
}

fn default_chat_font() -> String {
    "geist".to_string()
}

fn default_model() -> String {
    "opus".to_string()
}

fn default_thinking_level() -> String {
    "ultrathink".to_string()
}

fn default_effort_level() -> String {
    "high".to_string()
}

fn default_terminal() -> String {
    #[cfg(target_os = "windows")]
    {
        "windows-terminal".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "terminal".to_string()
    }
}

fn default_editor() -> String {
    "zed".to_string()
}

fn default_open_in() -> String {
    "editor".to_string()
}

fn default_git_poll_interval() -> u64 {
    60 // 1 minute default
}

fn default_remote_poll_interval() -> u64 {
    60 // 1 minute default for remote API calls (PR status, etc.)
}

fn default_keybindings() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    map.insert("focus_chat_input".to_string(), "mod+l".to_string());
    map.insert("toggle_left_sidebar".to_string(), "mod+1".to_string());
    map.insert("open_preferences".to_string(), "mod+comma".to_string());
    map.insert("open_commit_modal".to_string(), "mod+shift+c".to_string());
    map.insert("open_pull_request".to_string(), "mod+shift+p".to_string());
    map.insert("open_git_diff".to_string(), "mod+g".to_string());
    map.insert("execute_run".to_string(), "mod+r".to_string());
    map
}

fn default_archive_retention_days() -> u32 {
    7 // Keep archived items for 7 days by default
}

fn default_syntax_theme_dark() -> String {
    "vitesse-black".to_string()
}

fn default_syntax_theme_light() -> String {
    "github-light".to_string()
}

fn default_file_edit_mode() -> String {
    "external".to_string() // Default to external editor (VS Code, etc.)
}

fn default_session_recap_enabled() -> bool {
    false // Disabled by default (experimental)
}

fn default_parallel_execution_prompt_enabled() -> bool {
    false // Disabled by default (experimental)
}

fn default_chrome_enabled() -> bool {
    true // Enabled by default
}

fn default_canvas_layout() -> String {
    "list".to_string()
}

fn default_confirm_session_close() -> bool {
    true // Enabled by default
}

fn default_backend() -> String {
    "claude".to_string()
}

fn default_codex_model() -> String {
    "gpt-5.3-codex".to_string()
}

fn default_opencode_model() -> String {
    "opencode/gpt-5.2-codex".to_string()
}

fn default_codex_reasoning_effort() -> String {
    "high".to_string()
}

fn default_codex_max_agent_threads() -> u32 {
    3
}

fn default_zoom_level() -> u32 {
    90 // 90% = slightly smaller default
}

fn default_allow_web_tools_in_plan_mode() -> bool {
    true // Enabled by default
}

fn default_waiting_sound() -> String {
    "none".to_string()
}

fn default_review_sound() -> String {
    "none".to_string()
}

fn default_http_server_port() -> u16 {
    3456
}

fn default_http_server_token_required() -> bool {
    true // Require token by default for security
}

fn default_removal_behavior() -> String {
    "delete".to_string()
}

fn default_auto_pull_base_branch() -> bool {
    true // Enabled by default
}

fn default_auto_archive_on_pr_merged() -> bool {
    true // Enabled by default
}

fn default_show_keybinding_hints() -> bool {
    true // Enabled by default
}

// =============================================================================
// Magic Prompts - Customizable prompts for AI-powered features
// =============================================================================

/// Customizable prompts for AI-powered features.
/// Fields are Option<String>: None = use current app default (auto-updates on new versions),
/// Some(text) = user customization (preserved across updates).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MagicPrompts {
    #[serde(default)]
    pub investigate_issue: Option<String>,
    #[serde(default)]
    pub investigate_pr: Option<String>,
    #[serde(default)]
    pub pr_content: Option<String>,
    #[serde(default)]
    pub commit_message: Option<String>,
    #[serde(default)]
    pub code_review: Option<String>,
    #[serde(default)]
    pub context_summary: Option<String>,
    #[serde(default)]
    pub resolve_conflicts: Option<String>,
    #[serde(default)]
    pub investigate_workflow_run: Option<String>,
    #[serde(default)]
    pub release_notes: Option<String>,
    #[serde(default)]
    pub session_naming: Option<String>,
    #[serde(default)]
    pub parallel_execution: Option<String>,
    #[serde(default)]
    pub global_system_prompt: Option<String>,
    #[serde(default)]
    pub session_recap: Option<String>,
}

fn default_investigate_issue_prompt() -> String {
    r#"<task>

Investigate the loaded GitHub {issueWord} ({issueRefs})

</task>


<instructions>

1. Read the issue context file(s) to understand the full problem description and comments
2. Analyze the problem: expected vs actual behavior, error messages, reproduction steps
3. Explore the codebase to find relevant code
4. Identify root cause and constraints
5. Check for regression if this is a bug fix
6. Propose solution with specific files, risks, and test cases

</instructions>


<guidelines>

- Be thorough but focused
- Ask clarifying questions if requirements are unclear
- If multiple solutions exist, explain trade-offs
- Reference specific file paths and line numbers

</guidelines>"#
        .to_string()
}

fn default_investigate_pr_prompt() -> String {
    r#"<task>

Investigate the loaded GitHub {prWord} ({prRefs})

</task>


<instructions>

1. Read the PR context file(s) to understand the full description, reviews, and comments
2. Understand what the PR is trying to accomplish and branch info (head → base)
3. Explore the codebase to understand the context
4. Analyze if the implementation matches the PR description
5. Security review - check the changes for:
   - Malicious or obfuscated code (eval, encoded strings, hidden network calls, data exfiltration)
   - Suspicious dependency additions or version changes (typosquatting, hijacked packages)
   - Hardcoded secrets, tokens, API keys, or credentials
   - Backdoors, reverse shells, or unauthorized remote access
   - Unsafe deserialization, command injection, SQL injection, XSS
   - Weakened auth/permissions (removed checks, broadened access, disabled validation)
   - Suspicious file system or environment variable access
6. Identify action items from reviewer feedback
7. Propose next steps to get the PR merged

</instructions>


<guidelines>

- Be thorough but focused
- Pay attention to reviewer feedback and requested changes
- Flag any security concerns prominently, even minor ones
- If multiple approaches exist, explain trade-offs
- Reference specific file paths and line numbers

</guidelines>"#
        .to_string()
}

fn default_pr_content_prompt() -> String {
    r#"<task>Generate a pull request title and description</task>

<context>
<source_branch>{current_branch}</source_branch>
<target_branch>{target_branch}</target_branch>
<commit_count>{commit_count}</commit_count>
</context>

<commits>
{commits}
</commits>

<diff>
{diff}
</diff>"#
        .to_string()
}

fn default_commit_message_prompt() -> String {
    r#"<task>Generate a commit message for the following changes</task>

<git_status>
{status}
</git_status>

<staged_diff>
{diff}
</staged_diff>

<recent_commits>
{recent_commits}
</recent_commits>

<remote_info>
{remote_info}
</remote_info>"#
        .to_string()
}

fn default_code_review_prompt() -> String {
    r#"<task>Review the following code changes and provide structured feedback</task>

<branch_info>{branch_info}</branch_info>

<commits>
{commits}
</commits>

<diff>
{diff}
</diff>

{uncommitted_section}

<instructions>
Focus on:
- Security & supply-chain risks:
  - Malicious or obfuscated code (eval, encoded strings, hidden network calls, data exfiltration)
  - Suspicious dependency additions or version changes (typosquatting, hijacked packages)
  - Hardcoded secrets, tokens, API keys, or credentials
  - Backdoors, reverse shells, or unauthorized remote access
  - Unsafe deserialization, command injection, SQL injection, XSS
  - Weakened auth/permissions (removed checks, broadened access, disabled validation)
  - Suspicious file system or environment variable access
- Performance issues
- Code quality and maintainability (use /check skill if available to run linters/tests)
- Potential bugs
- Best practices violations

If there are uncommitted changes, review those as well.

Be constructive and specific. Include praise for good patterns.
Provide actionable suggestions when possible.
</instructions>"#
        .to_string()
}

fn default_context_summary_prompt() -> String {
    r#"<task>Summarize the following conversation for future context loading</task>

<output_format>
Your summary should include:
1. Main Goal - What was the primary objective?
2. Key Decisions & Rationale - Important decisions and WHY they were chosen
3. Trade-offs Considered - What approaches were weighed and rejected?
4. Problems Solved - Errors, blockers, or gotchas and how resolved
5. Current State - What has been implemented so far?
6. Unresolved Questions - Open questions or blockers
7. Key Files & Patterns - Critical file paths and code patterns
8. Next Steps - What remains to be done?

Format as clean markdown. Be concise but capture reasoning.
</output_format>

<context>
<project>{project_name}</project>
<date>{date}</date>
</context>

<conversation>
{conversation}
</conversation>"#
        .to_string()
}

fn default_resolve_conflicts_prompt() -> String {
    r#"Please help me resolve these conflicts. Analyze the diff above, explain what's conflicting in each file, and guide me through resolving each conflict.

After resolving each file's conflicts, stage it with `git add`. Then run the appropriate continue command (`git rebase --continue`, `git merge --continue`, or `git cherry-pick --continue`). If more conflicts appear, resolve those too. Keep going until the operation is fully complete and the branch is ready to push."#
        .to_string()
}

fn default_investigate_workflow_run_prompt() -> String {
    r#"Investigate the failed GitHub Actions workflow run for "{workflowName}" on branch `{branch}`.

**Context:**
- Workflow: {workflowName}
- Commit/PR: {displayTitle}
- Branch: {branch}
- Run URL: {runUrl}

**Instructions:**
1. Use the GitHub CLI to fetch the workflow run logs: `gh run view {runId} --log-failed`
2. Read the error output carefully to identify the failure cause
3. Explore the relevant code in the codebase to understand the context
4. Determine if this is a code issue, configuration issue, or flaky test
5. Propose a fix with specific files and changes needed"#
        .to_string()
}

fn default_parallel_execution_prompt() -> String {
    r#"In plan mode, structure plans so subagents can work simultaneously. In build/execute mode, use subagents in parallel for faster implementation.

When launching multiple Task subagents, prefer sending them in a single message rather than sequentially. Group independent work items (e.g., editing separate files, researching unrelated questions) into parallel Task calls. Only sequence Tasks when one depends on another's output.

Instruct each sub-agent to briefly outline its approach before implementing, so it can course-correct early without formal plan mode overhead.

When specifying subagent_type for Task tool calls, always use the fully qualified name exactly as listed in the system prompt (e.g., "code-simplifier:code-simplifier", not just "code-simplifier"). If the agent type contains a colon, include the full namespace:name string."#
        .to_string()
}

/// Per-prompt model overrides for magic prompts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MagicPromptModels {
    #[serde(default = "default_model")]
    pub investigate_issue_model: String,
    #[serde(default = "default_model")]
    pub investigate_pr_model: String,
    #[serde(default = "default_model")]
    pub investigate_workflow_run_model: String,
    #[serde(default = "default_haiku_model")]
    pub pr_content_model: String,
    #[serde(default = "default_haiku_model")]
    pub commit_message_model: String,
    #[serde(default = "default_model")]
    pub code_review_model: String,
    #[serde(default = "default_model")]
    pub context_summary_model: String,
    #[serde(default = "default_model")]
    pub resolve_conflicts_model: String,
    #[serde(default = "default_haiku_model")]
    pub release_notes_model: String,
    #[serde(default = "default_haiku_model")]
    pub session_naming_model: String,
    #[serde(default = "default_haiku_model")]
    pub session_recap_model: String,
}

fn default_haiku_model() -> String {
    "haiku".to_string()
}

impl Default for MagicPromptModels {
    fn default() -> Self {
        Self {
            investigate_issue_model: default_model(),
            investigate_pr_model: default_model(),
            investigate_workflow_run_model: default_model(),
            pr_content_model: default_haiku_model(),
            commit_message_model: default_haiku_model(),
            code_review_model: default_model(),
            context_summary_model: default_model(),
            resolve_conflicts_model: default_model(),
            release_notes_model: default_haiku_model(),
            session_naming_model: default_haiku_model(),
            session_recap_model: default_haiku_model(),
        }
    }
}

/// Returns true if the given model string identifies an OpenCode model.
/// OpenCode model IDs are prefixed with "opencode/" (e.g. "opencode/gpt-5.2-codex").
pub fn is_opencode_model(model: &str) -> bool {
    model.starts_with("opencode/")
}

/// Returns true if the given model string identifies a Codex model.
/// Codex model IDs contain "codex" or start with "gpt-", but NOT OpenCode models.
pub fn is_codex_model(model: &str) -> bool {
    !is_opencode_model(model) && (model.contains("codex") || model.starts_with("gpt-"))
}

/// Per-prompt provider overrides for magic prompts (None = use global default_provider)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MagicPromptProviders {
    #[serde(default)]
    pub investigate_issue_provider: Option<String>,
    #[serde(default)]
    pub investigate_pr_provider: Option<String>,
    #[serde(default)]
    pub investigate_workflow_run_provider: Option<String>,
    #[serde(default)]
    pub pr_content_provider: Option<String>,
    #[serde(default)]
    pub commit_message_provider: Option<String>,
    #[serde(default)]
    pub code_review_provider: Option<String>,
    #[serde(default)]
    pub context_summary_provider: Option<String>,
    #[serde(default)]
    pub resolve_conflicts_provider: Option<String>,
    #[serde(default)]
    pub release_notes_provider: Option<String>,
    #[serde(default)]
    pub session_naming_provider: Option<String>,
    #[serde(default)]
    pub session_recap_provider: Option<String>,
}

impl MagicPrompts {
    /// Migrate prompts that match the current default to None.
    /// This ensures users who never customized a prompt get auto-updated defaults.
    fn migrate_defaults(&mut self) {
        type DefaultEntry<'a> = (fn() -> String, &'a mut Option<String>);
        let defaults: [DefaultEntry; 9] = [
            (
                default_investigate_issue_prompt,
                &mut self.investigate_issue,
            ),
            (default_investigate_pr_prompt, &mut self.investigate_pr),
            (default_pr_content_prompt, &mut self.pr_content),
            (default_commit_message_prompt, &mut self.commit_message),
            (default_code_review_prompt, &mut self.code_review),
            (default_context_summary_prompt, &mut self.context_summary),
            (
                default_resolve_conflicts_prompt,
                &mut self.resolve_conflicts,
            ),
            (
                default_investigate_workflow_run_prompt,
                &mut self.investigate_workflow_run,
            ),
            (
                default_parallel_execution_prompt,
                &mut self.parallel_execution,
            ),
        ];

        for (default_fn, field) in defaults {
            if let Some(ref value) = field {
                if value == &default_fn() {
                    *field = None;
                }
            }
        }
    }
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            selected_model: default_model(),
            thinking_level: default_thinking_level(),
            terminal: default_terminal(),
            editor: default_editor(),
            open_in: default_open_in(),
            auto_branch_naming: default_auto_branch_naming(),
            branch_naming_model: default_branch_naming_model(),
            auto_session_naming: default_auto_session_naming(),
            session_naming_model: default_session_naming_model(),
            ui_font_size: 16,
            chat_font_size: 16,
            ui_font: default_ui_font(),
            chat_font: default_chat_font(),
            git_poll_interval: default_git_poll_interval(),
            remote_poll_interval: default_remote_poll_interval(),
            keybindings: default_keybindings(),
            archive_retention_days: default_archive_retention_days(),
            syntax_theme_dark: default_syntax_theme_dark(),
            syntax_theme_light: default_syntax_theme_light(),
            session_recap_enabled: default_session_recap_enabled(),
            parallel_execution_prompt_enabled: default_parallel_execution_prompt_enabled(),
            magic_prompts: MagicPrompts::default(),
            magic_prompt_models: MagicPromptModels::default(),
            magic_prompt_providers: MagicPromptProviders::default(),
            file_edit_mode: default_file_edit_mode(),
            ai_language: String::new(),
            allow_web_tools_in_plan_mode: default_allow_web_tools_in_plan_mode(),
            waiting_sound: default_waiting_sound(),
            review_sound: default_review_sound(),
            http_server_enabled: false,
            http_server_auto_start: false,
            http_server_port: default_http_server_port(),
            http_server_token: None,
            http_server_localhost_only: true, // Default to localhost-only for security
            http_server_token_required: default_http_server_token_required(),
            removal_behavior: default_removal_behavior(),
            auto_pull_base_branch: default_auto_pull_base_branch(),
            auto_archive_on_pr_merged: default_auto_archive_on_pr_merged(),
            show_keybinding_hints: default_show_keybinding_hints(),
            debug_mode_enabled: false,
            default_effort_level: default_effort_level(),
            default_enabled_mcp_servers: Vec::new(),
            known_mcp_servers: Vec::new(),
            has_seen_feature_tour: false,
            has_seen_jean_config_wizard: false,
            chrome_enabled: default_chrome_enabled(),
            zoom_level: default_zoom_level(),
            custom_cli_profiles: Vec::new(),
            default_provider: None,
            canvas_layout: default_canvas_layout(),
            confirm_session_close: default_confirm_session_close(),
            default_backend: default_backend(),
            selected_codex_model: default_codex_model(),
            selected_opencode_model: default_opencode_model(),
            default_codex_reasoning_effort: default_codex_reasoning_effort(),
            codex_multi_agent_enabled: false,
            codex_max_agent_threads: default_codex_max_agent_threads(),
            restore_last_session: false,
        }
    }
}

// UI State data structure
// Contains ephemeral UI state that should be restored on app restart
//
// NOTE: Session-specific state (answered_questions, submitted_answers, fixed_findings,
// pending_permission_denials, denied_message_context, reviewing_sessions) is now
// stored in the Session files. See update_session_state command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIState {
    /// Last opened worktree ID (to restore active worktree)
    #[serde(default)]
    pub active_worktree_id: Option<String>,

    /// Last opened worktree path (needed for chat context)
    #[serde(default)]
    pub active_worktree_path: Option<String>,

    /// Last active worktree ID (survives clearing, used by dashboard to restore selection)
    #[serde(default)]
    pub last_active_worktree_id: Option<String>,

    /// Last selected project ID (to restore project selection for GitHub issues)
    #[serde(default)]
    pub active_project_id: Option<String>,

    /// Project IDs whose tree nodes are expanded in sidebar
    #[serde(default)]
    pub expanded_project_ids: Vec<String>,

    /// Folder IDs whose tree nodes are expanded in sidebar
    #[serde(default)]
    pub expanded_folder_ids: Vec<String>,

    /// Left sidebar width in pixels, defaults to 250
    #[serde(default)]
    pub left_sidebar_size: Option<f64>,

    /// Left sidebar visibility, defaults to false
    #[serde(default)]
    pub left_sidebar_visible: Option<bool>,

    /// Active session ID per worktree (for restoring open tabs)
    #[serde(default)]
    pub active_session_ids: std::collections::HashMap<String, String>,

    /// Whether the review sidebar is visible
    #[serde(default)]
    pub review_sidebar_visible: Option<bool>,

    /// Session IDs that completed while out of focus, need digest on open
    #[serde(default)]
    pub pending_digest_session_ids: Vec<String>,

    /// Modal terminal drawer open state per worktree
    #[serde(default)]
    pub modal_terminal_open: std::collections::HashMap<String, bool>,

    /// Modal terminal drawer width in pixels
    #[serde(default)]
    pub modal_terminal_width: Option<f64>,

    /// Last-accessed timestamps per project for recency sorting (projectId → unix ms)
    #[serde(default)]
    pub project_access_timestamps: std::collections::HashMap<String, f64>,

    /// Dashboard worktree collapse overrides: worktreeId → collapsed (true/false)
    #[serde(default)]
    pub dashboard_worktree_collapse_overrides: std::collections::HashMap<String, bool>,

    /// Last opened worktree+session per project: projectId → { worktree_id, session_id }
    #[serde(default)]
    pub last_opened_per_project: std::collections::HashMap<String, LastOpenedEntry>,

    /// Version for future migration support
    #[serde(default = "default_ui_state_version")]
    pub version: u32,
}

fn default_ui_state_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastOpenedEntry {
    pub worktree_id: String,
    pub session_id: String,
}

impl Default for UIState {
    fn default() -> Self {
        Self {
            active_worktree_id: None,
            active_worktree_path: None,
            last_active_worktree_id: None,
            active_project_id: None,
            expanded_project_ids: Vec::new(),
            expanded_folder_ids: Vec::new(),
            left_sidebar_size: None,
            left_sidebar_visible: None,
            active_session_ids: std::collections::HashMap::new(),
            review_sidebar_visible: None,
            pending_digest_session_ids: Vec::new(),
            modal_terminal_open: std::collections::HashMap::new(),
            modal_terminal_width: None,
            project_access_timestamps: std::collections::HashMap::new(),
            dashboard_worktree_collapse_overrides: std::collections::HashMap::new(),
            last_opened_per_project: std::collections::HashMap::new(),
            version: default_ui_state_version(),
        }
    }
}

pub fn get_preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    // Ensure the directory exists
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    Ok(app_data_dir.join("preferences.json"))
}

#[tauri::command]
async fn load_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    log::trace!("Loading preferences from disk");
    let prefs_path = get_preferences_path(&app)?;

    if !prefs_path.exists() {
        log::trace!("Preferences file not found, using defaults");
        return Ok(AppPreferences::default());
    }

    let contents = std::fs::read_to_string(&prefs_path).map_err(|e| {
        log::error!("Failed to read preferences file: {e}");
        format!("Failed to read preferences file: {e}")
    })?;

    let mut preferences: AppPreferences = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse preferences JSON: {e}");
        format!("Failed to parse preferences: {e}")
    })?;

    // Migrate magic prompts: convert prompts matching current defaults to None
    // so they auto-update when new defaults are shipped
    preferences.magic_prompts.migrate_defaults();

    // Migrate CLI profiles: move settings_json from preferences.json to standalone files
    let mut needs_resave = false;
    for profile in &mut preferences.custom_cli_profiles {
        let path = match get_cli_profile_path(&profile.name) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Failed to get CLI profile path for '{}': {e}", profile.name);
                continue;
            }
        };
        profile.file_path = path.to_string_lossy().to_string();

        // Migration: if settings_json is in preferences.json, write to file
        if !profile.settings_json.is_empty() && !path.exists() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::write(&path, &profile.settings_json) {
                log::error!("Failed to migrate CLI profile '{}': {e}", profile.name);
            } else {
                log::info!(
                    "Migrated CLI profile '{}' to {}",
                    profile.name,
                    path.display()
                );
                needs_resave = true;
            }
        }

        // Load settings_json from file (always prefer file as source of truth)
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(contents) => profile.settings_json = contents,
                Err(e) => log::warn!("Failed to read CLI profile '{}': {e}", profile.name),
            }
        }
    }

    // Re-save preferences with settings_json cleared (file is now source of truth)
    if needs_resave {
        let mut prefs_for_disk = preferences.clone();
        for profile in &mut prefs_for_disk.custom_cli_profiles {
            profile.settings_json = String::new();
        }
        if let Ok(json) = serde_json::to_string_pretty(&prefs_for_disk) {
            let _ = std::fs::write(&prefs_path, json);
            log::trace!("Re-saved preferences after CLI profile migration");
        }
    }

    log::trace!("Successfully loaded preferences");
    Ok(preferences)
}

#[tauri::command]
async fn save_preferences(app: AppHandle, preferences: AppPreferences) -> Result<(), String> {
    // Validate theme value
    validate_theme(&preferences.theme)?;

    log::trace!("Saving preferences to disk");
    let prefs_path = get_preferences_path(&app)?;

    // Write any non-empty settings_json to standalone files before clearing
    for profile in &preferences.custom_cli_profiles {
        if !profile.settings_json.is_empty() {
            if let Ok(path) = get_cli_profile_path(&profile.name) {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(&path, &profile.settings_json) {
                    log::error!("Failed to write CLI profile '{}': {e}", profile.name);
                }
            }
        }
    }

    // Strip settings_json from CLI profiles before writing to preferences.json (file is source of truth)
    let mut prefs_for_disk = preferences;
    for profile in &mut prefs_for_disk.custom_cli_profiles {
        profile.settings_json = String::new();
        profile.file_path = String::new();
    }

    let json_content = serde_json::to_string_pretty(&prefs_for_disk).map_err(|e| {
        log::error!("Failed to serialize preferences: {e}");
        format!("Failed to serialize preferences: {e}")
    })?;

    // Write to a temporary file first, then rename (atomic operation)
    // Use unique temp file to avoid race conditions with concurrent saves
    let temp_path = prefs_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));

    std::fs::write(&temp_path, json_content).map_err(|e| {
        log::error!("Failed to write preferences file: {e}");
        format!("Failed to write preferences file: {e}")
    })?;

    std::fs::rename(&temp_path, &prefs_path).map_err(|e| {
        // Clean up temp file on rename failure
        let _ = std::fs::remove_file(&temp_path);
        log::error!("Failed to finalize preferences file: {e}");
        format!("Failed to finalize preferences file: {e}")
    })?;

    log::trace!("Successfully saved preferences to {prefs_path:?}");
    Ok(())
}

#[tauri::command]
async fn save_cli_profile(name: String, settings_json: String) -> Result<String, String> {
    // Validate JSON
    serde_json::from_str::<serde_json::Value>(&settings_json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;

    let path = get_cli_profile_path(&name)?;

    // Ensure ~/.claude/ exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;
    }

    // Atomic write via temp file
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, &settings_json).map_err(|e| format!("Failed to write: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to finalize: {e}")
    })?;

    let path_str = path.to_string_lossy().to_string();
    log::trace!("Saved CLI profile '{name}' to {path_str}");
    Ok(path_str)
}

#[tauri::command]
async fn delete_cli_profile(name: String) -> Result<(), String> {
    let path = get_cli_profile_path(&name)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete: {e}"))?;
        log::trace!("Deleted CLI profile '{name}' at {}", path.display());
    }
    Ok(())
}

fn get_ui_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    // Ensure the directory exists
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    Ok(app_data_dir.join("ui-state.json"))
}

#[tauri::command]
async fn load_ui_state(app: AppHandle) -> Result<UIState, String> {
    log::trace!("Loading UI state from disk");
    let state_path = get_ui_state_path(&app)?;

    if !state_path.exists() {
        log::trace!("UI state file not found, using defaults");
        return Ok(UIState::default());
    }

    let contents = std::fs::read_to_string(&state_path).map_err(|e| {
        log::error!("Failed to read UI state file: {e}");
        format!("Failed to read UI state file: {e}")
    })?;

    let ui_state: UIState = serde_json::from_str(&contents).map_err(|e| {
        log::warn!("Failed to parse UI state JSON, using defaults: {e}");
        format!("Failed to parse UI state: {e}")
    })?;

    log::trace!("Successfully loaded UI state");
    Ok(ui_state)
}

#[tauri::command]
async fn save_ui_state(app: AppHandle, ui_state: UIState) -> Result<(), String> {
    log::trace!("Saving UI state to disk: {ui_state:?}");
    let state_path = get_ui_state_path(&app)?;

    let json_content = serde_json::to_string_pretty(&ui_state).map_err(|e| {
        log::error!("Failed to serialize UI state: {e}");
        format!("Failed to serialize UI state: {e}")
    })?;

    // Write to a temporary file first, then rename (atomic operation)
    // Use unique temp file to avoid race conditions with concurrent saves
    let temp_path = state_path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));

    std::fs::write(&temp_path, json_content).map_err(|e| {
        log::error!("Failed to write UI state file: {e}");
        format!("Failed to write UI state file: {e}")
    })?;

    std::fs::rename(&temp_path, &state_path).map_err(|e| {
        // Clean up temp file on rename failure
        let _ = std::fs::remove_file(&temp_path);
        log::error!("Failed to finalize UI state file: {e}");
        format!("Failed to finalize UI state file: {e}")
    })?;

    log::trace!("Saved UI state to {state_path:?}");
    Ok(())
}

#[tauri::command]
async fn send_native_notification(
    app: AppHandle,
    title: String,
    body: Option<String>,
) -> Result<(), String> {
    log::trace!("Sending native notification: {title}");

    #[cfg(not(mobile))]
    {
        use tauri_plugin_notification::NotificationExt;

        let mut notification = app.notification().builder().title(title);

        if let Some(body_text) = body {
            notification = notification.body(body_text);
        }

        match notification.show() {
            Ok(_) => {
                log::trace!("Native notification sent successfully");
                Ok(())
            }
            Err(e) => {
                log::error!("Failed to send native notification: {e}");
                Err(format!("Failed to send notification: {e}"))
            }
        }
    }

    #[cfg(mobile)]
    {
        log::warn!("Native notifications not supported on mobile");
        Err("Native notifications not supported on mobile".to_string())
    }
}

// Recovery functions - simple pattern for saving JSON data to disk
fn get_recovery_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let recovery_dir = app_data_dir.join("recovery");

    // Ensure the recovery directory exists
    std::fs::create_dir_all(&recovery_dir)
        .map_err(|e| format!("Failed to create recovery directory: {e}"))?;

    Ok(recovery_dir)
}

#[tauri::command]
async fn save_emergency_data(app: AppHandle, filename: String, data: Value) -> Result<(), String> {
    log::trace!("Saving emergency data to file: {filename}");

    // Validate filename with proper security checks
    validate_filename(&filename)?;

    // Validate data size (10MB limit)
    let data_str = serde_json::to_string(&data)
        .map_err(|e| format!("Failed to serialize data for size check: {e}"))?;
    if data_str.len() > 10_485_760 {
        return Err("Data too large (max 10MB)".to_string());
    }

    let recovery_dir = get_recovery_dir(&app)?;
    let file_path = recovery_dir.join(format!("{filename}.json"));

    let json_content = serde_json::to_string_pretty(&data).map_err(|e| {
        log::error!("Failed to serialize emergency data: {e}");
        format!("Failed to serialize data: {e}")
    })?;

    // Write to a temporary file first, then rename (atomic operation)
    let temp_path = file_path.with_extension("tmp");

    std::fs::write(&temp_path, json_content).map_err(|e| {
        log::error!("Failed to write emergency data file: {e}");
        format!("Failed to write data file: {e}")
    })?;

    std::fs::rename(&temp_path, &file_path).map_err(|e| {
        log::error!("Failed to finalize emergency data file: {e}");
        format!("Failed to finalize data file: {e}")
    })?;

    log::trace!("Successfully saved emergency data to {file_path:?}");
    Ok(())
}

#[tauri::command]
async fn load_emergency_data(app: AppHandle, filename: String) -> Result<Value, String> {
    log::trace!("Loading emergency data from file: {filename}");

    // Validate filename with proper security checks
    validate_filename(&filename)?;

    let recovery_dir = get_recovery_dir(&app)?;
    let file_path = recovery_dir.join(format!("{filename}.json"));

    if !file_path.exists() {
        log::trace!("Recovery file not found: {file_path:?}");
        return Err("File not found".to_string());
    }

    let contents = std::fs::read_to_string(&file_path).map_err(|e| {
        log::error!("Failed to read recovery file: {e}");
        format!("Failed to read file: {e}")
    })?;

    let data: Value = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse recovery JSON: {e}");
        format!("Failed to parse data: {e}")
    })?;

    log::trace!("Successfully loaded emergency data");
    Ok(data)
}

#[tauri::command]
async fn cleanup_old_recovery_files(app: AppHandle) -> Result<u32, String> {
    log::trace!("Cleaning up old recovery files");

    let recovery_dir = get_recovery_dir(&app)?;
    let mut removed_count = 0;

    // Calculate cutoff time (7 days ago)
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to get current time: {e}"))?
        .as_secs();
    let seven_days_ago = now - (7 * 24 * 60 * 60);

    // Read directory and check each file
    let entries = std::fs::read_dir(&recovery_dir).map_err(|e| {
        log::error!("Failed to read recovery directory: {e}");
        format!("Failed to read directory: {e}")
    })?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("Failed to read directory entry: {e}");
                continue;
            }
        };

        let path = entry.path();

        // Only process JSON files
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }

        // Check file modification time
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to get file metadata: {e}");
                continue;
            }
        };

        let modified = match metadata.modified() {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to get file modification time: {e}");
                continue;
            }
        };

        let modified_secs = match modified.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs(),
            Err(e) => {
                log::warn!("Failed to convert modification time: {e}");
                continue;
            }
        };

        // Remove if older than 7 days
        if modified_secs < seven_days_ago {
            match std::fs::remove_file(&path) {
                Ok(_) => {
                    log::trace!("Removed old recovery file: {path:?}");
                    removed_count += 1;
                }
                Err(e) => {
                    log::warn!("Failed to remove old recovery file: {e}");
                }
            }
        }
    }

    log::trace!("Cleanup complete. Removed {removed_count} old recovery files");
    Ok(removed_count)
}

// =============================================================================
// HTTP Server Tauri Commands
// =============================================================================

#[tauri::command]
async fn start_http_server(
    app: AppHandle,
    port: Option<u16>,
) -> Result<http_server::server::ServerStatus, String> {
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let prefs = load_preferences(app.clone()).await?;
    let actual_port = port.unwrap_or(prefs.http_server_port);
    let localhost_only = prefs.http_server_localhost_only;
    let token_required = prefs.http_server_token_required;

    // Generate or load token
    let token = match prefs.http_server_token {
        Some(t) if !t.is_empty() => t,
        _ => {
            let new_token = http_server::auth::generate_token();
            // Persist the token
            let mut prefs = prefs.clone();
            prefs.http_server_token = Some(new_token.clone());
            save_preferences(app.clone(), prefs).await?;
            new_token
        }
    };

    // Check if already running
    {
        let handle_state =
            app.try_state::<Arc<Mutex<Option<http_server::server::HttpServerHandle>>>>();
        if let Some(state) = handle_state {
            let handle = state.lock().await;
            if handle.is_some() {
                return Err("HTTP server is already running".to_string());
            }
        }
    }

    // Start the server
    let handle = http_server::server::start_server(
        app.clone(),
        actual_port,
        token,
        localhost_only,
        token_required,
    )
    .await?;
    let status = http_server::server::ServerStatus {
        running: true,
        url: Some(handle.url.clone()),
        token: Some(handle.token.clone()),
        port: Some(handle.port),
        localhost_only: Some(handle.localhost_only),
    };

    // Store the handle
    let handle_state = app.try_state::<Arc<Mutex<Option<http_server::server::HttpServerHandle>>>>();
    if let Some(state) = handle_state {
        let mut guard = state.lock().await;
        *guard = Some(handle);
    }

    log::info!(
        "HTTP server started: {} (localhost_only: {})",
        status.url.as_deref().unwrap_or("unknown"),
        localhost_only
    );
    Ok(status)
}

#[tauri::command]
async fn stop_http_server(app: AppHandle) -> Result<(), String> {
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let handle_state = app.try_state::<Arc<Mutex<Option<http_server::server::HttpServerHandle>>>>();
    if let Some(state) = handle_state {
        let mut guard = state.lock().await;
        if let Some(handle) = guard.take() {
            let _ = handle.shutdown_tx.send(());
            log::info!("HTTP server stopped");
        }
    }

    Ok(())
}

/// Start HTTP server with explicit localhost_only override (for headless mode)
async fn start_http_server_headless(
    app: AppHandle,
    port: u16,
    bind_all_interfaces: bool,
) -> Result<http_server::server::ServerStatus, String> {
    use std::sync::Arc;
    use tokio::sync::Mutex;

    let prefs = load_preferences(app.clone()).await?;
    // In headless mode with bind_all_interfaces=true, override localhost_only to false
    let localhost_only = if bind_all_interfaces {
        false
    } else {
        prefs.http_server_localhost_only
    };
    let token_required = prefs.http_server_token_required;

    // Generate or load token
    let token = match prefs.http_server_token {
        Some(t) if !t.is_empty() => t,
        _ => {
            let new_token = http_server::auth::generate_token();
            // Persist the token
            let mut prefs = prefs.clone();
            prefs.http_server_token = Some(new_token.clone());
            save_preferences(app.clone(), prefs).await?;
            new_token
        }
    };

    // Check if already running
    {
        let handle_state =
            app.try_state::<Arc<Mutex<Option<http_server::server::HttpServerHandle>>>>();
        if let Some(state) = handle_state {
            let handle = state.lock().await;
            if handle.is_some() {
                return Err("HTTP server is already running".to_string());
            }
        }
    }

    // Start the server
    let handle =
        http_server::server::start_server(app.clone(), port, token, localhost_only, token_required)
            .await?;
    let status = http_server::server::ServerStatus {
        running: true,
        url: Some(handle.url.clone()),
        token: Some(handle.token.clone()),
        port: Some(handle.port),
        localhost_only: Some(handle.localhost_only),
    };

    // Store the handle
    let handle_state = app.try_state::<Arc<Mutex<Option<http_server::server::HttpServerHandle>>>>();
    if let Some(state) = handle_state {
        let mut guard = state.lock().await;
        *guard = Some(handle);
    }

    log::info!(
        "HTTP server started: {} (localhost_only: {})",
        status.url.as_deref().unwrap_or("unknown"),
        localhost_only
    );
    Ok(status)
}

#[tauri::command]
async fn get_http_server_status(
    app: AppHandle,
) -> Result<http_server::server::ServerStatus, String> {
    Ok(http_server::server::get_server_status(app).await)
}

#[tauri::command]
async fn regenerate_http_token(app: AppHandle) -> Result<String, String> {
    let new_token = http_server::auth::generate_token();
    let mut prefs = load_preferences(app.clone()).await?;
    prefs.http_server_token = Some(new_token.clone());
    save_preferences(app.clone(), prefs).await?;
    Ok(new_token)
}

#[cfg(target_os = "macos")]
// Create the native menu system
fn create_app_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    log::trace!("Setting up native menu system");

    // Build the main application submenu
    let app_submenu = SubmenuBuilder::new(app, "Jean")
        .item(&MenuItemBuilder::with_id("about", "About Jean").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("preferences", "Preferences...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide Jean"))?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("Quit Jean"))?)
        .build()?;

    // Build the Edit submenu with standard clipboard operations
    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // Build the View submenu
    // Note: Accelerators removed since keybindings are user-configurable in preferences
    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("toggle-left-sidebar", "Toggle Left Sidebar").build(app)?)
        .item(&MenuItemBuilder::with_id("toggle-right-sidebar", "Toggle Right Sidebar").build(app)?)
        .build()?;

    // Build the main menu with submenus
    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .build()?;

    // Set the menu for the app
    app.set_menu(menu)?;

    log::trace!("Native menu system initialized successfully");
    Ok(())
}

/// Fix PATH environment for macOS GUI applications.
///
/// macOS GUI apps launched from Finder/Spotlight don't inherit the user's shell PATH.
/// This function spawns a login shell (without -i) to capture PATH from login profiles
/// (.zprofile, .bash_profile) while avoiding .zshrc which triggers TCC dialogs on Sequoia.
#[cfg(target_os = "macos")]
fn fix_macos_path() {
    use crate::platform::silent_command;

    // Get user's shell from $SHELL, default to zsh (macOS default since Catalina)
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Spawn a login (-l) + interactive (-i) shell to source all config files
    // including .zshrc where tools like bun, nvm add their PATH entries.
    // Use `printenv PATH` instead of `echo $PATH` because fish shell prints
    // $PATH as space-separated (it's a list in fish), while printenv always
    // outputs the raw colon-separated environment variable.
    let output = silent_command(&shell)
        .args(["-l", "-i", "-c", "/usr/bin/printenv PATH"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                // Filter out /Volumes/ paths to avoid macOS TCC permission dialogs
                // for removable volumes (mounted DMGs, USB drives, network shares)
                // when Claude CLI or other subprocesses inherit this PATH
                let filtered_path: String = path
                    .split(':')
                    .filter(|p| !p.contains("/Volumes/"))
                    .collect::<Vec<_>>()
                    .join(":");
                std::env::set_var("PATH", &filtered_path);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse CLI arguments for headless mode
    let args: Vec<String> = std::env::args().collect();
    let headless = args.iter().any(|a| a == "--headless");

    // Fix PATH environment for macOS GUI applications
    // GUI apps don't inherit shell PATH - spawns login shell to get PATH from profiles
    #[cfg(target_os = "macos")]
    fix_macos_path();

    // FIX: Avoid WebKit GBM buffer errors on Linux (especially NVIDIA)
    //
    // This issue occurs when using transparent windows with WebKitGTK on Linux,
    // particularly with NVIDIA GPUs. The error "Failed to create GBM buffer of size NxN: Invalid argument"
    // is caused by incompatibilities between hardware-accelerated compositing and certain
    // GPU drivers/compositors.
    //
    // Related issues:
    // - https://github.com/tauri-apps/tauri/issues/13493
    // - https://github.com/tauri-apps/tauri/issues/8254
    // - https://bugs.webkit.org/show_bug.cgi?id=165246
    // - https://github.com/tauri-apps/tauri/issues/9394 (NVIDIA problems doc)
    //
    // The fix disables problematic GPU compositing modes. Users can override via env vars:
    // - JEAN_FORCE_X11=1 to force X11 backend in non-AppImage runs (default: no)
    // - WEBKIT_DISABLE_COMPOSITING_MODE=0 to re-enable GPU compositing (risky)
    #[cfg(target_os = "linux")]
    {
        log::trace!("Setting WebKit compatibility fixes for Linux");

        // Detect if running inside an AppImage
        let is_appimage =
            std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some();
        if is_appimage {
            log::trace!("Running inside AppImage");
        }

        // Detect Wayland compositor type
        let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
        let xdg_session_type = std::env::var("XDG_SESSION_TYPE")
            .unwrap_or_default()
            .to_lowercase();
        let is_wayland = wayland_display.is_some() || xdg_session_type == "wayland";
        let compositor = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
        log::trace!(
            "Display: wayland={is_wayland}, compositor={compositor}, session={xdg_session_type}"
        );

        // Disable problematic GPU compositing modes
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            log::trace!("WEBKIT_DISABLE_COMPOSITING_MODE=1");
        }

        // Disable DMABUF renderer (common cause of GBM errors)
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            log::trace!("WEBKIT_DISABLE_DMABUF_RENDERER=1");
        }

        // Non-AppImage: Force X11 backend only if user explicitly requests it
        let force_x11 = std::env::var("JEAN_FORCE_X11").unwrap_or_else(|_| "0".to_string()) == "1";
        if force_x11 && is_appimage {
            log::trace!(
                "JEAN_FORCE_X11 requested but ignored in AppImage (AppRun/apprun-hooks control backend)"
            );
        }
        if !is_appimage && force_x11 && std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
            log::trace!("GDK_BACKEND=x11 (forced by JEAN_FORCE_X11)");
        }
    }

    // Build log targets conditionally (skip webview in headless mode)
    let mut log_targets = vec![tauri_plugin_log::Target::new(
        tauri_plugin_log::TargetKind::Stdout,
    )];
    if !headless {
        log_targets.push(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Webview,
        ));
    }
    #[cfg(target_os = "macos")]
    log_targets.push(tauri_plugin_log::Target::new(
        tauri_plugin_log::TargetKind::LogDir { file_name: None },
    ));

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Use Debug level in development, Info in production
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                // Silence noisy external crates
                .level_for("globset", log::LevelFilter::Warn)
                .level_for("ignore", log::LevelFilter::Warn)
                .level_for("tauri_plugin_updater", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Debug)
                .targets(log_targets)
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            log::trace!("🚀 Application starting up");
            log::trace!(
                "App handle initialized for package: {}",
                app.package_info().name
            );

            // In headless mode, close the window immediately
            if headless {
                log::info!("Running in headless mode");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }

            // Recover any incomplete runs from previous session (crash recovery)
            let app_handle = app.handle().clone();
            match chat::run_log::recover_incomplete_runs(&app_handle) {
                Ok(recovered) => {
                    if !recovered.is_empty() {
                        log::trace!(
                            "Recovered {} incomplete run(s) from previous session",
                            recovered.len()
                        );
                        // Emit event to frontend about recovered runs
                        if let Err(e) = app_handle.emit("runs:recovered", &recovered) {
                            log::warn!("Failed to emit runs:recovered event: {e}");
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to recover incomplete runs: {e}");
                }
            }

            // Skip menu creation in headless mode (no window to attach to)
            #[cfg(target_os = "macos")]
            if !headless {
                log::trace!("Creating macOS app menu");
                if let Err(e) = create_app_menu(app) {
                    log::error!("Failed to create app menu: {e}");
                    return Err(e);
                }
            }

            #[cfg(target_os = "macos")]
            if !headless {
                // Set up menu event handlers
                app.on_menu_event(move |app, event| {
                    log::trace!("Menu event received: {:?}", event.id());

                    match event.id().as_ref() {
                        "about" => {
                            log::trace!("About menu item clicked");
                            // Emit event to React for handling
                            match app.emit("menu-about", ()) {
                                Ok(_) => log::trace!("Successfully emitted menu-about event"),
                                Err(e) => log::error!("Failed to emit menu-about event: {e}"),
                            }
                        }
                        "check-updates" => {
                            log::trace!("Check for Updates menu item clicked");
                            // Emit event to React for handling
                            match app.emit("menu-check-updates", ()) {
                                Ok(_) => {
                                    log::trace!("Successfully emitted menu-check-updates event")
                                }
                                Err(e) => {
                                    log::error!("Failed to emit menu-check-updates event: {e}")
                                }
                            }
                        }
                        "preferences" => {
                            log::trace!("Preferences menu item clicked");
                            // Emit event to React for handling
                            match app.emit("menu-preferences", ()) {
                                Ok(_) => log::trace!("Successfully emitted menu-preferences event"),
                                Err(e) => log::error!("Failed to emit menu-preferences event: {e}"),
                            }
                        }
                        "toggle-left-sidebar" => {
                            log::trace!("Toggle Left Sidebar menu item clicked");
                            // Emit event to React for handling
                            match app.emit("menu-toggle-left-sidebar", ()) {
                                Ok(_) => {
                                    log::trace!(
                                        "Successfully emitted menu-toggle-left-sidebar event"
                                    )
                                }
                                Err(e) => {
                                    log::error!(
                                        "Failed to emit menu-toggle-left-sidebar event: {e}"
                                    )
                                }
                            }
                        }
                        "toggle-right-sidebar" => {
                            log::trace!("Toggle Right Sidebar menu item clicked");
                            // Emit event to React for handling
                            match app.emit("menu-toggle-right-sidebar", ()) {
                                Ok(_) => {
                                    log::trace!(
                                        "Successfully emitted menu-toggle-right-sidebar event"
                                    )
                                }
                                Err(e) => {
                                    log::error!(
                                        "Failed to emit menu-toggle-right-sidebar event: {e}"
                                    )
                                }
                            }
                        }
                        _ => {
                            log::trace!("Unhandled menu event: {:?}", event.id());
                        }
                    }
                });
            }

            // Initialize background task manager
            let task_manager = background_tasks::BackgroundTaskManager::new(app.handle().clone());
            task_manager.start();
            app.manage(task_manager);
            log::trace!("Background task manager initialized");

            // Initialize HTTP server infrastructure
            let (broadcaster, _) = http_server::WsBroadcaster::new();
            app.manage(broadcaster);
            app.manage(std::sync::Arc::new(tokio::sync::Mutex::new(
                None::<http_server::server::HttpServerHandle>,
            )));
            log::trace!("HTTP server infrastructure initialized");

            // Start HTTP server (always in headless mode, or if auto-start configured)
            let app_handle_http = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match load_preferences(app_handle_http.clone()).await {
                    Ok(prefs) if headless || prefs.http_server_auto_start => {
                        let port = prefs.http_server_port;
                        log::info!("Starting HTTP server on port {port}");
                        match start_http_server_headless(
                            app_handle_http,
                            port,
                            headless, // In headless mode, bind to 0.0.0.0
                        )
                        .await
                        {
                            Ok(status) => {
                                let url = status.url.unwrap_or_default();
                                let token = status.token.unwrap_or_default();
                                log::info!("HTTP server started: {url}");
                                if headless {
                                    // Print to stdout for scripts/users to capture
                                    println!("\n╔══════════════════════════════════════════════════════════════╗");
                                    println!("║  Jean server running in headless mode                        ║");
                                    println!("╠══════════════════════════════════════════════════════════════╣");
                                    println!("║  URL: {url:<54} ║");
                                    println!("║  Token: {token:<52} ║");
                                    println!("║                                                              ║");
                                    println!("║  Open in browser: {url}?token={token}");
                                    println!("╚══════════════════════════════════════════════════════════════╝\n");
                                }
                            }
                            Err(e) => {
                                log::error!("Failed to start HTTP server: {e}");
                                if headless {
                                    eprintln!("Error: Failed to start HTTP server: {e}");
                                    std::process::exit(1);
                                }
                            }
                        }
                    }
                    Ok(_) => {
                        // Not headless and auto-start not configured
                    }
                    Err(e) => {
                        log::error!("Failed to load preferences: {e}");
                        if headless {
                            eprintln!("Error: Failed to load preferences: {e}");
                            std::process::exit(1);
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            load_preferences,
            save_preferences,
            save_cli_profile,
            delete_cli_profile,
            load_ui_state,
            save_ui_state,
            send_native_notification,
            save_emergency_data,
            load_emergency_data,
            cleanup_old_recovery_files,
            // Project management commands
            projects::check_git_identity,
            projects::set_git_identity,
            projects::list_projects,
            projects::add_project,
            projects::init_git_in_folder,
            projects::init_project,
            projects::remove_project,
            projects::list_worktrees,
            projects::get_worktree,
            projects::create_worktree,
            projects::create_worktree_from_existing_branch,
            projects::checkout_pr,
            projects::delete_worktree,
            projects::create_base_session,
            projects::close_base_session,
            projects::close_base_session_clean,
            projects::close_base_session_archive,
            projects::archive_worktree,
            projects::unarchive_worktree,
            projects::list_archived_worktrees,
            projects::import_worktree,
            projects::permanently_delete_worktree,
            projects::cleanup_old_archives,
            projects::delete_all_archives,
            projects::rename_worktree,
            projects::open_worktree_in_finder,
            projects::open_project_worktrees_folder,
            projects::open_worktree_in_terminal,
            projects::open_worktree_in_editor,
            projects::open_pull_request,
            projects::create_pr_with_ai_content,
            projects::generate_pr_update_content,
            projects::update_pr_description,
            projects::create_commit_with_ai,
            projects::run_review_with_ai,
            projects::cancel_review_with_ai,
            projects::list_github_releases,
            projects::generate_release_notes,
            projects::commit_changes,
            projects::open_project_on_github,
            projects::open_branch_on_github,
            projects::get_git_remotes,
            projects::get_github_remotes,
            projects::get_github_branch_url,
            projects::get_github_repo_url,
            projects::list_worktree_files,
            projects::get_project_branches,
            projects::update_project_settings,
            projects::get_jean_config,
            projects::save_jean_config,
            projects::get_pr_prompt,
            projects::get_review_prompt,
            projects::save_worktree_pr,
            projects::clear_worktree_pr,
            projects::update_worktree_cached_status,
            projects::rebase_worktree,
            projects::has_uncommitted_changes,
            projects::get_git_diff,
            projects::git_pull,
            projects::git_stash,
            projects::git_stash_pop,
            projects::git_push,
            projects::merge_worktree_to_base,
            projects::get_merge_conflicts,
            projects::fetch_and_merge_base,
            projects::reorder_projects,
            projects::reorder_worktrees,
            projects::fetch_worktrees_status,
            // Claude CLI skills & commands
            projects::list_claude_skills,
            projects::list_claude_commands,
            // GitHub issues commands
            projects::list_github_issues,
            projects::search_github_issues,
            projects::get_github_issue,
            projects::get_github_issue_by_number,
            projects::load_issue_context,
            projects::list_loaded_issue_contexts,
            projects::remove_issue_context,
            // GitHub PR commands
            projects::list_github_prs,
            projects::search_github_prs,
            projects::get_github_pr,
            projects::get_github_pr_by_number,
            projects::load_pr_context,
            projects::list_loaded_pr_contexts,
            projects::remove_pr_context,
            projects::get_pr_context_content,
            projects::get_issue_context_content,
            // GitHub Actions commands
            projects::list_workflow_runs,
            // Saved context commands
            projects::attach_saved_context,
            projects::remove_saved_context,
            projects::list_attached_saved_contexts,
            projects::get_saved_context_content,
            // Folder commands
            projects::create_folder,
            projects::rename_folder,
            projects::delete_folder,
            projects::move_item,
            projects::reorder_items,
            // Avatar commands
            projects::set_project_avatar,
            projects::remove_project_avatar,
            projects::get_app_data_dir,
            // Terminal commands
            terminal::start_terminal,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::stop_terminal,
            terminal::get_active_terminals,
            terminal::has_active_terminal,
            terminal::get_run_script,
            terminal::kill_all_terminals,
            // Chat commands - Session management
            chat::get_sessions,
            chat::list_all_sessions,
            chat::get_session,
            chat::create_session,
            chat::rename_session,
            chat::regenerate_session_name,
            chat::update_session_state,
            chat::close_session,
            chat::archive_session,
            chat::unarchive_session,
            chat::restore_session_with_base,
            chat::delete_archived_session,
            chat::list_archived_sessions,
            chat::list_all_archived_sessions,
            chat::reorder_sessions,
            chat::set_active_session,
            // Chat commands - Session-based messaging
            chat::send_chat_message,
            chat::get_mcp_servers,
            chat::check_mcp_health,
            chat::clear_session_history,
            chat::set_session_model,
            chat::set_session_backend,
            chat::set_session_thinking_level,
            chat::set_session_provider,
            chat::cancel_chat_message,
            chat::has_running_sessions,
            chat::save_cancelled_message,
            chat::mark_plan_approved,
            chat::approve_codex_command,
            // Chat commands - Image handling
            chat::save_pasted_image,
            chat::save_dropped_image,
            chat::delete_pasted_image,
            // Chat commands - Text paste handling
            chat::save_pasted_text,
            chat::delete_pasted_text,
            chat::read_pasted_text,
            // Chat commands - Plan file handling
            chat::read_plan_file,
            // Chat commands - File content preview/edit
            chat::read_file_content,
            chat::write_file_content,
            chat::open_file_in_default_app,
            // Chat commands - Saved context handling
            chat::list_saved_contexts,
            chat::save_context_file,
            chat::read_context_file,
            chat::delete_context_file,
            chat::rename_saved_context,
            chat::generate_context_from_session,
            // Chat commands - Session digest (context recall)
            chat::generate_session_digest,
            chat::update_session_digest,
            // Chat commands - Real-time setting sync
            chat::broadcast_session_setting,
            // Chat commands - Debug info
            chat::get_session_debug_info,
            // Chat commands - Session resume (detached process recovery)
            chat::resume_session,
            chat::check_resumable_sessions,
            // Claude CLI management commands
            claude_cli::check_claude_cli_installed,
            claude_cli::check_claude_cli_auth,
            claude_cli::get_available_cli_versions,
            claude_cli::install_claude_cli,
            // Codex CLI management commands
            codex_cli::check_codex_cli_installed,
            codex_cli::check_codex_cli_auth,
            codex_cli::get_available_codex_versions,
            codex_cli::install_codex_cli,
            // OpenCode CLI management commands
            opencode_cli::check_opencode_cli_installed,
            opencode_cli::check_opencode_cli_auth,
            opencode_cli::get_available_opencode_versions,
            opencode_cli::install_opencode_cli,
            opencode_cli::list_opencode_models,
            // GitHub CLI management commands
            gh_cli::check_gh_cli_installed,
            gh_cli::check_gh_cli_auth,
            gh_cli::get_available_gh_versions,
            gh_cli::install_gh_cli,
            // Background task commands
            background_tasks::commands::set_app_focus_state,
            background_tasks::commands::set_active_worktree_for_polling,
            background_tasks::commands::set_pr_worktrees_for_polling,
            background_tasks::commands::set_all_worktrees_for_polling,
            background_tasks::commands::set_git_poll_interval,
            background_tasks::commands::get_git_poll_interval,
            background_tasks::commands::trigger_immediate_git_poll,
            background_tasks::commands::set_remote_poll_interval,
            background_tasks::commands::get_remote_poll_interval,
            background_tasks::commands::trigger_immediate_remote_poll,
            // HTTP server commands
            start_http_server,
            stop_http_server,
            get_http_server_status,
            regenerate_http_token,
            // OpenCode server commands
            opencode_server::start_opencode_server,
            opencode_server::stop_opencode_server,
            opencode_server::get_opencode_server_status,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(move |_app_handle, event| match &event {
            tauri::RunEvent::Exit => {
                eprintln!("[TERMINAL CLEANUP] RunEvent::Exit received");
                let killed = terminal::cleanup_all_terminals();
                eprintln!("[TERMINAL CLEANUP] Killed {killed} terminal(s)");
                match opencode_server::shutdown_managed_server() {
                    Ok(true) => eprintln!("[OPENCODE CLEANUP] Stopped managed OpenCode server"),
                    Ok(false) => {}
                    Err(e) => eprintln!("[OPENCODE CLEANUP] Failed during Exit: {e}"),
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } => {
                // In headless mode, prevent exit when window closes
                if headless {
                    api.prevent_exit();
                    return;
                }
                eprintln!("[TERMINAL CLEANUP] RunEvent::ExitRequested received");
                let killed = terminal::cleanup_all_terminals();
                eprintln!("[TERMINAL CLEANUP] Killed {killed} terminal(s) on ExitRequested");
                match opencode_server::shutdown_managed_server() {
                    Ok(true) => eprintln!(
                        "[OPENCODE CLEANUP] Stopped managed OpenCode server on ExitRequested"
                    ),
                    Ok(false) => {}
                    Err(e) => {
                        eprintln!("[OPENCODE CLEANUP] Failed during ExitRequested: {e}")
                    }
                }
            }
            tauri::RunEvent::WindowEvent { label, event, .. } => {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    // In headless mode, we already closed the window, don't cleanup terminals
                    if headless {
                        return;
                    }
                    eprintln!("[TERMINAL CLEANUP] Window {label} close requested");
                    let killed = terminal::cleanup_all_terminals();
                    eprintln!("[TERMINAL CLEANUP] Killed {killed} terminal(s) on CloseRequested");
                    match opencode_server::shutdown_managed_server() {
                        Ok(true) => eprintln!(
                            "[OPENCODE CLEANUP] Stopped managed OpenCode server on CloseRequested"
                        ),
                        Ok(false) => {}
                        Err(e) => {
                            eprintln!("[OPENCODE CLEANUP] Failed during CloseRequested: {e}")
                        }
                    }
                }
                if let tauri::WindowEvent::Destroyed = event {
                    eprintln!("[TERMINAL CLEANUP] Window {label} destroyed");
                }
            }
            _ => {}
        });
}
