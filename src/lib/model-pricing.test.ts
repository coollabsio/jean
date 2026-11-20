import { describe, expect, it } from 'vitest'
import {
  cacheSavingsUsd,
  findModelPrice,
  rowCost,
  usageTotals,
  type UsageSummaryRow,
} from './model-pricing'

function row(overrides: Partial<UsageSummaryRow>): UsageSummaryRow {
  return {
    backend: 'claude',
    model: 'claude-opus-5-5',
    runCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reportedCostUsd: 0,
    reportedCostRuns: 0,
    ...overrides,
  }
}

describe('findModelPrice', () => {
  it.each([
    ['claude-opus-4-8[1m]', 5],
    ['anthropic/claude-sonnet-4-5', 3],
    ['claude-sonnet-4-5-20250929', 3],
    ['claude-opus-4.5', 5],
    ['claude-opus-5', 5],
    ['claude-opus-5-5', 4],
    ['openai/gpt-5.3-codex', 1.75],
    ['gpt-5.4-mini', 0.75],
    ['GPT-5.5', 5],
    ['google/gemini-2.5-pro', 1.25],
    ['grok-4.7', 2],
  ])('prices %s at $%s input', (model, input) => {
    expect(findModelPrice(model)?.input).toBe(input)
  })

  it.each([
    'opus',
    'sonnet',
    'haiku',
    'claude-opus-4-8[1m]-fast',
    'gpt-5.5-codex',
    'claude-opus-9',
    '',
    null,
  ])('has no price for %s', model => {
    expect(findModelPrice(model)).toBeNull()
  })
})

describe('rowCost', () => {
  it('uses the reported cost when every run reported one', () => {
    expect(
      rowCost(
        row({
          runCount: 2,
          reportedCostRuns: 2,
          reportedCostUsd: 1.5,
          inputTokens: 1_000_000,
        })
      )
    ).toEqual({ usd: 1.5, estimated: false })
  })

  it('estimates from list prices when some run had no reported cost', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write per 1M.
    expect(
      rowCost(
        row({
          runCount: 2,
          reportedCostRuns: 1,
          reportedCostUsd: 99,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadInputTokens: 2_000_000,
          cacheCreationInputTokens: 200_000,
        })
      )
    ).toEqual({ usd: 4 + 10 + 0.4 + 1, estimated: true })
  })

  it('does not bill Codex cache reads twice as input', () => {
    // gpt-5.5: $5 in, $30 out, $0.50 cached in; inputTokens includes cached.
    const cost = rowCost(
      row({
        backend: 'codex',
        model: 'gpt-5.5',
        inputTokens: 3_000_000,
        cacheReadInputTokens: 2_000_000,
      })
    )
    expect(cost).toEqual({ usd: 5 + 1, estimated: true })
  })

  it('returns null for an unknown model without reported cost', () => {
    expect(rowCost(row({ model: 'opus', inputTokens: 10 }))).toBeNull()
  })
})

describe('cacheSavingsUsd', () => {
  it('values cache reads at input price minus cache read price', () => {
    expect(
      cacheSavingsUsd(row({ cacheReadInputTokens: 10_000_000 }))
    ).toBeCloseTo(38, 10)
  })

  it('returns null for an unknown model', () => {
    expect(cacheSavingsUsd(row({ model: null }))).toBeNull()
  })
})

describe('usageTotals', () => {
  it('sums tokens and known costs and flags estimates and gaps', () => {
    expect(
      usageTotals([
        row({
          inputTokens: 1_000_000,
          cacheReadInputTokens: 1_000_000,
          reportedCostRuns: 1,
          reportedCostUsd: 2,
        }),
        row({ model: 'gpt-5.4', backend: 'codex', outputTokens: 1_000_000 }),
        row({ model: 'mystery', inputTokens: 5 }),
      ])
    ).toEqual({
      inputTokens: 1_000_005,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      costUsd: 17,
      estimated: true,
      partial: true,
      savingsUsd: 3.8,
    })
  })
})
