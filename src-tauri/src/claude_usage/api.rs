use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, USER_AGENT};
use std::sync::Mutex;

use super::credentials::get_oauth_token;
use super::types::{CachedUsageLimits, UsageLimits, UsageLimitsApiResponse};

/// API endpoint for usage limits
const USAGE_API_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Beta header required for OAuth API
const ANTHROPIC_BETA_HEADER: &str = "anthropic-beta";
const ANTHROPIC_BETA_VALUE: &str = "oauth-2025-04-20";

/// User agent to match Claude Code
const CLAUDE_CODE_USER_AGENT: &str = "claude-code/2.0.31";

/// Global cache for usage limits (1 minute TTL)
static USAGE_LIMITS_CACHE: Mutex<Option<CachedUsageLimits>> = Mutex::new(None);

/// Fetch usage limits from Anthropic API
///
/// Uses a 60-second cache to avoid excessive API calls.
/// Returns cached data if available and valid.
pub async fn fetch_usage_limits() -> Result<UsageLimits, String> {
    // Check cache first
    {
        let cache = USAGE_LIMITS_CACHE.lock().map_err(|e| format!("Cache lock error: {e}"))?;
        if let Some(cached) = cache.as_ref() {
            if cached.is_valid() {
                return Ok(cached.data.clone());
            }
        }
    }

    // Fetch fresh data
    let limits = fetch_usage_limits_uncached().await?;

    // Update cache
    {
        let mut cache = USAGE_LIMITS_CACHE.lock().map_err(|e| format!("Cache lock error: {e}"))?;
        *cache = Some(CachedUsageLimits::new(limits.clone()));
    }

    Ok(limits)
}

/// Fetch usage limits without caching
async fn fetch_usage_limits_uncached() -> Result<UsageLimits, String> {
    let token = get_oauth_token().await?;

    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|e| format!("Invalid token format: {e}"))?,
    );
    headers.insert(
        ANTHROPIC_BETA_HEADER,
        HeaderValue::from_static(ANTHROPIC_BETA_VALUE),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static(CLAUDE_CODE_USER_AGENT));

    let client = reqwest::Client::new();
    let response = client
        .get(USAGE_API_URL)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch usage limits: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("API error {status}: {body}"));
    }

    let api_response: UsageLimitsApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse usage limits response: {e}"))?;

    Ok(api_response.into())
}

/// Clear the usage limits cache (useful for testing or force refresh)
#[allow(dead_code)]
pub fn clear_cache() {
    if let Ok(mut cache) = USAGE_LIMITS_CACHE.lock() {
        *cache = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_clear() {
        clear_cache();
        let cache = USAGE_LIMITS_CACHE.lock().unwrap();
        assert!(cache.is_none());
    }
}
