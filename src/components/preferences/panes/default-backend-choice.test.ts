import { describe, expect, it } from 'vitest'
import type { AppPreferences } from '@/types/preferences'
import {
  currentDefaultBackendChoice,
  defaultBackendChoices,
  patchForDefaultBackendChoice,
} from './default-backend-choice'

const preferences = {
  custom_cli_profiles: [{ name: 'CLIProxyAPI', settings_json: '{}' }],
  custom_codex_providers: [
    {
      name: 'CLIProxyAPI',
      provider_id: 'cliproxyapi',
      base_url: 'http://127.0.0.1:8317/v1',
      env_key: 'CLIPROXYAPI_API_KEY',
    },
  ],
  default_provider: 'CLIProxyAPI',
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
      'claude::CLIProxyAPI',
      'codex',
      'codex::CLIProxyAPI',
      'grok',
    ])
  })

  it('selects the stored provider only when it still exists', () => {
    expect(currentDefaultBackendChoice('claude', preferences)).toBe(
      'claude::CLIProxyAPI'
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
    const [, claudeProxy, codex] = defaultBackendChoices(
      ['claude', 'codex'],
      preferences
    )
    expect(patchForDefaultBackendChoice(claudeProxy!)).toEqual({
      default_backend: 'claude',
      default_provider: 'CLIProxyAPI',
    })
    expect(patchForDefaultBackendChoice(codex!)).toEqual({
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
