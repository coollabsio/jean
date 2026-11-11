/**
 * Model utilities for feature detection and CLI compatibility.
 *
 * Some Claude models use effort levels (effort parameter) instead of
 * traditional thinking levels (budget_tokens). This is supported from
 * Claude CLI >= 2.1.32. Sonnet and other models continue to use
 * traditional thinking levels.
 */

import { compareVersions } from './version-utils'
import type { EffortLevel, ThinkingLevel } from '@/types/chat'
import {
  resolveProviderModelId,
  type CliBackend,
  type CustomCliProfile,
} from '@/types/preferences'

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
  if (model.startsWith('devin/')) return 'devin'
  if (model.startsWith('antigravity/')) return 'antigravity'
  if (model.startsWith('muse/')) return 'muse'
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

/**
 * Effort support for `model` sent through `provider`, decided by the
 * upstream model id: CLIProxyAPI maps `opus` to `claude-opus-5-5`, which
 * supports effort; a profile that maps `opus` to `glm-4.7` does not.
 */
export function providerSupportsAdaptiveThinking(
  model: string,
  provider: string | null | undefined,
  customCliProfiles: readonly CustomCliProfile[] | null | undefined,
  cliVersion: string | null | undefined,
  catalogUsesEffort?: boolean
): boolean {
  const modelId = resolveProviderModelId(model, provider, customCliProfiles)
  return (
    modelId !== undefined &&
    supportsAdaptiveThinking(modelId, cliVersion, catalogUsesEffort)
  )
}

/** Backends whose chat turns always take an effort level. */
const EFFORT_BACKENDS: ReadonlySet<CliBackend> = new Set<CliBackend>([
  'codex',
  'opencode',
  'pi',
  'grok',
  'kimi',
  'antigravity',
  'muse',
])

/** The backend and model that one chat turn runs on. */
export interface ReasoningTarget {
  backend: CliBackend
  model: string
  provider?: string | null
  customCliProfiles?: readonly CustomCliProfile[] | null
  cliVersion?: string | null
  /** Effort support from the model catalog, when known. */
  catalogUsesEffort?: boolean
}

/**
 * True when a turn on `target` takes an effort level, not a thinking level.
 * Decide this from the model the turn runs on, not from the model of the
 * session that started it: a build override can change the model.
 */
export function targetUsesEffort(target: ReasoningTarget): boolean {
  if (EFFORT_BACKENDS.has(target.backend)) return true
  if (target.backend !== 'claude') return false
  return providerSupportsAdaptiveThinking(
    target.model,
    target.provider,
    target.customCliProfiles,
    target.cliVersion,
    target.catalogUsesEffort
  )
}

/**
 * The reasoning fields of a send: an effort level for effort targets, else a
 * thinking level. Never both, so the message badge matches what ran.
 */
export function resolveSendReasoning(
  usesEffort: boolean,
  thinkingLevel: ThinkingLevel,
  effortLevel: EffortLevel
): { thinkingLevel?: ThinkingLevel; effortLevel?: EffortLevel } {
  return usesEffort ? { effortLevel } : { thinkingLevel }
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

interface ParsedModelVersion {
  family: string
  line: string
  version: number[]
}

function parseModelVersion(value: string): ParsedModelVersion {
  // Drop variant suffixes like `[1m]`, then split letters from digits so
  // `kimi-k2.5`, `o4-mini`, and `gpt-5.4-mini` all yield comparable parts.
  const tokens =
    value
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, '')
      .match(/[a-z]+|\d+/g) ?? []
  const words: string[] = []
  const lineWords: string[] = []
  const version: number[] = []
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      // Long digit runs are release dates (`20251101`), not versions.
      if (token.length < 6) version.push(Number(token))
    } else {
      words.push(token)
      if (version.length === 0) lineWords.push(token)
    }
  }
  return {
    family: words.join(' '),
    line: lineWords.join(' '),
    version,
  }
}

function compareVersionParts(left: number[], right: number[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? -1) - (right[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Return the model values that a newer model supersedes.
 *
 * A model is older when its family (name without numbers, e.g. `claude opus`
 * or `gpt mini`) has a higher version, or when its line (name before the
 * first number, e.g. `gpt`) has a higher major version. Models without a
 * version number (aliases like `haiku`, `auto`) are never older.
 */
export function getOlderModelValues(values: readonly string[]): Set<string> {
  const parsed = values.map(value => ({ value, ...parseModelVersion(value) }))
  const newestByFamily = new Map<string, number[]>()
  const newestMajorByLine = new Map<string, number>()
  for (const model of parsed) {
    if (model.version.length === 0) continue
    const newest = newestByFamily.get(model.family)
    if (!newest || compareVersionParts(model.version, newest) > 0) {
      newestByFamily.set(model.family, model.version)
    }
    const major = model.version[0] ?? 0
    if (major > (newestMajorByLine.get(model.line) ?? -1)) {
      newestMajorByLine.set(model.line, major)
    }
  }
  const older = new Set<string>()
  for (const model of parsed) {
    if (model.version.length === 0) continue
    const newest = newestByFamily.get(model.family) ?? model.version
    const newestMajor = newestMajorByLine.get(model.line) ?? 0
    if (
      compareVersionParts(model.version, newest) < 0 ||
      (model.version[0] ?? 0) < newestMajor
    ) {
      older.add(model.value)
    }
  }
  return older
}
