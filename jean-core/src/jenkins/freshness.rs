//! Preview freshness: is the live PR preview up to date with the PR head?
//!
//! Rather than ask Jenkins what it *deployed*, we ask the **preview itself**
//! what it is *actually serving* — the only source that can tell a deploy that
//! reported success from one that silently didn't land. Previews serve a
//! `/version` endpoint, in one of two shapes:
//!
//! - the bare 40-char SHA (`text/plain`), what the unified pipeline's
//!   compose-based deploys publish;
//! - a `git log -1` dump whose first line is `commit <sha>` (the older deploys,
//!   still live on previews that haven't been redeployed since).
//!
//! [`parse_version_sha`] accepts both. We compare that deployed SHA to the PR
//! head (`headRefOid` from GitHub) and get four actionable states:
//!
//! - **UP_TO_DATE** — preview reachable and containing the PR head commit
//!   (either directly or through GitHub's generated merge commit).
//! - **STALE** — preview reachable but serving an older commit (périmée).
//! - **DOWN** — preview unreachable (env down / not deployed).
//! - **UNKNOWN** — reachable but we couldn't resolve a SHA to compare.
//!
//! Some previews answer `/version` with a **404** while the app itself is up
//! (the compose deploy didn't publish the file). Those are *not* down: only a
//! transport error or a 5xx is. When the preview is up but publishes no SHA, we
//! fall back to the `REVISION` parameter of its last successful deploy build —
//! what Jenkins was *asked* to deploy rather than what is live, which
//! [`PreviewFreshness::sha_source`] keeps honest in the UI.
//!
//! Classification ([`classify`]) and parsing ([`parse_version_sha`]) are pure
//! and unit-tested. The PR head read shells out to `gh` like
//! `projects::pr_status`, so it runs inside `spawn_blocking` from async callers.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::platform::silent_command;

/// Preview is reachable and contains the current PR head commit.
pub const FRESH_UP_TO_DATE: &str = "UP_TO_DATE";
/// Preview is reachable but serving an older commit than the PR head.
pub const FRESH_STALE: &str = "STALE";
/// Preview is unreachable (env down or never deployed).
pub const FRESH_DOWN: &str = "DOWN";
/// Reachable, but a SHA to compare couldn't be resolved.
pub const FRESH_UNKNOWN: &str = "UNKNOWN";

/// `preview_sha` came from the preview itself (`/version`) — what is *live*.
pub const SHA_SOURCE_PREVIEW: &str = "preview";
/// `preview_sha` came from the deploy build's `REVISION` — what Jenkins was
/// *asked* to deploy, used when the preview publishes no `/version`.
pub const SHA_SOURCE_JENKINS: &str = "jenkins";

/// How long to wait on the preview `/version` probe before calling it down.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// Whether the live preview matches the PR head, surfaced to the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFreshness {
    /// `UP_TO_DATE` / `STALE` / `DOWN` / `UNKNOWN`.
    pub status: String,
    /// Commit the preview is serving, per [`Self::sha_source`].
    pub preview_sha: Option<String>,
    /// Where `preview_sha` came from: [`SHA_SOURCE_PREVIEW`] (the live
    /// `/version`) or [`SHA_SOURCE_JENKINS`] (the deploy build's `REVISION`).
    pub sha_source: Option<String>,
    /// Current PR head commit (`headRefOid`).
    pub pr_head_sha: Option<String>,
    /// How many commits the PR head is ahead of the preview (best-effort).
    pub behind_by: Option<u32>,
}

/// Outcome of a `/version` probe.
#[derive(Debug, Clone, PartialEq)]
enum Probe {
    /// The env answered: it is up, with the SHA it published (if any).
    Up(Option<String>),
    /// Transport error, timeout or 5xx — nothing is serving this preview.
    Down,
}

/// Parse the deployed commit SHA from a `/version` body.
///
/// Two shapes are served in the wild: the bare SHA (unified/compose deploys)
/// and a `git log -1` dump whose first line is `commit <sha>` (older deploys).
/// The bare form must be a full 40-char SHA — anything shorter is more likely a
/// version string or an error page than a commit.
pub fn parse_version_sha(body: &str) -> Option<String> {
    let first = body.lines().next()?.trim();
    match first.strip_prefix("commit ") {
        Some(rest) => {
            let sha = rest.trim();
            is_sha(sha).then(|| sha.to_string())
        }
        None => (first.len() == 40 && is_sha(first)).then(|| first.to_string()),
    }
}

