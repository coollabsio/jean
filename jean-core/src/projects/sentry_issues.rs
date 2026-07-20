use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::github_issues::{
    get_github_contexts_dir, load_context_references, save_context_references, slugify_issue_title,
};
use super::storage::load_projects_data;

const SENTRY_BASE_URL: &str = "https://sentry.io";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentryProject {
    pub id: String,
    pub name: String,
    pub slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentryOrganization {
    pub id: String,
    pub name: String,
    pub slug: String,
    #[serde(default, skip_serializing)]
    links: Option<SentryOrganizationLinks>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SentryOrganizationLinks {
    region_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentryProjectMapping {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub organization: SentryOrganization,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentryIssue {
    pub id: String,
    pub short_id: String,
    pub title: String,
    #[serde(default)]
    pub culprit: String,
    pub permalink: String,
    pub level: String,
    pub status: String,
    #[serde(default)]
    pub count: String,
    #[serde(default)]
    pub user_count: u64,
    pub first_seen: String,
    pub last_seen: String,
    pub project: SentryProject,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentryIssueContext {
    pub id: String,
    pub short_id: String,
    pub title: String,
    pub permalink: String,
    pub content: String,
}

struct SentryConfig {
    auth_token: String,
    organization_slug: String,
    sentry_project_slug: String,
    project_name: String,
}

fn get_sentry_auth_token(app: &AppHandle, project_id: Option<&str>) -> Result<String, String> {
    if let Some(project_id) = project_id {
        let data = load_projects_data(app)?;
        let project = data
            .find_project(project_id)
            .ok_or_else(|| format!("Project not found: {project_id}"))?;
        if let Some(token) = project
            .sentry_auth_token
            .clone()
            .filter(|value| !value.trim().is_empty())
        {
            return Ok(token);
        }
    }

    crate::load_preferences_sync(app)?
        .sentry_auth_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "No Sentry auth token configured. Add one in Settings → Integrations, or override per-project."
                .to_string()
        })
}

fn get_sentry_config(app: &AppHandle, project_id: &str) -> Result<SentryConfig, String> {
    let data = load_projects_data(app)?;
    let project = data
        .find_project(project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    let organization_slug = project
        .sentry_organization_slug
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "No Sentry organization configured. Add it in project settings.".to_string()
        })?;
    let sentry_project_slug = project
        .sentry_project_slug
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "No Sentry project configured. Add it in project settings.".to_string())?;

    let auth_token = get_sentry_auth_token(app, Some(project_id))?;

    Ok(SentryConfig {
        auth_token,
        organization_slug,
        sentry_project_slug,
        project_name: project.name.clone(),
    })
}

async fn sentry_get(
    auth_token: &str,
    url: reqwest::Url,
    required_scope: &str,
) -> Result<serde_json::Value, String> {
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(auth_token)
        .send()
        .await
        .map_err(|e| format!("Sentry API request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!(
                "Sentry auth token is invalid or missing the {required_scope} scope. Update it in Settings → Integrations."
            ));
        }
        if status.as_u16() == 404 {
            return Err(
                "Sentry organization or project was not found. Check the slugs in project settings."
                    .to_string(),
            );
        }
        return Err(format!("Sentry API error ({status}): {text}"));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Sentry response: {e}"))
}

fn sentry_api_url(segments: &[&str]) -> Result<reqwest::Url, String> {
    sentry_api_url_for_base(SENTRY_BASE_URL, segments)
}

fn sentry_api_url_for_base(base_url: &str, segments: &[&str]) -> Result<reqwest::Url, String> {
    let mut url =
        reqwest::Url::parse(base_url).map_err(|e| format!("Invalid Sentry API URL: {e}"))?;
    let mut path = url
        .path_segments_mut()
        .map_err(|_| "Invalid Sentry API URL".to_string())?;
    path.clear().extend(["api", "0"]).extend(segments).push("");
    drop(path);
    Ok(url)
}

fn sentry_projects_url(organization: &SentryOrganization) -> Result<reqwest::Url, String> {
    let base_url = organization
        .links
        .as_ref()
        .map(|links| links.region_url.as_str())
        .unwrap_or(SENTRY_BASE_URL);
    sentry_api_url_for_base(base_url, &["organizations", &organization.slug, "projects"])
}

