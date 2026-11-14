# Custom themes

Jean's colours come from the CSS variables in `src/App.css`. A custom theme
overrides any of them for light mode, dark mode or both. Tokens a theme leaves
out keep Jean's built-in values, so a theme can be as small as one colour.

## Importing a theme

Settings → Appearance → **Custom theme** → **Import**, then pick a `.json`
file. The theme applies straight away and the dropdown switches between
imported themes and **None** (the built-in colours). Importing a file with the
same `name` again replaces the earlier copy, which makes it easy to iterate on
a theme.

Themes are client preferences, like fonts and zoom: they are stored in the
app's local storage, so each desktop app and each Web Access browser keeps its
own list.

## Format

```json
{
  "name": "Dracula",
  "dark": {
    "background": "#282a36",
    "foreground": "#f8f8f2",
    "card": "#21222c",
    "popover": "#21222c",
    "primary": "#bd93f9",
    "primary-foreground": "#282a36",
    "muted": "#44475a",
    "muted-foreground": "#6272a4",
    "accent": "#44475a",
    "border": "#44475a",
    "destructive": "#ff5555",
    "success": "#50fa7b",
    "warning": "#ffb86c",
    "info": "#8be9fd",
    "sidebar": "#21222c"
  }
}
```

- `name`: required.
- `light` and `dark`: objects mapping a token to a colour. At least one is
  required. The theme follows the **Color theme** setting, so a theme with only
  `dark` leaves light mode on the built-in colours.
- Tokens may be written with or without the leading `--`. Unknown tokens are
  rejected so typos don't fail silently.
- Colours: hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) or a single colour
  function: `rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`,
  `oklab()`, `oklch()` or `color()`. `var()`, `url()` and nested functions are
  rejected.

## Tokens

| Group    | Tokens                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base     | `background`, `foreground`                                                                                                                                        |
| Surfaces | `card`, `card-foreground`, `popover`, `popover-foreground`                                                                                                        |
| Actions  | `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `accent`, `accent-foreground`                                                               |
| Muted    | `muted`, `muted-foreground`                                                                                                                                       |
| Status   | `destructive`, `warning`, `warning-foreground`, `success`, `success-foreground`, `info`, `info-foreground`                                                        |
| Lines    | `border`, `input`, `ring`                                                                                                                                         |
| Charts   | `chart-1`, `chart-2`, `chart-3`, `chart-4`, `chart-5`                                                                                                             |
| Sidebar  | `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring` |
| Toasts   | `toast-background`, `toast-border`                                                                                                                                |

## What a theme doesn't cover

- Code highlighting keeps its own **Syntax theme** settings.
- The terminal follows the theme's `background` when **Terminal background** is
  set to Auto; its ANSI colours are unchanged.
