import { describe, expect, it } from 'vitest'
import {
  providerSupportsAdaptiveThinking,
  getModelImpliedBackend,
  getOlderModelValues,
  isGeminiModel,
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

  it('treats muse/ model ids as Muse', () => {
    expect(getModelImpliedBackend('muse/default')).toBe('muse')
    expect(resolveBackend('muse/muse-spark-1.2')).toBe('muse')
  })

  it('treats Devin model ids as Devin', () => {
    expect(getModelImpliedBackend('devin/default')).toBe('devin')
    expect(resolveBackend('devin/default')).toBe('devin')
  })
})

describe('isGeminiModel', () => {
  it('detects Antigravity model ids across backends', () => {
    expect(isGeminiModel('commandcode/google/gemini-3.5-flash')).toBe(true)
    expect(isGeminiModel('cursor/gemini-3.1-pro')).toBe(true)
    expect(isGeminiModel('opencode/google/gemini-2.5-pro')).toBe(true)
    expect(isGeminiModel('GEMINI-3.5-flash')).toBe(true)
  })

  it('rejects non-Antigravity models', () => {
    expect(isGeminiModel('claude-opus-4-8')).toBe(false)
    expect(isGeminiModel('gpt-5.6-sol')).toBe(false)
    expect(isGeminiModel(null)).toBe(false)
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

describe('providerSupportsAdaptiveThinking', () => {
  const profile = (name: string, env: Record<string, string>) => ({
    name,
    settings_json: JSON.stringify({ env }),
  })
  const profiles = [
    profile('CLIProxyAPI', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5' }),
    profile('Zai', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7' }),
    profile('Empty', {}),
  ]

  it('uses effort when a provider maps the alias to an effort Claude model', () => {
    expect(
      providerSupportsAdaptiveThinking('opus', 'CLIProxyAPI', profiles, '2.2.0')
    ).toBe(true)
  })

  it('uses thinking when the alias maps to a non-Claude model', () => {
    expect(
      providerSupportsAdaptiveThinking('opus', 'Zai', profiles, '2.2.0')
    ).toBe(false)
  })

  it('uses thinking when the provider does not map the alias', () => {
    expect(
      providerSupportsAdaptiveThinking('opus', 'Empty', profiles, '2.2.0')
    ).toBe(false)
  })

  it('checks the model itself without a custom provider', () => {
    for (const provider of [null, '__anthropic__', '__default__']) {
      expect(
        providerSupportsAdaptiveThinking(
          'claude-opus-5-5',
          provider,
          profiles,
          '2.2.0'
        )
      ).toBe(true)
    }
    expect(
      providerSupportsAdaptiveThinking('opus', null, profiles, '2.2.0')
    ).toBe(false)
  })
})

describe('getOlderModelValues', () => {
  it('keeps only the newest Claude model of each family', () => {
    const older = getOlderModelValues([
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-sonnet-5',
      'claude-opus-4-8[1m]',
      'claude-opus-4-8',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-6[1m]',
      'haiku',
    ])
    expect([...older].sort()).toEqual([
      'claude-fable-5',
      'claude-opus-4-5-20251101',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-5',
      'claude-sonnet-4-6[1m]',
      'claude-sonnet-5',
    ])
  })

  it('hides Codex models from an older major version line', () => {
    const older = getOlderModelValues([
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.3-codex-spark',
    ])
    expect([...older].sort()).toEqual([
      'gpt-5.3-codex-spark',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-6-sol',
    ])
  })

  it('compares families separately across providers', () => {
    const older = getOlderModelValues([
      'anthropic/claude-opus-4-5',
      'anthropic/claude-opus-4-1',
      'openai/gpt-5.4',
      'google/gemini-3-pro',
      'cursor/auto',
    ])
    expect([...older]).toEqual(['anthropic/claude-opus-4-1'])
  })
})