fn format_latest_event(event: &serde_json::Value) -> String {
    let mut content = String::new();

    if let Some(message) = event
        .get("message")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
    {
        content.push_str("## Latest Event\n\n");
        content.push_str(message);
        content.push_str("\n\n");
    }

    if let Some(tags) = event.get("tags").and_then(|value| value.as_array()) {
        let tags: Vec<String> = tags
            .iter()
            .filter_map(|tag| {
                Some(format!(
                    "{}={}",
                    tag.get("key")?.as_str()?,
                    tag.get("value")?.as_str()?
                ))
            })
            .collect();
        if !tags.is_empty() {
            content.push_str("## Tags\n\n");
            content.push_str(&tags.join(", "));
            content.push_str("\n\n");
        }
    }

    let Some(entries) = event.get("entries").and_then(|value| value.as_array()) else {
        return content;
    };

    for entry in entries {
        if entry.get("type").and_then(|value| value.as_str()) != Some("exception") {
            continue;
        }
        let Some(values) = entry
            .get("data")
            .and_then(|value| value.get("values"))
            .and_then(|value| value.as_array())
        else {
            continue;
        };

        for exception in values {
            let exception_type = exception
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("Exception");
            let exception_value = exception
                .get("value")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            content.push_str(&format!("## {exception_type}\n\n{exception_value}\n\n"));

            let Some(frames) = exception
                .get("stacktrace")
                .and_then(|value| value.get("frames"))
                .and_then(|value| value.as_array())
            else {
                continue;
            };
            if frames.is_empty() {
                continue;
            }

            content.push_str("### Stack Trace\n\n```text\n");
            for frame in frames.iter().rev().take(30).rev() {
                let filename = frame
                    .get("filename")
                    .and_then(|value| value.as_str())
                    .unwrap_or("<unknown>");
                let function = frame
                    .get("function")
                    .and_then(|value| value.as_str())
                    .unwrap_or("<unknown>");
                let line = frame.get("lineNo").and_then(|value| value.as_u64());
                match line {
                    Some(line) => content.push_str(&format!("{filename}:{line} in {function}\n")),
                    None => content.push_str(&format!("{filename} in {function}\n")),
                }
                if let Some(context_line) = frame
                    .get("contextLine")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.trim().is_empty())
                {
                    content.push_str(&format!("  {context_line}\n"));
                }
            }
            content.push_str("```\n\n");
        }
    }

    content
}

fn format_sentry_issue_context(issue: &SentryIssue, event: &serde_json::Value) -> String {
    let mut content = format!(
        "# Sentry Issue {}: {}\n\n- **Level**: {}\n- **Status**: {}\n- **Events**: {}\n- **Users**: {}\n- **First seen**: {}\n- **Last seen**: {}\n- **URL**: {}\n",
        issue.short_id,
        issue.title,
        issue.level,
        issue.status,
        issue.count,
        issue.user_count,
        issue.first_seen,
        issue.last_seen,
        issue.permalink
    );
    if !issue.culprit.is_empty() {
        content.push_str(&format!("- **Culprit**: {}\n", issue.culprit));
    }
    content.push_str("\n---\n\n");
    content.push_str(&format_latest_event(event));
    content.push_str("---\n\n*Investigate this Sentry issue and propose a solution.*\n");
    content
}

pub fn generate_branch_name_from_sentry_issue(short_id: &str, title: &str) -> String {
    format!(
        "sentry-{}-{}",
        short_id.to_lowercase(),
        slugify_issue_title(title)
    )
}

