//! GitHub API quota shared by Jean's own background `gh` calls.
//!
//! REST (`core`) and GraphQL (`graphql`) have separate hourly quotas, and the
//! agents' own `gh` calls spend the same ones. Background polls stop when a
//! quota falls under the reserve or GitHub refused a request, so the rest stays
//! for user actions and agents.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Background requests stop when less than 1/RESERVE_DIVISOR of a quota is left.
const RESERVE_DIVISOR: u64 = 10;
/// Secondary (abuse) limits usually clear within a minute.
const SECONDARY_LIMIT_PAUSE_SECS: u64 = 60;
/// Used when GitHub refused a request and no reset time is known.
const FALLBACK_PAUSE_SECS: u64 = 15 * 60;
const ETAG_CACHE_MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GhResource {
    Core,
    Graphql,
}

impl GhResource {
    fn parse(name: &str) -> Option<Self> {
        match name.trim() {
            "core" => Some(Self::Core),
            "graphql" => Some(Self::Graphql),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Core => "REST",
            Self::Graphql => "GraphQL",
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Quota {
    limit: u64,
    remaining: u64,
    reset_at: u64,
    paused_until: u64,
}

#[derive(Debug, Default)]
struct QuotaBook(HashMap<GhResource, Quota>);

impl QuotaBook {
    fn observe(&mut self, resource: GhResource, limit: u64, remaining: u64, reset_at: u64) {
        let quota = self.0.entry(resource).or_default();
        // A late answer from an older window must not overwrite the current one.
        if reset_at < quota.reset_at {
            return;
        }
        quota.limit = limit;
        quota.remaining = remaining;
        quota.reset_at = reset_at;
    }

    fn pause(&mut self, resource: GhResource, until: u64) {
        let quota = self.0.entry(resource).or_default();
        quota.paused_until = quota.paused_until.max(until);
    }

    /// When background requests on `resource` may run again, if they must wait.
    fn background_wait(&self, resource: GhResource, now: u64) -> Option<u64> {
        let quota = self.0.get(&resource)?;
        if quota.paused_until > now {
            return Some(quota.paused_until);
        }
        let in_reserve = quota.limit > 0 && quota.remaining * RESERVE_DIVISOR < quota.limit;
        (in_reserve && quota.reset_at > now).then_some(quota.reset_at)
    }

    fn record_failure(&mut self, resource: GhResource, error: &str, now: u64) -> Option<u64> {
        if !is_rate_limit_error(error) {
            return None;
        }
        let known_reset = self
            .0
            .get(&resource)
            .filter(|quota| quota.remaining == 0 && quota.reset_at > now)
            .map(|quota| quota.reset_at);
        let until = known_reset.unwrap_or_else(|| {
            if error.to_lowercase().contains("secondary") {
                now + SECONDARY_LIMIT_PAUSE_SECS
            } else {
                now + FALLBACK_PAUSE_SECS
            }
        });
        self.pause(resource, until);
        Some(until)
    }
}

static QUOTAS: LazyLock<Mutex<QuotaBook>> = LazyLock::new(Mutex::default);
static ETAGS: LazyLock<Mutex<HashMap<String, (String, String)>>> = LazyLock::new(Mutex::default);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn quotas() -> std::sync::MutexGuard<'static, QuotaBook> {
    QUOTAS.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn is_rate_limit_error(error: &str) -> bool {
    error.to_lowercase().contains("rate limit")
}

/// Pauses background requests on `resource` when `error` is a GitHub rate
/// limit. Returns the pause end.
pub fn record_failure(resource: GhResource, error: &str) -> Option<u64> {
    quotas().record_failure(resource, error, now_secs())
}

/// When background requests on `resource` may run again, if they must wait.
pub fn background_wait(resource: GhResource) -> Option<u64> {
    quotas().background_wait(resource, now_secs())
}

/// Error for a skipped background request. Contains "rate limit" so callers
/// that look for that text treat it as a rate limit.
pub fn wait_error(resource: GhResource, until: u64) -> String {
    let secs = until.saturating_sub(now_secs());
    format!(
        "GitHub {} rate limit reserve reached; background requests resume in {secs}s",
        resource.label()
    )
}

fn observe_headers(headers: &HashMap<String, String>) {
    let number = |name: &str| headers.get(name).and_then(|v| v.trim().parse::<u64>().ok());
    let Some(resource) = headers
        .get("x-ratelimit-resource")
        .and_then(|v| GhResource::parse(v))
    else {
        return;
    };
    let mut book = quotas();
    if let (Some(limit), Some(remaining), Some(reset)) = (
        number("x-ratelimit-limit"),
        number("x-ratelimit-remaining"),
        number("x-ratelimit-reset"),
    ) {
        book.observe(resource, limit, remaining, reset);
    }
    if let Some(retry_after) = number("retry-after") {
        book.pause(resource, now_secs() + retry_after);
    }
}

#[derive(serde::Deserialize)]
struct RateLimitResponse {
    resources: HashMap<String, RateLimitResource>,
}

#[derive(serde::Deserialize)]
struct RateLimitResource {
    limit: u64,
    remaining: u64,
    reset: u64,
}

fn observe_rate_limit_json(json: &str) {
    let Ok(response) = serde_json::from_str::<RateLimitResponse>(json) else {
        return;
    };
    let mut book = quotas();
    for (name, quota) in response.resources {
        if let Some(resource) = GhResource::parse(&name) {
            book.observe(resource, quota.limit, quota.remaining, quota.reset);
        }
    }
}

/// Reads the current quotas from `GET /rate_limit`, which spends no quota.
/// Needed before GraphQL `gh` subcommands, which do not show their headers.
pub fn refresh(gh: &Path, cwd: &str) {
    let output = crate::platform::resolved_cli_command(gh, Some(Path::new(cwd)))
        .args(["api", "rate_limit"])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            observe_rate_limit_json(&String::from_utf8_lossy(&output.stdout));
        }
        Ok(output) => log::debug!(
            "gh api rate_limit failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(e) => log::debug!("Failed to run gh api rate_limit: {e}"),
    }
}

#[derive(Debug)]
pub struct RestError {
    pub status: Option<u16>,
    pub message: String,
}

struct RawResponse<'a> {
    status: Option<u16>,
    headers: HashMap<String, String>,
    body: &'a str,
}

/// Splits `gh api -i` output into status, lowercase headers and body.
fn parse_raw_response(raw: &str) -> RawResponse<'_> {
    let mut status = None;
    let mut headers = HashMap::new();
    let mut offset = 0;
    for line in raw.split_inclusive('\n') {
        offset += line.len();
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            return RawResponse {
                status,
                headers,
                body: &raw[offset..],
            };
        }
        if status.is_none() && line.starts_with("HTTP/") {
            status = line.split_whitespace().nth(1).and_then(|s| s.parse().ok());
        } else if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_lowercase(), value.trim().to_string());
        }
    }
    RawResponse {
        status,
        headers,
        body: "",
    }
}

