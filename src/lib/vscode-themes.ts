import {
  parseCustomTheme,
  type CustomTheme,
  type ThemeColourToken,
  type ThemeColours,
} from './custom-themes'

type Mode = 'light' | 'dark'

/**
 * Jean token → VS Code workbench colour keys. The first key the theme sets
 * wins. Tokens left out (e.g. `warning-foreground`) keep Jean's built-in value.
 */
const VSCODE_COLOUR_MAP: Partial<Record<ThemeColourToken, readonly string[]>> =
  {
    background: ['editor.background'],
    foreground: ['editor.foreground', 'foreground'],
    card: ['editorWidget.background', 'sideBar.background'],
    'card-foreground': [
      'editorWidget.foreground',
      'editor.foreground',
      'foreground',
    ],
    popover: [
      'quickInput.background',
      'editorWidget.background',
      'dropdown.background',
    ],
    'popover-foreground': [
      'quickInput.foreground',
      'editorWidget.foreground',
      'editor.foreground',
      'foreground',
    ],
    primary: ['button.background'],
    'primary-foreground': ['button.foreground'],
    secondary: ['button.secondaryBackground'],
    'secondary-foreground': ['button.secondaryForeground'],
    muted: ['tab.inactiveBackground', 'editorGroupHeader.tabsBackground'],
    'muted-foreground': [
      'descriptionForeground',
      'tab.inactiveForeground',
      'editorLineNumber.foreground',
    ],
    accent: ['list.hoverBackground', 'list.inactiveSelectionBackground'],
    'accent-foreground': [
      'list.hoverForeground',
      'editor.foreground',
      'foreground',
    ],
    destructive: ['editorError.foreground', 'errorForeground'],
    warning: ['editorWarning.foreground', 'terminal.ansiYellow'],
    success: ['terminal.ansiGreen', 'gitDecoration.addedResourceForeground'],
    info: ['editorInfo.foreground', 'terminal.ansiBlue'],
    border: [
      'panel.border',
      'contrastBorder',
      'editorGroup.border',
      'sideBar.border',
    ],
    input: ['input.background', 'input.border'],
    ring: ['focusBorder'],
    'chart-1': ['terminal.ansiBlue'],
    'chart-2': ['terminal.ansiGreen'],
    'chart-3': ['terminal.ansiYellow'],
    'chart-4': ['terminal.ansiMagenta'],
    'chart-5': ['terminal.ansiCyan'],
    sidebar: ['sideBar.background'],
    'sidebar-foreground': [
      'sideBar.foreground',
      'editor.foreground',
      'foreground',
    ],
    'sidebar-primary': ['activityBarBadge.background', 'button.background'],
    'sidebar-primary-foreground': [
      'activityBarBadge.foreground',
      'button.foreground',
    ],
    'sidebar-accent': [
      'list.activeSelectionBackground',
      'list.hoverBackground',
    ],
    'sidebar-accent-foreground': [
      'list.activeSelectionForeground',
      'sideBar.foreground',
      'editor.foreground',
      'foreground',
    ],
    'sidebar-border': ['sideBar.border', 'panel.border', 'contrastBorder'],
    'sidebar-ring': ['focusBorder'],
    'toast-background': ['notifications.background', 'editorWidget.background'],
    'toast-border': [
      'notifications.border',
      'editorWidget.border',
      'panel.border',
    ],
  }

// VS Code's own editor backgrounds, used when a theme does not set one.
const DEFAULT_BACKGROUND: Record<Mode, Rgb> = {
  dark: [0x1e, 0x1e, 0x1e],
  light: [0xff, 0xff, 0xff],
}

type Rgb = [number, number, number]

/** Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. Alpha is 0–1. */
function parseHex(value: unknown): { rgb: Rgb; alpha: number } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim())
  if (!match?.[1]) return undefined
  let hex = match[1]
  if (hex.length <= 4) hex = [...hex].map(c => c + c).join('')
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16)
  return { rgb: [n(0), n(2), n(4)], alpha: hex.length === 8 ? n(6) / 255 : 1 }
}

