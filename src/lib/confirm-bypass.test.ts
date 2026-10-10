import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeConfirmBypassLabel,
  hasCloseConfirmBypassModifier,
  resolveCloseConfirmBypassModifier,
  stripShortcutModifier,
} from '@/lib/confirm-bypass'

const platformMocks = vi.hoisted(() => ({
  isClientMacOS: false,
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

function setPlatform(options: { isClientMacOS: boolean }) {
  platformMocks.isClientMacOS = options.isClientMacOS
}

interface Mods {
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

function evt(mods: Mods): Mods & {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
} {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  }
}

describe('hasCloseConfirmBypassModifier', () => {
  afterEach(() => {
    setPlatform({ isClientMacOS: false })
  })

  it('detects shift held / not held', () => {
    expect(
      hasCloseConfirmBypassModifier(evt({ shiftKey: true }), 'shift')
    ).toBe(true)
    expect(hasCloseConfirmBypassModifier(evt({}), 'shift')).toBe(false)
  })

  it('detects alt held / not held', () => {
    expect(hasCloseConfirmBypassModifier(evt({ altKey: true }), 'alt')).toBe(
      true
    )
    expect(hasCloseConfirmBypassModifier(evt({ shiftKey: true }), 'alt')).toBe(
      false
    )
  })

  it('returns false for none even with every modifier held', () => {
    expect(
      hasCloseConfirmBypassModifier(
        evt({ metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }),
        'none'
      )
    ).toBe(false)
  })

  it('defaults to off (none) when modifier is undefined', () => {
    expect(
      hasCloseConfirmBypassModifier(evt({ shiftKey: true }), undefined)
    ).toBe(false)
  })

  it('returns false for a null or undefined event', () => {
    expect(hasCloseConfirmBypassModifier(null, 'shift')).toBe(false)
    expect(hasCloseConfirmBypassModifier(undefined, 'shift')).toBe(false)
  })
})

describe('resolveCloseConfirmBypassModifier', () => {
  it('passes known modifiers through', () => {
    expect(resolveCloseConfirmBypassModifier('shift')).toBe('shift')
    expect(resolveCloseConfirmBypassModifier('alt')).toBe('alt')
    expect(resolveCloseConfirmBypassModifier('none')).toBe('none')
  })

  it('coerces unknown / stale / undefined values to the default (none)', () => {
    expect(resolveCloseConfirmBypassModifier('bogus')).toBe('none')
    expect(resolveCloseConfirmBypassModifier('mod')).toBe('none')
    expect(resolveCloseConfirmBypassModifier(undefined)).toBe('none')
  })
})

describe('stripShortcutModifier', () => {
  it('removes the modifier token, keeping canonical order', () => {
    expect(stripShortcutModifier('mod+shift+w', 'shift')).toBe('mod+w')
  })

  it('returns null when the modifier is absent', () => {
    expect(stripShortcutModifier('mod+w', 'shift')).toBeNull()
  })

  it('returns null for none', () => {
    expect(stripShortcutModifier('mod+shift+w', 'none')).toBeNull()
  })

  it('returns null for undefined modifier', () => {
    expect(stripShortcutModifier('mod+shift+w', undefined)).toBeNull()
  })

  it('returns null when stripping the only remaining token', () => {
    expect(stripShortcutModifier('shift', 'shift')).toBeNull()
  })
})

describe('closeConfirmBypassLabel', () => {
  afterEach(() => {
    setPlatform({ isClientMacOS: false })
  })

  it('returns a label for every non-none modifier', () => {
    expect(closeConfirmBypassLabel('shift')).not.toBeNull()
    expect(closeConfirmBypassLabel('alt')).not.toBeNull()
  })

  it('returns null only for none', () => {
    expect(closeConfirmBypassLabel('none')).toBeNull()
  })

  it('uses glyphs on macOS', () => {
    setPlatform({ isClientMacOS: true })
    expect(closeConfirmBypassLabel('shift')).toBe('⇧')
    expect(closeConfirmBypassLabel('alt')).toBe('⌥')
  })
})
