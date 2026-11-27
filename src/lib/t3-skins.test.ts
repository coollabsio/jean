import { describe, expect, it } from 'vitest'
import { parseCustomTheme } from './custom-themes'
import { convertT3Skin, isT3Skin } from './t3-skins'
import { importThemeFiles } from './vscode-themes'

// Shape of a dual-mode skin from https://www.t3skins.dev/ (values made up).
const skin = {
  version: 1,
  name: 'Harbor',
  appearance: 'light',
  canvas: '#fcfcfc',
  accent: '#1b4ed8',
  colors: {
    canvas: '#fcfcfc',
    text: '#27272a',
    surface: '#ffffff',
    surfaceOverlay: '#fefefe',
    accent: '#1B4ED8',
    accentForeground: '#ffffff',
    accentSurface: '#f4f4f5',
    focus: '#1b4ed8',
    sidebar: '#fafafa',
    sidebarRowSelected: '#eeeeee',
    sidebarBorder: '#e4e4e7',
    border: '#e4e4e7',
    error: '#fb2c36',
    terminalCursor: '#26384e',
  },
  variants: {
    dark: {
      canvas: '#161a2e',
      messageForeground: '#ece7dd',
      accent: '#8a97f0',
      sidebarRowActive: '#232945',
    },
  },
  css: '.app { background: url(data:image/png;base64,AAAA) }',
}

describe('isT3Skin', () => {
  it('needs version, appearance and colors', () => {
    expect(isT3Skin(skin)).toBe(true)
    expect(isT3Skin({ ...skin, version: undefined })).toBe(false)
    expect(isT3Skin({ ...skin, appearance: 'dim' })).toBe(false)
    // A VS Code theme has `colors` and `type`, no `appearance`.
    expect(isT3Skin({ type: 'dark', colors: {} })).toBe(false)
  })
})

describe('convertT3Skin', () => {
  it('maps colors to the appearance mode and variants to the other mode', () => {
    const theme = convertT3Skin(
      skin as Parameters<typeof convertT3Skin>[0],
      'f'
    )
    expect(theme).toEqual({
      name: 'Harbor',
      light: {
        background: '#fcfcfc',
        foreground: '#27272a',
        card: '#ffffff',
        'card-foreground': '#27272a',
        popover: '#fefefe',
        'popover-foreground': '#27272a',
        primary: '#1b4ed8',
        'primary-foreground': '#ffffff',
        accent: '#f4f4f5',
        'accent-foreground': '#27272a',
        destructive: '#fb2c36',
        border: '#e4e4e7',
        ring: '#1b4ed8',
        sidebar: '#fafafa',
        'sidebar-foreground': '#27272a',
        'sidebar-primary': '#1b4ed8',
        'sidebar-primary-foreground': '#ffffff',
        'sidebar-accent': '#eeeeee',
        'sidebar-accent-foreground': '#27272a',
        'sidebar-border': '#e4e4e7',
        'sidebar-ring': '#1b4ed8',
        'toast-background': '#fefefe',
        'toast-border': '#e4e4e7',
      },
      dark: {
        background: '#161a2e',
        foreground: '#ece7dd',
        'card-foreground': '#ece7dd',
        'popover-foreground': '#ece7dd',
        primary: '#8a97f0',
        'sidebar-primary': '#8a97f0',
        'sidebar-accent': '#232945',
      },
    })
  })

  it('skips non-hex values and uses the file name without a name', () => {
    const theme = convertT3Skin(
      {
        appearance: 'dark',
        colors: { canvas: 'url(x)', surface: '#000', text: 'var(--x)' },
      },
      'nyx'
    )
    expect(theme).toEqual({
      name: 'nyx',
      dark: { card: '#000', popover: '#000' },
    })
  })

  it('rejects a skin with no colour it can convert', () => {
    expect(() =>
      convertT3Skin({ appearance: 'dark', colors: { canvas: 'red' } }, 'x')
    ).toThrow('No T3 Code skin colours could be converted')
  })
})

describe('importThemeFiles with T3 Code skins', () => {
  it('imports a skin as one Jean theme and drops its css', () => {
    const { themes, errors } = importThemeFiles([
      { fileName: 'skin.json', text: JSON.stringify(skin) },
    ])
    expect(errors).toEqual([])
    expect(themes).toHaveLength(1)
    const [theme] = themes
    expect(theme?.name).toBe('Harbor')
    expect(theme?.light?.background).toBe('#fcfcfc')
    expect(theme?.dark?.background).toBe('#161a2e')
    expect(JSON.stringify(theme)).not.toContain('url(')
    expect(parseCustomTheme(theme, theme?.id)).toEqual(theme)
  })
})
