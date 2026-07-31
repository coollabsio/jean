import { describe, expect, it } from 'vitest'
import { isImeComposingEvent } from './ime-composition'

function makeNativeEvent(overrides: {
  isComposing?: boolean
  keyCode?: number
}): Pick<KeyboardEvent, 'isComposing' | 'keyCode'> {
  return {
    isComposing: overrides.isComposing ?? false,
    keyCode: overrides.keyCode ?? 0,
  }
}

describe('isImeComposingEvent', () => {
  it('returns false for a normal Enter keydown', () => {
    expect(
      isImeComposingEvent(makeNativeEvent({ isComposing: false, keyCode: 13 }))
    ).toBe(false)
  })

  it('returns true when isComposing is set (Chromium/Firefox during IME)', () => {
    expect(
      isImeComposingEvent(makeNativeEvent({ isComposing: true, keyCode: 13 }))
    ).toBe(true)
  })

  it('returns true for keyCode 229 even when isComposing is false (Safari/WKWebView)', () => {
    // Safari can fire compositionend before the confirming Enter keydown,
    // so isComposing is already false but keyCode remains 229.
    expect(
      isImeComposingEvent(makeNativeEvent({ isComposing: false, keyCode: 229 }))
    ).toBe(true)
  })

  it('reads React synthetic events via nativeEvent', () => {
    const synthetic = {
      nativeEvent: makeNativeEvent({ isComposing: true, keyCode: 229 }),
    }
    expect(isImeComposingEvent(synthetic)).toBe(true)
  })

  it('does not treat other keyCodes as composing', () => {
    expect(
      isImeComposingEvent(makeNativeEvent({ isComposing: false, keyCode: 65 }))
    ).toBe(false)
  })
})
