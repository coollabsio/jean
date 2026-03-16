use serde_json::Value;
use tauri::AppHandle;
use tauri::Manager;

use super::EmitExt;

/// Dispatch a command by name to the corresponding Rust handler.
/// This mirrors Tauri's invoke system but routes through WebSocket.
///
/// Each arm deserializes args from the JSON Value and calls the
/// existing command function directly, then serializes the result.
pub async fn dispatch_command(
    app: &AppHandle,
    command: &str,
    args: Value,
) -> Result<Value, String> {
    match command {
        // =====================================================================
        // Preferences & UI State
        // =====================================================================
        "load_preferences" => {
            let result = crate::load_preferences(app.clone()).await?;
            to_value(result)
        }
        "save_preferences" => {
            let preferences = from_field(&args, "preferences")?;
            crate::save_preferences(app.clone(), preferences).await?;
            emit_cache_invalidation(app, &["preferences"]);
            Ok(Value::Null)
        }
        "patch_preferences" => {
            let patch: Value = from_field(&args, "patch")?;
            crate::patch_preferences(app.clone(), patch).await?;
            emit_cache_invalidation(app, &["preferences"]);
            Ok(Value::Null)
        }
        "load_ui_state" => {
            let result = crate::load_ui_state(app.clone()).await?;
            to_value(result)
        }
        "save_ui_state" => {
            let ui_state = field(&args, "uiState", "ui_state")?;
            crate::save_ui_state(app.clone(), ui_state).await?;
            emit_cache_invalidation(app, &["ui-state"]);
            Ok(Value::Null)
        }

        // =====================================================================
        // Projects
        // =====================================================================
        "list_projects" => {
            let result = crate::projects::list_projects(app.clone()).await?;
            to_value(result)
        }
        "add_project" => {
            let path: String = from_field(&args, "path")?;
            let parent_id: Option<String> = field_opt(&args, "parentId", "parent_id")?;
            let result = crate::projects::add_project(app.clone(), path, parent_id).await?;
            to_value(result)
        }
        "remove_project" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            crate::projects::remove_project(app.clone(), project_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "list_worktrees" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::projects::list_worktrees(app.clone(), project_id).await?;
            to_value(result)
        }
        "get_worktree" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let result = crate::projects::get_worktree(app.clone(), worktree_id).await?;
            to_value(result)
        }
        "create_worktree" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let base_branch: Option<String> = field_opt(&args, "baseBranch", "base_branch")?;
            let issue_context = field_opt(&args, "issueContext", "issue_context")?;
            let pr_context = field_opt(&args, "prContext", "pr_context")?;
            let security_context = field_opt(&args, "securityContext", "security_context")?;
            let advisory_context = field_opt(&args, "advisoryContext", "advisory_context")?;
            let linear_context = field_opt(&args, "linearContext", "linear_context")?;
            let custom_name = field_opt(&args, "customName", "custom_name")?;
            let result = crate::projects::create_worktree(
                app.clone(),
                project_id,
                base_branch,
                issue_context,
                pr_context,
                security_context,
                advisory_context,
                linear_context,
                custom_name,
            )
            .await?;
            // No cache invalidation here — worktree creation uses event-based sync
            // (worktree:creating/created/error) that preserves the optimistic pending status.
            // Invalidating would refetch list_worktrees which overwrites status: 'pending',
            // preventing WorktreeSetupCard from appearing on the canvas.
            to_value(result)
        }
        "delete_worktree" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            crate::projects::delete_worktree(app.clone(), worktree_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "get_project_branches" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::projects::get_project_branches(app.clone(), project_id).await?;
            to_value(result)
        }
        "update_project_settings" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let default_branch: Option<String> =
                field_opt(&args, "defaultBranch", "default_branch")?;
            let result = crate::projects::update_project_settings(
                app.clone(),
                project_id,
                default_branch,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await?;
            to_value(result)
        }
        "reorder_projects" => {
            let project_ids: Vec<String> = field(&args, "projectIds", "project_ids")?;
            crate::projects::reorder_projects(app.clone(), project_ids).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "reorder_worktrees" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let worktree_ids: Vec<String> = field(&args, "worktreeIds", "worktree_ids")?;
            crate::projects::reorder_worktrees(app.clone(), project_id, worktree_ids).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "fetch_worktrees_status" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            crate::projects::fetch_worktrees_status(app.clone(), project_id).await?;
            to_value(())
        }
        "archive_worktree" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            crate::projects::archive_worktree(app.clone(), worktree_id).await?;
            Ok(Value::Null)
        }
        "unarchive_worktree" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let result = crate::projects::unarchive_worktree(app.clone(), worktree_id).await?;
            to_value(result)
        }
        "rename_worktree" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let new_name: String = field(&args, "newName", "new_name")?;
            let result =
                crate::projects::rename_worktree(app.clone(), worktree_id, new_name).await?;
            to_value(result)
        }
        "update_worktree_label" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let label: Option<crate::chat::types::LabelData> = field_opt(&args, "label", "label")?;
            crate::projects::update_worktree_label(app.clone(), worktree_id, label).await?;
            Ok(Value::Null)
        }
        "has_uncommitted_changes" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let result = crate::projects::has_uncommitted_changes(app.clone(), worktree_id).await?;
            to_value(result)
        }
        "get_git_diff" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let diff_type: String = field(&args, "diffType", "diff_type")?;
            let base_branch: Option<String> = field_opt(&args, "baseBranch", "base_branch")?;
            let result =
                crate::projects::get_git_diff(worktree_path, diff_type, base_branch).await?;
            to_value(result)
        }
        "get_commit_history" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let branch: Option<String> = field_opt(&args, "branch", "branch")?;
            let limit: Option<u32> = field_opt(&args, "limit", "limit")?;
            let skip: Option<u32> = field_opt(&args, "skip", "skip")?;
            let result =
                crate::projects::get_commit_history(worktree_path, branch, limit, skip).await?;
            to_value(result)
        }
        "get_commit_diff" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let commit_sha: String = field(&args, "commitSha", "commit_sha")?;
            let result = crate::projects::get_commit_diff(worktree_path, commit_sha).await?;
            to_value(result)
        }
        "get_repo_branches" => {
            let repo_path: String = field(&args, "repoPath", "repo_path")?;
            let result = crate::projects::get_repo_branches(repo_path).await?;
            to_value(result)
        }
        "git_pull" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let base_branch: String = field(&args, "baseBranch", "base_branch")?;
            let remote: Option<String> = field_opt(&args, "remote", "remote")?;
            let result = crate::projects::git_pull(worktree_path, base_branch, remote).await?;
            to_value(result)
        }
        "git_push" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let pr_number: Option<u32> = field_opt(&args, "prNumber", "pr_number")?;
            let remote: Option<String> = field_opt(&args, "remote", "remote")?;
            let result =
                crate::projects::git_push(app.clone(), worktree_path, pr_number, remote).await?;
            to_value(result)
        }
        "commit_changes" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let message: String = from_field(&args, "message")?;
            let stage_all: Option<bool> = field_opt(&args, "stageAll", "stage_all")?;
            let result =
                crate::projects::commit_changes(app.clone(), worktree_id, message, stage_all)
                    .await?;
            to_value(result)
        }
        "save_worktree_pr" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let pr_number: u32 = field(&args, "prNumber", "pr_number")?;
            let pr_url: String = field(&args, "prUrl", "pr_url")?;
            crate::projects::save_worktree_pr(app.clone(), worktree_id, pr_number, pr_url).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "detect_and_link_pr" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let result =
                crate::projects::detect_and_link_pr(app.clone(), worktree_id, worktree_path)
                    .await?;
            if result.is_some() {
                emit_cache_invalidation(app, &["projects"]);
            }
            to_value(result)
        }
        "clear_worktree_pr" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            crate::projects::clear_worktree_pr(app.clone(), worktree_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "create_pr_with_ai_content" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: Option<String> = field_opt(&args, "sessionId", "session_id")?;
            let magic_prompt: Option<String> = field_opt(&args, "magicPrompt", "magic_prompt")?;
            let model: Option<String> = from_field_opt(&args, "model")?;
            let custom_profile_name: Option<String> =
                field_opt(&args, "customProfileName", "custom_profile_name")?;
            let reasoning_effort: Option<String> =
                field_opt(&args, "reasoningEffort", "reasoning_effort")?;
            let result = crate::projects::create_pr_with_ai_content(
                app.clone(),
                worktree_path,
                session_id,
                magic_prompt,
                model,
                custom_profile_name,
                reasoning_effort,
            )
            .await?;
            to_value(result)
        }
        "merge_github_pr" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let result = crate::projects::merge_github_pr(app.clone(), worktree_path).await?;
            emit_cache_invalidation(app, &["projects"]);
            to_value(result)
        }
        "create_commit_with_ai" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let custom_prompt: Option<String> = field_opt(&args, "magicPrompt", "magic_prompt")?;
            let push: bool = from_field_opt(&args, "push")?.unwrap_or(false);
            let remote: Option<String> = from_field_opt(&args, "remote")?;
            let pr_number: Option<u32> = from_field_opt(&args, "prNumber")?;
            let model: Option<String> = from_field_opt(&args, "model")?;
            let custom_profile_name: Option<String> =
                field_opt(&args, "customProfileName", "custom_profile_name")?;
            let reasoning_effort: Option<String> =
                field_opt(&args, "reasoningEffort", "reasoning_effort")?;
            let result = crate::projects::create_commit_with_ai(
                app.clone(),
                worktree_path,
                custom_prompt,
                push,
                remote,
                pr_number,
                model,
                custom_profile_name,
                reasoning_effort,
            )
            .await?;
            to_value(result)
        }
        "revert_last_local_commit" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let result =
                crate::projects::revert_last_local_commit(worktree_path).await?;
            emit_cache_invalidation(app, &["projects"]);
            to_value(result)
        }
        "run_review_with_ai" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let magic_prompt: Option<String> = field_opt(&args, "magicPrompt", "magic_prompt")?;
            let model: Option<String> = from_field_opt(&args, "model")?;
            let custom_profile_name: Option<String> =
                field_opt(&args, "customProfileName", "custom_profile_name")?;
            let review_run_id: Option<String> = field_opt(&args, "reviewRunId", "review_run_id")?;
            let reasoning_effort: Option<String> =
                field_opt(&args, "reasoningEffort", "reasoning_effort")?;
            let result = crate::projects::run_review_with_ai(
                app.clone(),
                worktree_path,
                magic_prompt,
                model,
                custom_profile_name,
                review_run_id,
                reasoning_effort,
            )
            .await?;
            to_value(result)
        }
        "cancel_review_with_ai" => {
            let review_run_id: String = field(&args, "reviewRunId", "review_run_id")?;
            let result = crate::projects::cancel_review_with_ai(review_run_id).await?;
            to_value(result)
        }
        "update_worktree_cached_status" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let branch: Option<String> = field_opt(&args, "branch", "branch")?;
            let pr_status: Option<String> = field_opt(&args, "prStatus", "pr_status")?;
            let check_status: Option<String> = field_opt(&args, "checkStatus", "check_status")?;
            let behind_count: Option<u32> = field_opt(&args, "behindCount", "behind_count")?;
            let ahead_count: Option<u32> = field_opt(&args, "aheadCount", "ahead_count")?;
            let uncommitted_added: Option<u32> =
                field_opt(&args, "uncommittedAdded", "uncommitted_added")?;
            let uncommitted_removed: Option<u32> =
                field_opt(&args, "uncommittedRemoved", "uncommitted_removed")?;
            let branch_diff_added: Option<u32> =
                field_opt(&args, "branchDiffAdded", "branch_diff_added")?;
            let branch_diff_removed: Option<u32> =
                field_opt(&args, "branchDiffRemoved", "branch_diff_removed")?;
            let base_branch_ahead_count: Option<u32> =
                field_opt(&args, "baseBranchAheadCount", "base_branch_ahead_count")?;
            let base_branch_behind_count: Option<u32> =
                field_opt(&args, "baseBranchBehindCount", "base_branch_behind_count")?;
            let worktree_ahead_count: Option<u32> =
                field_opt(&args, "worktreeAheadCount", "worktree_ahead_count")?;
            let unpushed_count: Option<u32> = field_opt(&args, "unpushedCount", "unpushed_count")?;
            crate::projects::update_worktree_cached_status(
                app.clone(),
                worktree_id,
                branch,
                pr_status,
                check_status,
                behind_count,
                ahead_count,
                uncommitted_added,
                uncommitted_removed,
                branch_diff_added,
                branch_diff_removed,
                base_branch_ahead_count,
                base_branch_behind_count,
                worktree_ahead_count,
                unpushed_count,
            )
            .await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "list_worktree_files" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let max_files: Option<usize> = field_opt(&args, "maxFiles", "max_files")?;
            let result = crate::projects::list_worktree_files(worktree_path, max_files).await?;
            to_value(result)
        }

        // =====================================================================
        // GitHub Issues & PRs
        // =====================================================================
        "list_github_issues" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let state: Option<String> = from_field_opt(&args, "state")?;
            let result =
                crate::projects::list_github_issues(app.clone(), project_path, state).await?;
            to_value(result)
        }
        "get_github_issue" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let issue_number: u32 = field(&args, "issueNumber", "issue_number")?;
            let result =
                crate::projects::get_github_issue(app.clone(), project_path, issue_number).await?;
            to_value(result)
        }
        "list_github_prs" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let state: Option<String> = from_field_opt(&args, "state")?;
            let result = crate::projects::list_github_prs(app.clone(), project_path, state).await?;
            to_value(result)
        }
        "get_github_pr" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let pr_number: u32 = field(&args, "prNumber", "pr_number")?;
            let result =
                crate::projects::get_github_pr(app.clone(), project_path, pr_number).await?;
            to_value(result)
        }
        "get_pr_review_comments" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let pr_number: u32 = field(&args, "prNumber", "pr_number")?;
            let result =
                crate::projects::get_pr_review_comments(app.clone(), project_path, pr_number)
                    .await?;
            to_value(result)
        }
        "load_issue_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let issue_number: u32 = field(&args, "issueNumber", "issue_number")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result = crate::projects::load_issue_context(
                app.clone(),
                session_id,
                issue_number,
                project_path,
            )
            .await?;
            to_value(result)
        }
        "list_loaded_issue_contexts" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: Option<String> = field_opt(&args, "worktreeId", "worktree_id")?;
            let result =
                crate::projects::list_loaded_issue_contexts(app.clone(), session_id, worktree_id)
                    .await?;
            to_value(result)
        }
        "remove_issue_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let issue_number: u32 = field(&args, "issueNumber", "issue_number")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            crate::projects::remove_issue_context(
                app.clone(),
                session_id,
                issue_number,
                project_path,
            )
            .await?;
            emit_cache_invalidation(app, &["contexts"]);
            Ok(Value::Null)
        }
        "load_pr_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let pr_number: u32 = field(&args, "prNumber", "pr_number")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result =
                crate::projects::load_pr_context(app.clone(), session_id, pr_number, project_path)
                    .await?;
            to_value(result)
        }
        "list_loaded_pr_contexts" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: Option<String> = field_opt(&args, "worktreeId", "worktree_id")?;
            let result =
                crate::projects::list_loaded_pr_contexts(app.clone(), session_id, worktree_id)
                    .await?;
            to_value(result)
        }
        "remove_pr_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let pr_number: u32 = field(&args, "prNumber", "pr_number")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            crate::projects::remove_pr_context(app.clone(), session_id, pr_number, project_path)
                .await?;
            emit_cache_invalidation(app, &["contexts"]);
            Ok(Value::Null)
        }
        "get_issue_context_content" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let issue_number: u32 = field(&args, "issueNumber", "issue_number")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result = crate::projects::get_issue_context_content(
                app.clone(),
                session_id,
                issue_number,
                project_path,
            )
            .await?;
            to_value(result)
        }
        "get_pr_context_content" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let pr_number: u32 = field(&args, "prNumber", "pr_number")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result = crate::projects::get_pr_context_content(
                app.clone(),
                session_id,
                pr_number,
                project_path,
            )
            .await?;
            to_value(result)
        }

        // =====================================================================
        // Security Alerts (Dependabot)
        // =====================================================================
        "list_dependabot_alerts" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let state: Option<String> = field_opt(&args, "state", "state")?;
            let result =
                crate::projects::list_dependabot_alerts(app.clone(), project_path, state).await?;
            to_value(result)
        }
        "get_dependabot_alert" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let alert_number: u32 = field(&args, "alertNumber", "alert_number")?;
            let result =
                crate::projects::get_dependabot_alert(app.clone(), project_path, alert_number)
                    .await?;
            to_value(result)
        }
        "load_security_alert_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let alert_number: u32 = field(&args, "alertNumber", "alert_number")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result = crate::projects::load_security_alert_context(
                app.clone(),
                session_id,
                alert_number,
                project_path,
            )
            .await?;
            to_value(result)
        }
        "list_loaded_security_contexts" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: Option<String> = field_opt(&args, "worktreeId", "worktree_id")?;
            let result = crate::projects::list_loaded_security_contexts(
                app.clone(),
                session_id,
                worktree_id,
            )
            .await?;
            to_value(result)
        }
        "remove_security_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let alert_number: u32 = field(&args, "alertNumber", "alert_number")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            crate::projects::remove_security_context(
                app.clone(),
                session_id,
                alert_number,
                project_path,
            )
            .await?;
            emit_cache_invalidation(app, &["contexts"]);
            Ok(Value::Null)
        }
        "get_security_context_content" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let alert_number: u32 = field(&args, "alertNumber", "alert_number")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result = crate::projects::get_security_context_content(
                app.clone(),
                session_id,
                alert_number,
                project_path,
            )
            .await?;
            to_value(result)
        }

        // =====================================================================
        // Repository Advisories
        // =====================================================================
        "list_repository_advisories" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let state: Option<String> = field_opt(&args, "state", "state")?;
            let result =
                crate::projects::list_repository_advisories(app.clone(), project_path, state)
                    .await?;
            to_value(result)
        }
        "load_advisory_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let ghsa_id: String = field(&args, "ghsaId", "ghsa_id")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result = crate::projects::load_advisory_context(
                app.clone(),
                session_id,
                ghsa_id,
                project_path,
            )
            .await?;
            to_value(result)
        }
        "list_loaded_advisory_contexts" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: Option<String> = field_opt(&args, "worktreeId", "worktree_id")?;
            let result = crate::projects::list_loaded_advisory_contexts(
                app.clone(),
                session_id,
                worktree_id,
            )
            .await?;
            to_value(result)
        }
        "remove_advisory_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let ghsa_id: String = field(&args, "ghsaId", "ghsa_id")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            crate::projects::remove_advisory_context(
                app.clone(),
                session_id,
                ghsa_id,
                project_path,
            )
            .await?;
            emit_cache_invalidation(app, &["contexts"]);
            Ok(Value::Null)
        }
        "get_advisory_context_content" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let ghsa_id: String = field(&args, "ghsaId", "ghsa_id")?;
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result = crate::projects::get_advisory_context_content(
                app.clone(),
                session_id,
                ghsa_id,
                project_path,
            )
            .await?;
            to_value(result)
        }

        // =====================================================================
        // Saved Contexts
        // =====================================================================
        "attach_saved_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let source_path: String = field(&args, "sourcePath", "source_path")?;
            let context_slug: String = field(&args, "contextSlug", "context_slug")?;
            crate::projects::attach_saved_context(
                app.clone(),
                session_id,
                source_path,
                context_slug,
            )
            .await?;
            emit_cache_invalidation(app, &["contexts"]);
            Ok(Value::Null)
        }
        "remove_saved_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let context_slug: String = field(&args, "contextSlug", "context_slug")?;
            crate::projects::remove_saved_context(app.clone(), session_id, context_slug).await?;
            emit_cache_invalidation(app, &["contexts"]);
            Ok(Value::Null)
        }
        "list_attached_saved_contexts" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let result =
                crate::projects::list_attached_saved_contexts(app.clone(), session_id).await?;
            to_value(result)
        }
        "get_saved_context_content" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let context_slug: String = field(&args, "contextSlug", "context_slug")?;
            let result =
                crate::projects::get_saved_context_content(app.clone(), session_id, context_slug)
                    .await?;
            to_value(result)
        }

        // =====================================================================
        // Chat Sessions
        // =====================================================================
        "get_sessions" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let include_archived: Option<bool> =
                field_opt(&args, "includeArchived", "include_archived")?;
            let include_message_counts: Option<bool> =
                field_opt(&args, "includeMessageCounts", "include_message_counts")?;
            let result = crate::chat::get_sessions(
                app.clone(),
                worktree_id,
                worktree_path,
                include_archived,
                include_message_counts,
            )
            .await?;
            to_value(result)
        }
        "list_all_sessions" => {
            let result = crate::chat::list_all_sessions(app.clone()).await?;
            to_value(result)
        }
        "get_session" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let result =
                crate::chat::get_session(app.clone(), worktree_id, worktree_path, session_id)
                    .await?;
            to_value(result)
        }
        "create_session" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let name: Option<String> = from_field_opt(&args, "name")?;
            let result =
                crate::chat::create_session(app.clone(), worktree_id, worktree_path, name, None)
                    .await?;
            to_value(result)
        }
        "rename_session" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let new_name: String = field(&args, "newName", "new_name")?;
            crate::chat::rename_session(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                new_name,
            )
            .await?;
            emit_cache_invalidation(app, &["sessions"]);
            Ok(Value::Null)
        }
        "close_session" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let result =
                crate::chat::close_session(app.clone(), worktree_id, worktree_path, session_id)
                    .await?;
            to_value(result)
        }
        "reorder_sessions" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_ids: Vec<String> = field(&args, "sessionIds", "session_ids")?;
            crate::chat::reorder_sessions(app.clone(), worktree_id, worktree_path, session_ids)
                .await?;
            emit_cache_invalidation(app, &["sessions"]);
            Ok(Value::Null)
        }
        "set_active_session" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            crate::chat::set_active_session(app.clone(), worktree_id, worktree_path, session_id)
                .await?;
            Ok(Value::Null)
        }

        // =====================================================================
        // Chat Messaging
        // =====================================================================
        "send_chat_message" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let message: String = from_field(&args, "message")?;
            let model: Option<String> = from_field_opt(&args, "model")?;
            let execution_mode: Option<String> =
                field_opt(&args, "executionMode", "execution_mode")?;
            let thinking_level_raw: Option<String> =
                field_opt(&args, "thinkingLevel", "thinking_level")?;
            let parallel_execution_prompt: Option<String> = field_opt(
                &args,
                "parallelExecutionPrompt",
                "parallel_execution_prompt",
            )?;
            let ai_language: Option<String> = field_opt(&args, "aiLanguage", "ai_language")?;
            let allowed_tools: Option<Vec<String>> =
                field_opt(&args, "allowedTools", "allowed_tools")?;
            let mut effort_level: Option<crate::chat::types::EffortLevel> =
                field_opt(&args, "effortLevel", "effort_level")?;
            let thinking_level: Option<crate::chat::types::ThinkingLevel> = match thinking_level_raw
                .as_deref()
            {
                None => None,
                Some("off") => Some(crate::chat::types::ThinkingLevel::Off),
                Some("think") => Some(crate::chat::types::ThinkingLevel::Think),
                Some("megathink") => Some(crate::chat::types::ThinkingLevel::Megathink),
                Some("ultrathink") => Some(crate::chat::types::ThinkingLevel::Ultrathink),
                // Backward compatibility:
                // Some frontend flows may send Codex effort values in thinkingLevel.
                // Translate to effortLevel and force thinking off instead of failing.
                Some("low") => {
                    if effort_level.is_none() {
                        effort_level = Some(crate::chat::types::EffortLevel::Low);
                    }
                    Some(crate::chat::types::ThinkingLevel::Off)
                }
                Some("medium") => {
                    if effort_level.is_none() {
                        effort_level = Some(crate::chat::types::EffortLevel::Medium);
                    }
                    Some(crate::chat::types::ThinkingLevel::Off)
                }
                Some("high") => {
                    if effort_level.is_none() {
                        effort_level = Some(crate::chat::types::EffortLevel::High);
                    }
                    Some(crate::chat::types::ThinkingLevel::Off)
                }
                Some("max" | "xhigh") => {
                    if effort_level.is_none() {
                        effort_level = Some(crate::chat::types::EffortLevel::Max);
                    }
                    Some(crate::chat::types::ThinkingLevel::Off)
                }
                Some(other) => {
                    return Err(format!(
                            "invalid args `thinkingLevel` for command `send_chat_message`: unknown variant `{other}`, expected one of `off`, `think`, `megathink`, `ultrathink`"
                        ));
                }
            };
            let mcp_config: Option<String> = field_opt(&args, "mcpConfig", "mcp_config")?;
            let chrome_enabled: Option<bool> = field_opt(&args, "chromeEnabled", "chrome_enabled")?;
            let custom_profile_name: Option<String> =
                field_opt(&args, "customProfileName", "custom_profile_name")?;
            let backend: Option<String> = field_opt(&args, "backend", "backend")?;
            let result = crate::chat::send_chat_message(
                app.clone(),
                session_id,
                worktree_id,
                worktree_path,
                message,
                model,
                execution_mode,
                thinking_level,
                effort_level,
                parallel_execution_prompt,
                ai_language,
                allowed_tools,
                mcp_config,
                chrome_enabled,
                custom_profile_name,
                backend,
            )
            .await?;
            to_value(result)
        }
        "cancel_chat_message" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            crate::chat::cancel_chat_message(app.clone(), session_id, worktree_id).await?;
            Ok(Value::Null)
        }
        "clear_session_history" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            crate::chat::clear_session_history(app.clone(), worktree_id, worktree_path, session_id)
                .await?;
            emit_cache_invalidation(app, &["sessions"]);
            Ok(Value::Null)
        }
        "set_session_model" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let model: String = from_field(&args, "model")?;
            crate::chat::set_session_model(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                model,
            )
            .await?;
            Ok(Value::Null)
        }
        "set_session_thinking_level" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let thinking_level: crate::chat::types::ThinkingLevel =
                field(&args, "thinkingLevel", "thinking_level")?;
            crate::chat::set_session_thinking_level(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                thinking_level,
            )
            .await?;
            Ok(Value::Null)
        }
        "mark_plan_approved" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let message_id: String = field(&args, "messageId", "message_id")?;
            crate::chat::mark_plan_approved(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                message_id,
            )
            .await?;
            // Don't emit cache invalidation here — all callers also invoke
            // update_session_state which emits its own invalidation.  Emitting
            // here races with that command (concurrent tokio::spawn) and causes
            // the other client to refetch stale selected_execution_mode before
            // update_session_state persists the new value, reverting to plan mode.
            Ok(Value::Null)
        }
        "save_cancelled_message" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let content: String = from_field(&args, "content")?;
            let tool_calls: Vec<crate::chat::types::ToolCall> =
                from_field_opt(&args, "toolCalls")?.unwrap_or_default();
            let content_blocks: Vec<crate::chat::types::ContentBlock> =
                from_field_opt(&args, "contentBlocks")?.unwrap_or_default();
            crate::chat::save_cancelled_message(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                content,
                tool_calls,
                content_blocks,
            )
            .await?;
            emit_cache_invalidation(app, &["sessions"]);
            Ok(Value::Null)
        }
        "has_running_sessions" => {
            let result = crate::chat::has_running_sessions();
            to_value(result)
        }

        // =====================================================================
        // Chat - Saved Contexts
        // =====================================================================
        "list_saved_contexts" => {
            let result = crate::chat::list_saved_contexts(app.clone()).await?;
            to_value(result)
        }
        "save_context_file" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let slug: String = from_field(&args, "slug")?;
            let content: String = from_field(&args, "content")?;
            crate::chat::save_context_file(app.clone(), worktree_path, slug, content).await?;
            emit_cache_invalidation(app, &["contexts"]);
            Ok(Value::Null)
        }
        "read_context_file" => {
            let path: String = from_field(&args, "path")?;
            let result = crate::chat::read_context_file(app.clone(), path).await?;
            to_value(result)
        }
        "delete_context_file" => {
            let path: String = from_field(&args, "path")?;
            crate::chat::delete_context_file(app.clone(), path).await?;
            emit_cache_invalidation(app, &["contexts"]);
            Ok(Value::Null)
        }
        "generate_context_from_session" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let project_name: String = field(&args, "projectName", "project_name")?;
            let custom_prompt: Option<String> = field_opt(&args, "magicPrompt", "magic_prompt")?;
            let model: Option<String> = from_field_opt(&args, "model")?;
            let custom_profile_name: Option<String> =
                field_opt(&args, "customProfileName", "custom_profile_name")?;
            let reasoning_effort: Option<String> =
                field_opt(&args, "reasoningEffort", "reasoning_effort")?;
            let result = crate::chat::generate_context_from_session(
                app.clone(),
                worktree_path,
                worktree_id,
                session_id,
                project_name,
                custom_prompt,
                model,
                custom_profile_name,
                reasoning_effort,
            )
            .await?;
            to_value(result)
        }

        // =====================================================================
        // Chat - File operations
        // =====================================================================
        "read_file_content" => {
            let file_path: String = field(&args, "filePath", "file_path")?;
            let result = crate::chat::read_file_content(file_path).await?;
            to_value(result)
        }
        "read_plan_file" => {
            let path: String = from_field(&args, "path")?;
            let result = crate::chat::read_plan_file(path).await?;
            to_value(result)
        }

        // =====================================================================
        // Background Tasks (polling control)
        // =====================================================================
        "set_app_focus_state" => {
            let focused: bool = from_field(&args, "focused")?;
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            crate::background_tasks::commands::set_app_focus_state(state, focused)?;
            Ok(Value::Null)
        }
        "set_active_worktree_for_polling" => {
            let worktree_id: Option<String> = field_opt(&args, "worktreeId", "worktree_id")?;
            let worktree_path: Option<String> = field_opt(&args, "worktreePath", "worktree_path")?;
            let base_branch: Option<String> = field_opt(&args, "baseBranch", "base_branch")?;
            let pr_number: Option<u32> = field_opt(&args, "prNumber", "pr_number")?;
            let pr_url: Option<String> = field_opt(&args, "prUrl", "pr_url")?;
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            crate::background_tasks::commands::set_active_worktree_for_polling(
                state,
                worktree_id,
                worktree_path,
                base_branch,
                pr_number,
                pr_url,
            )?;
            Ok(Value::Null)
        }
        "trigger_immediate_git_poll" => {
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            crate::background_tasks::commands::trigger_immediate_git_poll(state)?;
            Ok(Value::Null)
        }
        "trigger_immediate_remote_poll" => {
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            crate::background_tasks::commands::trigger_immediate_remote_poll(state)?;
            Ok(Value::Null)
        }
        "set_git_poll_interval" => {
            let seconds: u64 = from_field(&args, "seconds")?;
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            crate::background_tasks::commands::set_git_poll_interval(state, seconds)?;
            Ok(Value::Null)
        }
        "get_git_poll_interval" => {
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            let result = crate::background_tasks::commands::get_git_poll_interval(state)?;
            to_value(result)
        }
        "set_remote_poll_interval" => {
            let seconds: u64 = from_field(&args, "seconds")?;
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            crate::background_tasks::commands::set_remote_poll_interval(state, seconds)?;
            Ok(Value::Null)
        }
        "get_remote_poll_interval" => {
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            let result = crate::background_tasks::commands::get_remote_poll_interval(state)?;
            to_value(result)
        }

        // =====================================================================
        // Terminal
        // =====================================================================
        "kill_all_terminals" => {
            let result = crate::terminal::kill_all_terminals();
            to_value(result)
        }

        // =====================================================================
        // Recovery & Cleanup
        // =====================================================================
        "cleanup_old_recovery_files" => {
            let result = crate::cleanup_old_recovery_files(app.clone()).await?;
            to_value(result)
        }
        "check_resumable_sessions" => {
            let result = crate::chat::check_resumable_sessions(app.clone()).await?;
            to_value(result)
        }
        "cleanup_old_archives" => {
            let retention_days: u32 = field(&args, "retentionDays", "retention_days")?;
            let result = crate::projects::cleanup_old_archives(app.clone(), retention_days).await?;
            to_value(result)
        }

        "cleanup_combined_contexts" => {
            let result = crate::projects::cleanup_combined_contexts(app.clone()).await?;
            to_value(result)
        }

        // =====================================================================
        // HTTP Server control (exposed so web clients can check status)
        // =====================================================================
        "get_http_server_status" => {
            let result = crate::http_server::server::get_server_status(app.clone()).await;
            to_value(result)
        }

        // =====================================================================
        // Core / Utility
        // =====================================================================
        "greet" => {
            let name: String = from_field(&args, "name")?;
            let result = format!("Hello, {name}! You've been greeted from Rust!");
            to_value(result)
        }
        "send_native_notification" => {
            let title: String = from_field(&args, "title")?;
            let body: Option<String> = from_field_opt(&args, "body")?;
            crate::send_native_notification(app.clone(), title, body).await?;
            Ok(Value::Null)
        }
        "save_emergency_data" => {
            let filename: String = from_field(&args, "filename")?;
            let data: Value = from_field(&args, "data")?;
            crate::save_emergency_data(app.clone(), filename, data).await?;
            Ok(Value::Null)
        }
        "load_emergency_data" => {
            let filename: String = from_field(&args, "filename")?;
            let result = crate::load_emergency_data(app.clone(), filename).await?;
            to_value(result)
        }

        // =====================================================================
        // Project Management (additional)
        // =====================================================================
        "init_git_in_folder" => {
            let path: String = from_field(&args, "path")?;
            let result = crate::projects::init_git_in_folder(path).await?;
            to_value(result)
        }
        "init_project" => {
            let path: String = from_field(&args, "path")?;
            let parent_id: Option<String> = field_opt(&args, "parentId", "parent_id")?;
            let result = crate::projects::init_project(app.clone(), path, parent_id).await?;
            to_value(result)
        }
        "create_worktree_from_existing_branch" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let branch_name: String = field(&args, "branchName", "branch_name")?;
            let issue_context = field_opt(&args, "issueContext", "issue_context")?;
            let pr_context = field_opt(&args, "prContext", "pr_context")?;
            let security_context = field_opt(&args, "securityContext", "security_context")?;
            let advisory_context = field_opt(&args, "advisoryContext", "advisory_context")?;
            let linear_context = field_opt(&args, "linearContext", "linear_context")?;
            let result = crate::projects::create_worktree_from_existing_branch(
                app.clone(),
                project_id,
                branch_name,
                issue_context,
                pr_context,
                security_context,
                advisory_context,
                linear_context,
            )
            .await?;
            to_value(result)
        }
        "checkout_pr" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let pr_number: u32 = field(&args, "prNumber", "pr_number")?;
            let result = crate::projects::checkout_pr(app.clone(), project_id, pr_number).await?;
            to_value(result)
        }
        "create_base_session" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::projects::create_base_session(app.clone(), project_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            to_value(result)
        }
        "close_base_session" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            crate::projects::close_base_session(app.clone(), worktree_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "close_base_session_clean" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            crate::projects::close_base_session_clean(app.clone(), worktree_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "close_base_session_archive" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            crate::projects::close_base_session_archive(app.clone(), worktree_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "list_archived_worktrees" => {
            let result = crate::projects::list_archived_worktrees(app.clone()).await?;
            to_value(result)
        }
        "import_worktree" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let path: String = from_field(&args, "path")?;
            let result = crate::projects::import_worktree(app.clone(), project_id, path).await?;
            to_value(result)
        }
        "permanently_delete_worktree" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            crate::projects::permanently_delete_worktree(app.clone(), worktree_id).await?;
            Ok(Value::Null)
        }
        "delete_all_archives" => {
            let result = crate::projects::delete_all_archives(app.clone()).await?;
            to_value(result)
        }
        "open_worktree_in_finder" => {
            // NATIVE ONLY: Finder doesn't exist in browser mode
            Ok(Value::Null)
        }
        "open_project_worktrees_folder" => {
            // NATIVE ONLY: Finder doesn't exist in browser mode
            Ok(Value::Null)
        }
        "open_worktree_in_terminal" => {
            // NATIVE ONLY: Cannot open native terminal from browser
            Ok(Value::Null)
        }
        "open_worktree_in_editor" => {
            // NATIVE ONLY: Cannot open native editor from browser
            Ok(Value::Null)
        }
        "open_pull_request" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let title: Option<String> = from_field_opt(&args, "title")?;
            let body: Option<String> = from_field_opt(&args, "body")?;
            let draft: Option<bool> = from_field_opt(&args, "draft")?;
            let result =
                crate::projects::open_pull_request(app.clone(), worktree_id, title, body, draft)
                    .await?;
            to_value(result)
        }
        "open_project_on_github" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            crate::projects::open_project_on_github(app.clone(), project_id).await?;
            Ok(Value::Null)
        }
        "get_git_remotes" => {
            let repo_path: String = field(&args, "repoPath", "repo_path")?;
            let result = crate::projects::get_git_remotes(repo_path).await?;
            to_value(result)
        }
        "get_github_remotes" => {
            let repo_path: String = field(&args, "repoPath", "repo_path")?;
            let result = crate::projects::get_github_remotes(repo_path).await?;
            to_value(result)
        }
        "get_github_branch_url" => {
            let repo_path: String = field(&args, "repoPath", "repo_path")?;
            let branch: String = from_field(&args, "branch")?;
            let result = crate::projects::get_github_branch_url(repo_path, branch).await?;
            to_value(result)
        }
        "get_github_repo_url" => {
            let repo_path: String = field(&args, "repoPath", "repo_path")?;
            let result = crate::projects::get_github_repo_url(repo_path).await?;
            to_value(result)
        }
        "get_pr_prompt" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let result = crate::projects::get_pr_prompt(app.clone(), worktree_path).await?;
            to_value(result)
        }
        "get_review_prompt" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let result = crate::projects::get_review_prompt(app.clone(), worktree_path).await?;
            to_value(result)
        }
        "rebase_worktree" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let commit_message: Option<String> =
                field_opt(&args, "commitMessage", "commit_message")?;
            let result =
                crate::projects::rebase_worktree(app.clone(), worktree_id, commit_message).await?;
            to_value(result)
        }

        // =====================================================================
        // Git Operations (additional)
        // =====================================================================
        "merge_worktree_to_base" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let merge_type: crate::projects::types::MergeType =
                field(&args, "mergeType", "merge_type")?;
            let result =
                crate::projects::merge_worktree_to_base(app.clone(), worktree_id, merge_type)
                    .await?;
            to_value(result)
        }
        "get_merge_conflicts" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let result = crate::projects::get_merge_conflicts(app.clone(), worktree_id).await?;
            to_value(result)
        }
        "fetch_and_merge_base" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let result = crate::projects::fetch_and_merge_base(app.clone(), worktree_id).await?;
            to_value(result)
        }

        // =====================================================================
        // Skills & Search
        // =====================================================================
        "list_claude_skills" => {
            let worktree_path: Option<String> = field_opt(&args, "worktreePath", "worktree_path")?;
            let result = crate::projects::list_claude_skills(worktree_path).await?;
            to_value(result)
        }
        "list_claude_commands" => {
            let worktree_path: Option<String> = field_opt(&args, "worktreePath", "worktree_path")?;
            let result = crate::projects::list_claude_commands(worktree_path).await?;
            to_value(result)
        }
        "search_github_issues" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let query: String = from_field(&args, "query")?;
            let result =
                crate::projects::search_github_issues(app.clone(), project_path, query).await?;
            to_value(result)
        }
        "search_github_prs" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let query: String = from_field(&args, "query")?;
            let result =
                crate::projects::search_github_prs(app.clone(), project_path, query).await?;
            to_value(result)
        }

        // =====================================================================
        // Folder Management
        // =====================================================================
        "create_folder" => {
            let name: String = from_field(&args, "name")?;
            let parent_id: Option<String> = field_opt(&args, "parentId", "parent_id")?;
            let result = crate::projects::create_folder(app.clone(), name, parent_id).await?;
            to_value(result)
        }
        "rename_folder" => {
            let folder_id: String = field(&args, "folderId", "folder_id")?;
            let name: String = from_field(&args, "name")?;
            let result = crate::projects::rename_folder(app.clone(), folder_id, name).await?;
            to_value(result)
        }
        "delete_folder" => {
            let folder_id: String = field(&args, "folderId", "folder_id")?;
            crate::projects::delete_folder(app.clone(), folder_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }
        "move_item" => {
            let item_id: String = field(&args, "itemId", "item_id")?;
            let new_parent_id: Option<String> = field_opt(&args, "newParentId", "new_parent_id")?;
            let target_index: Option<u32> = field_opt(&args, "targetIndex", "target_index")?;
            let result =
                crate::projects::move_item(app.clone(), item_id, new_parent_id, target_index)
                    .await?;
            to_value(result)
        }
        "reorder_items" => {
            let item_ids: Vec<String> = field(&args, "itemIds", "item_ids")?;
            let parent_id: Option<String> = field_opt(&args, "parentId", "parent_id")?;
            crate::projects::reorder_items(app.clone(), item_ids, parent_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            Ok(Value::Null)
        }

        // =====================================================================
        // Avatar Management
        // =====================================================================
        "set_project_avatar" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::projects::set_project_avatar(app.clone(), project_id).await?;
            to_value(result)
        }
        "remove_project_avatar" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::projects::remove_project_avatar(app.clone(), project_id).await?;
            to_value(result)
        }
        "get_app_data_dir" => {
            let result = crate::projects::get_app_data_dir(app.clone()).await?;
            to_value(result)
        }

        // =====================================================================
        // Terminal (NATIVE ONLY — return empty/null in browser mode)
        // =====================================================================
        "start_terminal" => {
            // NATIVE ONLY: Terminals don't work in browser mode
            Ok(Value::Null)
        }
        "terminal_write" => {
            // NATIVE ONLY: Terminals don't work in browser mode
            Ok(Value::Null)
        }
        "terminal_resize" => {
            // NATIVE ONLY: Terminals don't work in browser mode
            Ok(Value::Null)
        }
        "stop_terminal" => {
            // NATIVE ONLY: Terminals don't work in browser mode
            Ok(Value::Null)
        }
        "get_active_terminals" => {
            // NATIVE ONLY: Return empty array
            Ok(Value::Array(vec![]))
        }
        "has_active_terminal" => {
            // NATIVE ONLY: No terminals in browser mode
            to_value(false)
        }
        "get_run_script" => {
            // NATIVE ONLY: Terminals don't work in browser mode
            Ok(Value::Null)
        }

        // =====================================================================
        // Session Management (additional)
        // =====================================================================
        "update_session_state" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let answered_questions: Option<Vec<String>> =
                field_opt(&args, "answeredQuestions", "answered_questions")?;
            let submitted_answers: Option<std::collections::HashMap<String, serde_json::Value>> =
                field_opt(&args, "submittedAnswers", "submitted_answers")?;
            let fixed_findings: Option<Vec<String>> =
                field_opt(&args, "fixedFindings", "fixed_findings")?;
            let pending_permission_denials: Option<Vec<crate::chat::types::PermissionDenial>> =
                field_opt(
                    &args,
                    "pendingPermissionDenials",
                    "pending_permission_denials",
                )?;
            let denied_message_context: Option<Option<crate::chat::types::DeniedMessageContext>> =
                field_opt(&args, "deniedMessageContext", "denied_message_context")?;
            let is_reviewing: Option<bool> = field_opt(&args, "isReviewing", "is_reviewing")?;
            let waiting_for_input: Option<bool> =
                field_opt(&args, "waitingForInput", "waiting_for_input")?;
            let waiting_for_input_type: Option<Option<String>> =
                field_opt(&args, "waitingForInputType", "waiting_for_input_type")?;
            let plan_file_path: Option<Option<String>> =
                field_opt(&args, "planFilePath", "plan_file_path")?;
            let pending_plan_message_id: Option<Option<String>> =
                field_opt(&args, "pendingPlanMessageId", "pending_plan_message_id")?;
            // Special handling for label: distinguish between missing field (None) and null value (Some(None))
            let label: Option<Option<crate::chat::types::LabelData>> = match args.get("label") {
                None => None,                    // field not provided -> None
                Some(Value::Null) => Some(None), // explicitly null -> Some(None) to clear
                Some(v) => {
                    let parsed: Result<crate::chat::types::LabelData, _> =
                        serde_json::from_value(v.clone());
                    match parsed {
                        Ok(label_data) => Some(Some(label_data)),
                        Err(e) => return Err(format!("Invalid label: {}", e)),
                    }
                }
            };
            let clear_label: Option<bool> = field_opt(&args, "clearLabel", "clear_label")?;
            let review_results: Option<Option<serde_json::Value>> =
                field_opt(&args, "reviewResults", "review_results")?;
            let enabled_mcp_servers: Option<Option<Vec<String>>> =
                field_opt(&args, "enabledMcpServers", "enabled_mcp_servers")?;
            let selected_execution_mode: Option<Option<String>> =
                field_opt(&args, "selectedExecutionMode", "selected_execution_mode")?;
            crate::chat::update_session_state(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                answered_questions,
                submitted_answers,
                fixed_findings,
                pending_permission_denials,
                denied_message_context,
                is_reviewing,
                waiting_for_input,
                waiting_for_input_type,
                plan_file_path,
                pending_plan_message_id,
                label,
                clear_label,
                review_results,
                enabled_mcp_servers,
                selected_execution_mode,
            )
            .await?;
            emit_cache_invalidation(app, &["sessions"]);
            Ok(Value::Null)
        }
        "archive_session" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let result =
                crate::chat::archive_session(app.clone(), worktree_id, worktree_path, session_id)
                    .await?;
            to_value(result)
        }
        "unarchive_session" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let result =
                crate::chat::unarchive_session(app.clone(), worktree_id, worktree_path, session_id)
                    .await?;
            emit_cache_invalidation(app, &["sessions"]);
            to_value(result)
        }
        "restore_session_with_base" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::chat::restore_session_with_base(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                project_id,
            )
            .await?;
            emit_cache_invalidation(app, &["sessions", "projects"]);
            to_value(result)
        }
        "delete_archived_session" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            crate::chat::delete_archived_session(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
            )
            .await?;
            emit_cache_invalidation(app, &["sessions"]);
            Ok(Value::Null)
        }
        "list_archived_sessions" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let result =
                crate::chat::list_archived_sessions(app.clone(), worktree_id, worktree_path)
                    .await?;
            to_value(result)
        }
        "list_all_archived_sessions" => {
            let result = crate::chat::list_all_archived_sessions(app.clone()).await?;
            to_value(result)
        }

        // =====================================================================
        // Images & Pasted Text
        // =====================================================================
        "save_pasted_image" => {
            let data: String = from_field(&args, "data")?;
            let mime_type: String = field(&args, "mimeType", "mime_type")?;
            let result = crate::chat::save_pasted_image(app.clone(), data, mime_type).await?;
            to_value(result)
        }
        "save_dropped_image" => {
            // NATIVE ONLY: Drag-drop from native file paths doesn't work in browser
            Ok(Value::Null)
        }
        "delete_pasted_image" => {
            let path: String = from_field(&args, "path")?;
            crate::chat::delete_pasted_image(app.clone(), path).await?;
            Ok(Value::Null)
        }
        "save_pasted_text" => {
            let content: String = from_field(&args, "content")?;
            let result = crate::chat::save_pasted_text(app.clone(), content).await?;
            to_value(result)
        }
        "update_pasted_text" => {
            let path: String = from_field(&args, "path")?;
            let content: String = from_field(&args, "content")?;
            let result = crate::chat::update_pasted_text(app.clone(), path, content).await?;
            to_value(result)
        }
        "delete_pasted_text" => {
            let path: String = from_field(&args, "path")?;
            crate::chat::delete_pasted_text(app.clone(), path).await?;
            Ok(Value::Null)
        }
        "read_pasted_text" => {
            let path: String = from_field(&args, "path")?;
            let result = crate::chat::read_pasted_text(app.clone(), path).await?;
            to_value(result)
        }

        // =====================================================================
        // File Operations (additional)
        // =====================================================================
        "write_file_content" => {
            let path: String = from_field(&args, "path")?;
            let content: String = from_field(&args, "content")?;
            crate::chat::write_file_content(path, content).await?;
            Ok(Value::Null)
        }
        "open_file_in_default_app" => {
            // NATIVE ONLY: Cannot open native apps from browser
            Ok(Value::Null)
        }

        // =====================================================================
        // Context & Debug (additional)
        // =====================================================================
        "rename_saved_context" => {
            let filename: String = from_field(&args, "filename")?;
            let new_name: String = field(&args, "newName", "new_name")?;
            crate::chat::rename_saved_context(app.clone(), filename, new_name).await?;
            emit_cache_invalidation(app, &["contexts"]);
            Ok(Value::Null)
        }
        "generate_session_digest" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let result = crate::chat::generate_session_digest(app.clone(), session_id).await?;
            to_value(result)
        }
        "update_session_digest" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let digest: crate::chat::types::SessionDigest = from_field(&args, "digest")?;
            crate::chat::update_session_digest(app.clone(), session_id, digest).await?;
            Ok(Value::Null)
        }
        "get_session_debug_info" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let result = crate::chat::get_session_debug_info(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
            )
            .await?;
            to_value(result)
        }
        "resume_session" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let result = crate::chat::resume_session(app.clone(), session_id, worktree_id).await?;
            to_value(result)
        }
        "broadcast_session_setting" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let key: String = field(&args, "key", "key")?;
            let value: String = field(&args, "value", "value")?;
            crate::chat::broadcast_session_setting(app.clone(), session_id, key, value).await?;
            Ok(Value::Null)
        }

        // =====================================================================
        // CLI Management
        // =====================================================================
        "check_claude_cli_installed" => {
            let result = crate::claude_cli::check_claude_cli_installed(app.clone()).await?;
            to_value(result)
        }
        "check_claude_cli_auth" => {
            let result = crate::claude_cli::check_claude_cli_auth(app.clone()).await?;
            to_value(result)
        }
        "get_claude_usage" => {
            let result = crate::claude_cli::get_claude_usage().await?;
            to_value(result)
        }
        "get_available_cli_versions" => {
            let result = crate::claude_cli::get_available_cli_versions().await?;
            to_value(result)
        }
        "install_claude_cli" => {
            let version: Option<String> = from_field_opt(&args, "version")?;
            crate::claude_cli::install_claude_cli(app.clone(), version).await?;
            Ok(Value::Null)
        }
        "check_opencode_cli_installed" => {
            let result = crate::opencode_cli::check_opencode_cli_installed(app.clone()).await?;
            to_value(result)
        }
        "check_opencode_cli_auth" => {
            let result = crate::opencode_cli::check_opencode_cli_auth(app.clone()).await?;
            to_value(result)
        }
        "get_available_opencode_versions" => {
            let result = crate::opencode_cli::get_available_opencode_versions().await?;
            to_value(result)
        }
        "install_opencode_cli" => {
            let version: Option<String> = from_field_opt(&args, "version")?;
            crate::opencode_cli::install_opencode_cli(app.clone(), version).await?;
            Ok(Value::Null)
        }
        "list_opencode_models" => {
            let result = crate::opencode_cli::list_opencode_models(app.clone()).await?;
            to_value(result)
        }
        "check_gh_cli_installed" => {
            let result = crate::gh_cli::check_gh_cli_installed(app.clone()).await?;
            to_value(result)
        }
        "check_gh_cli_auth" => {
            let result = crate::gh_cli::check_gh_cli_auth(app.clone()).await?;
            to_value(result)
        }
        "get_available_gh_versions" => {
            let result = crate::gh_cli::get_available_gh_versions(app.clone()).await?;
            to_value(result)
        }
        "install_gh_cli" => {
            let version: Option<String> = from_field_opt(&args, "version")?;
            crate::gh_cli::install_gh_cli(app.clone(), version).await?;
            Ok(Value::Null)
        }

        // =====================================================================
        // HTTP Server control (additional)
        // =====================================================================
        "start_http_server" => {
            // Server is already running if we're receiving this via WebSocket
            let result = crate::http_server::server::get_server_status(app.clone()).await;
            to_value(result)
        }
        "stop_http_server" => {
            // Cannot stop the server from within the server — use native Tauri command
            Err("Cannot stop HTTP server from a WebSocket connection".to_string())
        }
        "regenerate_http_token" => {
            let result = crate::regenerate_http_token(app.clone()).await?;
            to_value(result)
        }
        "start_opencode_server" => {
            let result = crate::opencode_server::start_opencode_server(app.clone()).await?;
            to_value(result)
        }
        "stop_opencode_server" => {
            crate::opencode_server::stop_opencode_server().await?;
            Ok(Value::Null)
        }
        "get_opencode_server_status" => {
            let result = crate::opencode_server::get_opencode_server_status().await?;
            to_value(result)
        }

        // =====================================================================
        // Codex CLI
        // =====================================================================
        "check_codex_cli_installed" => {
            let result = crate::codex_cli::check_codex_cli_installed(app.clone()).await?;
            to_value(result)
        }
        "check_codex_cli_auth" => {
            let result = crate::codex_cli::check_codex_cli_auth(app.clone()).await?;
            to_value(result)
        }
        "get_available_codex_versions" => {
            let result = crate::codex_cli::get_available_codex_versions(app.clone()).await?;
            to_value(result)
        }
        "get_codex_usage" => {
            let result = crate::codex_cli::get_codex_usage().await?;
            to_value(result)
        }
        "install_codex_cli" => {
            let version: Option<String> = from_field_opt(&args, "version")?;
            crate::codex_cli::install_codex_cli(app.clone(), version).await?;
            Ok(Value::Null)
        }
        "approve_codex_command" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let rpc_id: u64 = field(&args, "rpcId", "rpc_id")?;
            let decision: String = from_field(&args, "decision")?;
            crate::chat::approve_codex_command(session_id, rpc_id, decision)?;
            Ok(Value::Null)
        }

        // =====================================================================
        // Queue management (cross-client sync)
        // =====================================================================
        "enqueue_message" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let message: Value = from_field(&args, "message")?;
            let result = crate::chat::enqueue_message(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                message,
            )
            .await?;
            to_value(result)
        }
        "dequeue_message" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let result =
                crate::chat::dequeue_message(app.clone(), worktree_id, worktree_path, session_id)
                    .await?;
            to_value(result)
        }
        "remove_queued_message" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let message_id: String = field(&args, "messageId", "message_id")?;
            crate::chat::remove_queued_message(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                message_id,
            )
            .await?;
            Ok(Value::Null)
        }
        "clear_message_queue" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            crate::chat::clear_message_queue(app.clone(), worktree_id, worktree_path, session_id)
                .await?;
            Ok(Value::Null)
        }

        // =====================================================================
        // Chat (additional)
        // =====================================================================
        "check_mcp_health" => {
            let backend: Option<String> = from_field_opt(&args, "backend")?;
            let result = crate::chat::check_mcp_health(app.clone(), backend).await?;
            to_value(result)
        }
        "get_mcp_servers" => {
            let backend: Option<String> = from_field_opt(&args, "backend")?;
            let worktree_path: Option<String> = field_opt(&args, "worktreePath", "worktree_path")?;
            let result = crate::chat::get_mcp_servers(backend, worktree_path).await?;
            to_value(result)
        }
        "read_clipboard_image" => {
            let result = crate::chat::read_clipboard_image(app.clone()).await?;
            to_value(result)
        }
        "regenerate_session_name" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let custom_prompt: Option<String> = field_opt(&args, "customPrompt", "custom_prompt")?;
            let model: Option<String> = from_field_opt(&args, "model")?;
            let custom_profile_name: Option<String> =
                field_opt(&args, "customProfileName", "custom_profile_name")?;
            let reasoning_effort: Option<String> =
                field_opt(&args, "reasoningEffort", "reasoning_effort")?;
            crate::chat::regenerate_session_name(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                custom_prompt,
                model,
                custom_profile_name,
                reasoning_effort,
            )
            .await?;
            emit_cache_invalidation(app, &["sessions"]);
            Ok(Value::Null)
        }
        "set_session_backend" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let backend: String = from_field(&args, "backend")?;
            crate::chat::set_session_backend(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                backend,
            )
            .await?;
            emit_cache_invalidation(app, &["session", "sessions"]);
            Ok(Value::Null)
        }
        "set_session_provider" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let provider: Option<String> = from_field_opt(&args, "provider")?;
            crate::chat::set_session_provider(
                app.clone(),
                worktree_id,
                worktree_path,
                session_id,
                provider,
            )
            .await?;
            emit_cache_invalidation(app, &["session", "sessions"]);
            Ok(Value::Null)
        }
        "set_session_last_opened" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            crate::chat::set_session_last_opened(app.clone(), session_id).await?;
            Ok(Value::Null)
        }
        "set_sessions_last_opened_bulk" => {
            let session_ids: Vec<String> = field(&args, "sessionIds", "session_ids")?;
            crate::chat::set_sessions_last_opened_bulk(app.clone(), session_ids).await?;
            Ok(Value::Null)
        }

        // =====================================================================
        // Git & Project (additional)
        // =====================================================================
        "check_git_identity" => {
            let result = crate::projects::check_git_identity().await?;
            to_value(result)
        }
        "set_git_identity" => {
            let name: String = from_field(&args, "name")?;
            let email: String = from_field(&args, "email")?;
            crate::projects::set_git_identity(name, email).await?;
            Ok(Value::Null)
        }
        "clone_project" => {
            let url: String = from_field(&args, "url")?;
            let path: String = from_field(&args, "path")?;
            let parent_id: Option<String> = field_opt(&args, "parentId", "parent_id")?;
            let result = crate::projects::clone_project(app.clone(), url, path, parent_id).await?;
            emit_cache_invalidation(app, &["projects"]);
            to_value(result)
        }
        "open_branch_on_github" => {
            let repo_path: String = field(&args, "repoPath", "repo_path")?;
            let branch: String = from_field(&args, "branch")?;
            crate::projects::open_branch_on_github(repo_path, branch).await?;
            Ok(Value::Null)
        }
        "open_log_directory" => {
            crate::projects::open_log_directory(app.clone()).await?;
            Ok(Value::Null)
        }
        "remove_git_remote" => {
            let repo_path: String = field(&args, "repoPath", "repo_path")?;
            let remote_name: String = field(&args, "remoteName", "remote_name")?;
            crate::projects::remove_git_remote(repo_path, remote_name).await?;
            Ok(Value::Null)
        }
        "resolve_claude_command" => {
            let command_path: String = field(&args, "commandPath", "command_path")?;
            let working_dir: String = field(&args, "workingDir", "working_dir")?;
            let result = crate::projects::resolve_claude_command(command_path, working_dir).await?;
            to_value(result)
        }
        "revert_file" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let file_path: String = field(&args, "filePath", "file_path")?;
            let file_status: String = field(&args, "fileStatus", "file_status")?;
            crate::projects::revert_file(worktree_path, file_path, file_status).await?;
            Ok(Value::Null)
        }
        "set_worktree_last_opened" => {
            let worktree_id: String = field(&args, "worktreeId", "worktree_id")?;
            crate::projects::set_worktree_last_opened(app.clone(), worktree_id).await?;
            Ok(Value::Null)
        }
        "git_stash" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let result = crate::projects::git_stash(worktree_path).await?;
            to_value(result)
        }
        "git_stash_pop" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let result = crate::projects::git_stash_pop(worktree_path).await?;
            to_value(result)
        }
        "generate_pr_update_content" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let session_id: Option<String> = field_opt(&args, "sessionId", "session_id")?;
            let custom_prompt: Option<String> = field_opt(&args, "customPrompt", "custom_prompt")?;
            let model: Option<String> = from_field_opt(&args, "model")?;
            let custom_profile_name: Option<String> =
                field_opt(&args, "customProfileName", "custom_profile_name")?;
            let reasoning_effort: Option<String> =
                field_opt(&args, "reasoningEffort", "reasoning_effort")?;
            let result = crate::projects::generate_pr_update_content(
                app.clone(),
                worktree_path,
                session_id,
                custom_prompt,
                model,
                custom_profile_name,
                reasoning_effort,
            )
            .await?;
            to_value(result)
        }
        "update_pr_description" => {
            let worktree_path: String = field(&args, "worktreePath", "worktree_path")?;
            let pr_number: u32 = field(&args, "prNumber", "pr_number")?;
            let title: String = from_field(&args, "title")?;
            let body: String = from_field(&args, "body")?;
            crate::projects::update_pr_description(
                app.clone(),
                worktree_path,
                pr_number,
                title,
                body,
            )
            .await?;
            Ok(Value::Null)
        }
        "get_jean_config" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result = crate::projects::get_jean_config(project_path).await;
            to_value(result)
        }
        "save_jean_config" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let config = from_field(&args, "config")?;
            crate::projects::save_jean_config(project_path, config).await?;
            Ok(Value::Null)
        }
        "list_github_releases" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let result = crate::projects::list_github_releases(app.clone(), project_path).await?;
            to_value(result)
        }
        "generate_release_notes" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let tag: String = from_field(&args, "tag")?;
            let release_name: String = field(&args, "releaseName", "release_name")?;
            let custom_prompt: Option<String> = field_opt(&args, "customPrompt", "custom_prompt")?;
            let model: Option<String> = from_field_opt(&args, "model")?;
            let custom_profile_name: Option<String> =
                field_opt(&args, "customProfileName", "custom_profile_name")?;
            let reasoning_effort: Option<String> =
                field_opt(&args, "reasoningEffort", "reasoning_effort")?;
            let result = crate::projects::generate_release_notes(
                app.clone(),
                project_path,
                tag,
                release_name,
                custom_prompt,
                model,
                custom_profile_name,
                reasoning_effort,
            )
            .await?;
            to_value(result)
        }

        // =====================================================================
        // GitHub Issues (additional)
        // =====================================================================
        "get_github_issue_by_number" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let issue_number: u32 = field(&args, "issueNumber", "issue_number")?;
            let result = crate::projects::get_github_issue_by_number(
                app.clone(),
                project_path,
                issue_number,
            )
            .await?;
            to_value(result)
        }
        "get_github_pr_by_number" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let pr_number: u32 = field(&args, "prNumber", "pr_number")?;
            let result =
                crate::projects::get_github_pr_by_number(app.clone(), project_path, pr_number)
                    .await?;
            to_value(result)
        }
        "get_repository_advisory" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let ghsa_id: String = field(&args, "ghsaId", "ghsa_id")?;
            let result =
                crate::projects::get_repository_advisory(app.clone(), project_path, ghsa_id)
                    .await?;
            to_value(result)
        }
        "list_workflow_runs" => {
            let project_path: String = field(&args, "projectPath", "project_path")?;
            let branch: Option<String> = from_field_opt(&args, "branch")?;
            let result =
                crate::projects::list_workflow_runs(app.clone(), project_path, branch).await?;
            to_value(result)
        }

        // =====================================================================
        // Linear Issues
        // =====================================================================
        "list_linear_teams" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::projects::list_linear_teams(app.clone(), project_id).await?;
            to_value(result)
        }
        "list_linear_issues" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::projects::list_linear_issues(app.clone(), project_id).await?;
            to_value(result)
        }
        "search_linear_issues" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let query: String = from_field(&args, "query")?;
            let result =
                crate::projects::search_linear_issues(app.clone(), project_id, query).await?;
            to_value(result)
        }
        "get_linear_issue" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let issue_id: String = field(&args, "issueId", "issue_id")?;
            let result =
                crate::projects::get_linear_issue(app.clone(), project_id, issue_id).await?;
            to_value(result)
        }
        "get_linear_issue_by_number" => {
            let project_id: String = field(&args, "projectId", "project_id")?;
            let issue_number: i64 = field(&args, "issueNumber", "issue_number")?;
            let result =
                crate::projects::get_linear_issue_by_number(app.clone(), project_id, issue_number)
                    .await?;
            to_value(result)
        }
        "load_linear_issue_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let project_id: String = field(&args, "projectId", "project_id")?;
            let issue_id: String = field(&args, "issueId", "issue_id")?;
            let result = crate::projects::load_linear_issue_context(
                app.clone(),
                session_id,
                project_id,
                issue_id,
            )
            .await?;
            to_value(result)
        }
        "list_loaded_linear_issue_contexts" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: Option<String> = field_opt(&args, "worktreeId", "worktree_id")?;
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::projects::list_loaded_linear_issue_contexts(
                app.clone(),
                session_id,
                worktree_id,
                project_id,
            )
            .await?;
            to_value(result)
        }
        "get_linear_issue_context_contents" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let worktree_id: Option<String> = field_opt(&args, "worktreeId", "worktree_id")?;
            let project_id: String = field(&args, "projectId", "project_id")?;
            let result = crate::projects::get_linear_issue_context_contents(
                app.clone(),
                session_id,
                worktree_id,
                project_id,
            )
            .await?;
            to_value(result)
        }
        "remove_linear_issue_context" => {
            let session_id: String = field(&args, "sessionId", "session_id")?;
            let project_id: String = field(&args, "projectId", "project_id")?;
            let identifier: String = from_field(&args, "identifier")?;
            crate::projects::remove_linear_issue_context(
                app.clone(),
                session_id,
                project_id,
                identifier,
            )
            .await?;
            Ok(Value::Null)
        }

        // =====================================================================
        // CLI Profiles
        // =====================================================================
        "save_cli_profile" => {
            let name: String = from_field(&args, "name")?;
            let settings_json: String = field(&args, "settingsJson", "settings_json")?;
            let result = crate::save_cli_profile(name, settings_json).await?;
            to_value(result)
        }
        "delete_cli_profile" => {
            let name: String = from_field(&args, "name")?;
            crate::delete_cli_profile(name).await?;
            Ok(Value::Null)
        }

        // =====================================================================
        // Background Tasks (additional)
        // =====================================================================
        "set_all_worktrees_for_polling" => {
            let worktrees = from_field(&args, "worktrees")?;
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            crate::background_tasks::commands::set_all_worktrees_for_polling(state, worktrees)?;
            Ok(Value::Null)
        }
        "set_pr_worktrees_for_polling" => {
            let worktrees = from_field(&args, "worktrees")?;
            let state = app.state::<crate::background_tasks::BackgroundTaskManager>();
            crate::background_tasks::commands::set_pr_worktrees_for_polling(state, worktrees)?;
            Ok(Value::Null)
        }

        // =====================================================================
        // Unknown command
        // =====================================================================
        _ => Err(format!("Unknown command: {command}")),
    }
}

