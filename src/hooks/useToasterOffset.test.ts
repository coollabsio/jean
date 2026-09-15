import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  CHAT_COMPOSER_GUTTER,
  registerChatComposer,
  resetChatComposerMetrics,
} from '@/lib/chat-composer-metrics'
import { useToasterOffset } from './useToasterOffset'

const isNativeAppMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => isNativeAppMock(),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: (selector: (state: { activeWorktreeId: null }) => unknown) =>
    selector({ activeWorktreeId: null }),
}))

vi.mock('@/store/ui-store', () => ({
  useUIStore: (
    selector: (state: {
      sessionChatModalOpen: boolean
      sessionChatModalWorktreeId: null
    }) => unknown
  ) =>
    selector({
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
    }),
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: (
    selector: (state: { selectedWorktreeId: null }) => unknown
  ) => selector({ selectedWorktreeId: null }),
}))

vi.mock('@/store/browser-store', () => ({
  useBrowserStore: (
    selector: (state: {
      sidePaneOpen: Record<string, boolean>
      bottomPanelOpen: Record<string, boolean>
      modalOpen: Record<string, boolean>
      sidePaneWidth: number
      bottomPanelHeight: number
      modalDockMode: string
      modalWidth: number
      modalHeight: number
    }) => unknown
  ) =>
    selector({
      sidePaneOpen: {},
      bottomPanelOpen: {},
      modalOpen: {},
      sidePaneWidth: 0,
      bottomPanelHeight: 0,
      modalDockMode: 'right',
      modalWidth: 0,
      modalHeight: 0,
    }),
}))

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

describe('useToasterOffset', () => {
  const originalInnerHeight = window.innerHeight

  beforeEach(() => {
    isNativeAppMock.mockReturnValue(false)
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    })
  })

  afterEach(() => {
    resetChatComposerMetrics()
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    })
  })

  it('keeps the default mobile bottom offset when no composer is visible', () => {
    const { result } = renderHook(() => useToasterOffset())
    expect(result.current.offset).toBe('52px')
    expect(result.current.mobileOffset).toEqual({
      top: 52,
      right: 52,
      left: 52,
      bottom: 52,
    })
  })

  it('lifts mobile toasts above the chat composer', () => {
    const el = document.createElement('div')
    mockRect(el, { top: 600, width: 390, height: 200 })
    registerChatComposer(el)

    const { result } = renderHook(() => useToasterOffset())

    expect(result.current.mobileOffset).toEqual({
      top: 52,
      right: 52,
      left: 52,
      bottom: 800 - 600 + CHAT_COMPOSER_GUTTER,
    })
    expect(result.current.offset).toBe('52px')
  })
})
