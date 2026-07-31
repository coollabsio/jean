import { describe, expect, it } from 'vitest'
import {
  EFFORT_LEVEL_OPTIONS,
  PI_EFFORT_LEVEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  withAdaptiveEffortOption,
} from './toolbar-options'

describe('PI_EFFORT_LEVEL_OPTIONS', () => {
  it('exposes every PI CLI thinking level in CLI order', () => {
    expect(PI_EFFORT_LEVEL_OPTIONS.map(option => option.value)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })
})

describe('Adaptive/Default thinking/effort option (Gemini only)', () => {
  it('does not include Adaptive/Default in default non-Gemini option lists', () => {
    expect(EFFORT_LEVEL_OPTIONS.map(option => option.value)).not.toContain(
      'adaptive'
    )
    expect(THINKING_LEVEL_OPTIONS.map(option => option.value)).not.toContain(
      'adaptive'
    )
  })

  it('prepends Adaptive/Default only for Gemini models', () => {
    const base = [
      { value: 'medium', label: 'Medium', description: 'Balanced' },
      { value: 'high', label: 'High', description: 'Deep' },
    ]
    expect(
      withAdaptiveEffortOption(base, 'claude-opus-4-8').map(level => level.value)
    ).toEqual(['medium', 'high'])
    const geminiLevels = withAdaptiveEffortOption(
      base,
      'commandcode/google/gemini-3.5-flash'
    )
    expect(geminiLevels.map(level => level.value)).toEqual([
      'adaptive',
      'medium',
      'high',
    ])
    expect(geminiLevels[0]?.label).toBe('Adaptive/Default')
  })

  it('does not duplicate Adaptive/Default when already present for Gemini', () => {
    const levels = withAdaptiveEffortOption(
      [
        {
          value: 'adaptive',
          label: 'Adaptive/Default',
          description: 'Model default (no forced level)',
        },
        { value: 'high', label: 'High', description: 'Deep' },
      ],
      'opencode/google/gemini-3.5-flash'
    )
    expect(levels.map(level => level.value)).toEqual(['adaptive', 'high'])
  })
})