/// Background REST GET through `gh api`. Stops in the reserve, records the
/// quota from the response headers, and revalidates with the cached ETag: a
/// `304 Not Modified` answer spends no quota.
pub fn background_rest_get(
    gh: &Path,
    cwd: &str,
    hostname: Option<&str>,
    path: &str,
) -> Result<String, RestError> {
    if let Some(until) = background_wait(GhResource::Core) {
        return Err(RestError {
            status: None,
            message: wait_error(GhResource::Core, until),
        });
    }

    let cache_key = format!("{}/{path}", hostname.unwrap_or("github.com"));
    let cached = ETAGS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&cache_key)
        .cloned();

    let mut command = crate::platform::resolved_cli_command(gh, Some(Path::new(cwd)));
    command.args(["api", "-i"]);
    if let Some(hostname) = hostname {
        command.args(["--hostname", hostname]);
    }
    if let Some((etag, _)) = &cached {
        command.args(["-H", &format!("If-None-Match: {etag}")]);
    }
    command.arg(path);

    let output = command.output().map_err(|e| RestError {
        status: None,
        message: format!("Failed to run gh api: {e}"),
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let response = parse_raw_response(&stdout);
    observe_headers(&response.headers);

    if response.status == Some(304) {
        if let Some((_, body)) = cached {
            return Ok(body);
        }
    }
    if output.status.success() {
        if let Some(etag) = response.headers.get("etag") {
            let mut etags = ETAGS.lock().unwrap_or_else(|e| e.into_inner());
            if etags.len() >= ETAG_CACHE_MAX_ENTRIES {
                etags.clear();
            }
            etags.insert(cache_key, (etag.clone(), response.body.to_string()));
        }
        return Ok(response.body.to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = format!(
        "gh api {path} failed: {} {}",
        stderr.trim(),
        response.body.trim()
    );
    record_failure(GhResource::Core, &message);
    Err(RestError {
        status: response.status,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000;

    #[test]
    fn background_waits_in_reserve_until_reset() {
        let mut book = QuotaBook::default();
        book.observe(GhResource::Core, 5000, 500, NOW + 600);
        assert_eq!(book.background_wait(GhResource::Core, NOW), None);
        book.observe(GhResource::Core, 5000, 499, NOW + 600);
        assert_eq!(book.background_wait(GhResource::Core, NOW), Some(NOW + 600));
        assert_eq!(book.background_wait(GhResource::Graphql, NOW), None);
        assert_eq!(book.background_wait(GhResource::Core, NOW + 600), None);
    }

    #[test]
    fn older_window_does_not_overwrite_newer_quota() {
        let mut book = QuotaBook::default();
        book.observe(GhResource::Graphql, 5000, 4000, NOW + 600);
        book.observe(GhResource::Graphql, 5000, 0, NOW - 10);
        assert_eq!(book.background_wait(GhResource::Graphql, NOW), None);
    }

    #[test]
    fn failure_pause_uses_known_reset_then_message_kind() {
        let mut book = QuotaBook::default();
        assert_eq!(
            book.record_failure(GhResource::Core, "Could not resolve repository", NOW),
            None
        );
        assert_eq!(
            book.record_failure(
                GhResource::Graphql,
                "You have exceeded a secondary rate limit",
                NOW
            ),
            Some(NOW + SECONDARY_LIMIT_PAUSE_SECS)
        );
        assert_eq!(
            book.record_failure(GhResource::Core, "API rate limit exceeded for user", NOW),
            Some(NOW + FALLBACK_PAUSE_SECS)
        );

        let mut book = QuotaBook::default();
        book.observe(GhResource::Core, 5000, 0, NOW + 120);
        assert_eq!(
            book.record_failure(GhResource::Core, "API rate limit exceeded", NOW),
            Some(NOW + 120)
        );
        assert_eq!(
            book.background_wait(GhResource::Core, NOW + 60),
            Some(NOW + 120)
        );
    }

    #[test]
    fn parses_gh_api_include_output() {
        let raw = "HTTP/2.0 304 Not Modified\nEtag: \"abc\"\r\nX-Ratelimit-Remaining: 12\r\n\r\n{\"a\":1}";
        let response = parse_raw_response(raw);
        assert_eq!(response.status, Some(304));
        assert_eq!(
            response.headers.get("etag").map(String::as_str),
            Some("\"abc\"")
        );
        assert_eq!(
            response
                .headers
                .get("x-ratelimit-remaining")
                .map(String::as_str),
            Some("12")
        );
        assert_eq!(response.body, "{\"a\":1}");
    }

    #[test]
    fn detects_github_rate_limit_errors() {
        assert!(is_rate_limit_error(
            "gh issue list failed: API rate limit exceeded for user"
        ));
        assert!(is_rate_limit_error(
            "You have exceeded a secondary rate limit"
        ));
        assert!(!is_rate_limit_error("Could not resolve repository"));
    }
}
