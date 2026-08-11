//! Git forge detection (GitHub vs GitLab) from repository remotes.

use crate::platform::wsl_aware_command;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Hosting forge for a repository remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeKind {
    GitHub,
    GitLab,
    Unknown,
}

impl ForgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
            Self::Unknown => "unknown",
        }
    }
}

/// Detect forge kind from a single remote URL.
///
/// Recognizes:
/// - GitHub.com and common GHE patterns (`github.`)
/// - GitLab.com and hosts containing `gitlab`
pub fn detect_forge_from_url(remote_url: &str) -> ForgeKind {
    let url = remote_url.trim().to_lowercase();
    if url.is_empty() {
        return ForgeKind::Unknown;
    }

    // SSH: git@host:owner/repo.git  or  ssh://git@host/owner/repo.git
    // HTTPS: https://host/owner/repo.git
    if let Some(host) = extract_host(&url) {
        if host == "github.com" || host.starts_with("github.") || host.ends_with(".ghe.com") {
            return ForgeKind::GitHub;
        }
        if host == "gitlab.com"
            || host.starts_with("gitlab.")
            || host.contains("gitlab")
            || host.ends_with(".gitlab.io")
        {
            return ForgeKind::GitLab;
        }
    } else {
        // Path-style heuristics when host parsing fails
        if url.contains("github.com") || url.contains("github.") {
            return ForgeKind::GitHub;
        }
        if url.contains("gitlab.com") || url.contains("gitlab.") || url.contains("gitlab") {
            return ForgeKind::GitLab;
        }
    }

    ForgeKind::Unknown
}

fn extract_host(url: &str) -> Option<&str> {
    if let Some(rest) = url.strip_prefix("git@") {
        // git@host:path
        return rest.split([':', '/']).next().filter(|h| !h.is_empty());
    }
    if let Some(rest) = url
        .strip_prefix("ssh://git@")
        .or_else(|| url.strip_prefix("ssh://"))
        .or_else(|| url.strip_prefix("https://"))
        .or_else(|| url.strip_prefix("http://"))
    {
        return rest.split(['/', ':', '?']).next().filter(|h| !h.is_empty());
    }
    None
}

/// Detect forge for a repository by inspecting git remotes (prefers origin).
pub fn detect_forge(repo_path: &str) -> ForgeKind {
    let remotes = list_remote_urls(repo_path);
    if remotes.is_empty() {
        return ForgeKind::Unknown;
    }

    // Prefer origin when present
    if let Some((_, url)) = remotes.iter().find(|(name, _)| name == "origin") {
        let kind = detect_forge_from_url(url);
        if kind != ForgeKind::Unknown {
            return kind;
        }
    }

    for (_, url) in &remotes {
        let kind = detect_forge_from_url(url);
        if kind != ForgeKind::Unknown {
            return kind;
        }
    }

    ForgeKind::Unknown
}

fn list_remote_urls(repo_path: &str) -> Vec<(String, String)> {
    let output = match wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["remote", "-v"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    let mut result = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        // origin  https://github.com/o/r.git (fetch)
        let mut parts = line.split_whitespace();
        let name = match parts.next() {
            Some(n) => n.to_string(),
            None => continue,
        };
        let url = match parts.next() {
            Some(u) => u.to_string(),
            None => continue,
        };
        let kind = parts.next().unwrap_or("");
        if kind.contains("fetch") || kind.is_empty() {
            // Dedup name: keep first (fetch)
            if !result.iter().any(|(n, _)| n == &name) {
                result.push((name, url));
            }
        }
    }
    result
}

/// Tauri/command entry: detect forge for a project path.
pub async fn detect_project_forge(project_path: String) -> Result<ForgeKind, String> {
    Ok(detect_forge(&project_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_github_https_and_ssh() {
        assert_eq!(
            detect_forge_from_url("https://github.com/acme/app.git"),
            ForgeKind::GitHub
        );
        assert_eq!(
            detect_forge_from_url("git@github.com:acme/app.git"),
            ForgeKind::GitHub
        );
        assert_eq!(
            detect_forge_from_url("https://github.mycorp.com/acme/app"),
            ForgeKind::GitHub
        );
    }

    #[test]
    fn detects_gitlab_https_and_ssh() {
        assert_eq!(
            detect_forge_from_url("https://gitlab.com/acme/app.git"),
            ForgeKind::GitLab
        );
        assert_eq!(
            detect_forge_from_url("git@gitlab.com:acme/app.git"),
            ForgeKind::GitLab
        );
        assert_eq!(
            detect_forge_from_url("https://gitlab.example.com/group/proj.git"),
            ForgeKind::GitLab
        );
        assert_eq!(
            detect_forge_from_url("git@git.company.com:group/proj.git"),
            ForgeKind::Unknown // no gitlab in host
        );
    }

    #[test]
    fn self_hosted_gitlab_with_gitlab_in_hostname() {
        assert_eq!(
            detect_forge_from_url("https://gitlab.internal.corp/team/repo.git"),
            ForgeKind::GitLab
        );
    }

    #[test]
    fn does_not_detect_gitlab_from_repository_path_when_host_was_parsed() {
        assert_eq!(
            detect_forge_from_url("https://git.example.com/acme/gitlab-tools.git"),
            ForgeKind::Unknown
        );
    }
}
