import type { ThemeColours } from './custom-themes'

/** A few palette colours that expand to every Jean colour token. */
interface Palette {
  background: string
  surface: string // cards, popovers, toasts
  raised: string // secondary, muted, accent, hover
  border: string
  foreground: string
  muted: string // secondary text
  primary: string
  onPrimary: string
  red: string
  orange: string
  green: string
  blue: string
  purple: string
}

function expand(p: Palette): ThemeColours {
  return {
    background: p.background,
    foreground: p.foreground,
    card: p.surface,
    'card-foreground': p.foreground,
    popover: p.surface,
    'popover-foreground': p.foreground,
    primary: p.primary,
    'primary-foreground': p.onPrimary,
    secondary: p.raised,
    'secondary-foreground': p.foreground,
    muted: p.raised,
    'muted-foreground': p.muted,
    accent: p.raised,
    'accent-foreground': p.foreground,
    destructive: p.red,
    warning: p.orange,
    'warning-foreground': p.background,
    success: p.green,
    'success-foreground': p.background,
    info: p.blue,
    'info-foreground': p.background,
    border: p.border,
    input: p.border,
    ring: p.muted,
    'chart-1': p.primary,
    'chart-2': p.green,
    'chart-3': p.purple,
    'chart-4': p.red,
    'chart-5': p.blue,
    sidebar: p.background,
    'sidebar-foreground': p.foreground,
    'sidebar-primary': p.primary,
    'sidebar-primary-foreground': p.onPrimary,
    'sidebar-accent': p.raised,
    'sidebar-accent-foreground': p.foreground,
    'sidebar-border': p.border,
    'sidebar-ring': p.muted,
    'toast-background': p.surface,
    'toast-border': p.border,
  }
}

export interface ThemePreset {
  name: string
  light?: ThemeColours
  dark?: ThemeColours
}

/**
 * Built-in themes based on popular editor palettes. A preset with only one
 * mode keeps the built-in colours for the other mode.
 */
export const THEME_PRESETS: ThemePreset[] = [
  {
    name: 'Dracula',
    dark: expand({
      background: '#282a36',
      surface: '#2f3241',
      raised: '#383a4a',
      border: '#44475a',
      foreground: '#f8f8f2',
      muted: '#a0a4c0',
      primary: '#bd93f9',
      onPrimary: '#282a36',
      red: '#ff5555',
      orange: '#ffb86c',
      green: '#50fa7b',
      blue: '#8be9fd',
      purple: '#ff79c6',
    }),
  },
  {
    name: 'Nord',
    dark: expand({
      background: '#2e3440',
      surface: '#353b49',
      raised: '#3b4252',
      border: '#434c5e',
      foreground: '#eceff4',
      muted: '#a3abbc',
      primary: '#88c0d0',
      onPrimary: '#2e3440',
      red: '#bf616a',
      orange: '#d08770',
      green: '#a3be8c',
      blue: '#81a1c1',
      purple: '#b48ead',
    }),
  },
  {
    name: 'Catppuccin',
    light: expand({
      background: '#eff1f5',
      surface: '#e6e9ef',
      raised: '#dce0e8',
      border: '#ccd0da',
      foreground: '#4c4f69',
      muted: '#6c6f85',
      primary: '#8839ef',
      onPrimary: '#eff1f5',
      red: '#d20f39',
      orange: '#fe640b',
      green: '#40a02b',
      blue: '#1e66f5',
      purple: '#ea76cb',
    }),
    dark: expand({
      background: '#1e1e2e',
      surface: '#24243a',
      raised: '#313244',
      border: '#45475a',
      foreground: '#cdd6f4',
      muted: '#a6adc8',
      primary: '#cba6f7',
      onPrimary: '#1e1e2e',
      red: '#f38ba8',
      orange: '#fab387',
      green: '#a6e3a1',
      blue: '#89b4fa',
      purple: '#f5c2e7',
    }),
  },
  {
    name: 'Tokyo Night',
    dark: expand({
      background: '#1a1b26',
      surface: '#1f2335',
      raised: '#292e42',
      border: '#3b4261',
      foreground: '#c0caf5',
      muted: '#9aa5ce',
      primary: '#7aa2f7',
      onPrimary: '#1a1b26',
      red: '#f7768e',
      orange: '#ff9e64',
      green: '#9ece6a',
      blue: '#7dcfff',
      purple: '#bb9af7',
    }),
  },
  {
    name: 'One Dark',
    dark: expand({
      background: '#282c34',
      surface: '#2c313a',
      raised: '#353b45',
      border: '#3e4451',
      foreground: '#dcdfe4',
      muted: '#9da5b4',
      primary: '#61afef',
      onPrimary: '#282c34',
      red: '#e06c75',
      orange: '#d19a66',
      green: '#98c379',
      blue: '#56b6c2',
      purple: '#c678dd',
    }),
  },
  {
    name: 'Gruvbox',
    light: expand({
      background: '#fbf1c7',
      surface: '#f2e5bc',
      raised: '#ebdbb2',
      border: '#d5c4a1',
      foreground: '#3c3836',
      muted: '#665c54',
      primary: '#af3a03',
      onPrimary: '#fbf1c7',
      red: '#9d0006',
      orange: '#b57614',
      green: '#79740e',
      blue: '#076678',
      purple: '#8f3f71',
    }),
    dark: expand({
      background: '#282828',
      surface: '#32302f',
      raised: '#3c3836',
      border: '#504945',
      foreground: '#ebdbb2',
      muted: '#a89984',
      primary: '#fabd2f',
      onPrimary: '#282828',
      red: '#fb4934',
      orange: '#fe8019',
      green: '#b8bb26',
      blue: '#83a598',
      purple: '#d3869b',
    }),
  },
  {
    name: 'Solarized',
    light: expand({
      background: '#fdf6e3',
      surface: '#f7f0dc',
      raised: '#eee8d5',
      border: '#dcd5c1',
      foreground: '#586e75',
      muted: '#839496',
      primary: '#268bd2',
      onPrimary: '#fdf6e3',
      red: '#dc322f',
      orange: '#cb4b16',
      green: '#859900',
      blue: '#2aa198',
      purple: '#6c71c4',
    }),
    dark: expand({
      background: '#002b36',
      surface: '#04313c',
      raised: '#073642',
      border: '#0e4552',
      foreground: '#93a1a1',
      muted: '#839496',
      primary: '#268bd2',
      onPrimary: '#fdf6e3',
      red: '#dc322f',
      orange: '#cb4b16',
      green: '#859900',
      blue: '#2aa198',
      purple: '#6c71c4',
    }),
  },
  {
    name: 'GitHub',
    light: expand({
      background: '#ffffff',
      surface: '#f6f8fa',
      raised: '#eff2f5',
      border: '#d0d7de',
      foreground: '#1f2328',
      muted: '#59636e',
      primary: '#0969da',
      onPrimary: '#ffffff',
      red: '#cf222e',
      orange: '#9a6700',
      green: '#1a7f37',
      blue: '#0969da',
      purple: '#8250df',
    }),
    dark: expand({
      background: '#0d1117',
      surface: '#151b23',
      raised: '#212830',
      border: '#30363d',
      foreground: '#e6edf3',
      muted: '#9198a1',
      primary: '#4493f8',
      onPrimary: '#0d1117',
      red: '#f85149',
      orange: '#d29922',
      green: '#3fb950',
      blue: '#58a6ff',
      purple: '#bc8cff',
    }),
  },
]
