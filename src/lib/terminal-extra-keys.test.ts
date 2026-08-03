import { describe, expect, it } from 'vitest'
import {
  applyAltModifier,
  applyCtrlModifier,
  resolveStickyKeyData,
  TERMINAL_EXTRA_KEYS,
} from './terminal-extra-keys'

describe('applyCtrlModifier', () => {
  it('maps letters to control characters', () => {
    expect(applyCtrlModifier('c')).toBe('\x03')
    expect(applyCtrlModifier('C')).toBe('\x03')
    expect(applyCtrlModifier('z')).toBe('\x1a')
    expect(applyCtrlModifier('s')).toBe('\x13')
  })

  it('maps common punctuation control combos', () => {
    expect(applyCtrlModifier('\\')).toBe('\x1c')
    expect(applyCtrlModifier('[')).toBe('\x1b')
    expect(applyCtrlModifier('?')).toBe('\x7f')
  })

  it('returns null for unmapped multi-char keys', () => {
    expect(applyCtrlModifier('Enter')).toBeNull()
    expect(applyCtrlModifier('')).toBeNull()
  })
})

describe('applyAltModifier', () => {
  it('prefixes with ESC', () => {
    expect(applyAltModifier('b')).toBe('\x1bb')
    expect(applyAltModifier('.')).toBe('\x1b.')
  })

  it('returns null for multi-char keys', () => {
    expect(applyAltModifier('ArrowLeft')).toBeNull()
  })
})

describe('resolveStickyKeyData', () => {
  it('returns null when no sticky modifiers', () => {
    expect(
      resolveStickyKeyData({ key: 'c', ctrlKey: false, altKey: false, metaKey: false }, false, false)
    ).toBeNull()
  })

  it('applies sticky ctrl', () => {
    expect(
      resolveStickyKeyData(
        { key: 'c', ctrlKey: false, altKey: false, metaKey: false },
        true,
        false
      )
    ).toBe('\x03')
  })

  it('applies sticky alt', () => {
    expect(
      resolveStickyKeyData(
        { key: 'x', ctrlKey: false, altKey: false, metaKey: false },
        false,
        true
      )
    ).toBe('\x1bx')
  })

  it('ignores pure modifier keydowns', () => {
    expect(
      resolveStickyKeyData(
        { key: 'Control', ctrlKey: true, altKey: false, metaKey: false },
        true,
        false
      )
    ).toBeNull()
  })

  it('does not double-apply when OS already sent a modifier', () => {
    expect(
      resolveStickyKeyData(
        { key: 'c', ctrlKey: true, altKey: false, metaKey: false },
        true,
        false
      )
    ).toBeNull()
  })
})

describe('TERMINAL_EXTRA_KEYS', () => {
  it('includes Termius-style essentials plus clipboard actions', () => {
    const labels = TERMINAL_EXTRA_KEYS.map(k => k.label)
    expect(labels).toEqual([
      'paste',
      'copy',
      'esc',
      'tab',
      'ctrl',
      'alt',
      '/',
      '|',
      '~',
      '-',
      '^C',
      '^\\',
      '^S',
      '^Z',
    ])
  })

  it('defines clipboard actions for paste and copy', () => {
    const clipboard = TERMINAL_EXTRA_KEYS.filter(k => k.type === 'clipboard')
    expect(clipboard).toEqual([
      { type: 'clipboard', action: 'paste', label: 'paste' },
      { type: 'clipboard', action: 'copy', label: 'copy' },
    ])
  })

  it('sends correct control sequences for chords', () => {
    const byLabel = Object.fromEntries(
      TERMINAL_EXTRA_KEYS.filter(k => k.type === 'data').map(k => [
        k.label,
        k.data,
      ])
    )
    expect(byLabel['esc']).toBe('\x1b')
    expect(byLabel['tab']).toBe('\t')
    expect(byLabel['^C']).toBe('\x03')
    expect(byLabel['^\\']).toBe('\x1c')
    expect(byLabel['^S']).toBe('\x13')
    expect(byLabel['^Z']).toBe('\x1a')
  })
})
