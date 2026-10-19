import { describe, expect, it } from 'vitest'
import type { ModelCatalog } from '@/services/model-catalog'
import { effortLevelOptions, type CustomCliProfile } from '@/types/preferences'
import { getMagicPromptModelReasoning } from './magic-prompt-reasoning'

const customProfile: CustomCliProfile = {
  name: 'OpenRouter',
  settings_json: '{}',
}

const catalogWith = (model: string, reasoning: unknown): ModelCatalog =>
  ({
    version: 1,
    updated_at: 'test',
    defaults: {},
    backends: {
      claude: { models: [{ id: model, label: model, reasoning }] },
    },
  }) as unknown as ModelCatalog

describe('getMagicPromptModelReasoning', () => {
  it('offers Claude effort levels for a custom profile model missing from the catalog', () => {
    const reasoning = getMagicPromptModelReasoning(
      null,
      'claude',
      'glm-4.6',
      customProfile.name,
      [customProfile]
    )

    expect(reasoning?.type).toBe('effort')
    expect(reasoning?.default).toBe('high')
    expect(reasoning?.levels).toBe(effortLevelOptions)
    expect(reasoning?.levels.map(level => level.value)).not.toContain(
      'ultrathink'
    )
    expect(reasoning?.levels.map(level => level.value)).not.toContain('think')
  })

  it('offers Claude effort levels for a provider alias the catalog does not describe', () => {
    const reasoning = getMagicPromptModelReasoning(
      null,
      'claude',
      'opus',
      customProfile.name,
      [customProfile]
    )

    expect(reasoning?.type).toBe('effort')
    expect(reasoning?.levels).toBe(effortLevelOptions)
  })

  it('offers Claude effort levels when the model is missing and no profile is selected', () => {
    expect(
      getMagicPromptModelReasoning(null, 'claude', 'glm-4.6', null, [])?.levels
    ).toBe(effortLevelOptions)
  })

  it('keeps catalog reasoning for a known Claude model on a custom profile', () => {
    const reasoning = getMagicPromptModelReasoning(
      null,
      'claude',
      'claude-opus-5-5',
      customProfile.name,
      [customProfile]
    )

    expect(reasoning?.type).toBe('effort')
    expect(reasoning?.levels).not.toBe(effortLevelOptions)
    expect(reasoning?.levels.map(level => level.value)).toContain('ultracode')
  })

  it('keeps catalog thinking levels for older Claude models', () => {
    const reasoning = getMagicPromptModelReasoning(
      null,
      'claude',
      'claude-haiku-4-5',
      customProfile.name,
      [customProfile]
    )

    expect(reasoning?.type).toBe('thinking')
    expect(reasoning?.default).toBe('ultrathink')
  })

  it('hides the control when the catalog marks a Claude model as reasoning-less', () => {
    const catalog = catalogWith('claude-no-reasoning', null)
    expect(
      getMagicPromptModelReasoning(
        catalog,
        'claude',
        'claude-no-reasoning',
        customProfile.name,
        [customProfile]
      )
    ).toBeNull()
  })

  it('keeps the effort fallback for non-Claude backends', () => {
    expect(
      getMagicPromptModelReasoning(null, 'pi', 'custom/model', null, [])?.type
    ).toBe('effort')
    expect(
      getMagicPromptModelReasoning(null, 'cursor', 'custom', null, [])
    ).toBeUndefined()
  })
})