async fn fetch_sentry_projects(auth_token: &str) -> Result<Vec<SentryProjectMapping>, String> {
    let organizations_value =
        sentry_get(auth_token, sentry_api_url(&["organizations"])?, "org:read").await?;
    let organizations: Vec<SentryOrganization> = serde_json::from_value(organizations_value)
        .map_err(|e| format!("Unexpected Sentry organizations response: {e}"))?;

    let mut mappings = Vec::new();
    for organization in organizations {
        let mut url = sentry_projects_url(&organization)?;
        url.query_pairs_mut().append_pair("limit", "100");
        let projects_value = sentry_get(auth_token, url, "org:read").await?;
        let projects: Vec<SentryProject> = serde_json::from_value(projects_value)
            .map_err(|e| format!("Unexpected Sentry projects response: {e}"))?;
        mappings.extend(projects.into_iter().map(|project| SentryProjectMapping {
            id: project.id,
            name: project.name,
            slug: project.slug,
            organization: organization.clone(),
        }));
    }

    Ok(mappings)
}

pub async fn test_sentry_auth_token(
    auth_token: String,
) -> Result<Vec<SentryProjectMapping>, String> {
    let auth_token = auth_token.trim();
    if auth_token.is_empty() {
        return Err("Enter a Sentry auth token first.".to_string());
    }
    fetch_sentry_projects(auth_token).await
}

