import type { ThemeColourToken, ThemeColours } from './custom-themes'

type Mode = 'light' | 'dark'

/**
 * Jean token → T3 Code skin colour keys (https://www.t3skins.dev/). The first
 * key the skin sets wins. T3 `accent` is the brand colour, so it maps to
 * Jean's `primary`; Jean's `accent` (hover surface) comes from `accentSurface`.
 */
const T3_COLOUR_MAP: Partial<Record<ThemeColourToken, readonly string[]>> = {
  background: ['canvas'],
  foreground: ['text', 'messageForeground'],
  card: ['surface'],
  'card-foreground': ['text', 'messageForeground'],
  popover: ['surfaceOverlay', 'surfaceRaised', 'surface'],
  'popover-foreground': ['text', 'messageForeground'],
  primary: ['accent'],
  'primary-foreground': ['accentForeground'],
  secondary: ['secondary'],
  'secondary-foreground': ['secondaryForeground'],
  muted: ['muted'],
  'muted-foreground': ['mutedForeground', 'textMuted'],
  accent: ['accentSurface', 'toolbarControlHover'],
  'accent-foreground': ['accentSurfaceForeground', 'text'],
  destructive: ['error'],
  warning: ['warning'],
  'warning-foreground': ['warningForeground'],
  border: ['border'],
  input: ['input'],
  ring: ['focus'],
  sidebar: ['sidebar'],
  'sidebar-foreground': ['sidebarForeground', 'text'],
  'sidebar-primary': ['accent'],
  'sidebar-primary-foreground': ['accentForeground'],
  'sidebar-accent': [
    'sidebarRowSelected',
    'sidebarRowActive',
    'sidebarControlSurface',
  ],
  'sidebar-accent-foreground': ['sidebarForeground', 'text'],
  'sidebar-border': ['sidebarBorder', 'border'],
  'sidebar-ring': ['focus'],
  'toast-background': ['surfaceOverlay', 'surfaceRaised'],
  'toast-border': ['border'],
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const isMode = (value: unknown): value is Mode =>
  value === 'light' || value === 'dark'

/** A T3 Code skin has a numeric `version`, an `appearance` and `colors`. */
export function isT3Skin(value: unknown): value is {
  name?: unknown
  appearance: Mode
  colors: Record<string, unknown>
  variants?: unknown
} {
  return (
    isRecord(value) &&
    typeof value.version === 'number' &&
    isMode(value.appearance) &&
    isRecord(value.colors)
  )
}

function convertColours(colors: Record<string, unknown>): ThemeColours {
  const colours: ThemeColours = {}
  for (const [token, keys] of Object.entries(T3_COLOUR_MAP)) {
    for (const key of keys) {
      const colour = colors[key]
      if (typeof colour === 'string' && HEX.test(colour.trim())) {
        colours[token as ThemeColourToken] = colour.trim().toLowerCase()
        break
      }
    }
  }
  return colours
}

/**
 * Convert a T3 Code skin to Jean theme input for `parseCustomTheme`. `colors`
 * fills the `appearance` mode; `variants.<other mode>` fills the other mode.
 * Only hex colours are read. `css` is dropped: Jean themes are colours only.
 */
export function convertT3Skin(
  skin: {
    name?: unknown
    appearance: Mode
    colors: Record<string, unknown>
    variants?: unknown
  },
  fallbackName: string
): { name: string; light?: ThemeColours; dark?: ThemeColours } {
  const modes: Partial<Record<Mode, ThemeColours>> = {
    [skin.appearance]: convertColours(skin.colors),
  }
  const other: Mode = skin.appearance === 'light' ? 'dark' : 'light'
  const variant = isRecord(skin.variants) ? skin.variants[other] : undefined
  if (isRecord(variant)) modes[other] = convertColours(variant)

  const result: { name: string; light?: ThemeColours; dark?: ThemeColours } = {
    name: (typeof skin.name === 'string' && skin.name.trim()) || fallbackName,
  }
  for (const mode of ['light', 'dark'] as const) {
    const colours = modes[mode]
    if (colours && Object.keys(colours).length > 0) result[mode] = colours
  }
  if (!result.light && !result.dark) {
    throw new Error('No T3 Code skin colours could be converted')
  }
  return result
}