/// A plausible git SHA: 7–40 hex chars.
fn is_sha(value: &str) -> bool {
    let len = value.len();
    (7..=40).contains(&len) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Classify freshness from the probe result and the PR head SHA. Pure.
///
/// `sha_source` travels with `preview_sha` (see [`SHA_SOURCE_PREVIEW`] /
/// [`SHA_SOURCE_JENKINS`]) so the UI can say whether the commit is what the
/// preview serves or only what Jenkins deployed.
pub fn classify(
    reachable: bool,
    preview_sha: Option<&str>,
    sha_source: Option<&str>,
    pr_head_sha: Option<&str>,
    behind_by: Option<u32>,
) -> PreviewFreshness {
    let head = pr_head_sha.map(str::to_string);

    if !reachable {
        return PreviewFreshness {
            status: FRESH_DOWN.to_string(),
            preview_sha: None,
            sha_source: None,
            pr_head_sha: head,
            behind_by: None,
        };
    }

    let preview = preview_sha.map(str::to_string);
    // A source without a SHA would be meaningless.
    let source = preview_sha.and(sha_source).map(str::to_string);

    match (preview_sha, pr_head_sha) {
        // GitHub may deploy refs/pull/<n>/merge. Its SHA differs from the PR
        // head, but an ahead count of zero means no PR commit is missing from
        // the deployed merge commit.
        (Some(p), Some(h)) if sha_matches(p, h) || behind_by == Some(0) => PreviewFreshness {
            status: FRESH_UP_TO_DATE.to_string(),
            preview_sha: preview,
            sha_source: source,
            pr_head_sha: head,
            behind_by: Some(0),
        },
        (Some(_), Some(_)) => PreviewFreshness {
            status: FRESH_STALE.to_string(),
            preview_sha: preview,
            sha_source: source,
            pr_head_sha: head,
            behind_by,
        },
        _ => PreviewFreshness {
            status: FRESH_UNKNOWN.to_string(),
            preview_sha: preview,
            sha_source: source,
            pr_head_sha: head,
            behind_by: None,
        },
    }
}

/// Equal as far as both are known — tolerant of short vs full SHAs.
fn sha_matches(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim(), b.trim());
    let n = a.len().min(b.len()).min(40);
    n >= 7 && a[..n].eq_ignore_ascii_case(&b[..n])
}

/// Resolve freshness for a PR's preview: probe `/version`, resolve the PR head,
/// compare, and (only when stale) count how many commits behind.
///
/// `known_head_sha` is the `headRefOid` already fetched project-wide by
/// `gh_checks`; passing it skips the per-worktree `gh pr view` subprocess. Only
/// when it is `None` do we shell out for a single PR.
///
/// `deployed_sha` is the `REVISION` of the PR's last successful preview deploy,
/// used only when the preview is up but publishes no `/version`.
pub async fn resolve_freshness(
    repo_path: &str,
    pr_number: Option<u32>,
    gh_binary: PathBuf,
    version_url: &str,
    known_head_sha: Option<String>,
    deployed_sha: Option<String>,
) -> PreviewFreshness {
    let Probe::Up(served_sha) = probe_preview(version_url).await else {
        return classify(false, None, None, None, None);
    };

    // What the preview serves beats what Jenkins deployed; fall back to the
    // latter only when the preview publishes nothing.
    let (preview_sha, sha_source) = match served_sha {
        Some(sha) => (Some(sha), SHA_SOURCE_PREVIEW),
        None => (deployed_sha, SHA_SOURCE_JENKINS),
    };

    // The PR head read + behind-count shell out to `gh` (blocking).
    let repo = repo_path.to_string();
    let probe_sha = preview_sha.clone();
    let (head, behind_by) = tokio::task::spawn_blocking(move || {
        let head = known_head_sha.or_else(|| fetch_pr_head_sha(&repo, pr_number, &gh_binary));
        let behind = match (probe_sha.as_deref(), head.as_deref()) {
            (Some(p), Some(h)) if !sha_matches(p, h) => fetch_behind_by(&repo, p, h, &gh_binary),
            _ => None,
        };
        (head, behind)
    })
    .await
    .unwrap_or((None, None));

    classify(
        true,
        preview_sha.as_deref(),
        Some(sha_source),
        head.as_deref(),
        behind_by,
    )
}

