use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

mod ai_cli;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

mod background_tasks;
mod chat;
mod claude_cli;
mod gh_cli;
mod glab_cli;
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
    #[serde(default = "default_terminal")]
    pub terminal: String, // Terminal app: terminal, warp, ghostty
    #[serde(default = "default_editor")]
    pub editor: String, // Editor app: vscode, cursor, xcode
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
    #[serde(default = "default_session_grouping_enabled")]
    pub session_grouping_enabled: bool, // Group session tabs by status when >3 sessions
    #[serde(default = "default_syntax_theme_dark")]
    pub syntax_theme_dark: String, // Syntax highlighting theme for dark mode
    #[serde(default = "default_syntax_theme_light")]
    pub syntax_theme_light: String, // Syntax highlighting theme for light mode
    #[serde(default = "default_disable_thinking_in_non_plan_modes")]
    pub disable_thinking_in_non_plan_modes: bool, // Disable thinking in build/yolo modes (only plan uses thinking)
    #[serde(default = "default_session_recap_enabled")]
    pub session_recap_enabled: bool, // Show session recap when returning to unfocused sessions
    #[serde(default = "default_session_recap_model")]
    pub session_recap_model: String, // Model for generating session recaps: haiku, sonnet, opus
    #[serde(default = "default_parallel_execution_prompt_enabled")]
    pub parallel_execution_prompt_enabled: bool, // Add system prompt to encourage parallel sub-agent execution
    #[serde(default)]
    pub magic_prompts: MagicPrompts, // Customizable prompts for AI-powered features
    #[serde(default)]
    pub magic_prompt_models: MagicPromptModels, // Per-prompt model overrides
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
    pub workspace_folder: String, // Base folder for worktrees (empty = default ~/jean/)
    #[serde(default = "default_ai_provider")]
    pub default_ai_provider: String, // Default AI CLI provider: claude, gemini, codex
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

