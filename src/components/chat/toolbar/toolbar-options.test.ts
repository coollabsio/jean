import { describe, expect, it } from 'vitest'
import {
  EFFORT_LEVEL_OPTIONS,
  PI_EFFORT_LEVEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  withAdaptiveEffortOption,
} from './toolbar-options'

describe('PI_EFFORT_LEVEL_OPTIONS', () => {
  it('exposes Adaptive/Default plus every PI CLI thinking level in CLI order', () => {
    expect(PI_EFFORT_LEVEL_OPTIONS.map(option => option.value)).toEqual([
      'adaptive',
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })
})

describe('Adaptive/Default thinking/effort option', () => {
  it('includes Adaptive/Default in default effort and thinking dropdowns', () => {
    expect(EFFORT_LEVEL_OPTIONS.map(option => option.value)).toContain(
      'adaptive'
    )
    expect(THINKING_LEVEL_OPTIONS.map(option => option.value)).toContain(
      'adaptive'
    )
    expect(
      EFFORT_LEVEL_OPTIONS.find(option => option.value === 'adaptive')?.label
    ).toBe('Adaptive/Default')
    expect(
      THINKING_LEVEL_OPTIONS.find(option => option.value === 'adaptive')?.label
    ).toBe('Adaptive/Default')
  })

  it('prepends Adaptive/Default when catalog levels omit it', () => {
    const levels = withAdaptiveEffortOption([
      { value: 'medium', label: 'Medium', description: 'Balanced' },
      { value: 'high', label: 'High', description: 'Deep' },
    ])
    expect(levels.map(level => level.value)).toEqual([
      'adaptive',
      'medium',
      'high',
    ])
    expect(levels[0]?.label).toBe('Adaptive/Default')
  })

  it('does not duplicate Adaptive/Default when already present', () => {
    const levels = withAdaptiveEffortOption([
      {
        value: 'adaptive',
        label: 'Adaptive/Default',
        description: 'Model default (no forced level)',
      },
      { value: 'high', label: 'High', description: 'Deep' },
    ])
    expect(levels.map(level => level.value)).toEqual(['adaptive', 'high'])
  })
})
