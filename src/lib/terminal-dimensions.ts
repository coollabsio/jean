/**
 * Terminal dimension helpers for embedded PTYs.
 *
 * Interactive TUI CLIs (OpenCode `auth login`, clack prompts, etc.) mis-render
 * or appear frozen when the PTY starts at near-zero cols/rows — common while a
 * dialog is still animating open. These helpers enforce safe floors and a
 * minimum container size before spawning command PTYs.
 */

/** Absolute floor used when the emulator reports a degenerate size. */
export const SAFE_TERMINAL_MIN_COLS = 80
export const SAFE_TERMINAL_MIN_ROWS = 24

/**
 * Minimum container CSS pixels before a one-shot login/install PTY is started.
 * Below this, fit() often yields only a handful of cols during dialog zoom-in
 * (issue #624: OpenCode auth stuck on "Add credential").
 *
 * Kept low enough for narrow mobile dialogs, high enough to skip mid-animation
 * sizes (often tens of px).
 */
export const LOGIN_TERMINAL_MIN_WIDTH_PX = 200
export const LOGIN_TERMINAL_MIN_HEIGHT_PX = 120

/**
 * Resolve PTY cols/rows from an emulator's reported size.
 *
 * Degenerate sizes (< 2) crash portable_pty. Sizes that are merely "small"
 * still break interactive TUI apps — for command PTYs we therefore floor at
 * 80×24 so OpenCode/clack prompts get a usable viewport even if fit ran early.
 */
export function resolveSafeTerminalDimensions(
  rawCols: number,
  rawRows: number,
  options?: { forCommand?: boolean }
): { cols: number; rows: number } {
  const forCommand = options?.forCommand === true

  let cols = Number.isFinite(rawCols) ? Math.floor(rawCols) : 0
  let rows = Number.isFinite(rawRows) ? Math.floor(rawRows) : 0

  if (cols < 2) cols = SAFE_TERMINAL_MIN_COLS
  if (rows < 2) rows = SAFE_TERMINAL_MIN_ROWS

  if (forCommand) {
    cols = Math.max(cols, SAFE_TERMINAL_MIN_COLS)
    rows = Math.max(rows, SAFE_TERMINAL_MIN_ROWS)
  }

  return { cols, rows }
}

/** True when a login/install terminal container is large enough to start a TUI. */
export function isLoginTerminalContainerReady(
  width: number,
  height: number
): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= LOGIN_TERMINAL_MIN_WIDTH_PX &&
    height >= LOGIN_TERMINAL_MIN_HEIGHT_PX
  )
}
