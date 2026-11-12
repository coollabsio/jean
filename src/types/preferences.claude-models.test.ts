import { describe, expect, it } from 'vitest'
import { isClaudeModelId, normalizeClaudeModel } from './preferences'

describe('isClaudeModelId', () => {
  it('accepts plausible Claude ids, including models newer than this build', () => {
    expect(isClaudeModelId('claude-fable-5-2')).toBe(true)
    expect(isClaudeModelId('claude-fable-6')).toBe(true)
    expect(isClaudeModelId('claude-opus-4-8[1m]')).toBe(true)
    expect(isClaudeModelId('claude-opus-4-6[1m]-fast')).toBe(true)
  })

  it('rejects other providers and empty values', () => {
    expect(isClaudeModelId('gpt-6.1-sol')).toBe(false)
    expect(isClaudeModelId('qwen3.8-max')).toBe(false)
    expect(isClaudeModelId('')).toBe(false)
    expect(isClaudeModelId('   ')).toBe(false)
  })
})

describe('normalizeClaudeModel', () => {
  it('keeps an unknown but plausible id instead of rewriting it', () => {
    expect(normalizeClaudeModel('claude-fable-6')).toBe('claude-fable-6')
  })
})
