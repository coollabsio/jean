import { describe, expect, it } from 'vitest'
import { buildUnifiedModelOptions, getModelOptionLabel } from './toolbar-options'

describe('buildUnifiedModelOptions', () => {
  it('includes installed backends in order with backend metadata', () => {
    const options = buildUnifiedModelOptions({
      installedBackends: ['claude', 'codex', 'opencode'],
      selectedProvider: null,
      customCliProfiles: [],
      opencodeModelOptions: [
        {
          value: 'opencode/custom-model',
          label: 'Custom Model (OpenCode)',
          backend: 'opencode',
        },
      ],
    })

    expect(options.slice(0, 9).every(option => option.backend === 'claude')).toBe(
      true
    )
    expect(
      options.slice(9, options.length - 1).every(option => option.backend === 'codex')
    ).toBe(true)
    expect(options[options.length - 1]).toEqual({
      value: 'opencode/custom-model',
      label: 'Custom Model (OpenCode)',
      backend: 'opencode',
    })
  })

  it('uses custom provider labels for claude options without removing codex', () => {
    const options = buildUnifiedModelOptions({
      installedBackends: ['claude', 'codex'],
      selectedProvider: 'OpenAI',
      customCliProfiles: [
        {
          name: 'OpenAI',
          settings_json: JSON.stringify({
            env: {
              ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.4',
            },
          }),
        },
      ],
    })

    expect(options.find(option => option.value === 'opus')?.label).toBe(
      'Opus (gpt-5.4)'
    )
    expect(options.some(option => option.backend === 'codex')).toBe(true)
  })
})

describe('getModelOptionLabel', () => {
  it('returns a readable label for known models', () => {
    expect(getModelOptionLabel('gpt-5.4')).toBe('GPT 5.4')
  })
})