fn default_session_grouping_enabled() -> bool {
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

fn default_terminal() -> String {
    "terminal".to_string()
}

fn default_editor() -> String {
    "vscode".to_string()
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
    30 // Keep archived items for 30 days by default
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

fn default_disable_thinking_in_non_plan_modes() -> bool {
    true // Enabled by default: only plan mode uses thinking
}

fn default_session_recap_enabled() -> bool {
    false // Disabled by default (experimental)
}

fn default_session_recap_model() -> String {
    "haiku".to_string() // Use Haiku by default for fast, cheap session recap generation
}

fn default_parallel_execution_prompt_enabled() -> bool {
    false // Disabled by default (experimental)
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

fn default_ai_provider() -> String {
    "claude".to_string() // Claude is the default AI provider
}

// =============================================================================
// Magic Prompts - Customizable prompts for AI-powered features
// =============================================================================

/// Customizable prompts for AI-powered features
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MagicPrompts {
    #[serde(default = "default_investigate_issue_prompt")]
    pub investigate_issue: String,
    #[serde(default = "default_investigate_pr_prompt")]
    pub investigate_pr: String,
    #[serde(default = "default_pr_content_prompt")]
    pub pr_content: String,
    #[serde(default = "default_commit_message_prompt")]
    pub commit_message: String,
    #[serde(default = "default_code_review_prompt")]
    pub code_review: String,
    #[serde(default = "default_context_summary_prompt")]
    pub context_summary: String,
    #[serde(default = "default_resolve_conflicts_prompt")]
    pub resolve_conflicts: String,
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
5. Identify action items from reviewer feedback
6. Propose next steps to get the PR merged

</instructions>


<guidelines>

- Be thorough but focused
- Pay attention to reviewer feedback and requested changes
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
- Security vulnerabilities
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

/// Per-prompt model overrides for magic prompts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MagicPromptModels {
    #[serde(default = "default_model")]
    pub investigate_model: String,
    #[serde(default = "default_haiku_model")]
    pub pr_content_model: String,
    #[serde(default = "default_haiku_model")]
    pub commit_message_model: String,
    #[serde(default = "default_haiku_model")]
    pub code_review_model: String,
    #[serde(default = "default_model")]
    pub context_summary_model: String,
    #[serde(default = "default_model")]
    pub resolve_conflicts_model: String,
}

fn default_haiku_model() -> String {
    "haiku".to_string()
}

impl Default for MagicPromptModels {
    fn default() -> Self {
        Self {
            investigate_model: default_model(),
            pr_content_model: default_haiku_model(),
            commit_message_model: default_haiku_model(),
            code_review_model: default_haiku_model(),
            context_summary_model: default_model(),
            resolve_conflicts_model: default_model(),
        }
    }
}

impl Default for MagicPrompts {
    fn default() -> Self {
        Self {
            investigate_issue: default_investigate_issue_prompt(),
            investigate_pr: default_investigate_pr_prompt(),
            pr_content: default_pr_content_prompt(),
            commit_message: default_commit_message_prompt(),
            code_review: default_code_review_prompt(),
            context_summary: default_context_summary_prompt(),
            resolve_conflicts: default_resolve_conflicts_prompt(),
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
            session_grouping_enabled: default_session_grouping_enabled(),
            syntax_theme_dark: default_syntax_theme_dark(),
            syntax_theme_light: default_syntax_theme_light(),
            disable_thinking_in_non_plan_modes: default_disable_thinking_in_non_plan_modes(),
            session_recap_enabled: default_session_recap_enabled(),
            session_recap_model: default_session_recap_model(),
            parallel_execution_prompt_enabled: default_parallel_execution_prompt_enabled(),
            magic_prompts: MagicPrompts::default(),
            magic_prompt_models: MagicPromptModels::default(),
            file_edit_mode: default_file_edit_mode(),
            ai_language: String::new(),
            allow_web_tools_in_plan_mode: default_allow_web_tools_in_plan_mode(),
            waiting_sound: default_waiting_sound(),
            review_sound: default_review_sound(),
            workspace_folder: String::new(),
            default_ai_provider: default_ai_provider(),
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

    /// Left sidebar visibility, defaults to true
    #[serde(default)]
    pub left_sidebar_visible: Option<bool>,

    /// Active session ID per worktree (for restoring open tabs)
    #[serde(default)]
    pub active_session_ids: std::collections::HashMap<String, String>,

    /// AI review results per worktree: worktreeId → ReviewResponse JSON
    #[serde(default)]
    pub review_results: std::collections::HashMap<String, serde_json::Value>,

    /// Whether viewing review tab per worktree: worktreeId → viewing
    #[serde(default)]
    pub viewing_review_tab: std::collections::HashMap<String, bool>,

    /// Fixed AI review findings per worktree: worktreeId → array of fixed findingKeys
    #[serde(default)]
    pub fixed_review_findings: std::collections::HashMap<String, Vec<String>>,

    /// Session IDs that completed while out of focus, need digest on open
    #[serde(default)]
    pub pending_digest_session_ids: Vec<String>,

    /// Version for future migration support
    #[serde(default = "default_ui_state_version")]
    pub version: u32,
}

fn default_ui_state_version() -> u32 {
    1
}

impl Default for UIState {
    fn default() -> Self {
        Self {
            active_worktree_id: None,
            active_worktree_path: None,
            active_project_id: None,
            expanded_project_ids: Vec::new(),
            expanded_folder_ids: Vec::new(),
            left_sidebar_size: None,
            left_sidebar_visible: None,
            active_session_ids: std::collections::HashMap::new(),
            review_results: std::collections::HashMap::new(),
            viewing_review_tab: std::collections::HashMap::new(),
            fixed_review_findings: std::collections::HashMap::new(),
            pending_digest_session_ids: Vec::new(),
            version: default_ui_state_version(),
        }
    }
}

fn get_preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
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

    let preferences: AppPreferences = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse preferences JSON: {e}");
        format!("Failed to parse preferences: {e}")
    })?;

    log::trace!("Successfully loaded preferences");
    Ok(preferences)
}

#[tauri::command]
async fn save_preferences(app: AppHandle, preferences: AppPreferences) -> Result<(), String> {
    // Validate theme value
    validate_theme(&preferences.theme)?;

    log::trace!("Saving preferences to disk: {preferences:?}");
    let prefs_path = get_preferences_path(&app)?;

    let json_content = serde_json::to_string_pretty(&preferences).map_err(|e| {
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

    // Build the Git submenu
    // Note: Accelerators removed since keybindings are user-configurable in preferences
    let git_submenu = SubmenuBuilder::new(app, "Git")
        .item(&MenuItemBuilder::with_id("open-pull-request", "Open Pull Request...").build(app)?)
        .build()?;

    // Build the main menu with submenus
    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&git_submenu)
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
    use std::process::Command;

    // Get user's shell from $SHELL, default to zsh (macOS default since Catalina)
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Spawn a login (-l) + interactive (-i) shell to source all config files
    // including .zshrc where tools like bun, nvm add their PATH entries
    let output = Command::new(&shell)
        .args(["-l", "-i", "-c", "echo $PATH"])
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
    // - JEAN_FORCE_X11=1 to force X11 backend (default: no)
    // - WEBKIT_DISABLE_COMPOSITING_MODE=0 to re-enable GPU compositing (risky)
    #[cfg(target_os = "linux")]
    {
        log::trace!("Setting WebKit compatibility fixes for Linux");
        
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
        
        // Force X11 backend if Wayland causes issues
        // Check if user explicitly wants Wayland via environment variable
        let force_x11 = std::env::var("JEAN_FORCE_X11")
            .unwrap_or_else(|_| "0".to_string()) == "1";
        if force_x11 && std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
            log::trace!("GDK_BACKEND=x11 (forced by JEAN_FORCE_X11)");
        }
    }

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
                .targets([
                    // Always log to stdout for development
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // Log to webview console for development
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                    // Log to system logs on macOS (appears in Console.app)
                    #[cfg(target_os = "macos")]
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            log::trace!("🚀 Application starting up");
            log::trace!(
                "App handle initialized for package: {}",
                app.package_info().name
            );

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

            #[cfg(target_os = "macos")]
            {
                log::trace!("Creating macOS app menu");
                if let Err(e) = create_app_menu(app) {
                    log::error!("Failed to create app menu: {e}");
                    return Err(e);
                }
            }

            #[cfg(target_os = "macos")]
            {
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
                            Ok(_) => log::trace!("Successfully emitted menu-check-updates event"),
                            Err(e) => log::error!("Failed to emit menu-check-updates event: {e}"),
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
                                log::trace!("Successfully emitted menu-toggle-left-sidebar event")
                            }
                            Err(e) => {
                                log::error!("Failed to emit menu-toggle-left-sidebar event: {e}")
                            }
                        }
                    }
                    "toggle-right-sidebar" => {
                        log::trace!("Toggle Right Sidebar menu item clicked");
                        // Emit event to React for handling
                        match app.emit("menu-toggle-right-sidebar", ()) {
                            Ok(_) => {
                                log::trace!("Successfully emitted menu-toggle-right-sidebar event")
                            }
                            Err(e) => {
                                log::error!("Failed to emit menu-toggle-right-sidebar event: {e}")
                            }
                        }
                    }
                    "open-pull-request" => {
                        log::trace!("Open Pull Request menu item clicked");
                        // Emit event to React for handling
                        match app.emit("menu-open-pull-request", ()) {
                            Ok(_) => {
                                log::trace!("Successfully emitted menu-open-pull-request event")
                            }
                            Err(e) => {
                                log::error!("Failed to emit menu-open-pull-request event: {e}")
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            load_preferences,
            save_preferences,
            load_ui_state,
            save_ui_state,
            send_native_notification,
            save_emergency_data,
            load_emergency_data,
            cleanup_old_recovery_files,
            // Project management commands
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
            projects::create_commit_with_ai,
            projects::run_review_with_ai,
            projects::commit_changes,
            projects::open_project_on_github,
            projects::list_worktree_files,
            projects::get_project_branches,
            projects::update_project_settings,
            projects::get_pr_prompt,
            projects::get_review_prompt,
            projects::save_worktree_pr,
            projects::clear_worktree_pr,
            projects::update_worktree_cached_status,
            projects::rebase_worktree,
            projects::has_uncommitted_changes,
            projects::get_git_diff,
            projects::git_pull,
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
            projects::load_issue_context,
            projects::list_loaded_issue_contexts,
            projects::remove_issue_context,
            // GitHub PR commands
            projects::list_github_prs,
            projects::search_github_prs,
            projects::get_github_pr,
            projects::load_pr_context,
            projects::list_loaded_pr_contexts,
            projects::remove_pr_context,
            projects::get_pr_context_content,
            projects::get_issue_context_content,
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
            chat::clear_session_history,
            chat::set_session_model,
            chat::set_session_thinking_level,
            chat::cancel_chat_message,
            chat::has_running_sessions,
            chat::save_cancelled_message,
            chat::mark_plan_approved,
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
            // GitHub CLI management commands
            gh_cli::check_gh_cli_installed,
            gh_cli::check_gh_cli_auth,
            gh_cli::get_available_gh_versions,
            gh_cli::install_gh_cli,
            // GitLab CLI management commands
            glab_cli::check_glab_cli_installed,
            glab_cli::check_glab_cli_auth,
            glab_cli::get_available_glab_versions,
            glab_cli::install_glab_cli,
            // Gemini CLI management commands
            ai_cli::gemini::commands::check_gemini_cli_installed,
            ai_cli::gemini::commands::check_gemini_cli_auth,
            ai_cli::gemini::commands::install_gemini_cli,
            // Codex CLI management commands
            ai_cli::codex::commands::check_codex_cli_installed,
            ai_cli::codex::commands::check_codex_cli_auth,
            ai_cli::codex::commands::install_codex_cli,
            // GitLab issues/MRs commands
            projects::list_gitlab_issues,
            projects::get_gitlab_issue,
            projects::list_gitlab_mrs,
            projects::get_gitlab_mr,
            projects::load_gitlab_issue_context,
            projects::load_gitlab_mr_context,
            projects::remove_gitlab_issue_context,
            projects::remove_gitlab_mr_context,
            projects::list_loaded_gitlab_issue_contexts,
            projects::list_loaded_gitlab_mr_contexts,
            projects::get_gitlab_issue_context_content,
            projects::get_gitlab_mr_context_content,
            projects::open_merge_request,
            projects::checkout_gitlab_mr,
            // Background task commands
            background_tasks::commands::set_app_focus_state,
            background_tasks::commands::set_active_worktree_for_polling,
            background_tasks::commands::set_git_poll_interval,
            background_tasks::commands::get_git_poll_interval,
            background_tasks::commands::trigger_immediate_git_poll,
            background_tasks::commands::set_remote_poll_interval,
            background_tasks::commands::get_remote_poll_interval,
            background_tasks::commands::trigger_immediate_remote_poll,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|_app_handle, event| match &event {
            tauri::RunEvent::Exit => {
                eprintln!("[TERMINAL CLEANUP] RunEvent::Exit received");
                let killed = terminal::cleanup_all_terminals();
                eprintln!("[TERMINAL CLEANUP] Killed {killed} terminal(s)");
            }
            tauri::RunEvent::ExitRequested { .. } => {
                eprintln!("[TERMINAL CLEANUP] RunEvent::ExitRequested received");
                let killed = terminal::cleanup_all_terminals();
                eprintln!("[TERMINAL CLEANUP] Killed {killed} terminal(s) on ExitRequested");
            }
            tauri::RunEvent::WindowEvent { label, event, .. } => {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    eprintln!("[TERMINAL CLEANUP] Window {label} close requested");
                    let killed = terminal::cleanup_all_terminals();
                    eprintln!("[TERMINAL CLEANUP] Killed {killed} terminal(s) on CloseRequested");
                }
                if let tauri::WindowEvent::Destroyed = event {
                    eprintln!("[TERMINAL CLEANUP] Window {label} destroyed");
                }
            }
            _ => {}
        });
}
