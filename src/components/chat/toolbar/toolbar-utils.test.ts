import { describe, expect, it } from 'vitest'
import {
  formatCommandCodeModelLabel,
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
  it('uses backend-specific provider labels', () => {
    expect(getSessionProviderDisplayName('codex', null)).toBe('OpenAI')
    expect(getSessionProviderDisplayName('opencode', null)).toBe('OpenCode')
    expect(getSessionProviderDisplayName('opencode', '__anthropic__')).toBe(
      'OpenCode'
    )
    expect(getSessionProviderDisplayName('grok', null)).toBe('xAI')
  })

  it('falls back to provider selection for claude sessions', () => {
    expect(getSessionProviderDisplayName('claude', null)).toBe('Anthropic')
    expect(getSessionProviderDisplayName('claude', 'openrouter')).toBe(
      'openrouter'
    )
  })
})

describe('formatCommandCodeModelLabel', () => {
  it('formats CommandCode provider/model ids as backend-prefixed model names', () => {
    expect(
      formatCommandCodeModelLabel('commandcode/deepseek/deepseek-v4-flash')
    ).toBe('Command Code · Deepseek V4 Flash')
    expect(formatCommandCodeModelLabel('commandcode/claude-sonnet-4-6')).toBe(
      'Command Code · Claude Sonnet 4.6'
    )
    expect(
      formatCommandCodeModelLabel('commandcode/moonshotai/Kimi-K2.5')
    ).toBe('Command Code · Kimi K2.5')
  })
})
