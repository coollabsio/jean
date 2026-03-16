use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::gh_cli::config::resolve_gh_binary;
use crate::platform::silent_command;

// =============================================================================
// GitHub Actions Types
// =============================================================================

/// A single workflow run from `gh run list`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub database_id: u64,
    pub name: String,
    pub display_title: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub event: String,
    pub head_branch: String,
    pub created_at: String,
    pub url: String,
    pub workflow_name: String,
}

/// Result of listing workflow runs, includes failed count for badge display
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunsResult {
    pub runs: Vec<WorkflowRun>,
    pub failed_count: u32,
}

/// List GitHub Actions workflow runs for a repository
///
/// Uses `gh run list` to fetch recent workflow runs.
/// - branch: optional branch name to filter runs (for PR/worktree-specific views)
/// - Returns up to 30 recent runs with a count of failed runs for badge display
#[tauri::command]
pub async fn list_workflow_runs(
    app: AppHandle,
    project_path: String,
    branch: Option<String>,
) -> Result<WorkflowRunsResult, String> {
    log::trace!("Listing workflow runs for {project_path} with branch: {branch:?}");

    let gh = resolve_gh_binary(&app);

    let mut args = vec![
        "run".to_string(),
        "list".to_string(),
        "--json".to_string(),
        "databaseId,name,displayTitle,status,conclusion,event,headBranch,createdAt,url,workflowName"
            .to_string(),
        "-L".to_string(),
        "30".to_string(),
    ];

    if let Some(ref b) = branch {
        args.push("--branch".to_string());
        args.push(b.clone());
    }

    let output = silent_command(&gh)
        .args(&args)
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh run list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("not a git repository") {
            return Err("Not a git repository".to_string());
        }
        if stderr.contains("Could not resolve") {
            return Err("Could not resolve repository. Is this a GitHub repository?".to_string());
        }
        return Err(format!("gh run list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let runs: Vec<WorkflowRun> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    // Count failures only for the most recent run per workflow.
    // gh returns runs sorted by createdAt desc, so the first run we see
    // for each workflowName is the latest. Only count it if it failed.
    let mut seen_workflows = std::collections::HashSet::new();
    let mut failed_count: u32 = 0;
    for run in &runs {
        if seen_workflows.insert(&run.workflow_name)
            && matches!(
                run.conclusion.as_deref(),
                Some("failure") | Some("startup_failure")
            )
        {
            failed_count += 1;
        }
    }

    log::trace!("Found {} workflow runs ({failed_count} failed)", runs.len());

    Ok(WorkflowRunsResult { runs, failed_count })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_run_deserialization() {
        let json = r#"[{
            "databaseId": 123,
            "name": "build",
            "displayTitle": "Fix bug",
            "status": "completed",
            "conclusion": "failure",
            "event": "push",
            "headBranch": "main",
            "createdAt": "2025-01-01T00:00:00Z",
            "url": "https://github.com/owner/repo/actions/runs/123",
            "workflowName": "CI"
        }]"#;

        let runs: Vec<WorkflowRun> = serde_json::from_str(json).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].database_id, 123);
        assert_eq!(runs[0].conclusion.as_deref(), Some("failure"));
        assert_eq!(runs[0].workflow_name, "CI");
    }

    fn make_run(id: u64, workflow: &str, conclusion: Option<&str>) -> WorkflowRun {
        WorkflowRun {
            database_id: id,
            name: "job".into(),
            display_title: format!("run {id}"),
            status: "completed".into(),
            conclusion: conclusion.map(String::from),
            event: "push".into(),
            head_branch: "main".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
            url: format!("https://example.com/{id}"),
            workflow_name: workflow.into(),
        }
    }

    fn count_failed(runs: &[WorkflowRun]) -> u32 {
        let mut seen = std::collections::HashSet::new();
        let mut count: u32 = 0;
        for run in runs {
            if seen.insert(&run.workflow_name)
                && matches!(
                    run.conclusion.as_deref(),
                    Some("failure") | Some("startup_failure")
                )
            {
                count += 1;
            }
        }
        count
    }

    #[test]
    fn test_failed_count_ignores_old_failures_after_success() {
        // CI: latest=success, older=failure → should NOT count
        // Runs are ordered newest-first (like gh CLI output)
        let runs = vec![
            make_run(2, "CI", Some("success")),
            make_run(1, "CI", Some("failure")),
        ];
        assert_eq!(count_failed(&runs), 0);
    }

    #[test]
    fn test_failed_count_counts_latest_failure() {
        // CI: latest=failure → should count
        // Deploy: latest=success → should NOT count
        let runs = vec![
            make_run(4, "CI", Some("failure")),
            make_run(3, "Deploy", Some("success")),
            make_run(2, "CI", Some("success")),
            make_run(1, "Deploy", Some("failure")),
        ];
        assert_eq!(count_failed(&runs), 1);
    }

    #[test]
    fn test_failed_count_in_progress_not_counted() {
        // CI: latest=in_progress (no conclusion) → should NOT count
        let runs = vec![make_run(2, "CI", None), make_run(1, "CI", Some("failure"))];
        assert_eq!(count_failed(&runs), 0);
    }

    #[test]
    fn test_failed_count_multiple_workflows_failing() {
        let runs = vec![
            make_run(3, "CI", Some("failure")),
            make_run(2, "Deploy", Some("startup_failure")),
            make_run(1, "CI", Some("success")),
        ];
        assert_eq!(count_failed(&runs), 2);
    }

    #[test]
    fn test_workflow_runs_result_serialization() {
        let result = WorkflowRunsResult {
            runs: vec![],
            failed_count: 3,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"failedCount\":3"));
        assert!(json.contains("\"runs\":[]"));
    }
}
