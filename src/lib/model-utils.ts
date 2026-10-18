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
  if (model.startsWith('antigravity/')) return 'antigravity'
  if (model.startsWith('opencode/')) return 'opencode'
  if (model.startsWith('pi/')) return 'pi'
  if (model.startsWith('codex') || model.includes('codex')) return 'codex'
  if (model.startsWith('gpt-')) return 'codex'
  return null
}

/**
 * Antigravity models that support native adaptive thinking when no effort/thinking
 * level is forced (e.g. Antigravity 3.5 Flash). Jean only surfaces Adaptive/Default
 * for these models.
 */
export function isGeminiModel(model: string | null | undefined): boolean {
  if (!model) return false
  return model.toLowerCase().includes('gemini')
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
 *
 * Note: this is Claude "effort mode", not Jean's Antigravity-only Adaptive/Default
 * option (see `isGeminiModel`).
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

function getRawModelSortKey(value: string): {
  model: string
  numbers: number[]
  raw: string
} {
  const raw = value.toLowerCase().replace(/:[^/]*$/, '')
  const model = raw.split('/').filter(Boolean).at(-1) ?? raw
  const numbers = [...model.matchAll(/\d+(?:\.\d+)?/g)].flatMap(match =>
    match[0].split('.').map(Number)
  )

  return { model, numbers, raw }
}

function compareRawModelValues(left: string, right: string): number {
  const a = getRawModelSortKey(left)
  const b = getRawModelSortKey(right)
  const maxNumbers = Math.max(a.numbers.length, b.numbers.length)

  for (let i = 0; i < maxNumbers; i++) {
    const aNumber = a.numbers[i]
    const bNumber = b.numbers[i]
    if (aNumber === undefined && bNumber === undefined) continue
    if (aNumber === undefined) return 1
    if (bNumber === undefined) return -1
    if (aNumber !== bNumber) return bNumber - aNumber
  }

  const modelCompare = a.model.localeCompare(b.model, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
  if (modelCompare !== 0) return modelCompare

  return a.raw.localeCompare(b.raw, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

export function sortModelOptionsByRawModel<T extends { value: string }>(
  options: readonly T[]
): T[] {
  return [...options].sort((a, b) => compareRawModelValues(a.value, b.value))
}
