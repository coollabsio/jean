use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use tauri::AppHandle;

use crate::gh_cli::config::resolve_gh_binary;
use crate::platform::silent_command;

fn gh_command(gh: &Path, project_path: &str) -> std::process::Command {
    crate::platform::resolved_cli_command(gh, Some(Path::new(project_path)))
}

pub type PrIssueRefsMap = BTreeMap<u32, BTreeMap<String, BTreeSet<u32>>>;

static PR_NUMBER_IN_SUBJECT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\(#(\d+)\)").expect("valid PR number regex"));
static ISSUE_KEYWORD_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+((?:(?:#\d+|https?://github\.com/[^\s/]+/[^\s/]+/issues/\d+))(?:[\s,]*(?:and\s+)?(?:(?:#\d+|https?://github\.com/[^\s/]+/[^\s/]+/issues/\d+)))*)",
    )
    .expect("valid issue keyword regex")
});
static ISSUE_NUMBER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:#|/issues/)(\d+)").expect("valid issue number regex"));

#[derive(Debug, Clone)]
pub struct ReleaseNotesPromptContext {
    pub pull_requests: String,
    pub pr_issue_refs: PrIssueRefsMap,
}

#[derive(Debug, Clone)]
struct GitCommitRecord {
    oid: String,
    subject: String,
    body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubIssueRef {
    number: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubCommitRef {
    oid: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubPullRequestCommit {
    oid: String,
    #[serde(default)]
    message_headline: String,
    #[serde(default)]
    message_body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubPullRequestCandidate {
    number: u32,
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    closing_issues_references: Vec<GitHubIssueRef>,
    merge_commit: Option<GitHubCommitRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct IssueRef {
    number: u32,
    keyword: String,
}

#[derive(Debug, Clone)]
struct MatchedPullRequest {
    number: u32,
    title: String,
    matched_commits: Vec<GitCommitRecord>,
    issue_refs: Vec<IssueRef>,
}

pub fn build_release_notes_prompt_context(
    app: &AppHandle,
    project_path: &str,
    tag: &str,
) -> Result<ReleaseNotesPromptContext, String> {
    let all_commits = load_git_commits(project_path, tag)?;
    if all_commits.is_empty() {
        return Err(format!("No changes found since {tag}"));
    }

    let gh = resolve_gh_binary(app);
    let tag_date = load_tag_date(project_path, tag)?;
    let sha_set: HashSet<&str> = all_commits
        .iter()
        .map(|commit| commit.oid.as_str())
        .collect();
    let subjects_with_pr_numbers = collect_pr_numbers_from_subjects(&all_commits);
    let mut matched_prs = Vec::new();
    let mut unresolved_candidates = Vec::new();

    for pr in load_pull_requests(&gh, project_path, &tag_date)? {
        let merge_commit_match = pr
            .merge_commit
            .as_ref()
            .map(|merge_commit| sha_set.contains(merge_commit.oid.as_str()))
            .unwrap_or(false);
        let subject_match = subjects_with_pr_numbers.contains(&pr.number);

        if merge_commit_match || subject_match {
            let pr_commits =
                load_pull_request_commits(&gh, project_path, pr.number).unwrap_or_default();
            let matched_commits = collect_matched_commits(&pr_commits, &all_commits, &sha_set);
            let issue_refs = collect_issue_refs(&pr, &pr_commits, &matched_commits);
            matched_prs.push(MatchedPullRequest {
                number: pr.number,
                title: pr.title,
                matched_commits: matched_commits.clone(),
                issue_refs,
            });
        } else {
            unresolved_candidates.push(pr);
        }
    }

    for pr in unresolved_candidates {
        let pr_commits = load_pull_request_commits(&gh, project_path, pr.number)?;
        let matched_commits = collect_matched_commits(&pr_commits, &all_commits, &sha_set);
        if matched_commits.is_empty() {
            continue;
        }
        let issue_refs = collect_issue_refs(&pr, &pr_commits, &matched_commits);

        matched_prs.push(MatchedPullRequest {
            number: pr.number,
            title: pr.title,
            matched_commits: matched_commits.clone(),
            issue_refs,
        });
    }

    Ok(ReleaseNotesPromptContext {
        pull_requests: format_pull_requests_prompt(&matched_prs),
        pr_issue_refs: build_pr_issue_refs_map(&matched_prs),
    })
}

fn load_git_commits(project_path: &str, tag: &str) -> Result<Vec<GitCommitRecord>, String> {
    let output = silent_command("git")
        .args([
            "log",
            &format!("{tag}..HEAD"),
            "--format=%H%x1f%s%x1f%b%x1e",
        ])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to get commit metadata: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get commits since {tag}: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_git_log(stdout.as_ref()))
}

fn load_tag_date(project_path: &str, tag: &str) -> Result<String, String> {
    let output = silent_command("git")
        .args(["show", "-s", "--format=%cI", tag])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to get tag date: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get tag date for {tag}: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let date = stdout.trim();
    if date.is_empty() {
        return Err(format!("Tag {tag} has no commit date"));
    }

    Ok(date.to_string())
}

fn load_pull_requests(
    gh: &Path,
    project_path: &str,
    tag_date: &str,
) -> Result<Vec<GitHubPullRequestCandidate>, String> {
    let search = format!("merged:>={tag_date}");
    let output = gh_command(gh, project_path)
        .args([
            "pr",
            "list",
            "--state",
            "merged",
            "--limit",
            "200",
            "--search",
            &search,
            "--json",
            "number,title,body,closingIssuesReferences,mergeCommit",
        ])
        .output()
        .map_err(|e| format!("Failed to run gh pr list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        return Err(format!("Failed to list merged pull requests: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<Vec<GitHubPullRequestCandidate>>(&stdout)
        .map_err(|e| format!("Failed to parse merged pull requests: {e}"))
}

fn load_pull_request_commits(
    gh: &Path,
    project_path: &str,
    pr_number: u32,
) -> Result<Vec<GitHubPullRequestCommit>, String> {
    let output = gh_command(gh, project_path)
        .args(["pr", "view", &pr_number.to_string(), "--json", "commits"])
        .output()
        .map_err(|e| format!("Failed to run gh pr view for #{pr_number}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        return Err(format!(
            "Failed to load commits for PR #{pr_number}: {stderr}"
        ));
    }

    #[derive(Deserialize)]
    struct PullRequestCommitsResponse {
        #[serde(default)]
        commits: Vec<GitHubPullRequestCommit>,
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let response = serde_json::from_str::<PullRequestCommitsResponse>(&stdout)
        .map_err(|e| format!("Failed to parse commits for PR #{pr_number}: {e}"))?;
    Ok(response.commits)
}

fn load_pull_request_detail(
    gh: &Path,
    project_path: &str,
    pr_number: u32,
) -> Result<(GitHubPullRequestCandidate, Vec<GitHubPullRequestCommit>), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PullRequestDetailResponse {
        number: u32,
        title: String,
        #[serde(default)]
        body: String,
        #[serde(default)]
        closing_issues_references: Vec<GitHubIssueRef>,
        #[serde(default)]
        commits: Vec<GitHubPullRequestCommit>,
    }

    let output = gh_command(gh, project_path)
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "number,title,body,closingIssuesReferences,commits",
        ])
        .output()
        .map_err(|e| format!("Failed to run gh pr view for #{pr_number}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        return Err(format!("Failed to load PR #{pr_number}: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let response = serde_json::from_str::<PullRequestDetailResponse>(&stdout)
        .map_err(|e| format!("Failed to parse PR #{pr_number}: {e}"))?;

    Ok((
        GitHubPullRequestCandidate {
            number: response.number,
            title: response.title,
            body: response.body,
            closing_issues_references: response.closing_issues_references,
            merge_commit: None,
        },
        response.commits,
    ))
}

fn parse_git_log(raw: &str) -> Vec<GitCommitRecord> {
    raw.split('\u{1e}')
        .filter_map(|entry| {
            let trimmed = entry.trim_matches('\n').trim();
            if trimmed.is_empty() {
                return None;
            }

            let mut parts = trimmed.splitn(3, '\u{1f}');
            let oid = parts.next()?.trim();
            let subject = parts.next()?.trim();
            let body = parts.next().unwrap_or("").trim();

            Some(GitCommitRecord {
                oid: oid.to_string(),
                subject: subject.to_string(),
                body: body.to_string(),
            })
        })
        .collect()
}

fn collect_pr_numbers_from_subjects(commits: &[GitCommitRecord]) -> HashSet<u32> {
    commits
        .iter()
        .flat_map(|commit| {
            PR_NUMBER_IN_SUBJECT_RE
                .captures_iter(&commit.subject)
                .filter_map(|captures| captures.get(1)?.as_str().parse::<u32>().ok())
        })
        .collect()
}

fn collect_matched_commits(
    pr_commits: &[GitHubPullRequestCommit],
    all_commits: &[GitCommitRecord],
    sha_set: &HashSet<&str>,
) -> Vec<GitCommitRecord> {
    let pr_commit_oids: HashSet<&str> = pr_commits
        .iter()
        .filter_map(|commit| {
            if sha_set.contains(commit.oid.as_str()) {
                Some(commit.oid.as_str())
            } else {
                None
            }
        })
        .collect();

    all_commits
        .iter()
        .filter(|commit| pr_commit_oids.contains(commit.oid.as_str()))
        .cloned()
        .collect()
}

fn collect_issue_refs(
    pr: &GitHubPullRequestCandidate,
    pr_commits: &[GitHubPullRequestCommit],
    matched_commits: &[GitCommitRecord],
) -> Vec<IssueRef> {
    let mut issue_keywords = BTreeMap::new();

    merge_issue_keywords(&mut issue_keywords, parse_issue_keywords(&pr.title));
    merge_issue_keywords(&mut issue_keywords, parse_issue_keywords(&pr.body));

    for commit in pr_commits {
        let combined = join_message_parts(&commit.message_headline, &commit.message_body);
        merge_issue_keywords(&mut issue_keywords, parse_issue_keywords(&combined));
    }

    for commit in matched_commits {
        let combined = join_message_parts(&commit.subject, &commit.body);
        merge_issue_keywords(&mut issue_keywords, parse_issue_keywords(&combined));
    }

    for issue in &pr.closing_issues_references {
        issue_keywords
            .entry(issue.number)
            .or_insert_with(|| "fixes".to_string());
    }

    issue_keywords
        .into_iter()
        .map(|(number, keyword)| IssueRef { number, keyword })
        .collect()
}

fn merge_issue_keywords(target: &mut BTreeMap<u32, String>, refs: Vec<IssueRef>) {
    for issue_ref in refs {
        target.entry(issue_ref.number).or_insert(issue_ref.keyword);
    }
}

fn parse_issue_keywords(text: &str) -> Vec<IssueRef> {
    let mut found = BTreeMap::new();

    for captures in ISSUE_KEYWORD_RE.captures_iter(text) {
        let Some(keyword_match) = captures.get(1) else {
            continue;
        };
        let Some(issues_match) = captures.get(2) else {
            continue;
        };

        let keyword = normalize_keyword(keyword_match.as_str());
        for issue_captures in ISSUE_NUMBER_RE.captures_iter(issues_match.as_str()) {
            let Some(number_match) = issue_captures.get(1) else {
                continue;
            };
            if let Ok(number) = number_match.as_str().parse::<u32>() {
                found.entry(number).or_insert_with(|| keyword.clone());
            }
        }
    }

    found
        .into_iter()
        .map(|(number, keyword)| IssueRef { number, keyword })
        .collect()
}

fn normalize_keyword(keyword: &str) -> String {
    if keyword.eq_ignore_ascii_case("close")
        || keyword.eq_ignore_ascii_case("closes")
        || keyword.eq_ignore_ascii_case("closed")
    {
        "closes".to_string()
    } else if keyword.eq_ignore_ascii_case("fix")
        || keyword.eq_ignore_ascii_case("fixes")
        || keyword.eq_ignore_ascii_case("fixed")
    {
        "fixes".to_string()
    } else {
        "resolves".to_string()
    }
}

fn join_message_parts(headline: &str, body: &str) -> String {
    if body.trim().is_empty() {
        headline.trim().to_string()
    } else {
        format!("{}\n{}", headline.trim(), body.trim())
    }
}

fn format_pull_requests_prompt(prs: &[MatchedPullRequest]) -> String {
    if prs.is_empty() {
        return "No merged pull request metadata matched the commits in this release window. Use commit history only.".to_string();
    }

    let mut sorted = prs.to_vec();
    sorted.sort_by_key(|pr| pr.number);

    let mut lines = Vec::new();
    for pr in sorted {
        lines.push(format!("- PR #{}: {}", pr.number, pr.title));

        if pr.issue_refs.is_empty() {
            lines.push("  - Related issues: none detected".to_string());
        } else {
            lines.push(format!(
                "  - Related issues: {}",
                format_issue_groups(&group_issue_refs(&pr.issue_refs))
            ));
        }

        if pr.matched_commits.is_empty() {
            lines.push("  - Matched commits: none directly matched; PR number inferred from commit subjects".to_string());
        } else {
            lines.push("  - Matched commits:".to_string());
            for commit in pr.matched_commits {
                lines.push(format!(
                    "    - {} {}",
                    short_oid(&commit.oid),
                    commit.subject
                ));
            }
        }
    }

    lines.join("\n")
}

fn build_pr_issue_refs_map(prs: &[MatchedPullRequest]) -> PrIssueRefsMap {
    prs.iter()
        .filter(|pr| !pr.issue_refs.is_empty())
        .map(|pr| (pr.number, group_issue_refs(&pr.issue_refs)))
        .collect()
}

fn group_issue_refs(issue_refs: &[IssueRef]) -> BTreeMap<String, BTreeSet<u32>> {
    let mut grouped: BTreeMap<String, BTreeSet<u32>> = BTreeMap::new();
    for issue_ref in issue_refs {
        grouped
            .entry(issue_ref.keyword.clone())
            .or_default()
            .insert(issue_ref.number);
    }
    grouped
}

pub fn format_issue_groups(grouped: &BTreeMap<String, BTreeSet<u32>>) -> String {
    grouped
        .into_iter()
        .map(|(keyword, numbers)| {
            let numbers = numbers
                .into_iter()
                .map(|number| format!("#{number}"))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{keyword} {numbers}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn build_pr_prompt_context_from_revision_range(
    app: &AppHandle,
    project_path: &str,
    revision_range: &str,
) -> Result<ReleaseNotesPromptContext, String> {
    let gh = resolve_gh_binary(app);
    let commits = load_git_commits_for_range(project_path, revision_range)?;
    build_pr_prompt_context_from_commits_with_github(&gh, project_path, &commits)
}

fn build_pr_prompt_context_from_commits_with_github(
    gh: &Path,
    project_path: &str,
    commits: &[GitCommitRecord],
) -> Result<ReleaseNotesPromptContext, String> {
    let pr_numbers = collect_pr_numbers_from_subjects(commits);
    let mut prs = Vec::new();
    let mut pr_commits_by_number = BTreeMap::new();

    for pr_number in pr_numbers {
        let (pr, pr_commits) = load_pull_request_detail(gh, project_path, pr_number)?;
        prs.push(pr);
        pr_commits_by_number.insert(pr_number, pr_commits);
    }

    Ok(build_pr_prompt_context_from_commit_records(
        commits,
        prs,
        pr_commits_by_number,
    ))
}

fn build_pr_prompt_context_from_commit_records(
    commits: &[GitCommitRecord],
    prs: Vec<GitHubPullRequestCandidate>,
    pr_commits_by_number: BTreeMap<u32, Vec<GitHubPullRequestCommit>>,
) -> ReleaseNotesPromptContext {
    let sha_set: HashSet<&str> = commits
        .iter()
        .filter_map(|commit| (!commit.oid.is_empty()).then_some(commit.oid.as_str()))
        .collect();
    let subjects_with_pr_numbers = collect_pr_numbers_from_subjects(commits);
    let mut matched_prs = Vec::new();

    for pr in prs {
        let pr_commits = pr_commits_by_number
            .get(&pr.number)
            .cloned()
            .unwrap_or_default();
        let matched_commits = collect_matched_commits(&pr_commits, commits, &sha_set);
        let subject_match = subjects_with_pr_numbers.contains(&pr.number);
        let merge_commit_match = pr
            .merge_commit
            .as_ref()
            .map(|merge_commit| sha_set.contains(merge_commit.oid.as_str()))
            .unwrap_or(false);

        if !subject_match && !merge_commit_match && matched_commits.is_empty() {
            continue;
        }

        let issue_refs = collect_issue_refs(&pr, &pr_commits, &matched_commits);
        matched_prs.push(MatchedPullRequest {
            number: pr.number,
            title: pr.title,
            matched_commits,
            issue_refs,
        });
    }

    ReleaseNotesPromptContext {
        pull_requests: format_pull_requests_prompt(&matched_prs),
        pr_issue_refs: build_pr_issue_refs_map(&matched_prs),
    }
}

pub fn build_pr_issue_refs_from_commit_range(
    app: &AppHandle,
    project_path: &str,
    revision_range: &str,
) -> Result<PrIssueRefsMap, String> {
    let gh = resolve_gh_binary(app);
    let commits = load_git_commits_for_range(project_path, revision_range)?;
    let pr_numbers = collect_pr_numbers_from_subjects(&commits);
    build_pr_issue_refs_for_pr_numbers(&gh, project_path, &pr_numbers)
}

pub fn build_pr_issue_refs_from_commit_subjects(
    app: &AppHandle,
    project_path: &str,
    commit_subjects: &[String],
) -> Result<PrIssueRefsMap, String> {
    let gh = resolve_gh_binary(app);
    let commits = commit_subjects
        .iter()
        .map(|subject| GitCommitRecord {
            oid: String::new(),
            subject: subject.clone(),
            body: String::new(),
        })
        .collect::<Vec<_>>();
    let pr_numbers = collect_pr_numbers_from_subjects(&commits);
    build_pr_issue_refs_for_pr_numbers(&gh, project_path, &pr_numbers)
}

fn build_pr_issue_refs_for_pr_numbers(
    gh: &Path,
    project_path: &str,
    pr_numbers: &HashSet<u32>,
) -> Result<PrIssueRefsMap, String> {
    let mut result = BTreeMap::new();

    for pr_number in pr_numbers {
        let (pr, pr_commits) = load_pull_request_detail(gh, project_path, *pr_number)?;
        let issue_refs = collect_issue_refs(&pr, &pr_commits, &[]);
        if issue_refs.is_empty() {
            continue;
        }
        result.insert(*pr_number, group_issue_refs(&issue_refs));
    }

    Ok(result)
}

fn load_git_commits_for_range(
    project_path: &str,
    revision_range: &str,
) -> Result<Vec<GitCommitRecord>, String> {
    let output = silent_command("git")
        .args(["log", revision_range, "--format=%H%x1f%s%x1f%b%x1e"])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to get commit metadata: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to get commits for range {revision_range}: {stderr}"
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_git_log(stdout.as_ref()))
}

fn short_oid(oid: &str) -> &str {
    oid.get(..7).unwrap_or(oid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_issue_keywords_case_insensitively() {
        let refs = parse_issue_keywords("CLOSES #12 and #13. fixed #14. Resolves #15");
        assert_eq!(
            refs,
            vec![
                IssueRef {
                    number: 12,
                    keyword: "closes".to_string(),
                },
                IssueRef {
                    number: 13,
                    keyword: "closes".to_string(),
                },
                IssueRef {
                    number: 14,
                    keyword: "fixes".to_string(),
                },
                IssueRef {
                    number: 15,
                    keyword: "resolves".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parses_issue_keywords_from_github_issue_urls() {
        let refs = parse_issue_keywords(
            "Fixes https://github.com/coollabsio/coolify/issues/9501 and https://github.com/coollabsio/coolify/issues/9504",
        );
        assert_eq!(
            refs,
            vec![
                IssueRef {
                    number: 9501,
                    keyword: "fixes".to_string(),
                },
                IssueRef {
                    number: 9504,
                    keyword: "fixes".to_string(),
                },
            ]
        );
    }

    #[test]
    fn collects_matched_commits_from_pr_commit_oids() {
        let commits = vec![GitCommitRecord {
            oid: "abc123".to_string(),
            subject: "Merge pull request #42".to_string(),
            body: String::new(),
        }];
        let sha_set = commits.iter().map(|commit| commit.oid.as_str()).collect();
        let pr_commits = vec![GitHubPullRequestCommit {
            oid: "abc123".to_string(),
            message_headline: "headline".to_string(),
            message_body: String::new(),
        }];

        let matched = collect_matched_commits(&pr_commits, &commits, &sha_set);
        assert_eq!(matched.len(), 1);
    }

    #[test]
    fn collects_pr_numbers_from_squash_commit_subject() {
        let commits = vec![GitCommitRecord {
            oid: "abc123".to_string(),
            subject: "feat: add thing (#42)".to_string(),
            body: String::new(),
        }];
        let subject_pr_numbers = collect_pr_numbers_from_subjects(&commits);
        assert!(subject_pr_numbers.contains(&42));
    }

    #[test]
    fn collects_issue_refs_from_pr_title_body_and_commits() {
        let refs = collect_issue_refs(
            &GitHubPullRequestCandidate {
                number: 42,
                title: "Add thing, fixes #11".to_string(),
                body: "Closes #12".to_string(),
                closing_issues_references: vec![],
                merge_commit: None,
            },
            &[GitHubPullRequestCommit {
                oid: "abc123".to_string(),
                message_headline: "implementation".to_string(),
                message_body: "Resolved #13".to_string(),
            }],
            &[GitCommitRecord {
                oid: "abc123".to_string(),
                subject: "squash subject".to_string(),
                body: "FIXED #14".to_string(),
            }],
        );

        assert_eq!(
            refs,
            vec![
                IssueRef {
                    number: 11,
                    keyword: "fixes".to_string(),
                },
                IssueRef {
                    number: 12,
                    keyword: "closes".to_string(),
                },
                IssueRef {
                    number: 13,
                    keyword: "resolves".to_string(),
                },
                IssueRef {
                    number: 14,
                    keyword: "fixes".to_string(),
                },
            ]
        );
    }

    #[test]
    fn builds_prompt_context_from_commit_records_with_pr_metadata_issue_refs() {
        let commits = vec![GitCommitRecord {
            oid: "abc123".to_string(),
            subject: "feat: add thing (#42)".to_string(),
            body: "Fixes #99".to_string(),
        }];
        let prs = vec![GitHubPullRequestCandidate {
            number: 42,
            title: "Add thing".to_string(),
            body: "Closes #12".to_string(),
            closing_issues_references: vec![],
            merge_commit: None,
        }];
        let pr_commits = vec![(
            42,
            vec![GitHubPullRequestCommit {
                oid: "abc123".to_string(),
                message_headline: "implementation".to_string(),
                message_body: "Resolved #13".to_string(),
            }],
        )]
        .into_iter()
        .collect::<BTreeMap<_, _>>();

        let context = build_pr_prompt_context_from_commit_records(&commits, prs, pr_commits);

        assert!(context.pull_requests.contains("- PR #42: Add thing"));
        assert!(context
            .pull_requests
            .contains("Related issues: closes #12, fixes #99, resolves #13"));
        assert_eq!(
            context.pr_issue_refs.get(&42).map(format_issue_groups),
            Some("closes #12, fixes #99, resolves #13".to_string())
        );
    }

    #[test]
    fn falls_back_to_github_closing_references_when_no_regex_match() {
        let refs = collect_issue_refs(
            &GitHubPullRequestCandidate {
                number: 42,
                title: "Add thing".to_string(),
                body: String::new(),
                closing_issues_references: vec![GitHubIssueRef { number: 77 }],
                merge_commit: None,
            },
            &[],
            &[],
        );

        assert_eq!(
            refs,
            vec![IssueRef {
                number: 77,
                keyword: "fixes".to_string(),
            }]
        );
    }
}