/// Probe the preview `/version` endpoint.
///
/// A connection error, a timeout or a 5xx means the preview is down. A 4xx does
/// **not**: the env answered, it just doesn't publish `/version` (compose-based
/// deploys don't), and the app itself is usually fine — calling that "hors
/// ligne" would grey out the "open preview" button on a working preview.
/// Preview envs are internal and may use self-signed certs, so cert validation
/// is relaxed for this probe only.
async fn probe_preview(version_url: &str) -> Probe {
    let client = match reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build()
    {
        Ok(c) => c,
        Err(_) => return Probe::Down,
    };

    // Only the first line (the SHA) is needed; ask for a small range.
    match client
        .get(version_url)
        .header("Range", "bytes=0-127")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.text().await.unwrap_or_default();
            Probe::Up(parse_version_sha(&body))
        }
        Ok(resp) if resp.status().is_client_error() => Probe::Up(None),
        _ => Probe::Down,
    }
}

/// Fetch the PR head commit via `gh pr view <n> --json headRefOid`.
fn fetch_pr_head_sha(repo_path: &str, pr_number: Option<u32>, gh_binary: &Path) -> Option<String> {
    let pr_number = pr_number?;
    let output = silent_command(gh_binary)
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "headRefOid",
            "--jq",
            ".headRefOid",
        ])
        .current_dir(repo_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

/// Count how many commits `head` is ahead of `base` via the GitHub compare API.
///
/// `gh` resolves the `{owner}`/`{repo}` placeholders from the worktree's repo.
fn fetch_behind_by(repo_path: &str, base: &str, head: &str, gh_binary: &Path) -> Option<u32> {
    let path = format!("repos/{{owner}}/{{repo}}/compare/{base}...{head}");
    let output = silent_command(gh_binary)
        .args(["api", &path, "--jq", ".ahead_by"])
        .current_dir(repo_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA_A: &str = "9a54f3bafc2fa898b06a5fb0b48bae73af92963f";
    const SHA_B: &str = "ffffffffffffffffffffffffffffffffffffffff";

    #[test]
    fn parses_sha_from_version_dump() {
        // Older deploys serve a `git log -1 --stat` dump.
        let body = "commit 9a54f3bafc2fa898b06a5fb0b48bae73af92963f\n\
                    Author: Dev <dev@example.com>\n\
                    Date:   Fri Jun 19 17:58:08 2026 +0200\n\n    Revert ...\n\nM\tfront/app.elm\n";
        assert_eq!(parse_version_sha(body).as_deref(), Some(SHA_A));
    }

    #[test]
    fn parses_bare_sha_from_unified_deploy() {
        // The unified pipeline's compose deploys serve the bare SHA as
        // `text/plain`, with or without a trailing newline.
        assert_eq!(
            parse_version_sha(&format!("{SHA_A}\n")).as_deref(),
            Some(SHA_A)
        );
        assert_eq!(parse_version_sha(SHA_A).as_deref(), Some(SHA_A));
    }

    #[test]
    fn rejects_bodies_without_a_commit() {
        assert_eq!(parse_version_sha("<html>403 Forbidden</html>"), None);
        assert_eq!(parse_version_sha("commit not-a-sha"), None);
        assert_eq!(parse_version_sha(""), None);
        // A bare value must be a *full* SHA — "1.2.3" or a short hex-looking
        // version string is not a commit.
        assert_eq!(parse_version_sha("1.2.3"), None);
        assert_eq!(parse_version_sha(&SHA_A[..12]), None);
    }

    #[test]
    fn up_to_date_when_shas_match() {
        let f = classify(
            true,
            Some(SHA_A),
            Some(SHA_SOURCE_PREVIEW),
            Some(SHA_A),
            None,
        );
        assert_eq!(f.status, FRESH_UP_TO_DATE);
        assert_eq!(f.behind_by, Some(0));
        assert_eq!(f.preview_sha.as_deref(), Some(SHA_A));
        assert_eq!(f.sha_source.as_deref(), Some(SHA_SOURCE_PREVIEW));
    }

    #[test]
    fn up_to_date_tolerates_short_head() {
        // GitHub head given as an abbreviated SHA still matches the full preview SHA.
        let f = classify(
            true,
            Some(SHA_A),
            Some(SHA_SOURCE_PREVIEW),
            Some(&SHA_A[..10]),
            None,
        );
        assert_eq!(f.status, FRESH_UP_TO_DATE);
    }

    #[test]
    fn up_to_date_when_preview_merge_contains_pr_head() {
        // GitHub previews may serve refs/pull/<n>/merge rather than the PR head
        // itself. A compare result of zero means the PR has no commit missing
        // from that deployed merge commit.
        let f = classify(
            true,
            Some(SHA_A),
            Some(SHA_SOURCE_PREVIEW),
            Some(SHA_B),
            Some(0),
        );
        assert_eq!(f.status, FRESH_UP_TO_DATE);
        assert_eq!(f.behind_by, Some(0));
    }

    #[test]
    fn stale_when_shas_differ() {
        let f = classify(
            true,
            Some(SHA_A),
            Some(SHA_SOURCE_PREVIEW),
            Some(SHA_B),
            Some(3),
        );
        assert_eq!(f.status, FRESH_STALE);
        assert_eq!(f.preview_sha.as_deref(), Some(SHA_A));
        assert_eq!(f.pr_head_sha.as_deref(), Some(SHA_B));
        assert_eq!(f.behind_by, Some(3));
    }

    #[test]
    fn down_when_unreachable() {
        let f = classify(false, None, None, Some(SHA_A), None);
        assert_eq!(f.status, FRESH_DOWN);
        assert_eq!(f.preview_sha, None);
        assert_eq!(f.sha_source, None);
        // PR head is still surfaced for context.
        assert_eq!(f.pr_head_sha.as_deref(), Some(SHA_A));
    }

    #[test]
    fn unknown_when_a_sha_is_missing() {
        assert_eq!(
            classify(true, None, None, Some(SHA_A), None).status,
            FRESH_UNKNOWN
        );
        assert_eq!(
            classify(true, Some(SHA_A), Some(SHA_SOURCE_PREVIEW), None, None).status,
            FRESH_UNKNOWN
        );
    }

    #[test]
    fn a_jenkins_sourced_sha_still_classifies_but_stays_labelled() {
        // Preview up, no `/version` published → the deploy build's REVISION
        // answers the question, flagged as such so the UI can hedge.
        let f = classify(
            true,
            Some(SHA_A),
            Some(SHA_SOURCE_JENKINS),
            Some(SHA_A),
            None,
        );
        assert_eq!(f.status, FRESH_UP_TO_DATE);
        assert_eq!(f.sha_source.as_deref(), Some(SHA_SOURCE_JENKINS));
    }

    #[test]
    fn no_sha_means_no_source() {
        let f = classify(true, None, Some(SHA_SOURCE_JENKINS), Some(SHA_A), None);
        assert_eq!(f.sha_source, None);
    }

    /// Serve one canned HTTP response on a loopback port; returns its URL.
    ///
    /// The probe's verdict hinges on the status code, so these replay the three
    /// answers real previews give: the bare SHA, Express' 404 when the deploy
    /// published no version file, and nginx's 502 when the env is down.
    async fn serve_once(response: String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            if let Ok((mut sock, _)) = listener.accept().await {
                let _ = sock.read(&mut [0u8; 1024]).await;
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        format!("http://{addr}/version")
    }

    #[tokio::test]
    async fn probe_reads_the_bare_sha_served_by_unified_deploys() {
        let url = serve_once(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 41\r\n\r\n{SHA_A}\n"
        ))
        .await;
        assert_eq!(
            probe_preview(&url).await,
            Probe::Up(Some(SHA_A.to_string()))
        );
    }

    #[tokio::test]
    async fn a_404_is_up_without_a_version_not_down() {
        // The app answers (its admin UI works), it just doesn't publish
        // `/version`. Calling this DOWN would grey out a working preview.
        let url = serve_once(
            "HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 24\r\n\r\n<pre>Cannot GET /version</pre>".to_string(),
        )
        .await;
        assert_eq!(probe_preview(&url).await, Probe::Up(None));
    }

    #[tokio::test]
    async fn a_502_is_down() {
        let url = serve_once(
            "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: 9\r\n\r\n<html></html>".to_string(),
        )
        .await;
        assert_eq!(probe_preview(&url).await, Probe::Down);
    }

    #[tokio::test]
    async fn an_unreachable_host_is_down() {
        // Nothing listening on this port.
        assert_eq!(
            probe_preview("http://127.0.0.1:1/version").await,
            Probe::Down
        );
    }
}
