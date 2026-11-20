import type { CliBackend } from '@/types/preferences'

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One `get_usage_summary` row: every run of one backend + model. */
export interface UsageSummaryRow {
  backend: CliBackend
  model: string | null
  runCount: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reportedCostUsd: number
  reportedCostRuns: number
}

const price = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite = input
): ModelPrice => ({ input, output, cacheRead, cacheWrite })

/**
 * Public API list prices, standard tier, as of 2026-11-20. Cache write is the
 * 5-minute write price; providers without a write price bill it as input.
 * Models priced by prompt length (Claude Haiku 5.5, GPT-5.5/5.4, Grok,
 * Gemini 3.1 Pro) use the short-prompt tier, so long-context runs are
 * underestimated.
 *
 * Sources:
 * - https://platform.claude.com/docs/en/about-claude/pricing
 * - https://developers.openai.com/api/docs/pricing
 * - https://aistudio.google.com/docs/pricing (gemini-4-carbon/argon double
 *   on 2026-12-01, gemini-3.8/3.6-flash on 2027-01-01)
 * - https://docs.x.ai/docs/models
 */
const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-2': price(8, 40, 0.2, 10),
  'claude-mythos-5-2': price(8, 40, 0.2, 10),
  'claude-fable-5-1': price(10, 50, 0.25, 12.5),
  'claude-mythos-5-1': price(10, 50, 0.25, 12.5),
  'claude-fable-5': price(10, 50, 1, 12.5),
  'claude-mythos-5': price(10, 50, 1, 12.5),
  'claude-opus-5-5': price(4, 20, 0.2, 5),
  'claude-opus-5': price(5, 25, 0.5, 6.25),
  'claude-opus-4-8': price(5, 25, 0.5, 6.25),
  'claude-opus-4-7': price(5, 25, 0.5, 6.25),
  'claude-opus-4-6': price(5, 25, 0.5, 6.25),
  'claude-opus-4-5': price(5, 25, 0.5, 6.25),
  'claude-opus-4-1': price(15, 75, 1.5, 18.75),
  'claude-opus-4': price(15, 75, 1.5, 18.75),
  'claude-sonnet-5-5': price(2, 10, 0.1, 2.5),
  'claude-sonnet-5': price(2, 10, 0.2, 2.5),
  'claude-sonnet-4-6': price(3, 15, 0.3, 3.75),
  'claude-sonnet-4-5': price(3, 15, 0.3, 3.75),
  'claude-sonnet-4': price(3, 15, 0.3, 3.75),
  'claude-haiku-5-5': price(0.1, 0.5, 0.01, 0.125),
  'claude-haiku-4-5': price(1, 5, 0.1, 1.25),
  'gpt-5.6-sol': price(4, 20, 0.4),
  'gpt-5.6-terra': price(2, 12, 0.2),
  'gpt-5.6-luna': price(0.2, 1.2, 0.02),
  'gpt-5.5': price(5, 30, 0.5),
  'gpt-5.4': price(2.5, 15, 0.25),
  'gpt-5.4-mini': price(0.75, 4.5, 0.075),
  'gpt-5.4-nano': price(0.2, 1.25, 0.02),
  'gpt-5.3-codex': price(1.75, 14, 0.175),
  'gpt-5.2': price(1.75, 14, 0.175),
  'gpt-5.1': price(1.25, 10, 0.125),
  'gpt-5': price(1.25, 10, 0.125),
  'gpt-5-mini': price(0.25, 2, 0.025),
  'gpt-5-nano': price(0.05, 0.4, 0.005),
  'gemini-4-carbon': price(2, 10, 0.1),
  'gemini-4-argon': price(2, 10, 0.1),
  'gemini-4-neon': price(3, 15, 0.15),
  'gemini-4-hydrogen': price(1.5, 7.5, 0.075),
  'gemini-3.8-flash': price(0.75, 3.75, 0.075),
  'gemini-3.6-flash': price(0.75, 3.75, 0.075),
  'gemini-3.5-flash-lite': price(0.3, 2.5, 0.03),
  'gemini-3.1-flash-lite': price(0.25, 1.5, 0.025),
  'gemini-3.1-pro-preview': price(2, 12, 0.2),
  'gemini-3-flash-preview': price(0.5, 3, 0.05),
  'gemini-2.5-pro': price(1.25, 10, 0.125),
  'gemini-2.5-flash': price(0.3, 2.5, 0.03),
  'gemini-2.5-flash-lite': price(0.1, 0.4, 0.01),
  'grok-4.7': price(2, 6, 0.5),
  'grok-4.6': price(2, 6, 0.5),
  'grok-4.5': price(2, 6, 0.3),
  'grok-4.3': price(1.25, 2.5, 0.2),
  'grok-4.20-0309-reasoning': price(1.25, 2.5, 0.2),
  'grok-4.20-0309-non-reasoning': price(1.25, 2.5, 0.2),
  'grok-4.20-multi-agent-0309': price(1.25, 2.5, 0.2),
}

