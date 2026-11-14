import { generateId } from './uuid'

/** Colour tokens from `src/App.css` that a custom theme may override. */
export const THEME_COLOUR_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'warning',
  'warning-foreground',
  'success',
  'success-foreground',
  'info',
  'info-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'toast-background',
  'toast-border',
] as const

export type ThemeColourToken = (typeof THEME_COLOUR_TOKENS)[number]
export type ThemeColours = Partial<Record<ThemeColourToken, string>>

export interface CustomTheme {
  id: string
  name: string
  light?: ThemeColours
  dark?: ThemeColours
}

const TOKENS = new Set<string>(THEME_COLOUR_TOKENS)

// Hex or one un-nested colour function: rules out url(), var() and anything
// that could end the declaration early.
const COLOUR =
  /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^();{}]*\))$/i

function parseColours(
  value: unknown,
  mode: 'light' | 'dark'
): ThemeColours | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`"${mode}" must be an object of colour tokens`)
  }
  const colours: ThemeColours = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.replace(/^--/, '')
    if (!TOKENS.has(key)) {
      throw new Error(`Unknown colour token "${rawKey}" in "${mode}"`)
    }
    const colour = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!COLOUR.test(colour)) {
      throw new Error(`"${rawKey}" in "${mode}" is not a colour`)
    }
    colours[key as ThemeColourToken] = colour
  }
  return colours
}

/** Validate an imported theme file. Throws with a message fit for the user. */
export function parseCustomTheme(
  input: unknown,
  id: string = generateId()
): CustomTheme {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('A theme must be a JSON object')
  }
  const record = input as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name) throw new Error('A theme needs a "name"')

  const light = parseColours(record.light, 'light')
  const dark = parseColours(record.dark, 'dark')
  if (!light && !dark) {
    throw new Error('A theme needs "light" or "dark" colours')
  }

  return {
    id,
    name,
    ...(light && { light }),
    ...(dark && { dark }),
  }
}

/** Keep the stored themes that still validate; drop anything else. */
export function normalizeCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const id = (item as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) return []
    try {
      return [parseCustomTheme(item, id)]
    } catch {
      return []
    }
  })
}

/**
 * Set the theme's tokens as inline custom properties, which win over the
 * `:root` / `.dark` values in App.css. Tokens the theme leaves out fall back
 * to the built-in palette.
 */
export function applyThemeColours(
  style: CSSStyleDeclaration,
  colours: ThemeColours = {}
): void {
  for (const token of THEME_COLOUR_TOKENS) {
    const colour = colours[token]
    if (colour) style.setProperty(`--${token}`, colour)
    else style.removeProperty(`--${token}`)
  }
}