pub async fn list_sentry_projects(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<SentryProjectMapping>, String> {
    let auth_token = get_sentry_auth_token(&app, Some(&project_id))?;
    fetch_sentry_projects(&auth_token).await
}

pub async fn list_sentry_issues(
    app: AppHandle,
    project_id: String,
    query: Option<String>,
) -> Result<Vec<SentryIssue>, String> {
    let config = get_sentry_config(&app, &project_id)?;
    let mut url = sentry_api_url(&[
        "projects",
        &config.organization_slug,
        &config.sentry_project_slug,
        "issues",
    ])?;
    let sentry_query = match query.map(|value| value.trim().to_string()) {
        Some(value) if !value.is_empty() => format!("is:unresolved {value}"),
        _ => "is:unresolved".to_string(),
    };
    url.query_pairs_mut()
        .append_pair("query", &sentry_query)
        .append_pair("limit", "100")
        .append_pair("sort", "date");

    let value = sentry_get(&config.auth_token, url, "event:read").await?;
    serde_json::from_value(value).map_err(|e| format!("Unexpected Sentry issue response: {e}"))
}

pub async fn get_sentry_issue(
    app: AppHandle,
    project_id: String,
    issue_id: String,
) -> Result<SentryIssueContext, String> {
    let config = get_sentry_config(&app, &project_id)?;
    let issue_value = sentry_get(
        &config.auth_token,
        sentry_api_url(&["issues", &issue_id])?,
        "event:read",
    )
    .await?;
    let issue: SentryIssue = serde_json::from_value(issue_value)
        .map_err(|e| format!("Unexpected Sentry issue response: {e}"))?;
    let latest_event = sentry_get(
        &config.auth_token,
        sentry_api_url(&["issues", &issue_id, "events", "latest"])?,
        "event:read",
    )
    .await?;
    let content = format_sentry_issue_context(&issue, &latest_event);

    Ok(SentryIssueContext {
        id: issue.id,
        short_id: issue.short_id,
        title: issue.title,
        permalink: issue.permalink,
        content,
    })
}

pub fn add_sentry_reference(
    app: &AppHandle,
    project_name: &str,
    issue_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{project_name}::{issue_id}");
    let entry = refs.sentry.entry(key).or_default();
    if !entry.sessions.contains(&session_id.to_string()) {
        entry.sessions.push(session_id.to_string());
    }
    entry.orphaned_at = None;
    save_context_references(app, &refs)
}

pub fn get_session_sentry_refs(app: &AppHandle, session_id: &str) -> Result<Vec<String>, String> {
    let refs = load_context_references(app)?;
    Ok(refs
        .sentry
        .iter()
        .filter(|(_, entry)| entry.sessions.contains(&session_id.to_string()))
        .map(|(key, _)| key.clone())
        .collect())
}

pub async fn get_sentry_issue_context_contents(
    app: AppHandle,
    session_id: String,
    worktree_id: Option<String>,
    project_id: String,
) -> Result<Vec<SentryIssueContext>, String> {
    let config = get_sentry_config(&app, &project_id)?;
    let mut keys = get_session_sentry_refs(&app, &session_id)?;
    if let Some(worktree_id) = worktree_id {
        if let Ok(worktree_keys) = get_session_sentry_refs(&app, &worktree_id) {
            for key in worktree_keys {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contexts = Vec::new();
    for key in keys {
        let Some((project_name, issue_id)) = key.split_once("::") else {
            continue;
        };
        if project_name != config.project_name {
            continue;
        }
        let path = contexts_dir.join(format!("{project_name}-sentry-{issue_id}.md"));
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        let heading = content.lines().next().unwrap_or_default();
        let (short_id, title) = heading
            .strip_prefix("# Sentry Issue ")
            .and_then(|rest| rest.split_once(": "))
            .map(|(short_id, title)| (short_id.to_string(), title.to_string()))
            .unwrap_or_else(|| (issue_id.to_string(), "Sentry issue".to_string()));
        let permalink = content
            .lines()
            .find_map(|line| line.strip_prefix("- **URL**: "))
            .unwrap_or_default()
            .to_string();
        contexts.push(SentryIssueContext {
            id: issue_id.to_string(),
            short_id,
            title,
            permalink,
            content,
        });
    }
    Ok(contexts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_accessible_project_with_organization() {
        let organizations: Vec<SentryOrganization> = serde_json::from_value(serde_json::json!([{
            "id": "9",
            "name": "Jean",
            "slug": "jean"
        }]))
        .unwrap();
        let projects: Vec<SentryProject> = serde_json::from_value(serde_json::json!([{
            "id": "1",
            "name": "Jean Desktop",
            "slug": "jean-desktop"
        }]))
        .unwrap();
        let mapping = SentryProjectMapping {
            id: projects[0].id.clone(),
            name: projects[0].name.clone(),
            slug: projects[0].slug.clone(),
            organization: organizations[0].clone(),
        };

        assert_eq!(mapping.organization.slug, "jean");
        assert_eq!(mapping.slug, "jean-desktop");
    }

    #[test]
    fn uses_the_organization_region_for_project_discovery() {
        let organization: SentryOrganization = serde_json::from_value(serde_json::json!({
            "id": "9",
            "name": "Jean",
            "slug": "jean",
            "links": {
                "regionUrl": "https://us.sentry.io"
            }
        }))
        .unwrap();

        assert_eq!(
            sentry_projects_url(&organization).unwrap().as_str(),
            "https://us.sentry.io/api/0/organizations/jean/projects/"
        );
    }

    #[test]
    fn sentry_api_urls_include_the_required_trailing_slash() {
        assert_eq!(
            sentry_api_url(&["organizations"]).unwrap().as_str(),
            "https://sentry.io/api/0/organizations/"
        );
    }

    #[test]
    fn generates_readable_sentry_branch_name() {
        assert_eq!(
            generate_branch_name_from_sentry_issue("JEAN-42", "Cannot save preferences!"),
            "sentry-jean-42-cannot-save-preferences"
        );
    }

    #[test]
    fn formats_latest_exception_and_stack_trace() {
        let issue = SentryIssue {
            id: "123".to_string(),
            short_id: "JEAN-42".to_string(),
            title: "TypeError".to_string(),
            culprit: "render".to_string(),
            permalink: "https://acme.sentry.io/issues/123/".to_string(),
            level: "error".to_string(),
            status: "unresolved".to_string(),
            count: "17".to_string(),
            user_count: 3,
            first_seen: "2026-07-01".to_string(),
            last_seen: "2026-07-14".to_string(),
            project: SentryProject {
                id: "1".to_string(),
                name: "Jean".to_string(),
                slug: "jean".to_string(),
            },
        };
        let event = serde_json::json!({
            "entries": [{
                "type": "exception",
                "data": {"values": [{
                    "type": "TypeError",
                    "value": "undefined is not an object",
                    "stacktrace": {"frames": [{
                        "filename": "src/App.tsx",
                        "function": "render",
                        "lineNo": 42,
                        "contextLine": "return state.value"
                    }]}
                }]}
            }]
        });

        let content = format_sentry_issue_context(&issue, &event);
        assert!(content.contains("# Sentry Issue JEAN-42: TypeError"));
        assert!(content.contains("src/App.tsx:42 in render"));
        assert!(content.contains("undefined is not an object"));
    }
}
