import { describe, expect, it } from 'vitest'
import {
  getModelImpliedBackend,
  resolveBackend,
  supportsAdaptiveThinking,
} from './model-utils'

describe('resolveBackend', () => {
  it('resolves PI provider/model ids before Codex provider names', () => {
    expect(resolveBackend('pi/openai-codex/gpt-5.5')).toBe('pi')
  })
})

describe('getModelImpliedBackend', () => {
  it('treats PI provider/model ids as PI even when provider contains codex', () => {
    expect(getModelImpliedBackend('pi/openai-codex/gpt-5.5')).toBe('pi')
  })

  it('treats raw GPT model ids as Codex', () => {
    expect(getModelImpliedBackend('gpt-5.5')).toBe('codex')
  })
})

describe('supportsAdaptiveThinking', () => {
  it('uses effort levels for Claude Fable when the CLI supports adaptive thinking', () => {
    expect(supportsAdaptiveThinking('claude-fable-5', '2.1.32')).toBe(true)
  })

  it('uses effort levels for Claude Opus 5 when the CLI supports adaptive thinking', () => {
    expect(supportsAdaptiveThinking('claude-opus-5', '2.1.32')).toBe(true)
  })

  it('uses catalog effort metadata for models unknown to the bundled app', () => {
    expect(supportsAdaptiveThinking('claude-future', '2.1.32', true)).toBe(true)
    expect(supportsAdaptiveThinking('claude-future', '2.1.31', true)).toBe(
      false
    )
  })

  it('does not use effort levels for Claude Fable before CLI support', () => {
    expect(supportsAdaptiveThinking('claude-fable-5', '2.1.31')).toBe(false)
  })

  it('does not use effort levels for Claude Fable without a CLI version', () => {
    expect(supportsAdaptiveThinking('claude-fable-5', null)).toBe(false)
  })

  it('keeps Claude Sonnet on traditional thinking levels', () => {
    expect(supportsAdaptiveThinking('claude-sonnet-4-6[1m]', '2.1.32')).toBe(
      false
    )
  })
})
