//! Per-file "Viewed" marks for the git diff viewer, synced with GitHub PR viewed state.
//!
//! Local marks live in `<app_data>/diff-viewed/<worktree_id>.json` as `path -> patch hash`.
//! The frontend computes the hash, so a changed patch no longer matches and reads as unviewed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::git::get_repo_identifier;
use super::github_discussions::{graphql_data, run_gh_graphql};
use super::storage::load_projects_data;

pub type ViewedMap = HashMap<String, String>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GithubFileViewedState {
    pub path: String,
    /// `VIEWED`, `UNVIEWED` or `DISMISSED` (GitHub `FileViewedState`).
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffViewedFiles {
    pub local: ViewedMap,
    pub github: Option<Vec<GithubFileViewedState>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDiffFileViewedResult {
    pub github_synced: bool,
}

/// Serializes load-modify-save so concurrent toggles from several clients don't drop marks.
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn store_path(app: &AppHandle, worktree_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?
        .join("diff-viewed");
    let safe: String = worktree_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(dir.join(format!("{safe}.json")))
}

fn load_map(path: &Path) -> ViewedMap {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn update_map(path: &Path, file: &str, hash: &str, viewed: bool) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = load_map(path);
    if viewed {
        map.insert(file.to_string(), hash.to_string());
    } else {
        map.remove(file);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create diff-viewed dir: {e}"))?;
    }
    let json = serde_json::to_string(&map)
        .map_err(|e| format!("Failed to serialize viewed files: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write viewed files: {e}"))
}

const PR_FILES_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } } } } }";

struct PrFilesPage {
    pr_id: String,
    files: Vec<GithubFileViewedState>,
    next_cursor: Option<String>,
}

