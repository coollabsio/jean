import { describe, expect, it } from 'vitest'
import {
  applyThemeColours,
  normalizeCustomThemes,
  parseCustomTheme,
} from './custom-themes'

describe('custom-themes', () => {
  it('parses a theme file and accepts tokens with or without --', () => {
    const theme = parseCustomTheme(
      {
        name: ' Dracula ',
        author: 'ignored',
        dark: { background: '#282a36', '--primary': ' oklch(0.7 0.15 300) ' },
      },
      'id-1'
    )

    expect(theme).toEqual({
      id: 'id-1',
      name: 'Dracula',
      dark: { background: '#282a36', primary: 'oklch(0.7 0.15 300)' },
    })
  })

  it.each([
    [[], 'A theme must be a JSON object'],
    [{ dark: { background: '#000' } }, 'A theme needs a "name"'],
    [{ name: 'x' }, 'A theme needs "light" or "dark" colours'],
    [{ name: 'x', dark: [] }, '"dark" must be an object of colour tokens'],
    [{ name: 'x', dark: { radius: '#000' } }, 'Unknown colour token "radius"'],
    [{ name: 'x', light: { background: 'red' } }, '"background" in "light"'],
    [{ name: 'x', dark: { background: 'url(https://x)' } }, 'not a colour'],
    [{ name: 'x', dark: { background: 'rgb(0 0 0); color: red' } }, 'not'],
    [{ name: 'x', dark: { background: 'var(--card)' } }, 'not a colour'],
  ])('rejects %j', (input, message) => {
    expect(() => parseCustomTheme(input)).toThrow(message)
  })

  it('keeps only stored themes that still validate', () => {
    const valid = { id: 'a', name: 'A', dark: { background: '#101010' } }

    expect(
      normalizeCustomThemes([
        valid,
        { name: 'no id', dark: { background: '#000' } },
        { id: 'b', name: 'B', dark: { background: 'url(x)' } },
        null,
      ])
    ).toEqual([valid])
    expect(normalizeCustomThemes('nope')).toEqual([])
  })

  it('sets theme tokens and clears them without touching other properties', () => {
    const { style } = document.createElement('div')
    style.setProperty('--ui-font-size', '14px')

    applyThemeColours(style, { background: '#17191b', primary: '#b3a6bc' })
    expect(style.getPropertyValue('--background')).toBe('#17191b')
    expect(style.getPropertyValue('--primary')).toBe('#b3a6bc')

    applyThemeColours(style, { background: '#ffffff' })
    expect(style.getPropertyValue('--background')).toBe('#ffffff')
    expect(style.getPropertyValue('--primary')).toBe('')

    applyThemeColours(style)
    expect(style.getPropertyValue('--background')).toBe('')
    expect(style.getPropertyValue('--ui-font-size')).toBe('14px')
  })
})
