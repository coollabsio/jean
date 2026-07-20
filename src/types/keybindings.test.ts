import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYBINDINGS,
  eventToShortcutString,
  KEYBINDING_DEFINITIONS,
} from '@/types/keybindings'

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

describe('eventToShortcutString', () => {
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
      metaKey: true,
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

  it('matches every default mod shortcut with either Command or Control', () => {
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
