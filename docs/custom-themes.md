# Custom themes

Jean's colours come from the CSS variables in `src/App.css`. A custom theme
overrides any of them for light mode, dark mode or both. Tokens a theme leaves
out keep Jean's built-in values, so a theme can be as small as one colour.

## Importing a theme

Settings → Appearance → **Custom theme** → **Import**, then pick one or more
`.json` files: Jean themes (see [Format](#format)) or VS Code colour themes
(see [VS Code themes](#vs-code-themes)). If some files fail, Jean imports the
others and shows one error for each failed file. The last imported theme
applies straight away, and the dropdown switches between imported themes and
**None** (the built-in colours). Importing a file with the
same `name` again replaces the earlier copy, which makes it easy to iterate on
a theme.

**Export** copies the active theme to the clipboard as JSON in the same
format, so you can save it as a file, share it, or import it in another
desktop app or Web Access browser.

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

## VS Code themes

A file with a `colors` object is a VS Code colour theme. Jean converts it on
import:

- **Light or dark.** A `type` that contains `light` (`light`, `hcLight`) gives a
  light theme; any other `type` gives a dark theme. Without `type`, the
  luminance of `editor.background` decides.
- **Colours.** Jean maps workbench colours such as `editor.background`,
  `sideBar.background`, `button.background` and `focusBorder` to its tokens.
  The full table is `VSCODE_COLOUR_MAP` in `src/lib/vscode-themes.ts`. Tokens
  with no match keep Jean's built-in values.
- **Alpha.** Colours with alpha (`#rrggbbaa`, `#rgba`) are flattened onto
  `editor.background`, so every converted colour is opaque `#rrggbb`. Values
  that are not hex colours are skipped.
- **JSONC.** VS Code files can have comments and trailing commas. Jean
  accepts them in VS Code files only; Jean theme files must be strict JSON.
- **Pairs.** Select the light and the dark file of one family together (for
  example `Solarized (light)` and `Solarized (dark)`) to get one theme with
  both modes. Jean pairs two files when their names are the same after it
  removes the words "light" and "dark" and brackets. The paired theme gets
  that shorter name (`Solarized`).
- **Not supported:** `tokenColors` and `semanticTokenColors` (code
  highlighting keeps the **Syntax theme**), and `include` (a theme that
  extends another file is converted from its own `colors` only).

A file without `name` gets its file name, without `-color-theme.json`.

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
