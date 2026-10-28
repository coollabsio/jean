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
  })
})
