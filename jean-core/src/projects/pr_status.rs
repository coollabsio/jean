use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

fn gh_command(gh: &std::path::Path, project_path: &str) -> std::process::Command {
    crate::platform::resolved_cli_command(gh, Some(std::path::Path::new(project_path)))
}

/// PR state from GitHub API
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

/// Review decision from GitHub API
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

/// CI check status rollup
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Success,
    Failure,
    Pending,
    Error,
}

/// High-level display status for UI
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PrDisplayStatus {
    Draft,
    Open,
    Review,
    Merged,
    Closed,
}

/// PR merge conflict status from GitHub API
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MergeableStatus {
    Mergeable,
    Conflicting,
    Unknown,
}

/// Raw response from gh pr view --json
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrViewResponse {
    state: String,
    is_draft: bool,
    review_decision: Option<String>,
    status_check_rollup: Option<Vec<StatusCheck>>,
    mergeable: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct StatusCheck {
    conclusion: Option<String>,
    status: Option<String>,
}

/// Processed PR status for frontend consumption
#[derive(Debug, Clone, Serialize)]
pub struct PrStatus {
    pub worktree_id: String,
    pub pr_number: u32,
    pub pr_url: String,
    pub state: PrState,
    pub is_draft: bool,
    pub review_decision: Option<ReviewDecision>,
    pub check_status: Option<CheckStatus>,
    pub display_status: PrDisplayStatus,
    pub mergeable: Option<MergeableStatus>,
    pub checked_at: u64,
}

/// Fetch PR status using gh CLI
pub fn get_pr_status(
    repo_path: &str,
    pr_number: u32,
    pr_url: &str,
    worktree_id: &str,
    gh_binary: &std::path::Path,
) -> Result<PrStatus, String> {
    log::trace!("Fetching PR status for #{pr_number} in {repo_path}");

    // Run gh pr view
    let output = gh_command(gh_binary, repo_path)
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "state,isDraft,reviewDecision,statusCheckRollup,mergeable",
        ])
        .output()
        .map_err(|e| format!("Failed to run gh pr view: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Handle specific errors
        if stderr.contains("no pull requests found") || stderr.contains("Could not resolve") {
            return Err("PR not found - may have been deleted".to_string());
        }
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated".to_string());
        }
        return Err(format!("gh pr view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let response: GhPrViewResponse =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    // Convert to PrStatus
    let state = parse_pr_state(&response.state);
    let review_decision = response
        .review_decision
        .as_ref()
        .and_then(|s| parse_review_decision(s));
    let check_status = compute_check_status(&response.status_check_rollup);
    let display_status = compute_display_status(&state, response.is_draft, &review_decision);
    let mergeable = response
        .mergeable
        .as_ref()
        .and_then(|s| parse_mergeable_status(s));

    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(PrStatus {
        worktree_id: worktree_id.to_string(),
        pr_number,
        pr_url: pr_url.to_string(),
        state,
        is_draft: response.is_draft,
        review_decision,
        check_status,
        display_status,
        mergeable,
        checked_at,
    })
}

fn parse_pr_state(s: &str) -> PrState {
    match s.to_uppercase().as_str() {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => PrState::Open,
    }
}

fn parse_mergeable_status(s: &str) -> Option<MergeableStatus> {
    match s.to_uppercase().as_str() {
        "MERGEABLE" => Some(MergeableStatus::Mergeable),
        "CONFLICTING" => Some(MergeableStatus::Conflicting),
        "UNKNOWN" => Some(MergeableStatus::Unknown),
        _ => None,
    }
}

fn parse_review_decision(s: &str) -> Option<ReviewDecision> {
    match s.to_uppercase().as_str() {
        "APPROVED" => Some(ReviewDecision::Approved),
        "CHANGES_REQUESTED" => Some(ReviewDecision::ChangesRequested),
        "REVIEW_REQUIRED" => Some(ReviewDecision::ReviewRequired),
        _ => None,
    }
}

fn compute_check_status(checks: &Option<Vec<StatusCheck>>) -> Option<CheckStatus> {
    let checks = checks.as_ref()?;
    if checks.is_empty() {
        return None;
    }

    // Aggregate: any failure = failure, any pending = pending, all success = success
    let mut has_pending = false;
    for check in checks {
        match check.conclusion.as_deref() {
            Some("FAILURE") | Some("failure") => return Some(CheckStatus::Failure),
            Some("ERROR") | Some("error") => return Some(CheckStatus::Error),
            _ => {}
        }
        match check.status.as_deref() {
            Some("IN_PROGRESS") | Some("QUEUED") | Some("PENDING") | Some("in_progress")
            | Some("queued") | Some("pending") => has_pending = true,
            _ => {}
        }
        // Also check if conclusion is null but status is not completed
        if check.conclusion.is_none() {
            if let Some(status) = &check.status {
                if status != "COMPLETED" && status != "completed" {
                    has_pending = true;
                }
            }
        }
    }

    if has_pending {
        Some(CheckStatus::Pending)
    } else {
        Some(CheckStatus::Success)
    }
}

fn compute_display_status(
    state: &PrState,
    is_draft: bool,
    review_decision: &Option<ReviewDecision>,
) -> PrDisplayStatus {
    match state {
        PrState::Merged => PrDisplayStatus::Merged,
        PrState::Closed => PrDisplayStatus::Closed,
        PrState::Open => {
            if is_draft {
                PrDisplayStatus::Draft
            } else if review_decision.is_some() {
                PrDisplayStatus::Review
            } else {
                PrDisplayStatus::Open
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pr_state() {
        assert_eq!(parse_pr_state("OPEN"), PrState::Open);
        assert_eq!(parse_pr_state("CLOSED"), PrState::Closed);
        assert_eq!(parse_pr_state("MERGED"), PrState::Merged);
        assert_eq!(parse_pr_state("open"), PrState::Open);
    }

    #[test]
    fn test_compute_display_status() {
        assert_eq!(
            compute_display_status(&PrState::Merged, false, &None),
            PrDisplayStatus::Merged
        );
        assert_eq!(
            compute_display_status(&PrState::Closed, false, &None),
            PrDisplayStatus::Closed
        );
        assert_eq!(
            compute_display_status(&PrState::Open, true, &None),
            PrDisplayStatus::Draft
        );
        assert_eq!(
            compute_display_status(&PrState::Open, false, &Some(ReviewDecision::Approved)),
            PrDisplayStatus::Review
        );
        assert_eq!(
            compute_display_status(&PrState::Open, false, &None),
            PrDisplayStatus::Open
        );
    }

    #[test]
    fn test_pr_status_serialization() {
        let status = PrStatus {
            worktree_id: "test-id".to_string(),
            pr_number: 123,
            pr_url: "https://github.com/owner/repo/pull/123".to_string(),
            state: PrState::Open,
            is_draft: false,
            review_decision: Some(ReviewDecision::Approved),
            check_status: Some(CheckStatus::Success),
            display_status: PrDisplayStatus::Review,
            mergeable: Some(MergeableStatus::Mergeable),
            checked_at: 1234567890,
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"display_status\":\"review\""));
        assert!(json.contains("\"check_status\":\"success\""));
        assert!(json.contains("\"mergeable\":\"mergeable\""));
    }

    #[test]
    fn test_parse_mergeable_status() {
        assert_eq!(
            parse_mergeable_status("MERGEABLE"),
            Some(MergeableStatus::Mergeable)
        );
        assert_eq!(
            parse_mergeable_status("CONFLICTING"),
            Some(MergeableStatus::Conflicting)
        );
        assert_eq!(
            parse_mergeable_status("UNKNOWN"),
            Some(MergeableStatus::Unknown)
        );
        assert_eq!(parse_mergeable_status("other"), None);
    }
}
