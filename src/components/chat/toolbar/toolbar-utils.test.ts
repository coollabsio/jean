import { describe, expect, it } from 'vitest'
import {
  getProviderDisplayName,
  getSessionProviderDisplayName,
} from './toolbar-utils'

describe('getProviderDisplayName', () => {
  it('defaults to Anthropic for missing providers', () => {
    expect(getProviderDisplayName(null)).toBe('Anthropic')
    expect(getProviderDisplayName('__anthropic__')).toBe('Anthropic')
  })

  it('returns custom provider names unchanged', () => {
    expect(getProviderDisplayName('openrouter')).toBe('openrouter')
  })
})

describe('getSessionProviderDisplayName', () => {
  it('uses backend labels for codex and opencode sessions', () => {
    expect(getSessionProviderDisplayName('codex', null)).toBe('OpenAI')
    expect(getSessionProviderDisplayName('opencode', null)).toBe('OpenCode')
    expect(getSessionProviderDisplayName('opencode', '__anthropic__')).toBe(
      'OpenCode'
    )
  })

  it('falls back to provider selection for claude sessions', () => {
    expect(getSessionProviderDisplayName('claude', null)).toBe('Anthropic')
    expect(getSessionProviderDisplayName('claude', 'openrouter')).toBe(
      'openrouter'
    )
  })
})