// =============================================================================
// Cache invalidation broadcast (real-time sync between native + web clients)
// =============================================================================

/// Emit a cache:invalidate event so all clients refresh the specified query keys.
fn emit_cache_invalidation(app: &AppHandle, keys: &[&str]) {
    if let Err(e) = app.emit_all("cache:invalidate", &serde_json::json!({ "keys": keys })) {
        log::error!("Failed to emit cache:invalidate: {e}");
    }
}

// =============================================================================
// Helper functions for JSON deserialization
// =============================================================================

fn to_value<T: serde::Serialize>(val: T) -> Result<Value, String> {
    serde_json::to_value(val).map_err(|e| format!("Serialization error: {e}"))
}

fn from_field<T: serde::de::DeserializeOwned>(args: &Value, field: &str) -> Result<T, String> {
    args.get(field)
        .ok_or_else(|| format!("Missing field: {field}"))
        .and_then(|v| {
            serde_json::from_value(v.clone()).map_err(|e| format!("Invalid field '{field}': {e}"))
        })
}

fn from_field_opt<T: serde::de::DeserializeOwned>(
    args: &Value,
    field: &str,
) -> Result<Option<T>, String> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("Invalid field '{field}': {e}")),
    }
}

/// Try camelCase field first, then snake_case. For required fields.
fn field<T: serde::de::DeserializeOwned>(
    args: &Value,
    camel: &str,
    snake: &str,
) -> Result<T, String> {
    from_field(args, camel).or_else(|_| from_field(args, snake))
}

/// Try camelCase field first, then snake_case. For optional fields.
fn field_opt<T: serde::de::DeserializeOwned>(
    args: &Value,
    camel: &str,
    snake: &str,
) -> Result<Option<T>, String> {
    let camel_result = from_field_opt(args, camel)?;
    if camel_result.is_some() {
        return Ok(camel_result);
    }
    from_field_opt(args, snake)
}
