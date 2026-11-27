import { describe, expect, it } from 'vitest'
import { THEME_COLOUR_TOKENS, parseCustomTheme } from './custom-themes'
import { THEME_PRESETS } from './theme-presets'

describe('THEME_PRESETS', () => {
  it.each(THEME_PRESETS)('$name validates and sets every token', preset => {
    const theme = parseCustomTheme(preset, 'id')
    for (const colours of [theme.light, theme.dark]) {
      if (colours)
        expect(Object.keys(colours)).toEqual([...THEME_COLOUR_TOKENS])
    }
  })

  it('has unique names', () => {
    const names = THEME_PRESETS.map(p => p.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
