//! Git hosting provider abstraction.
//!
//! Jean supports multiple git hosts (GitHub via the `gh` CLI, GitLab via the
//! `glab` CLI). A project's provider is resolved with this precedence:
//!
//! 1. The `provider` block in the repo's `jean.json` (explicit, committed).
//! 2. Auto-detection from the `origin` remote URL (github.com / gitlab.com).
//! 3. Default to GitHub (preserves historical behavior).
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

/// Detect the provider + host from a raw git remote URL.
///
/// Returns `None` for hosts we can't classify (e.g. a self-hosted GitLab on a
/// custom domain) — those require an explicit `provider` block in `jean.json`.
pub fn detect_provider_from_url(remote_url: &str) -> Option<(GitProvider, String)> {
    let host = extract_host(remote_url)?;
    let lower = host.to_ascii_lowercase();
    let provider = if lower == "github.com" || lower.ends_with(".github.com") {
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
/// Precedence: `jean.json` → origin-remote detection → default (GitHub).
pub fn resolve_git_provider(repo_path: &str) -> (GitProvider, String) {
    let cfg = crate::projects::git::read_jean_config(repo_path).and_then(|c| c.provider);
    let origin = get_origin_remote_url(repo_path);
    let detected = origin.as_deref().and_then(detect_provider_from_url);

    let provider = cfg
        .as_ref()
        .and_then(|c| c.git)
        .or(detected.map(|(p, _)| p))
        .unwrap_or_default();

    // Host: explicit config → the actual origin host (covers self-hosted) →
    // the provider's default host.
    let host = cfg
        .and_then(|c| c.host)
        .or_else(|| origin.as_deref().and_then(extract_host))
        .unwrap_or_else(|| provider.default_host().to_string());

    (provider, host)
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
#[tauri::command]
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
        // Unknown host → None (needs explicit jean.json).
        assert_eq!(
            detect_provider_from_url("https://git.company.com/g/r.git"),
            None
        );
    }
}
