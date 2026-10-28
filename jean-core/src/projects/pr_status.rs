use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::projects::provider::{resolve_git_provider, GitProvider};

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

/// One CI signal: a check run, or a commit status mapped onto the same fields.
#[derive(Debug, Clone, Deserialize)]
struct StatusCheck {
    conclusion: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RestPull {
    state: String,
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    draft: bool,
    mergeable: Option<bool>,
    #[serde(default)]
    requested_reviewers: Vec<serde_json::Value>,
    #[serde(default)]
    requested_teams: Vec<serde_json::Value>,
    base: RestBase,
    head: RestHead,
}

#[derive(Debug, Deserialize)]
struct RestBase {
    #[serde(rename = "ref")]
    name: String,
}

#[derive(Debug, Deserialize)]
struct RestHead {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct RestReview {
    user: Option<RestUser>,
    state: String,
}

#[derive(Debug, Deserialize)]
struct RestUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct RestCheckRuns {
    check_runs: Vec<StatusCheck>,
}

#[derive(Debug, Deserialize)]
struct RestCombinedStatus {
    statuses: Vec<RestCommitStatus>,
}

#[derive(Debug, Deserialize)]
struct RestCommitStatus {
    state: String,
}

/// Processed PR status for frontend consumption
#[derive(Debug, Clone, Serialize)]
pub struct PrStatus {
    pub worktree_id: String,
    pub pr_number: u32,
    pub pr_url: String,
    pub base_branch: String,
    pub state: PrState,
    pub is_draft: bool,
    pub review_decision: Option<ReviewDecision>,
    pub check_status: Option<CheckStatus>,
    pub display_status: PrDisplayStatus,
    pub mergeable: Option<MergeableStatus>,
    pub checked_at: u64,
}

/// Fetch PR/MR status for a worktree's linked PR, dispatching by git provider.
pub fn get_pr_status(
    app: &AppHandle,
    repo_path: &str,
    pr_number: u32,
    pr_url: &str,
    worktree_id: &str,
) -> Result<PrStatus, String> {
    if resolve_git_provider(repo_path).0 == GitProvider::Gitlab {
        return get_mr_status(app, repo_path, pr_number, pr_url, worktree_id);
    }

    let gh_binary = crate::gh_cli::config::resolve_gh_binary(app);
    get_github_pr_status(&gh_binary, repo_path, pr_number, pr_url, worktree_id)
}

/// REST, not `gh pr view`: the GraphQL quota is the one agents spend on
/// `gh pr create/view/checks`, and unchanged REST answers (304) are free.
fn get_github_pr_status(
    gh_binary: &std::path::Path,
    repo_path: &str,
    pr_number: u32,
    pr_url: &str,
    worktree_id: &str,
) -> Result<PrStatus, String> {
    log::trace!("Fetching PR status for #{pr_number} in {repo_path}");

    let (hostname, repo) = match parse_pr_url(pr_url) {
        Some((host, repo)) => ((host != "github.com").then_some(host), repo),
        None => (None, "{owner}/{repo}".to_string()),
    };
    let get = |path: String| -> Result<String, String> {
        crate::gh_cli::quota::background_rest_get(gh_binary, repo_path, hostname, &path).map_err(
            |e| match e.status {
                Some(404) => "PR not found - may have been deleted".to_string(),
                Some(401) => "GitHub CLI not authenticated".to_string(),
                _ => e.message,
            },
        )
    };
    let base = format!("repos/{repo}");
    let pull: RestPull = parse_json("pull request", &get(format!("{base}/pulls/{pr_number}"))?)?;
    let reviews: Vec<RestReview> = parse_json(
        "reviews",
        &get(format!("{base}/pulls/{pr_number}/reviews?per_page=100"))?,
    )?;
    let sha = &pull.head.sha;
    let check_runs: RestCheckRuns = parse_json(
        "check runs",
        &get(format!("{base}/commits/{sha}/check-runs?per_page=100"))?,
    )?;
    let combined: RestCombinedStatus = parse_json(
        "commit status",
        &get(format!("{base}/commits/{sha}/status"))?,
    )?;

    let state = if pull.merged {
        PrState::Merged
    } else {
        parse_pr_state(&pull.state)
    };
    let review_requested = !pull.requested_reviewers.is_empty() || !pull.requested_teams.is_empty();
    let review_decision = compute_review_decision(&reviews, review_requested);
    let mut checks = check_runs.check_runs;
    checks.extend(combined.statuses.iter().map(commit_status_as_check));
    let check_status = compute_check_status(&checks);
    let display_status = compute_display_status(&state, pull.draft, &review_decision);
    let mergeable = Some(match pull.mergeable {
        Some(true) => MergeableStatus::Mergeable,
        Some(false) => MergeableStatus::Conflicting,
        None => MergeableStatus::Unknown,
    });

    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(PrStatus {
        worktree_id: worktree_id.to_string(),
        pr_number,
        pr_url: pr_url.to_string(),
        base_branch: pull.base.name,
        state,
        is_draft: pull.draft,
        review_decision,
        check_status,
        display_status,
        mergeable,
        checked_at,
    })
}

fn parse_json<T: serde::de::DeserializeOwned>(what: &str, json: &str) -> Result<T, String> {
    serde_json::from_str(json).map_err(|e| format!("Failed to parse GitHub {what}: {e}"))
}

/// `https://host/owner/repo/pull/123` → `(host, "owner/repo")`.
fn parse_pr_url(url: &str) -> Option<(&str, String)> {
    let mut parts = url.split_once("://")?.1.split('/');
    let host = parts.next()?;
    let owner = parts.next()?;
    let repo = parts.next()?;
    (parts.next()? == "pull").then(|| (host, format!("{owner}/{repo}")))
}

/// REST has no `reviewDecision`. Approximate it from each reviewer's latest
/// verdict; without branch-protection data, "required" means a review was requested.
fn compute_review_decision(
    reviews: &[RestReview],
    review_requested: bool,
) -> Option<ReviewDecision> {
    let mut latest: HashMap<&str, &str> = HashMap::new();
    for review in reviews {
        let state = review.state.as_str();
        if let (Some(user), "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED") = (&review.user, state)
        {
            latest.insert(&user.login, state);
        }
    }
    if latest.values().any(|state| *state == "CHANGES_REQUESTED") {
        Some(ReviewDecision::ChangesRequested)
    } else if latest.values().any(|state| *state == "APPROVED") {
        Some(ReviewDecision::Approved)
    } else if review_requested {
        Some(ReviewDecision::ReviewRequired)
    } else {
        None
    }
}

fn commit_status_as_check(status: &RestCommitStatus) -> StatusCheck {
    match status.state.as_str() {
        "pending" => StatusCheck {
            conclusion: None,
            status: Some("pending".to_string()),
        },
        state => StatusCheck {
            conclusion: Some(state.to_string()),
            status: Some("completed".to_string()),
        },
    }
}

fn parse_pr_state(s: &str) -> PrState {
    match s.to_uppercase().as_str() {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        // GitLab MRs can be "locked" (open but discussion-locked). Treat as open
        // since there's no distinct display state and the MR is still active.
        "OPEN" | "OPENED" | "LOCKED" => PrState::Open,
        _ => PrState::Open,
    }
}

fn compute_check_status(checks: &[StatusCheck]) -> Option<CheckStatus> {
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

/// Fetch merge-request status via glab and map it onto [`PrStatus`].
///
/// GitLab has no direct equivalent of GitHub's review-decision, so
/// `review_decision` is always `None`; CI state comes from the MR's pipeline and
/// mergeability from `(detailed_)merge_status`.
fn get_mr_status(
    app: &AppHandle,
    repo_path: &str,
    pr_number: u32,
    pr_url: &str,
    worktree_id: &str,
) -> Result<PrStatus, String> {
    log::trace!("Fetching MR status for !{pr_number} in {repo_path}");

    let raw = crate::projects::gitlab_issues::fetch_mr_status_raw(app, repo_path, pr_number)?;

    let state = parse_pr_state(&raw.state);
    let review_decision = None;
    let check_status = raw
        .pipeline_status
        .as_deref()
        .and_then(parse_gitlab_pipeline_status);
    let mergeable = raw.merge_status.as_deref().map(parse_gitlab_merge_status);
    let display_status = compute_display_status(&state, raw.is_draft, &review_decision);

    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(PrStatus {
        worktree_id: worktree_id.to_string(),
        pr_number,
        pr_url: pr_url.to_string(),
        base_branch: raw.target_branch,
        state,
        is_draft: raw.is_draft,
        review_decision,
        check_status,
        display_status,
        mergeable,
        checked_at,
    })
}

/// Map a GitLab pipeline status to a [`CheckStatus`] (None when there's no
/// meaningful CI signal, e.g. canceled/skipped/no pipeline).
fn parse_gitlab_pipeline_status(s: &str) -> Option<CheckStatus> {
    match s {
        "success" => Some(CheckStatus::Success),
        "failed" => Some(CheckStatus::Failure),
        "running"
        | "pending"
        | "created"
        | "waiting_for_resource"
        | "preparing"
        | "scheduled"
        | "manual" => Some(CheckStatus::Pending),
        _ => None,
    }
}

/// Map a GitLab `merge_status` / `detailed_merge_status` to [`MergeableStatus`].
fn parse_gitlab_merge_status(s: &str) -> MergeableStatus {
    match s {
        "can_be_merged" | "mergeable" => MergeableStatus::Mergeable,
        "cannot_be_merged" | "cannot_be_merged_recheck" | "broken_status" | "conflict" => {
            MergeableStatus::Conflicting
        }
        _ => MergeableStatus::Unknown,
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

    fn review(login: &str, state: &str) -> RestReview {
        RestReview {
            user: Some(RestUser {
                login: login.to_string(),
            }),
            state: state.to_string(),
        }
    }

    #[test]
    fn review_decision_uses_each_reviewers_latest_verdict() {
        assert_eq!(compute_review_decision(&[], false), None);
        assert_eq!(
            compute_review_decision(&[], true),
            Some(ReviewDecision::ReviewRequired)
        );
        assert_eq!(
            compute_review_decision(
                &[
                    review("a", "CHANGES_REQUESTED"),
                    review("a", "COMMENTED"),
                    review("a", "APPROVED")
                ],
                false
            ),
            Some(ReviewDecision::Approved)
        );
        assert_eq!(
            compute_review_decision(
                &[review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")],
                false
            ),
            Some(ReviewDecision::ChangesRequested)
        );
        assert_eq!(
            compute_review_decision(&[review("a", "APPROVED"), review("a", "DISMISSED")], true),
            Some(ReviewDecision::ReviewRequired)
        );
    }

    #[test]
    fn check_status_includes_commit_statuses() {
        let passing = StatusCheck {
            conclusion: Some("success".to_string()),
            status: Some("completed".to_string()),
        };
        let failed = RestCommitStatus {
            state: "failure".to_string(),
        };
        let pending = RestCommitStatus {
            state: "pending".to_string(),
        };
        assert_eq!(compute_check_status(&[]), None);
        assert_eq!(
            compute_check_status(std::slice::from_ref(&passing)),
            Some(CheckStatus::Success)
        );
        assert_eq!(
            compute_check_status(&[passing.clone(), commit_status_as_check(&pending)]),
            Some(CheckStatus::Pending)
        );
        assert_eq!(
            compute_check_status(&[passing, commit_status_as_check(&failed)]),
            Some(CheckStatus::Failure)
        );
    }

    #[test]
    fn parses_pr_url_host_and_repo() {
        assert_eq!(
            parse_pr_url("https://github.com/coollabsio/jean/pull/882"),
            Some(("github.com", "coollabsio/jean".to_string()))
        );
        assert_eq!(
            parse_pr_url("https://ghe.example.com/team/app/pull/7"),
            Some(("ghe.example.com", "team/app".to_string()))
        );
        assert_eq!(
            parse_pr_url("https://github.com/coollabsio/jean/issues/1"),
            None
        );
        assert_eq!(parse_pr_url("not a url"), None);
    }

    /// Live: `JEAN_GH=/path/to/gh cargo test --lib live_github_pr_status -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_github_pr_status() {
        let gh = std::env::var("JEAN_GH").unwrap_or_else(|_| "gh".to_string());
        let gh = std::path::Path::new(&gh);
        let url = "https://github.com/coollabsio/jean/pull/882";
        let first = get_github_pr_status(gh, ".", 882, url, "w").unwrap();
        let second = get_github_pr_status(gh, ".", 882, url, "w").unwrap();
        println!("{first:?}");
        assert_eq!(first.state, PrState::Merged);
        assert_eq!(first.base_branch, "main");
        assert_eq!(first.check_status, second.check_status);
        let missing = get_github_pr_status(
            gh,
            ".",
            999_999,
            "https://github.com/coollabsio/jean/pull/999999",
            "w",
        );
        assert_eq!(missing.unwrap_err(), "PR not found - may have been deleted");
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
            base_branch: "main".to_string(),
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
        assert!(json.contains("\"base_branch\":\"main\""));
    }
}
