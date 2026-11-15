import { describe, expect, it } from 'vitest'
import type { AppPreferences } from '@/types/preferences'
import {
  currentDefaultBackendChoice,
  defaultBackendChoices,
  patchForDefaultBackendChoice,
} from './default-backend-choice'

const preferences = {
  custom_cli_profiles: [{ name: 'OpenRouter', settings_json: '{}' }],
  custom_codex_providers: [
    {
      name: 'OpenRouter',
      provider_id: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      env_key: 'OPENROUTER_API_KEY',
    },
  ],
  default_provider: 'OpenRouter',
  default_codex_provider: null,
} as unknown as AppPreferences

describe('default backend choices', () => {
  it('lists each backend followed by its providers', () => {
    expect(
      defaultBackendChoices(['claude', 'codex', 'grok'], preferences).map(
        choice => choice.value
      )
    ).toEqual([
      'claude',
      'claude::OpenRouter',
      'codex',
      'codex::OpenRouter',
      'grok',
    ])
  })

  it('selects the stored provider only when it still exists', () => {
    expect(currentDefaultBackendChoice('claude', preferences)).toBe(
      'claude::OpenRouter'
    )
    expect(currentDefaultBackendChoice('codex', preferences)).toBe('codex')
    expect(
      currentDefaultBackendChoice('claude', {
        ...preferences,
        default_provider: 'Deleted',
      })
    ).toBe('claude')
  })

  it('sets the backend and its provider together', () => {
    const [, claudeProvider, codex] = defaultBackendChoices(
      ['claude', 'codex'],
      preferences
    )
    if (!claudeProvider || !codex) throw new Error('missing backend choices')
    expect(patchForDefaultBackendChoice(claudeProvider)).toEqual({
      default_backend: 'claude',
      default_provider: 'OpenRouter',
    })
    expect(patchForDefaultBackendChoice(codex)).toEqual({
      default_backend: 'codex',
      default_codex_provider: null,
    })
    expect(
      patchForDefaultBackendChoice({
        value: 'grok',
        backend: 'grok',
        provider: null,
      })
    ).toEqual({ default_backend: 'grok' })
  })
})
