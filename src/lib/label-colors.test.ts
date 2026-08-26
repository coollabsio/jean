import { describe, expect, it } from 'vitest'
import { getLabelTextColor, LABEL_CONTRAST_LIGHT_COLORS } from './label-colors'

describe('getLabelTextColor', () => {
  it('uses black text on light backgrounds', () => {
    for (const color of LABEL_CONTRAST_LIGHT_COLORS) {
      expect(getLabelTextColor(color)).toBe('black')
    }
  })

  it('uses white text on dark/unknown backgrounds', () => {
    expect(getLabelTextColor('#ef4444')).toBe('white') // Red
    expect(getLabelTextColor('#8b5cf6')).toBe('white') // Purple
    expect(getLabelTextColor('#000000')).toBe('white')
    expect(getLabelTextColor('#123abc')).toBe('white')
  })
})
