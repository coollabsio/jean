/**
 * Model utilities for feature detection and CLI compatibility.
 *
 * Claude 4.6 models (Opus and Sonnet) introduce adaptive thinking (effort
 * parameter) replacing
 * traditional thinking levels (budget_tokens). This is supported from
 * Claude CLI >= 2.1.32.
 */

import { compareVersions } from './version-utils'

/** Minimum CLI version that supports Claude 4.6 adaptive thinking */
const ADAPTIVE_THINKING_MIN_CLI_VERSION = '2.1.32'

/**
 * Resolve which CLI backend to use based on the model string.
 */
export function resolveBackend(model: string): 'claude' | 'codex' | 'opencode' {
  if (model.startsWith('opencode/')) return 'opencode'
  if (model.startsWith('codex') || model.includes('codex')) return 'codex'
  return 'claude'
}

/**
 * Check if the current model + CLI version combination supports
 * adaptive thinking (effort parameter) instead of traditional thinking levels.
 *
 * Returns true when:
 * - Model is a Claude 4.6 model ('opus' or 'sonnet')
 * - CLI version is >= 2.1.32
 */
export function supportsAdaptiveThinking(
  model: string,
  cliVersion: string | null | undefined
): boolean {
  if (model !== 'opus' && model !== 'sonnet') return false
  if (!cliVersion) return false
  return compareVersions(cliVersion, ADAPTIVE_THINKING_MIN_CLI_VERSION) >= 0
}
