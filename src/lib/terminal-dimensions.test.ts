import { describe, expect, it } from 'vitest'
import {
  isLoginTerminalContainerReady,
  LOGIN_TERMINAL_MIN_HEIGHT_PX,
  LOGIN_TERMINAL_MIN_WIDTH_PX,
  resolveSafeTerminalDimensions,
  SAFE_TERMINAL_MIN_COLS,
  SAFE_TERMINAL_MIN_ROWS,
} from './terminal-dimensions'

describe('resolveSafeTerminalDimensions', () => {
  it('clamps degenerate sizes to the safe floor', () => {
    expect(resolveSafeTerminalDimensions(0, 0)).toEqual({
      cols: SAFE_TERMINAL_MIN_COLS,
      rows: SAFE_TERMINAL_MIN_ROWS,
    })
    expect(resolveSafeTerminalDimensions(1, 1)).toEqual({
      cols: SAFE_TERMINAL_MIN_COLS,
      rows: SAFE_TERMINAL_MIN_ROWS,
    })
  })

  it('keeps larger interactive panel sizes as-is when not a command PTY', () => {
    expect(resolveSafeTerminalDimensions(120, 40)).toEqual({
      cols: 120,
      rows: 40,
    })
    // Small but non-degenerate panel (no command) — preserve fit result
    expect(resolveSafeTerminalDimensions(40, 10)).toEqual({
      cols: 40,
      rows: 10,
    })
  })

  it('floors command/login PTYs at 80x24 so TUI prompts stay usable', () => {
    // Dialog zoom-in often yields a handful of cols before layout settles
    expect(
      resolveSafeTerminalDimensions(12, 5, { forCommand: true })
    ).toEqual({
      cols: SAFE_TERMINAL_MIN_COLS,
      rows: SAFE_TERMINAL_MIN_ROWS,
    })
    expect(
      resolveSafeTerminalDimensions(100, 30, { forCommand: true })
    ).toEqual({
      cols: 100,
      rows: 30,
    })
  })
})

describe('isLoginTerminalContainerReady', () => {
  it('rejects empty or sub-minimum containers', () => {
    expect(isLoginTerminalContainerReady(0, 0)).toBe(false)
    expect(isLoginTerminalContainerReady(100, 400)).toBe(false)
    expect(isLoginTerminalContainerReady(400, 50)).toBe(false)
  })

  it('accepts containers that meet the login TUI minimum', () => {
    expect(
      isLoginTerminalContainerReady(
        LOGIN_TERMINAL_MIN_WIDTH_PX,
        LOGIN_TERMINAL_MIN_HEIGHT_PX
      )
    ).toBe(true)
    expect(isLoginTerminalContainerReady(640, 360)).toBe(true)
  })
})
