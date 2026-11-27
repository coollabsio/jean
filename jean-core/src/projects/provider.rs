//! Git hosting provider abstraction.
//!
//! Jean supports multiple git hosts (GitHub via the `gh` CLI, GitLab via the
//! `glab` CLI). A project's provider is resolved with this precedence:
//!
//! 1. The `provider` block in the repo's `jean.json` (explicit, committed).
//! 2. Auto-detection from the `origin` remote URL (github.com / gitlab.com).
//! 3. A host that `glab` is configured for (self-hosted GitLab on any domain).
//! 4. Default to GitHub (preserves historical behavior).
//!
//! No secrets ever live in `jean.json` — the host is non-secret and each CLI
//! manages its own auth. Only the provider selection + optional (self-hosted)
//! host are stored there.

use serde::{Deserialize, Deserializer, Serialize};
use std::path::Path;

use crate::platform::wsl_aware_command;

/// The git hosting provider for a project.
///
/// Uses a hand-written, tolerant `Deserialize` (mirrors `chat::types::Backend`)
/// so unknown/legacy values never hard-fail — they fall back to the default.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum GitProvider {
    #[default]
    Github,
    Gitlab,
}

impl<'de> Deserialize<'de> for GitProvider {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Option::<String>::deserialize(deserializer)?;
        let provider = match value
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "gitlab" => GitProvider::Gitlab,
            "github" | "" => GitProvider::Github,
            other => {
                log::warn!("Unknown git provider '{other}', falling back to github");
                GitProvider::Github
            }
        };
        Ok(provider)
    }
}

impl GitProvider {
    /// Default public host for the provider (used when none is configured/detected).
    pub fn default_host(self) -> &'static str {
        match self {
            GitProvider::Github => "github.com",
            GitProvider::Gitlab => "gitlab.com",
        }
    }

    /// Lowercase stable identifier (used in context-file naming, logs, etc.).
    pub fn as_str(self) -> &'static str {
        match self {
            GitProvider::Github => "github",
            GitProvider::Gitlab => "gitlab",
        }
    }
}

/// The optional `provider` block in `jean.json`.
///
/// ```jsonc
/// "provider": { "git": "gitlab", "host": "gitlab.example.com" }
/// ```
/// Both fields optional: `git` omitted → auto-detect; `host` omitted → the
/// origin remote's host, else the provider's default host.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

