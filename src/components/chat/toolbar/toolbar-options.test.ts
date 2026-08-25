import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_EFFORT_LEVEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
  PI_EFFORT_LEVEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  withAdaptiveEffortOption,
} from './toolbar-options'

describe('ANTIGRAVITY_EFFORT_LEVEL_OPTIONS', () => {
  it('matches the agy --effort contract', () => {
    expect(ANTIGRAVITY_EFFORT_LEVEL_OPTIONS.map(option => option.value)).toEqual([
      'adaptive',
      'low',
      'medium',
      'high',
    ])
  })
})

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

describe('Adaptive/Default thinking/effort option (Antigravity only)', () => {
  it('does not include Adaptive/Default in default non-Antigravity option lists', () => {
    expect(EFFORT_LEVEL_OPTIONS.map(option => option.value)).not.toContain(
      'adaptive'
    )
    expect(THINKING_LEVEL_OPTIONS.map(option => option.value)).not.toContain(
      'adaptive'
    )
  })

  it('prepends Adaptive/Default only for Antigravity models', () => {
    const base = [
      { value: 'medium', label: 'Medium', description: 'Balanced' },
      { value: 'high', label: 'High', description: 'Deep' },
    ]
    expect(
      withAdaptiveEffortOption(base, 'claude-opus-4-8').map(level => level.value)
    ).toEqual(['medium', 'high'])
    const antigravityLevels = withAdaptiveEffortOption(
      base,
      'commandcode/google/gemini-3.5-flash'
    )
    expect(antigravityLevels.map(level => level.value)).toEqual([
      'adaptive',
      'medium',
      'high',
    ])
    expect(antigravityLevels[0]?.label).toBe('Adaptive/Default')
  })

  it('does not duplicate Adaptive/Default when already present for Antigravity', () => {
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
