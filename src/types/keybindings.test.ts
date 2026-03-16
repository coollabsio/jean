import { describe, expect, it } from 'vitest'
import { eventToShortcutString } from '@/types/keybindings'

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
})
