/**
 * Detect whether a chat error string is an AI usage / rate-limit error (vs a
 * generic failure). Backends pass limit text through `chat:error` verbatim, so
 * this mirrors the keyword set the Rust Grok classifier uses
 * (`format_grok_user_error` in jean-core/src/chat/grok.rs).
 *
 * Used to decide whether to offer "Auto-continue when limit resets".
 */
const LIMIT_PATTERNS = [
  'usage limit',
  'session limit',
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  'resource_exhausted',
  'resources exhausted',
  'quota',
  'limit exceeded',
  'limit reached',
  '"code":429',
  'status code 429',
  'http 429',
  '[429]',
  '429 ',
]

export function isUsageLimitError(error: string | null | undefined): boolean {
  if (!error) return false
  const lower = error.toLowerCase()
  return LIMIT_PATTERNS.some(p => lower.includes(p))
}
