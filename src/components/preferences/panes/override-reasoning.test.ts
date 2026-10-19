import { describe, expect, it } from 'vitest'
import type { ModelCatalog } from '@/services/model-catalog'
import {
  codexReasoningOptions,
  thinkingLevelOptions,
} from '@/types/preferences'
import { resolveOverrideReasoning } from './override-reasoning'

const catalogWith = (
  backend: 'claude' | 'codex',
  model: string,
  reasoning: unknown
): ModelCatalog =>
  ({
    version: 1,
    updated_at: 'test',
    defaults: {},
    backends: {
      [backend]: { models: [{ id: model, label: model, reasoning }] },
    },
  }) as unknown as ModelCatalog

describe('resolveOverrideReasoning', () => {
  it('shows thinking levels for custom Claude models missing from the catalog', () => {
    const reasoning = resolveOverrideReasoning(null, 'claude', 'glm-4.6')
    expect(reasoning?.type).toBe('thinking')
    expect(reasoning?.levels).toBe(thinkingLevelOptions)
  })

  it('shows thinking levels for provider-routed Claude aliases', () => {
    expect(resolveOverrideReasoning(null, 'claude', 'opus')?.type).toBe(
      'thinking'
    )
  })

  it('uses catalog reasoning for known Claude models', () => {
    expect(
      resolveOverrideReasoning(null, 'claude', 'claude-opus-5-5')?.type
    ).toBe('effort')
  })

  it('hides the control when the catalog marks a Claude model as reasoning-less', () => {
    const catalog = catalogWith('claude', 'claude-no-reasoning', null)
    expect(
      resolveOverrideReasoning(catalog, 'claude', 'claude-no-reasoning')
    ).toBeNull()
  })

  it('keeps the effort fallback for effort backends', () => {
    const reasoning = resolveOverrideReasoning(null, 'codex', 'custom-codex')
    expect(reasoning?.type).toBe('effort')
    expect(reasoning?.levels).toBe(codexReasoningOptions)
    expect(resolveOverrideReasoning(null, 'pi', 'x/y')?.type).toBe('effort')
  })

  it('returns null for backends without reasoning controls', () => {
    expect(resolveOverrideReasoning(null, 'commandcode', 'x')).toBeNull()
    expect(resolveOverrideReasoning(null, 'cursor', 'x')).toBeNull()
  })
})
