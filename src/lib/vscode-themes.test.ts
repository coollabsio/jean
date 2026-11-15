import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCustomTheme } from './custom-themes'
import {
  convertVsCodeTheme,
  importThemeFiles,
  parseJsonc,
} from './vscode-themes'

// Unmodified files from microsoft/vscode (MIT), see __fixtures__/README.md.
const fixture = (fileName: string) => ({
  fileName,
  text: readFileSync(`src/lib/__fixtures__/${fileName}`, 'utf8'),
})
const solarizedDark = fixture('solarized-dark-color-theme.json')
const solarizedLight = fixture('solarized-light-color-theme.json')

describe('parseJsonc', () => {
  it('removes comments and trailing commas outside strings', () => {
    const text = `{
      // line comment
      "url": "https://x.dev/a//b", /* block */
      "s": "a, }",
      "list": [1, 2,],
    }`
    expect(parseJsonc(text)).toEqual({
      url: 'https://x.dev/a//b',
      s: 'a, }',
      list: [1, 2],
    })
  })

  it('still rejects broken JSON', () => {
    expect(() => parseJsonc('{ "a": /* open')).toThrow()
  })
})

describe('convertVsCodeTheme', () => {
  it('maps workbench colours to Jean tokens, first key wins', () => {
    const { colours } = convertVsCodeTheme(
      {
        type: 'dark',
        colors: {
          'editor.background': '#101010',
          foreground: '#eeeeee',
          'editor.foreground': '#dddddd',
          'button.background': '#336699',
          focusBorder: '#ff0000',
          'sideBar.background': '#202020',
          'terminal.ansiBlue': '#0000ff',
          'unknown.key': '#123456',
        },
      },
      'x'
    )
    expect(colours).toEqual({
      background: '#101010',
      foreground: '#dddddd',
      'card-foreground': '#dddddd',
      'popover-foreground': '#dddddd',
      'accent-foreground': '#dddddd',
      'sidebar-foreground': '#dddddd',
      'sidebar-accent-foreground': '#dddddd',
      primary: '#336699',
      'sidebar-primary': '#336699',
      ring: '#ff0000',
      'sidebar-ring': '#ff0000',
      card: '#202020',
      sidebar: '#202020',
      info: '#0000ff',
      'chart-1': '#0000ff',
    })
  })

  it('flattens alpha onto the background and skips non-hex values', () => {
    const { colours } = convertVsCodeTheme(
      {
        type: 'dark',
        colors: {
          'editor.background': '#000000',
          'list.hoverBackground': '#ffffff80',
          focusBorder: '#f008',
          'button.background': 'red',
          'panel.border': 42,
        },
      },
      'x'
    )
    expect(colours).toEqual({
      background: '#000000',
      accent: '#808080',
      'sidebar-accent': '#808080',
      ring: '#880000',
      'sidebar-ring': '#880000',
    })
  })

  it.each([
    [{ type: 'light' }, '#000000', 'light'],
    [{ type: 'hcLight' }, '#000000', 'light'],
    [{ type: 'hc' }, '#ffffff', 'dark'],
    [{}, '#fdf6e3', 'light'],
    [{}, '#002b36', 'dark'],
  ])('detects %j with background %s as %s', (extra, background, mode) => {
    const theme = { ...extra, colors: { 'editor.background': background } }
    expect(convertVsCodeTheme(theme, 'x').mode).toBe(mode)
  })

  it('rejects a theme with no colour it can convert', () => {
    expect(() =>
      convertVsCodeTheme({ colors: { 'editor.background': 'red' } }, 'x')
    ).toThrow('No VS Code colours could be converted')
  })
})

describe('importThemeFiles', () => {
  it('converts the unmodified Solarized Dark file (JSONC, no type)', () => {
    const { themes, errors } = importThemeFiles([solarizedDark])
    expect(errors).toEqual([])
    expect(themes).toHaveLength(1)
    const [theme] = themes
    expect(theme?.name).toBe('Solarized (dark)')
    expect(theme?.light).toBeUndefined()
    expect(theme?.dark).toMatchObject({
      background: '#002b36',
      foreground: '#839496',
      sidebar: '#00212b',
      input: '#003847',
      border: '#2b2b4a',
      // #2AA19899 over #002B36
      ring: '#197271',
      primary: '#197271',
      // #004454AA over #002B36
      accent: '#003c4a',
    })
    for (const colour of Object.values(theme?.dark ?? {})) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(parseCustomTheme(theme, theme?.id)).toEqual(theme)
  })

  it('pairs a light and a dark file of the same family into one theme', () => {
    const { themes, errors } = importThemeFiles([solarizedDark, solarizedLight])
    expect(errors).toEqual([])
    expect(themes).toHaveLength(1)
    const [theme] = themes
    expect(theme?.name).toBe('Solarized')
    expect(theme?.dark?.background).toBe('#002b36')
    expect(theme?.light?.background).toBe('#fdf6e3')
    expect(parseCustomTheme(theme, theme?.id)).toEqual(theme)
  })

  it('keeps unrelated or same-mode files as separate themes', () => {
    const other = {
      fileName: 'night-owl.json',
      text: JSON.stringify({ colors: { 'editor.background': '#011627' } }),
    }
    const { themes } = importThemeFiles([solarizedDark, other])
    expect(themes.map(t => t.name).sort()).toEqual([
      'Solarized (dark)',
      'night-owl',
    ])
  })

  it('keeps Jean files strict JSON and reports each failing file', () => {
    const { themes, errors } = importThemeFiles([
      {
        fileName: 'jean.json',
        text: '{ "name": "J", "dark": { "ring": "#fff" } }',
      },
      { fileName: 'jsonc.json', text: '{ "name": "J", "dark": {}, }' },
      {
        fileName: 'bad.json',
        text: '{ "name": "J", "dark": { "radius": "#000" } }',
      },
    ])
    expect(themes.map(t => t.name)).toEqual(['J'])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/^jsonc\.json: /)
    expect(errors[1]).toBe('bad.json: Unknown colour token "radius" in "dark"')
  })
})