fn parse_pr_files_page(stdout: &str) -> Result<PrFilesPage, String> {
    let data = graphql_data(stdout)?;
    let pr = data
        .pointer("/repository/pullRequest")
        .filter(|pr| !pr.is_null())
        .ok_or_else(|| "Pull request not found".to_string())?;
    let pr_id = pr
        .get("id")
        .and_then(|id| id.as_str())
        .ok_or_else(|| "Pull request id missing".to_string())?
        .to_string();
    let files = pr
        .pointer("/files/nodes")
        .and_then(|nodes| nodes.as_array())
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|node| {
                    Some(GithubFileViewedState {
                        path: node.get("path")?.as_str()?.to_string(),
                        state: node.get("viewerViewedState")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let page_info = pr.pointer("/files/pageInfo");
    let has_next = page_info
        .and_then(|info| info.get("hasNextPage"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let next_cursor = has_next
        .then(|| {
            page_info
                .and_then(|info| info.get("endCursor"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .flatten();
    Ok(PrFilesPage {
        pr_id,
        files,
        next_cursor,
    })
}

/// The worktree's project path and linked PR number, if any.
fn linked_pr(app: &AppHandle, worktree_id: &str) -> Option<(String, u32)> {
    let data = load_projects_data(app).ok()?;
    let worktree = data.find_worktree(worktree_id)?;
    let pr_number = worktree.pr_number?;
    let project = data.find_project(&worktree.project_id)?;
    Some((project.path.clone(), pr_number))
}

/// Fetch the PR node id and every changed file's viewed state, following pagination.
/// `files_wanted == false` stops after the first page (only the id is needed).
fn fetch_pr_files(
    app: &AppHandle,
    project_path: &str,
    pr_number: u32,
    files_wanted: bool,
) -> Result<(String, Vec<GithubFileViewedState>), String> {
    let repo = get_repo_identifier(project_path)?;
    let mut files = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let mut string_vars = vec![("owner", repo.owner.as_str()), ("name", repo.repo.as_str())];
        if let Some(cursor) = after.as_deref() {
            string_vars.push(("after", cursor));
        }
        let stdout = run_gh_graphql(
            app,
            project_path,
            PR_FILES_QUERY,
            &string_vars,
            &[("number", pr_number)],
        )?;
        let page = parse_pr_files_page(&stdout)?;
        files.extend(page.files);
        match page.next_cursor {
            Some(cursor) if files_wanted => after = Some(cursor),
            _ => return Ok((page.pr_id, files)),
        }
    }
}

pub async fn get_diff_viewed_files(
    app: AppHandle,
    worktree_id: String,
    diff_type: String,
) -> Result<DiffViewedFiles, String> {
    let local = load_map(&store_path(&app, &worktree_id)?);
    let github = if diff_type == "branch" {
        linked_pr(&app, &worktree_id).and_then(|(project_path, pr_number)| {
            fetch_pr_files(&app, &project_path, pr_number, true)
                .map_err(|e| log::warn!("Failed to fetch PR viewed state: {e}"))
                .ok()
                .map(|(_, files)| files)
        })
    } else {
        None
    };
    Ok(DiffViewedFiles { local, github })
}

pub async fn set_diff_file_viewed(
    app: AppHandle,
    worktree_id: String,
    path: String,
    hash: String,
    viewed: bool,
    diff_type: String,
) -> Result<SetDiffFileViewedResult, String> {
    update_map(&store_path(&app, &worktree_id)?, &path, &hash, viewed)?;
    let github_synced = diff_type == "branch"
        && linked_pr(&app, &worktree_id).is_some_and(|(project_path, pr_number)| {
            sync_github_viewed(&app, &project_path, pr_number, &path, viewed)
                .map_err(|e| log::warn!("Failed to sync viewed state to GitHub: {e}"))
                .is_ok()
        });
    Ok(SetDiffFileViewedResult { github_synced })
}

fn sync_github_viewed(
    app: &AppHandle,
    project_path: &str,
    pr_number: u32,
    path: &str,
    viewed: bool,
) -> Result<(), String> {
    let (pr_id, _) = fetch_pr_files(app, project_path, pr_number, false)?;
    let mutation = if viewed {
        "markFileAsViewed"
    } else {
        "unmarkFileAsViewed"
    };
    let query = format!(
        "mutation($pr: ID!, $path: String!) {{ {mutation}(input: {{pullRequestId: $pr, path: $path}}) {{ clientMutationId }} }}"
    );
    let stdout = run_gh_graphql(
        app,
        project_path,
        &query,
        &[("pr", &pr_id), ("path", path)],
        &[],
    )?;
    graphql_data(&stdout).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_roundtrip_sets_and_clears_marks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diff-viewed").join("wt-1.json");
        assert!(load_map(&path).is_empty());

        update_map(&path, "src/a.rs", "h1", true).unwrap();
        update_map(&path, "src/b.rs", "h2", true).unwrap();
        update_map(&path, "src/a.rs", "h3", true).unwrap();
        update_map(&path, "src/b.rs", "", false).unwrap();

        let map = load_map(&path);
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("src/a.rs").map(String::as_str), Some("h3"));
    }

    #[test]
    fn parses_pr_files_page_with_cursor() {
        let stdout = r#"{"data":{"repository":{"pullRequest":{"id":"PR_kw1","files":{
            "pageInfo":{"hasNextPage":true,"endCursor":"Y3Vy"},
            "nodes":[{"path":"a.rs","viewerViewedState":"VIEWED"},
                     {"path":"b.rs","viewerViewedState":"DISMISSED"}]}}}}}"#;
        let page = parse_pr_files_page(stdout).unwrap();
        assert_eq!(page.pr_id, "PR_kw1");
        assert_eq!(page.next_cursor.as_deref(), Some("Y3Vy"));
        assert_eq!(
            page.files,
            vec![
                GithubFileViewedState {
                    path: "a.rs".into(),
                    state: "VIEWED".into()
                },
                GithubFileViewedState {
                    path: "b.rs".into(),
                    state: "DISMISSED".into()
                },
            ]
        );
    }

    #[test]
    fn last_page_has_no_cursor_and_missing_pr_errors() {
        let last = r#"{"data":{"repository":{"pullRequest":{"id":"PR_1","files":{
            "pageInfo":{"hasNextPage":false,"endCursor":"Y3Vy"},"nodes":[]}}}}}"#;
        assert_eq!(parse_pr_files_page(last).unwrap().next_cursor, None);

        let missing = r#"{"data":{"repository":{"pullRequest":null}}}"#;
        assert!(parse_pr_files_page(missing).is_err());

        let error = r#"{"data":null,"errors":[{"message":"Bad credentials"}]}"#;
        assert_eq!(
            parse_pr_files_page(error).err().as_deref(),
            Some("GitHub GraphQL error: Bad credentials")
        );
    }
}
