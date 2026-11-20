import { describe, expect, it } from 'vitest'
import {
  MAX_PROMPT_MODELS,
  buildPromptModelGroups,
  togglePromptModel,
} from './multi-model-prompt'

const sections = [
  {
    backend: 'claude' as const,
    label: 'Claude',
    options: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
    ],
  },
  {
    backend: 'pi' as const,
    label: 'PI',
    options: [
      { value: 'pi/sonnet:high', label: 'Sonnet High' },
      { value: 'pi/opus', label: 'Opus' },
    ],
  },
]

describe('buildPromptModelGroups', () => {
  it('lists favorites first and leaves them out of their backend group', () => {
    const groups = buildPromptModelGroups(sections, [
      'pi:pi/sonnet:high',
      'claude:missing',
      'claude:opus',
    ])
    expect(
      groups.map(group => [group.label, group.rows.map(row => row.key)])
    ).toEqual([
      ['Favorites', ['pi:pi/sonnet:high', 'claude:opus']],
      ['Claude', ['claude:sonnet']],
      ['PI', ['pi:pi/opus']],
    ])
    expect(groups[0]?.rows[0]).toMatchObject({
      backend: 'pi',
      model: 'pi/sonnet:high',
    })
  })

  it('omits the favorites group when no favorite is available', () => {
    expect(buildPromptModelGroups(sections, []).map(g => g.id)).toEqual([
      'claude',
      'pi',
    ])
  })
})

describe('togglePromptModel', () => {
  it('adds and removes a model', () => {
    expect(togglePromptModel(['a'], 'b')).toEqual(['a', 'b'])
    expect(togglePromptModel(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('stops adding at the limit but still allows removal', () => {
    const full = Array.from({ length: MAX_PROMPT_MODELS }, (_, i) => `m${i}`)
    expect(togglePromptModel(full, 'extra')).toEqual(full)
    expect(togglePromptModel(full, 'm0')).toHaveLength(MAX_PROMPT_MODELS - 1)
  })
})
