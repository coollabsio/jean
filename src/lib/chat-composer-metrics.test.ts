import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_COMPOSER_GUTTER,
  computeChatComposerBottomOffset,
  getChatComposerBottomOffset,
  registerChatComposer,
  resetChatComposerMetrics,
  subscribeChatComposerMetrics,
} from './chat-composer-metrics'

function mockRect(
  el: HTMLElement,
  rect: Pick<DOMRect, 'top' | 'width' | 'height'>
): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top: rect.top,
    bottom: rect.top + rect.height,
    left: 0,
    right: rect.width,
    width: rect.width,
    height: rect.height,
    x: 0,
    y: rect.top,
    toJSON: () => ({}),
  })
}

describe('computeChatComposerBottomOffset', () => {
  it('returns 0 when no visible composer is registered', () => {
    expect(computeChatComposerBottomOffset([], 800)).toBe(0)
  })

  it('ignores zero-size composers', () => {
    const el = document.createElement('div')
    mockRect(el, { top: 600, width: 0, height: 0 })
    expect(computeChatComposerBottomOffset([el], 800)).toBe(0)
  })

  it('measures from the viewport bottom to the composer top plus a gutter', () => {
    const el = document.createElement('div')
    mockRect(el, { top: 620, width: 390, height: 180 })
    expect(computeChatComposerBottomOffset([el], 800)).toBe(
      800 - 620 + CHAT_COMPOSER_GUTTER
    )
  })

  it('uses the tallest visible composer when several are mounted', () => {
    const lower = document.createElement('div')
    const higher = document.createElement('div')
    mockRect(lower, { top: 700, width: 390, height: 100 })
    mockRect(higher, { top: 560, width: 390, height: 160 })
    expect(computeChatComposerBottomOffset([lower, higher], 800)).toBe(
      800 - 560 + CHAT_COMPOSER_GUTTER
    )
  })
})

describe('registerChatComposer', () => {
  const originalInnerHeight = window.innerHeight

  afterEach(() => {
    resetChatComposerMetrics()
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    })
  })

  it('publishes the live bottom offset and clears it on unregister', () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    })
    const el = document.createElement('div')
    mockRect(el, { top: 610, width: 390, height: 190 })

    const listener = vi.fn()
    const unsubscribe = subscribeChatComposerMetrics(listener)
    const unregister = registerChatComposer(el)

    expect(getChatComposerBottomOffset()).toBe(800 - 610 + CHAT_COMPOSER_GUTTER)
    expect(listener).toHaveBeenCalled()

    unregister()
    expect(getChatComposerBottomOffset()).toBe(0)
    unsubscribe()
  })
})
