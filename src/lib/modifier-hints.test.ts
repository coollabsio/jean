import { afterEach, describe, expect, it } from 'vitest'
import { installModifierHints } from './modifier-hints'

describe('installModifierHints', () => {
  let uninstall: (() => void) | undefined
  afterEach(() => uninstall?.())

  it('marks the root only while a modifier is held', () => {
    uninstall = installModifierHints()
    const root = document.documentElement

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Meta', metaKey: true })
    )
    expect(root.hasAttribute('data-mod-held')).toBe(true)

    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Meta', metaKey: false })
    )
    expect(root.hasAttribute('data-mod-held')).toBe(false)

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true })
    )
    window.dispatchEvent(new Event('blur'))
    expect(root.hasAttribute('data-mod-held')).toBe(false)
    expect(root.hasAttribute('data-primary-mod-held')).toBe(false)
  })

  it('marks the primary modifier only for ⌘/Ctrl, not Alt', () => {
    uninstall = installModifierHints()
    const root = document.documentElement

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Alt', altKey: true })
    )
    expect(root.hasAttribute('data-mod-held')).toBe(true)
    expect(root.hasAttribute('data-primary-mod-held')).toBe(false)

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, altKey: true })
    )
    expect(root.hasAttribute('data-primary-mod-held')).toBe(true)

    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Meta', altKey: true })
    )
    expect(root.hasAttribute('data-mod-held')).toBe(true)
    expect(root.hasAttribute('data-primary-mod-held')).toBe(false)
  })
})
