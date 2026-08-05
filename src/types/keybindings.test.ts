import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KEYBINDINGS,
  eventToShortcutString,
  isModKeyEvent,
  KEYBINDING_DEFINITIONS,
} from '@/types/keybindings'

const environmentMocks = vi.hoisted(() => ({
  isNativeApp: false,
}))

const platformMocks = vi.hoisted(() => ({
  isClientMacOS: false,
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => environmentMocks.isNativeApp,
}))

vi.mock('@/lib/platform', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    get isClientMacOS() {
      return platformMocks.isClientMacOS
    },
  }
})

function keyboardKey(token: string): { key: string; code: string } {
  if (/^[a-z]$/.test(token)) {
    return { key: token, code: `Key${token.toUpperCase()}` }
  }
  if (/^[0-9]$/.test(token)) return { key: token, code: `Digit${token}` }

  const named: Record<string, { key: string; code: string }> = {
    comma: { key: ',', code: 'Comma' },
    period: { key: '.', code: 'Period' },
    backquote: { key: '`', code: 'Backquote' },
    enter: { key: 'Enter', code: 'Enter' },
    backspace: { key: 'Backspace', code: 'Backspace' },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
  }
  const result = named[token]
  if (!result) throw new Error(`Missing keyboard test mapping for ${token}`)
  return result
}

function setPlatform(options: {
  isClientMacOS: boolean
  isNativeApp: boolean
}) {
  platformMocks.isClientMacOS = options.isClientMacOS
  environmentMocks.isNativeApp = options.isNativeApp
}

describe('eventToShortcutString', () => {
  afterEach(() => {
    setPlatform({ isClientMacOS: false, isNativeApp: false })
  })

  it('maps alt-modified letter keys using physical key code', () => {
    const modelEvent = new KeyboardEvent('keydown', {
      key: 'µ',
      code: 'KeyM',
      altKey: true,
    })
    const thinkingEvent = new KeyboardEvent('keydown', {
      key: 'Dead',
      code: 'KeyE',
      altKey: true,
    })

    expect(eventToShortcutString(modelEvent)).toBe('alt+m')
    expect(eventToShortcutString(thinkingEvent)).toBe('alt+e')
  })

  it('normalizes shifted punctuation via key code', () => {
    const slashEvent = new KeyboardEvent('keydown', {
      key: '?',
      code: 'Slash',
      shiftKey: true,
    })

    expect(eventToShortcutString(slashEvent)).toBe('shift+slash')
  })

  it('falls back to key when code is not in the mapping', () => {
    const f5Event = new KeyboardEvent('keydown', {
      key: 'F5',
      code: 'F5',
    })

    expect(eventToShortcutString(f5Event)).toBe('f5')
  })

  it('normalizes delete keys to backspace for shortcut matching', () => {
    const deleteEvent = new KeyboardEvent('keydown', {
      key: 'Delete',
      code: 'Delete',
      ctrlKey: true,
      altKey: true,
    })

    expect(eventToShortcutString(deleteEvent)).toBe('mod+alt+backspace')
  })

  it('ignores modifier-only keys', () => {
    const altOnlyEvent = new KeyboardEvent('keydown', {
      key: 'Alt',
      code: 'AltLeft',
      altKey: true,
    })

    expect(eventToShortcutString(altOnlyEvent)).toBeNull()
  })

  it('matches every default mod shortcut with the platform mod key (Ctrl on non-mac)', () => {
    setPlatform({ isClientMacOS: false, isNativeApp: false })

    for (const shortcut of Object.values(DEFAULT_KEYBINDINGS)) {
      const parts = shortcut.split('+')
      if (!parts.includes('mod')) continue

      const keyToken = parts.at(-1)
      if (!keyToken) throw new Error(`Missing key in ${shortcut}`)
      const key = keyboardKey(keyToken)
      const modifiers = {
        shiftKey: parts.includes('shift'),
        altKey: parts.includes('alt'),
      }

      expect(
        eventToShortcutString(
          new KeyboardEvent('keydown', {
            ...key,
            ...modifiers,
            ctrlKey: true,
          })
        ),
        `Control should match ${shortcut}`
      ).toBe(shortcut)
    }
  })

  it('matches every default mod shortcut with Command on macOS native', () => {
    setPlatform({ isClientMacOS: true, isNativeApp: true })

    for (const shortcut of Object.values(DEFAULT_KEYBINDINGS)) {
      const parts = shortcut.split('+')
      if (!parts.includes('mod')) continue

      const keyToken = parts.at(-1)
      if (!keyToken) throw new Error(`Missing key in ${shortcut}`)
      const key = keyboardKey(keyToken)
      const modifiers = {
        shiftKey: parts.includes('shift'),
        altKey: parts.includes('alt'),
      }

      expect(
        eventToShortcutString(
          new KeyboardEvent('keydown', {
            ...key,
            ...modifiers,
            metaKey: true,
          })
        ),
        `Command should match ${shortcut}`
      ).toBe(shortcut)
    }
  })

  it('does not treat Control as mod on macOS native so Ctrl+T reaches the terminal (issue #615)', () => {
    setPlatform({ isClientMacOS: true, isNativeApp: true })

    const ctrlT = new KeyboardEvent('keydown', {
      key: 't',
      code: 'KeyT',
      ctrlKey: true,
    })
    const cmdT = new KeyboardEvent('keydown', {
      key: 't',
      code: 'KeyT',
      metaKey: true,
    })

    expect(isModKeyEvent(ctrlT)).toBe(false)
    expect(eventToShortcutString(ctrlT)).toBeNull()

    expect(isModKeyEvent(cmdT)).toBe(true)
    expect(eventToShortcutString(cmdT)).toBe('mod+t')
  })

  it('treats Control as mod on macOS web (browser intercepts Cmd)', () => {
    setPlatform({ isClientMacOS: true, isNativeApp: false })

    const ctrlT = new KeyboardEvent('keydown', {
      key: 't',
      code: 'KeyT',
      ctrlKey: true,
    })
    const cmdT = new KeyboardEvent('keydown', {
      key: 't',
      code: 'KeyT',
      metaKey: true,
    })

    expect(isModKeyEvent(ctrlT)).toBe(true)
    expect(eventToShortcutString(ctrlT)).toBe('mod+t')

    // Cmd is not the web mod key; leave unmatched rather than treating as bare "t"
    expect(isModKeyEvent(cmdT)).toBe(false)
    expect(eventToShortcutString(cmdT)).toBe('t')
  })

  it('keeps the settings definitions aligned with every default shortcut', () => {
    const definitions = new Map(
      KEYBINDING_DEFINITIONS.map(definition => [
        definition.action,
        definition.default_shortcut,
      ])
    )

    expect(Object.fromEntries(definitions)).toEqual(DEFAULT_KEYBINDINGS)
  })
})
