use serde::{Deserialize, Serialize};

/// A single usage limit (5-hour or 7-day)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    /// Utilization percentage (0-100)
    pub utilization: f64,
    /// ISO timestamp when the limit resets
    pub resets_at: Option<String>,
}

/// Usage limits from Claude API
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    /// 5-hour rolling window limit
    pub five_hour: Option<UsageLimit>,
    /// 7-day rolling window limit
    pub seven_day: Option<UsageLimit>,
}

/// API response format (snake_case from API)
#[derive(Debug, Clone, Deserialize)]
pub struct UsageLimitsApiResponse {
    pub five_hour: Option<UsageLimitApi>,
    pub seven_day: Option<UsageLimitApi>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsageLimitApi {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

impl From<UsageLimitsApiResponse> for UsageLimits {
    fn from(api: UsageLimitsApiResponse) -> Self {
        Self {
            five_hour: api.five_hour.map(|l| UsageLimit {
                utilization: l.utilization,
                resets_at: l.resets_at,
            }),
            seven_day: api.seven_day.map(|l| UsageLimit {
                utilization: l.utilization,
                resets_at: l.resets_at,
            }),
        }
    }
}

/// Session usage summary for a specific session
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    /// Total input tokens across all runs
    pub total_input_tokens: u64,
    /// Total output tokens across all runs
    pub total_output_tokens: u64,
    /// Total cache tokens (read + creation)
    pub total_cache_tokens: u64,
    /// Context percentage (0-100) based on 200k max
    pub context_percentage: f64,
    /// Estimated cost in USD
    pub estimated_cost_usd: f64,
}

impl SessionUsage {
    /// Create from token counts with separate context tracking
    ///
    /// - total_* params: Sum of all runs (for cost calculation)
    /// - context_* params: Last run's tokens (for context percentage)
    pub fn from_tokens_with_context(
        total_input_tokens: u64,
        total_output_tokens: u64,
        total_cache_read_tokens: u64,
        total_cache_creation_tokens: u64,
        context_input_tokens: u64,
        context_cache_read_tokens: u64,
        context_cache_creation_tokens: u64,
    ) -> Self {
        const MAX_CONTEXT_TOKENS: f64 = 200_000.0;
        // Sonnet 3.5 pricing (adjust for other models if needed)
        const INPUT_COST_PER_1M: f64 = 3.0;
        const OUTPUT_COST_PER_1M: f64 = 15.0;
        // Cache tokens are cheaper
        const CACHE_READ_COST_PER_1M: f64 = 0.30;
        const CACHE_CREATION_COST_PER_1M: f64 = 3.75;

        let total_cache_tokens = total_cache_read_tokens + total_cache_creation_tokens;

        // Context = last run's input + cache tokens (full context window usage)
        // This matches Claude Code's calculation: input + cache_read + cache_creation
        let context_tokens =
            context_input_tokens + context_cache_read_tokens + context_cache_creation_tokens;
        let context_percentage = ((context_tokens as f64 / MAX_CONTEXT_TOKENS) * 100.0).min(100.0);

        // Cost = sum of all tokens across all runs
        let estimated_cost_usd = (total_input_tokens as f64 * INPUT_COST_PER_1M
            + total_output_tokens as f64 * OUTPUT_COST_PER_1M
            + total_cache_read_tokens as f64 * CACHE_READ_COST_PER_1M
            + total_cache_creation_tokens as f64 * CACHE_CREATION_COST_PER_1M)
            / 1_000_000.0;

        Self {
            total_input_tokens,
            total_output_tokens,
            total_cache_tokens,
            context_percentage,
            estimated_cost_usd,
        }
    }
}

/// Cached usage limits with timestamp
#[derive(Debug, Clone)]
pub struct CachedUsageLimits {
    pub data: UsageLimits,
    pub timestamp: std::time::Instant,
}

impl CachedUsageLimits {
    pub fn new(data: UsageLimits) -> Self {
        Self {
            data,
            timestamp: std::time::Instant::now(),
        }
    }

    /// Check if cache is still valid (60 second TTL)
    pub fn is_valid(&self) -> bool {
        self.timestamp.elapsed().as_secs() < 60
    }
}

/// OAuth credentials structure from Claude Code
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCredentials {
    pub claude_ai_oauth: Option<OAuthCredentials>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCredentials {
    pub access_token: String,
    #[allow(dead_code)]
    pub refresh_token: Option<String>,
    #[allow(dead_code)]
    pub expires_at: Option<u64>,
}
