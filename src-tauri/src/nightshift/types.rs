use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Category of maintenance check
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CheckCategory {
    Lint,
    DeadCode,
    Documentation,
    Security,
    Tests,
    Dependencies,
    Performance,
    CodeQuality,
    TypeSafety,
    Configuration,
}

/// Cost tier for token budget awareness
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CostTier {
    Low,
    Medium,
    High,
}

/// A built-in maintenance check definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NightshiftCheck {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: CheckCategory,
    pub cost_tier: CostTier,
    /// Minimum hours between runs of this check
    pub cooldown_hours: u32,
    pub default_enabled: bool,
}

/// Per-check configuration overrides
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NightshiftCheckConfig {
    /// Custom prompt override (None = use built-in default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_prompt: Option<String>,
    /// Cooldown hours override (None = use built-in default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_hours_override: Option<u32>,
}

/// What to do after a nightshift run completes
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PostAction {
    /// Leave changes uncommitted in the worktree
    #[default]
    Nothing,
    /// Commit changes but don't create a PR
    Commit,
    /// Commit changes and create a PR
    CommitAndPr,
}

/// Per-project Nightshift configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NightshiftConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Check IDs to skip (empty = run all default-enabled)
    #[serde(default)]
    pub disabled_checks: Vec<String>,
    /// Additional check IDs to enable beyond defaults
    #[serde(default)]
    pub extra_enabled_checks: Vec<String>,
    /// Time of day to run (HH:MM format), None = manual only
    #[serde(default)]
    pub schedule_time: Option<String>,
    /// Target branch for PRs (defaults to project.default_branch)
    #[serde(default)]
    pub target_branch: Option<String>,
    /// Model override (None = use global preferences model)
    #[serde(default)]
    pub model: Option<String>,
    /// Custom provider profile name (None = use default)
    #[serde(default)]
    pub provider: Option<String>,
    /// Backend override (claude/codex/opencode, None = use project default)
    #[serde(default)]
    pub backend: Option<String>,
    /// What to do after a run completes
    #[serde(default)]
    pub post_action: PostAction,
    /// Per-check configuration overrides (check_id -> config)
    #[serde(default)]
    pub check_configs: HashMap<String, NightshiftCheckConfig>,
}

/// Status of a Nightshift run
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Running,
    Completed,
    PartiallyCompleted,
    Failed,
    Cancelled,
}

/// Result of a single check execution within a run
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub check_id: String,
    pub status: RunStatus,
    /// The session that was created for this check
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub duration_secs: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What triggered the run
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunTrigger {
    Manual,
    Scheduled,
}

/// A complete Nightshift run record
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NightshiftRun {
    pub id: String,
    pub project_id: String,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    pub status: RunStatus,
    pub trigger: RunTrigger,
    pub check_results: Vec<CheckResult>,
    /// Worktree created for this run
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    /// Path to the worktree
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// Branch name of the worktree
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u32>,
}

// ============================================================================
// Event payloads
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStartedEvent {
    pub run_id: String,
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckStartedEvent {
    pub run_id: String,
    pub check_id: String,
    pub check_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDoneEvent {
    pub run_id: String,
    pub check_id: String,
    pub status: RunStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCompletedEvent {
    pub run_id: String,
    pub project_id: String,
    pub status: RunStatus,
    pub total_checks: usize,
    pub worktree_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFailedEvent {
    pub run_id: String,
    pub project_id: String,
    pub error: String,
}

/// Event telling frontend to execute a check by sending a message in a session
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteCheckEvent {
    pub run_id: String,
    pub project_id: String,
    pub check_id: String,
    pub check_name: String,
    pub session_id: String,
    pub worktree_id: String,
    pub worktree_path: String,
    pub prompt: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub backend: Option<String>,
}

/// Completion info reported back from frontend
#[derive(Debug, Clone)]
pub struct CheckCompletion {
    pub session_id: String,
    pub success: bool,
    pub error: Option<String>,
}