/// Extract the host from any common git remote URL form.
///
/// Handles `https://host/…`, `http://host/…`, `git://host/…`,
/// `ssh://[user@]host[:port]/…`, and scp-like `git@host:owner/repo`.
pub fn extract_host(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();
    if url.is_empty() {
        return None;
    }

    // scp-like syntax: `git@host:owner/repo(.git)` (no scheme).
    if !url.contains("://") {
        if let Some((before_colon, _)) = url.split_once(':') {
            // `before_colon` = `[user@]host`
            let host = before_colon.rsplit('@').next()?;
            if !host.is_empty() {
                return Some(host.to_string());
            }
        }
        return None;
    }

    // Scheme-based: `<scheme>://[user@]host[:port]/path`
    let after_scheme = url.split("://").nth(1)?;
    let authority = after_scheme.split('/').next()?;
    let host_port = authority.rsplit('@').next()?; // strip optional `user@`
    let host = host_port.split(':').next()?; // strip optional `:port`
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// Extract the `owner/repo` (or `group/subgroup/repo`) path from any common git
/// remote URL form — no scheme/host, no trailing `.git` or slash.
///
/// Mirrors [`extract_host`] so both parsers accept the same URL shapes (crucially
/// any `user@host:` scp form, not just `git@`).
pub fn extract_repo_path(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();
    if url.is_empty() {
        return None;
    }

    // scp-like syntax `[user@]host:owner/repo(.git)` (no scheme); path is after `:`.
    // Scheme-based `<scheme>://[user@]host[:port]/owner/repo(.git)`; path is after
    // the authority's first `/`.
    let raw = if !url.contains("://") {
        url.split_once(':').map(|(_, p)| p)?
    } else {
        let after_scheme = url.split("://").nth(1)?;
        after_scheme.split_once('/').map(|(_, p)| p)?
    };

    let path = raw.trim_end_matches('/').trim_end_matches(".git");
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Detect the provider + host from a raw git remote URL.
///
/// Returns `None` when the host contains neither `github` nor `gitlab`
/// (for example `git.company.com`). [`resolve_git_provider`] then checks the
/// hosts `glab` is configured for, and defaults to GitHub after that.
pub fn detect_provider_from_url(remote_url: &str) -> Option<(GitProvider, String)> {
    let host = extract_host(remote_url)?;
    let lower = host.to_ascii_lowercase();
    // Symmetric host matching: classify by substring for both providers so
    // self-hosted instances (GitHub Enterprise `github.acme.com`, self-hosted
    // `gitlab.acme.com`) are detected the same way.
    let provider = if lower == "github.com" || lower.contains("github") {
        GitProvider::Github
    } else if lower == "gitlab.com" || lower.contains("gitlab") {
        GitProvider::Gitlab
    } else {
        return None;
    };
    Some((provider, host))
}

/// Raw `origin` remote URL (unnormalized), or `None` if unavailable.
fn get_origin_remote_url(repo_path: &str) -> Option<String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// Resolve the effective `(provider, host)` for a repository.
///
/// Precedence: `jean.json` `provider.git` → origin-remote detection → origin
/// host is configured in `glab` → GitHub. Any other unclassified host falls
/// through to GitHub so `gh` is used exactly as it was before GitLab support.
pub fn resolve_git_provider(repo_path: &str) -> (GitProvider, String) {
    resolve_git_provider_with(repo_path, glab_configured_hosts)
}

fn resolve_git_provider_with(
    repo_path: &str,
    glab_hosts: impl FnOnce() -> Vec<String>,
) -> (GitProvider, String) {
    let cfg = crate::projects::git::read_jean_config(repo_path).and_then(|c| c.provider);
    let origin = get_origin_remote_url(repo_path);
    let origin_host = origin.as_deref().and_then(extract_host);
    let detected = origin.as_deref().and_then(detect_provider_from_url);

    let provider = cfg
        .as_ref()
        .and_then(|c| c.git)
        .or(detected.map(|(p, _)| p))
        .or_else(|| {
            let host = origin_host.as_deref()?;
            glab_hosts()
                .iter()
                .any(|h| h.eq_ignore_ascii_case(host))
                .then_some(GitProvider::Gitlab)
        })
        .unwrap_or_default();

    // Host: explicit config → the actual origin host (covers self-hosted) →
    // the provider's default host.
    let host = cfg
        .and_then(|c| c.host)
        .map(|h| normalize_host(&h))
        .or(origin_host)
        .unwrap_or_else(|| provider.default_host().to_string());

    (provider, host)
}

/// Hosts `glab` is configured for: `GITLAB_HOST` / `GL_HOST`, plus the keys of
/// `hosts:` in the first global glab `config.yml` found, in glab's search order
/// (https://docs.gitlab.com/cli/configuration/). Lets a self-hosted GitLab on a
/// domain without `gitlab` in its name work without a `jean.json` block.
fn glab_configured_hosts() -> Vec<String> {
    let mut hosts: Vec<String> = ["GITLAB_HOST", "GL_HOST"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|h| normalize_host(&h))
        .filter(|h| !h.is_empty())
        .collect();

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("GLAB_CONFIG_DIR") {
        candidates.push(dir.into());
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".config").join("glab-cli"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        candidates.push(std::path::PathBuf::from(xdg).join("glab-cli"));
    }
    for base in [dirs::config_dir(), dirs::data_local_dir()]
        .into_iter()
        .flatten()
    {
        candidates.push(base.join("glab-cli"));
    }

    if let Some(yaml) = candidates
        .iter()
        .find_map(|dir| std::fs::read_to_string(dir.join("config.yml")).ok())
    {
        hosts.extend(hosts_from_glab_config(&yaml));
    }
    hosts
}

/// Keys of the `hosts:` mapping in a glab `config.yml`.
fn hosts_from_glab_config(yaml: &str) -> Vec<String> {
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else {
        return Vec::new();
    };
    value
        .get("hosts")
        .and_then(|h| h.as_mapping())
        .map(|m| {
            m.keys()
                .filter_map(|k| k.as_str())
                .map(normalize_host)
                .filter(|h| !h.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Normalize a user-supplied host from `jean.json` (`provider.host`): strip any
/// `scheme://`, `user@`, path, and trailing slash so it's a bare host suitable
/// for `GITLAB_HOST` / `glab --hostname`. A verbatim `https://gitlab.example.com`
/// would otherwise break every `glab` call.
fn normalize_host(raw: &str) -> String {
    let trimmed = raw.trim();
    let after_scheme = trimmed.rsplit("://").next().unwrap_or(trimmed);
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    let host = authority.rsplit('@').next().unwrap_or(authority);
    host.trim_end_matches('/').to_string()
}

/// Resolved provider info surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitProviderInfo {
    /// `"github"` | `"gitlab"`
    pub provider: String,
    /// Effective host (e.g. `github.com`, `gitlab.com`, or a self-hosted host).
    pub host: String,
}

/// Resolve the git host provider + host for a project path (for provider-aware UI).
pub async fn get_git_provider(project_path: String) -> Result<GitProviderInfo, String> {
    let (provider, host) = resolve_git_provider(&project_path);
    Ok(GitProviderInfo {
        provider: provider.as_str().to_string(),
        host,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_deserializes_known_and_unknown() {
        assert_eq!(
            serde_json::from_str::<GitProvider>("\"gitlab\"").unwrap(),
            GitProvider::Gitlab
        );
        assert_eq!(
            serde_json::from_str::<GitProvider>("\"github\"").unwrap(),
            GitProvider::Github
        );
        // Unknown falls back to github, never errors.
        assert_eq!(
            serde_json::from_str::<GitProvider>("\"bitbucket\"").unwrap(),
            GitProvider::Github
        );
        // Case-insensitive.
        assert_eq!(
            serde_json::from_str::<GitProvider>("\"GitLab\"").unwrap(),
            GitProvider::Gitlab
        );
    }

    #[test]
    fn provider_config_defaults_and_roundtrip() {
        let empty: ProviderConfig = serde_json::from_str("{}").unwrap();
        assert!(empty.git.is_none() && empty.host.is_none());

        let full: ProviderConfig =
            serde_json::from_str(r#"{"git":"gitlab","host":"gitlab.example.com"}"#).unwrap();
        assert_eq!(full.git, Some(GitProvider::Gitlab));
        assert_eq!(full.host.as_deref(), Some("gitlab.example.com"));

        // None fields are omitted when serialized.
        let serialized = serde_json::to_string(&empty).unwrap();
        assert_eq!(serialized, "{}");
    }

    #[test]
    fn extract_host_handles_all_forms() {
        assert_eq!(
            extract_host("https://github.com/owner/repo.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            extract_host("git@github.com:owner/repo.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            extract_host("ssh://git@gitlab.com/group/sub/repo.git").as_deref(),
            Some("gitlab.com")
        );
        assert_eq!(
            extract_host("ssh://git@git.company.com:2222/group/repo.git").as_deref(),
            Some("git.company.com")
        );
        assert_eq!(
            extract_host("git@git.company.com:group/repo.git").as_deref(),
            Some("git.company.com")
        );
        assert_eq!(extract_host("").as_deref(), None);
    }

    #[test]
    fn extract_repo_path_handles_all_forms() {
        assert_eq!(
            extract_repo_path("https://github.com/owner/repo.git").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(
            extract_repo_path("git@github.com:owner/repo.git").as_deref(),
            Some("owner/repo")
        );
        // Non-`git@` scp user (the deploy@… bug the shared parser fixes).
        assert_eq!(
            extract_repo_path("deploy@gitlab.example.com:group/repo.git").as_deref(),
            Some("group/repo")
        );
        // Nested groups + no `.git`.
        assert_eq!(
            extract_repo_path("ssh://git@gitlab.com/group/sub/repo").as_deref(),
            Some("group/sub/repo")
        );
        // Scheme with port.
        assert_eq!(
            extract_repo_path("ssh://git@git.company.com:2222/group/repo.git").as_deref(),
            Some("group/repo")
        );
        // Trailing slash.
        assert_eq!(
            extract_repo_path("https://gitlab.com/group/repo/").as_deref(),
            Some("group/repo")
        );
        assert_eq!(extract_repo_path("").as_deref(), None);
    }

    #[test]
    fn detect_provider_classifies_hosts() {
        assert_eq!(
            detect_provider_from_url("https://github.com/o/r.git"),
            Some((GitProvider::Github, "github.com".to_string()))
        );
        assert_eq!(
            detect_provider_from_url("git@github.com:o/r.git"),
            Some((GitProvider::Github, "github.com".to_string()))
        );
        assert_eq!(
            detect_provider_from_url("https://gitlab.com/g/r.git"),
            Some((GitProvider::Gitlab, "gitlab.com".to_string()))
        );
        // Self-hosted host with "gitlab" in the name is classified.
        assert_eq!(
            detect_provider_from_url("https://gitlab.example.com/g/r.git"),
            Some((GitProvider::Gitlab, "gitlab.example.com".to_string()))
        );
        // Unknown host is unclassified. resolve_git_provider then defaults to GitHub.
        assert_eq!(
            detect_provider_from_url("https://git.company.com/g/r.git"),
            None
        );
    }

    fn git_repo_with_origin(url: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path();
        for args in [vec!["init"], vec!["remote", "add", "origin", url]] {
            let status = crate::platform::silent_command("git")
                .args(&args)
                .current_dir(path)
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?} failed");
        }
        dir
    }

    #[test]
    fn glab_config_hosts_are_parsed() {
        let yaml = "git_protocol: ssh\nhosts:\n  gitlab.com:\n    token: x\n  git.company.com:\n    api_protocol: https\n";
        assert_eq!(
            hosts_from_glab_config(yaml),
            vec!["gitlab.com".to_string(), "git.company.com".to_string()]
        );
        assert!(hosts_from_glab_config("not: [valid").is_empty());
        assert!(hosts_from_glab_config("editor: vim\n").is_empty());
    }

    #[test]
    fn unknown_host_configured_in_glab_resolves_to_gitlab() {
        let dir = git_repo_with_origin("git@Git.Company.com:group/sub/repo.git");
        let (provider, host) = resolve_git_provider_with(dir.path().to_str().unwrap(), || {
            vec!["gitlab.com".to_string(), "git.company.com".to_string()]
        });
        assert_eq!(provider, GitProvider::Gitlab);
        assert_eq!(host, "Git.Company.com");
    }

    #[test]
    fn explicit_github_wins_over_glab_hosts() {
        let dir = git_repo_with_origin("https://git.company.com/group/repo.git");
        std::fs::write(
            dir.path().join("jean.json"),
            r#"{"provider":{"git":"github"}}"#,
        )
        .unwrap();
        let (provider, _) = resolve_git_provider_with(dir.path().to_str().unwrap(), || {
            vec!["git.company.com".to_string()]
        });
        assert_eq!(provider, GitProvider::Github);
    }

    #[test]
    fn unknown_host_without_provider_git_falls_through_to_github() {
        let dir = git_repo_with_origin("https://git.company.com/group/repo.git");
        let (provider, host) = resolve_git_provider_with(dir.path().to_str().unwrap(), Vec::new);
        assert_eq!(provider, GitProvider::Github);
        assert_eq!(host, "git.company.com");
    }

    #[test]
    fn explicit_provider_git_overrides_unknown_host() {
        let dir = git_repo_with_origin("https://git.company.com/group/repo.git");
        std::fs::write(
            dir.path().join("jean.json"),
            r#"{"provider":{"git":"gitlab"}}"#,
        )
        .unwrap();
        let (provider, host) = resolve_git_provider(dir.path().to_str().unwrap());
        assert_eq!(provider, GitProvider::Gitlab);
        assert_eq!(host, "git.company.com");
    }
}
