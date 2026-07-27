import { describe, expect, it } from 'vitest'
import { DEVIN_MODEL_OPTIONS, PI_EFFORT_LEVEL_OPTIONS } from './toolbar-options'

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

describe('DEVIN_MODEL_OPTIONS', () => {
  it('exposes the Devin configured default model', () => {
    expect(DEVIN_MODEL_OPTIONS).toEqual([
      { value: 'devin/default', label: 'Configured default' },
    ])
  })
})
