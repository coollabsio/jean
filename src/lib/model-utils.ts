/**
 * Model utilities for feature detection and CLI compatibility.
 *
 * Some Claude models use effort levels (effort parameter) instead of
 * traditional thinking levels (budget_tokens). This is supported from
 * Claude CLI >= 2.1.32. Sonnet and other models continue to use
 * traditional thinking levels.
 */

import { compareVersions } from './version-utils'
import type { CliBackend } from '@/types/preferences'

export type ModelBackend = CliBackend

/** Minimum CLI version that supports Claude effort levels */
const ADAPTIVE_THINKING_MIN_CLI_VERSION = '2.1.32'

/**
 * Resolve which CLI backend to use based on the model string.
 */
export function resolveBackend(model: string): CliBackend {
  return getModelImpliedBackend(model) ?? 'claude'
}

export function getModelImpliedBackend(
  model: string | null | undefined
): Exclude<CliBackend, 'claude'> | null {
  if (!model) return null
  if (model.startsWith('commandcode/')) return 'commandcode'
  if (model.startsWith('cursor/')) return 'cursor'
  if (model.startsWith('grok/')) return 'grok'
  if (model.startsWith('kimi/')) return 'kimi'
  if (model.startsWith('opencode/')) return 'opencode'
  if (model.startsWith('pi/')) return 'pi'
  if (model.startsWith('codex') || model.includes('codex')) return 'codex'
  if (model.startsWith('gpt-')) return 'codex'
  return null
}

/**
 * Check if the current model + CLI version combination uses effort levels
 * instead of traditional thinking levels.
 *
 * Returns true when:
 * - Model is a Claude Fable or Opus variant
 * - CLI version is >= 2.1.32
 *
 * Sonnet models use traditional thinking levels, not effort levels.
 */
export function supportsAdaptiveThinking(
  model: string,
  cliVersion: string | null | undefined,
  catalogUsesEffort?: boolean
): boolean {
  const usesEffortLevels =
    catalogUsesEffort ??
    (model.startsWith('claude-fable-') || model.startsWith('claude-opus-'))
  if (!usesEffortLevels) return false
  if (!cliVersion) return false
  return compareVersions(cliVersion, ADAPTIVE_THINKING_MIN_CLI_VERSION) >= 0
}