/** Blend a colour onto an opaque base and return `#rrggbb`. */
function flatten({ rgb, alpha }: { rgb: Rgb; alpha: number }, base: Rgb) {
  return (
    '#' +
    rgb
      .map((c, i) => Math.round(c * alpha + (base[i] ?? 0) * (1 - alpha)))
      .map(c => c.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(rgb: Rgb): number {
  const [r = 0, g = 0, b = 0] = rgb.map(c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** A VS Code colour theme file has a `colors` object. */
export function isVsCodeTheme(value: unknown): value is {
  name?: unknown
  type?: unknown
  colors: Record<string, unknown>
} {
  const colors = (value as { colors?: unknown } | null)?.colors
  return !!colors && typeof colors === 'object' && !Array.isArray(colors)
}

export interface ConvertedVsCodeTheme {
  name: string
  mode: Mode
  colours: ThemeColours
}

/**
 * Convert a VS Code colour theme. `type` picks light or dark; without it the
 * editor background's luminance decides. Colours with alpha are flattened onto
 * the background. Values that are not hex colours are skipped.
 */
export function convertVsCodeTheme(
  theme: { name?: unknown; type?: unknown; colors: Record<string, unknown> },
  fallbackName: string
): ConvertedVsCodeTheme {
  const { colors } = theme
  const background = parseHex(colors['editor.background'])
  const mode: Mode =
    typeof theme.type === 'string' && theme.type
      ? /light/i.test(theme.type)
        ? 'light'
        : 'dark'
      : background && luminance(background.rgb) > 0.179
        ? 'light'
        : 'dark'
  const base = background
    ? flatten(background, DEFAULT_BACKGROUND[mode])
    : undefined
  const baseRgb = parseHex(base)?.rgb ?? DEFAULT_BACKGROUND[mode]

  const colours: ThemeColours = {}
  for (const [token, keys] of Object.entries(VSCODE_COLOUR_MAP)) {
    for (const key of keys) {
      const colour = parseHex(colors[key])
      if (colour) {
        colours[token as ThemeColourToken] = flatten(colour, baseRgb)
        break
      }
    }
  }

  if (Object.keys(colours).length === 0) {
    throw new Error('No VS Code colours could be converted')
  }
  const name = typeof theme.name === 'string' ? theme.name.trim() : ''
  return { name: name || fallbackName, mode, colours }
}

/**
 * Parse JSON with comments and trailing commas (JSONC, as VS Code writes).
 * Comments and trailing commas outside strings are removed, then the result
 * goes through the strict `JSON.parse`.
 */
export function parseJsonc(text: string): unknown {
  const STRING = '"(?:[^"\\\\]|\\\\.)*"'
  const withoutComments = text.replace(
    new RegExp(`(${STRING})|//[^\\n]*|/\\*[\\s\\S]*?\\*/`, 'g'),
    (_, str: string | undefined) => str ?? ' '
  )
  return JSON.parse(
    withoutComments.replace(
      new RegExp(`(${STRING})|,(?=\\s*[}\\]])`, 'g'),
      (_, str: string | undefined) => str ?? ''
    )
  )
}

/** Strict JSON first; JSONC only when the file is a VS Code theme. */
function parseThemeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    let jsonc: unknown
    try {
      jsonc = parseJsonc(text)
    } catch {
      throw error
    }
    if (!isVsCodeTheme(jsonc)) throw error
    return jsonc
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** "Solarized (dark)" → "Solarized"; used to pair light and dark files. */
function familyName(name: string): string {
  const family = name
    .replace(/\b(light|dark)\b/gi, '')
    .replace(/[()[\]]/g, '')
    .replace(/^[\s\-_:]+|[\s\-_:]+$/g, '')
    .replace(/\s+/g, ' ')
  return family || name
}

export interface ThemeFile {
  fileName: string
  text: string
}

/**
 * Turn imported files into Jean themes. Jean theme files must be strict JSON;
 * VS Code colour themes may be JSONC and are converted. A light and a dark VS
 * Code theme from the same family become one theme. Each file that fails adds
 * one message to `errors` and does not stop the others.
 */
export function importThemeFiles(files: ThemeFile[]): {
  themes: CustomTheme[]
  errors: string[]
} {
  const themes: CustomTheme[] = []
  const errors: string[] = []
  const converted: ConvertedVsCodeTheme[] = []

  for (const { fileName, text } of files) {
    try {
      const input = parseThemeJson(text)
      if (isVsCodeTheme(input)) {
        converted.push(
          convertVsCodeTheme(
            input,
            fileName.replace(/(-color-theme)?\.jsonc?$/i, '')
          )
        )
      } else {
        themes.push(parseCustomTheme(input))
      }
    } catch (error) {
      errors.push(`${fileName}: ${message(error)}`)
    }
  }

  const families = new Map<string, ConvertedVsCodeTheme[]>()
  for (const theme of converted) {
    const key = familyName(theme.name).toLowerCase()
    families.set(key, [...(families.get(key) ?? []), theme])
  }
  for (const group of families.values()) {
    const light = group.filter(t => t.mode === 'light')
    const dark = group.filter(t => t.mode === 'dark')
    const pair =
      light.length === 1 && dark.length === 1
        ? [
            {
              name: familyName(group[0]?.name ?? ''),
              light: light[0]?.colours,
              dark: dark[0]?.colours,
            },
          ]
        : group.map(t => ({ name: t.name, [t.mode]: t.colours }))
    for (const input of pair) {
      try {
        themes.push(parseCustomTheme(input))
      } catch (error) {
        errors.push(`${input.name}: ${message(error)}`)
      }
    }
  }

  return { themes, errors }
}
