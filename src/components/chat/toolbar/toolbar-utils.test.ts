import { describe, expect, it } from 'vitest'
import {
  formatCommandCodeModelLabel,
  formatGrokModelOptionLabel,
  formatGrokPromptModelLabel,
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
    expect(getSessionProviderDisplayName('kimi', null)).toBe('Kimi Code')
    expect(getSessionProviderDisplayName('antigravity', null)).toBe('Google')
  })

  it('shows custom Codex provider names when selected', () => {
    expect(getSessionProviderDisplayName('codex', 'OpenRouter')).toBe(
      'OpenRouter'
    )
    expect(getSessionProviderDisplayName('codex', '__default__')).toBe('OpenAI')
  })

  it('falls back to provider selection for claude sessions', () => {
    expect(getSessionProviderDisplayName('claude', null)).toBe('Anthropic')
    expect(getSessionProviderDisplayName('claude', 'openrouter')).toBe(
      'openrouter'
    )
  })
})

describe('formatGrokPromptModelLabel', () => {
  it('uses a short name for the fast build model', () => {
    expect(formatGrokPromptModelLabel('grok/grok-4.7-build-fast')).toBe(
      '4.7 Fast'
    )
    expect(formatGrokPromptModelLabel('grok-4.7')).toBe('4.7')
    expect(formatGrokPromptModelLabel('grok/grok-4.6')).toBe('4.6')
  })
})

describe('formatGrokModelOptionLabel', () => {
  it('replaces a raw id or generated name with a friendly name', () => {
    expect(
      formatGrokModelOptionLabel(
        'grok/grok-4.7-build-fast',
        'grok/grok-4.7-build-fast'
      )
    ).toBe('Grok 4.7 Fast')
    expect(
      formatGrokModelOptionLabel(
        'grok/grok-4.7-build-fast',
        'Grok 4.7 Build Fast'
      )
    ).toBe('Grok 4.7 Fast')
  })

  it('keeps a custom catalog name', () => {
    expect(formatGrokModelOptionLabel('grok/future', 'Super Grok')).toBe(
      'Super Grok'
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
