import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SHIFT_ENTER_SEQUENCE,
  acceptsModifierEncodedKeys,
  handleShiftEnterKey,
  isShiftEnterEvent,
  shouldSendShiftEnterSequence,
  trackTerminalKeyboardMode,
} from './terminal-instances'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTransportConnected: () => true,
  listen: vi.fn().mockResolvedValue(() => undefined),
  requestTerminalReplay: vi.fn(),
}))

const keyEvent = (init: Partial<KeyboardEvent> & { type?: string }) =>
  ({
    type: 'keydown',
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 13,
    ...init,
  }) as KeyboardEvent

const terminalWrites = () =>
  invokeMock.mock.calls.filter(([command]) => command === 'terminal_write')

/** Input is coalesced on a short timer before it reaches the pty. */
const flushInput = () => new Promise(resolve => setTimeout(resolve, 25))

/**
 * Terminals send a bare carriage return for both Enter and Shift+Enter, so a
 * CLI that submits on Enter never sees the difference. CSI u encodes the
 * modifier, which is what Claude Code reads; ESC+CR is not enough.
 */
describe('terminal Shift+Enter', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
  })

  it('sends the CSI u encoding of Shift+Enter', () => {
    expect(SHIFT_ENTER_SEQUENCE).toBe('\x1b[13;2u')
  })

  it('sends the sequence once and keeps the renderer out of the press', async () => {
    const id = 'handler-1'
    trackTerminalKeyboardMode(id, '\x1b[?1004h')

    // Every event of the press must be claimed: letting keypress through makes
    // the renderer add its own carriage return, which the CLI reads as submit.
    for (const type of ['keydown', 'keypress', 'keyup']) {
      expect(handleShiftEnterKey(id, keyEvent({ type, shiftKey: true }))).toBe(
        true
      )
    }
    await flushInput()

    expect(terminalWrites()).toEqual([
      ['terminal_write', { terminalId: id, data: SHIFT_ENTER_SEQUENCE }],
    ])
  })

  it('stays out of the way at a shell prompt', async () => {
    const id = 'handler-shell'
    trackTerminalKeyboardMode(id, '\x1b[?2004h')

    expect(handleShiftEnterKey(id, keyEvent({ shiftKey: true }))).toBe(false)
    await flushInput()

    expect(terminalWrites()).toEqual([])
  })

  it('leaves plain Enter to the renderer even inside a TUI', async () => {
    const id = 'handler-enter'
    trackTerminalKeyboardMode(id, '\x1b[?1004h')

    expect(handleShiftEnterKey(id, keyEvent({}))).toBe(false)
    await flushInput()

    expect(terminalWrites()).toEqual([])
  })

  it('ignores an Enter that confirms IME composition', () => {
    const id = 'handler-ime'
    trackTerminalKeyboardMode(id, '\x1b[?1004h')

    expect(
      handleShiftEnterKey(id, keyEvent({ shiftKey: true, isComposing: true }))
    ).toBe(false)
    // WKWebView reports keyCode 229 instead of isComposing (issue #584).
    expect(
      handleShiftEnterKey(id, keyEvent({ shiftKey: true, keyCode: 229 }))
    ).toBe(false)
  })

  it('emits the sequence once per press', () => {
    expect(shouldSendShiftEnterSequence(keyEvent({ shiftKey: true }))).toBe(true)
    expect(
      shouldSendShiftEnterSequence(
        keyEvent({ type: 'keypress', shiftKey: true })
      )
    ).toBe(false)
    expect(
      shouldSendShiftEnterSequence(keyEvent({ type: 'keyup', shiftKey: true }))
    ).toBe(false)
  })

  it('leaves other modifier combinations alone', () => {
    expect(isShiftEnterEvent(keyEvent({ shiftKey: true, ctrlKey: true }))).toBe(
      false
    )
    expect(isShiftEnterEvent(keyEvent({ shiftKey: true, altKey: true }))).toBe(
      false
    )
    expect(isShiftEnterEvent(keyEvent({ shiftKey: true, metaKey: true }))).toBe(
      false
    )
    expect(isShiftEnterEvent(keyEvent({ key: 'a', shiftKey: true }))).toBe(false)
  })

  it('follows the program in and out of the kitty keyboard protocol', () => {
    const id = 'kitty-1'
    expect(acceptsModifierEncodedKeys(id)).toBe(false)

    trackTerminalKeyboardMode(id, '\x1b[>1u')
    expect(acceptsModifierEncodedKeys(id)).toBe(true)

    trackTerminalKeyboardMode(id, '\x1b[<1u')
    expect(acceptsModifierEncodedKeys(id)).toBe(false)

    trackTerminalKeyboardMode(id, '\x1b[=5;1u')
    expect(acceptsModifierEncodedKeys(id)).toBe(true)
    trackTerminalKeyboardMode(id, '\x1b[=0;1u')
    expect(acceptsModifierEncodedKeys(id)).toBe(false)
  })

  it('trusts focus reporting, including inside a parameter list', () => {
    // Claude Code negotiates no keyboard protocol; focus reporting is the
    // narrowest mode it does enable.
    const id = 'tui-focus'
    trackTerminalKeyboardMode(id, '\x1b[?1004h')
    expect(acceptsModifierEncodedKeys(id)).toBe(true)
    trackTerminalKeyboardMode(id, '\x1b[?1004l')
    expect(acceptsModifierEncodedKeys(id)).toBe(false)

    const multi = 'tui-multi'
    trackTerminalKeyboardMode(multi, '\x1b[?1004;1049h')
    expect(acceptsModifierEncodedKeys(multi)).toBe(true)
  })

  it('does not trust the alternate screen on its own', () => {
    // vim, less, htop and fzf use it without reading CSI u — and in vim's
    // insert mode the sequence would leave insert and then undo two changes.
    const id = 'alt-screen'
    trackTerminalKeyboardMode(id, '\x1b[?1049h')
    expect(acceptsModifierEncodedKeys(id)).toBe(false)
  })

  it('leaves a plain shell prompt alone', () => {
    // zsh turns on bracketed paste only, and would echo the raw sequence.
    const id = 'shell-1'
    trackTerminalKeyboardMode(id, '\x1b[?2004h')
    expect(acceptsModifierEncodedKeys(id)).toBe(false)
  })

  it('reads a sequence split across two output chunks', () => {
    const id = 'split-1'
    trackTerminalKeyboardMode(id, 'output\x1b[>')
    expect(acceptsModifierEncodedKeys(id)).toBe(false)
    trackTerminalKeyboardMode(id, '1u more output')
    expect(acceptsModifierEncodedKeys(id)).toBe(true)
  })

  it('reads a sequence split immediately after the CSI introducer', () => {
    // A pty read can end anywhere, including between `[` and its parameters.
    const id = 'split-2'
    trackTerminalKeyboardMode(id, 'output\x1b[')
    trackTerminalKeyboardMode(id, '?1004h')
    expect(acceptsModifierEncodedKeys(id)).toBe(true)
  })

  it('counts a push only once when a chunk boundary is carried over', () => {
    const id = 'split-3'
    trackTerminalKeyboardMode(id, '\x1b[>1u')
    trackTerminalKeyboardMode(id, 'plain output')
    trackTerminalKeyboardMode(id, '\x1b[<1u')
    expect(acceptsModifierEncodedKeys(id)).toBe(false)
  })

  it('does not grow the carried-over tail without bound', () => {
    const id = 'split-4'
    for (let i = 0; i < 50; i += 1) {
      trackTerminalKeyboardMode(id, '\x1b[?' + '1;'.repeat(20))
    }
    // A stuck partial sequence must not turn every chunk into a longer rescan.
    trackTerminalKeyboardMode(id, '1004h')
    expect(acceptsModifierEncodedKeys(id)).toBe(false)
  })
})