/**
 * API price of a model id, or null when unknown. Accepts provider prefixes
 * (`anthropic/claude-...`), Claude Code's `[1m]` suffix, dated snapshots and
 * dotted Claude versions. Claude Code aliases (`opus`, `sonnet`, `haiku`)
 * return null: they resolve to whatever model the CLI or provider picked.
 * `-fast` ids return null: fast mode has its own premium price.
 */
export function findModelPrice(
  model: string | null | undefined
): ModelPrice | null {
  if (!model) return null
  let id = model.trim().toLowerCase()
  id = id.slice(id.lastIndexOf('/') + 1)
  id = id.replace('[1m]', '')
  if (id.endsWith('-fast')) return null
  id = id.replace(/[-@]\d{8}$/, '')
  if (id.startsWith('claude-')) id = id.replaceAll('.', '-')
  return MODEL_PRICES[id] ?? null
}

/** Backends whose input token count already includes cache reads (OpenAI style). */
const INPUT_INCLUDES_CACHE_READ = new Set<CliBackend>(['codex'])

function uncachedInputTokens(row: UsageSummaryRow): number {
  return INPUT_INCLUDES_CACHE_READ.has(row.backend)
    ? Math.max(0, row.inputTokens - row.cacheReadInputTokens)
    : row.inputTokens
}

export interface RowCost {
  usd: number
  /** True when computed from the price table instead of CLI-reported cost. */
  estimated: boolean
}

/**
 * Reported cost when every run in the row reported one, else an estimate
 * from the price table, else null.
 */
export function rowCost(row: UsageSummaryRow): RowCost | null {
  if (row.runCount > 0 && row.reportedCostRuns === row.runCount) {
    return { usd: row.reportedCostUsd, estimated: false }
  }
  const p = findModelPrice(row.model)
  if (!p) return null
  const usd =
    (uncachedInputTokens(row) * p.input +
      row.outputTokens * p.output +
      row.cacheReadInputTokens * p.cacheRead +
      row.cacheCreationInputTokens * p.cacheWrite) /
    1_000_000
  return { usd, estimated: true }
}

/** What cache reads saved versus paying full input price, or null when unpriced. */
export function cacheSavingsUsd(row: UsageSummaryRow): number | null {
  const p = findModelPrice(row.model)
  if (!p) return null
  return (row.cacheReadInputTokens * (p.input - p.cacheRead)) / 1_000_000
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number
  /** Some row cost is an estimate. */
  estimated: boolean
  /** Some row had no price, so `costUsd` leaves it out. */
  partial: boolean
  savingsUsd: number
}

export function usageTotals(rows: UsageSummaryRow[]): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    estimated: false,
    partial: false,
    savingsUsd: 0,
  }
  for (const row of rows) {
    totals.inputTokens += row.inputTokens
    totals.outputTokens += row.outputTokens
    totals.cacheReadInputTokens += row.cacheReadInputTokens
    totals.cacheCreationInputTokens += row.cacheCreationInputTokens
    const cost = rowCost(row)
    if (cost) {
      totals.costUsd += cost.usd
      totals.estimated ||= cost.estimated
    } else {
      totals.partial = true
    }
    totals.savingsUsd += cacheSavingsUsd(row) ?? 0
  }
  return totals
}
