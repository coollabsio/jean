import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useScrollManagement } from './useScrollManagement'
import {
  __resetSessionScrollStateForTests,
  getSessionScrollState,
  saveSessionScrollState,
} from '../session-scroll-state'
import type { ChatMessage } from '@/types/chat'

let isMobile = false

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

type ResizeObserverCallback = ConstructorParameters<typeof ResizeObserver>[0]

let resizeObserverCallbacks: ResizeObserverCallback[] = []
const originalResizeObserver = globalThis.ResizeObserver
const originalIntersectionObserver = globalThis.IntersectionObserver

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback)
  }

  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

class IntersectionObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function defineReadonlyNumber(
  element: HTMLElement,
  property: 'clientHeight' | 'scrollHeight' | 'offsetTop',
  value: number
) {
  Object.defineProperty(element, property, {
    configurable: true,
    value,
  })
}

interface SetupHookOptions {
  isSending?: boolean
  activeSessionId?: string
  contentReady?: boolean
  messages?: ChatMessage[]
  scrollHeight?: number
}

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    session_id: 'session-a',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    timestamp: Date.now(),
    tool_calls: [],
  }))
}

function attachViewportMetrics(el: HTMLElement | null, scrollHeight: number) {
  if (!el) return
  defineReadonlyNumber(el, 'clientHeight', 400)
  defineReadonlyNumber(el, 'scrollHeight', scrollHeight)
  const plan = el.querySelector('[data-testid="plan"]') as HTMLElement | null
  if (plan) {
    defineReadonlyNumber(plan, 'offsetTop', 600)
  }
}

function setupHook({
  isSending = true,
  activeSessionId = 'session-1',
  contentReady = true,
  messages = [],
  scrollHeight = 2000,
}: SetupHookOptions = {}) {
  const virtualizedListRef = { current: null }
  // Keep latest values for rerenderSession defaults
  let currentSessionId = activeSessionId
  let currentReady = contentReady
  let currentMessages = messages
  let currentSending = isSending
  let currentScrollHeight = scrollHeight

  function TestHarness({
    sessionId,
    ready,
    msgs,
    sending,
  }: {
    sessionId: string
    ready: boolean
    msgs: ChatMessage[]
    sending: boolean
  }) {
    const { isAtBottom, scrollViewportRef, handleScroll } = useScrollManagement(
      {
        messages: msgs,
        virtualizedListRef,
        activeSessionId: sessionId,
        contentReady: ready,
        isSending: sending,
      }
    )

    return (
      <div
        ref={el => {
          // Metrics must be available before useScrollManagement's layout
          // effects read scrollHeight (session restore / scroll-to-tail).
          attachViewportMetrics(el, currentScrollHeight)
          scrollViewportRef.current = el
        }}
        data-testid="viewport"
        onScroll={handleScroll}
      >
        <span data-testid="is-at-bottom">{String(isAtBottom)}</span>
        <div data-testid="content">
          <div data-plan-display data-testid="plan" />
        </div>
      </div>
    )
  }

  const renderResult = render(
    <TestHarness
      sessionId={activeSessionId}
      ready={contentReady}
      msgs={messages}
      sending={isSending}
    />
  )
  const viewport = renderResult.getByTestId('viewport')
  const plan = renderResult.getByTestId('plan')

  return {
    ...renderResult,
    viewport,
    plan,
    setScrollHeight: (nextScrollHeight: number) => {
      currentScrollHeight = nextScrollHeight
      defineReadonlyNumber(viewport, 'scrollHeight', nextScrollHeight)
    },
    rerenderSession: (
      next: Partial<{
        sessionId: string
        ready: boolean
        msgs: ChatMessage[]
        sending: boolean
      }>
    ) => {
      currentSessionId = next.sessionId ?? currentSessionId
      currentReady = next.ready ?? currentReady
      currentMessages = next.msgs ?? currentMessages
      currentSending = next.sending ?? currentSending
      renderResult.rerender(
        <TestHarness
          sessionId={currentSessionId}
          ready={currentReady}
          msgs={currentMessages}
          sending={currentSending}
        />
      )
    },
  }
}

async function triggerResize() {
  await act(async () => {
    for (const callback of resizeObserverCallbacks) {
      callback([], {} as ResizeObserver)
    }
  })
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}

describe('useScrollManagement streaming auto-scroll', () => {
  beforeEach(() => {
    isMobile = false
    resizeObserverCallbacks = []
    __resetSessionScrollStateForTests()
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    })
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: IntersectionObserverMock,
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function scrollTo(options: ScrollToOptions) {
        if (typeof options.top === 'number') {
          this.scrollTop = options.top
        }
      },
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(performance.now())
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetSessionScrollStateForTests()
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: originalResizeObserver,
    })
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: originalIntersectionObserver,
    })
  })

  it('keeps desktop plan pinning during streaming', async () => {
    const { viewport } = setupHook()

    await triggerResize()

    expect(viewport.scrollTop).toBe(600)
  })

  it('follows the streaming tail on mobile even when a plan is visible', async () => {
    isMobile = true
    const { viewport } = setupHook()

    await triggerResize()

    expect(viewport.scrollTop).toBe(2000)
  })

  it('does not auto-scroll after the user scrolls up', async () => {
    isMobile = true
    const { viewport } = setupHook()
    viewport.scrollTop = 1500

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })
    await triggerResize()

    expect(viewport.scrollTop).toBe(1500)
  })

  it('does not pin the desktop plan after the user scrolls up during streaming', async () => {
    const { viewport } = setupHook()
    viewport.scrollTop = 1500

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })
    await triggerResize()

    expect(viewport.scrollTop).toBe(1500)
  })

  it('resumes streaming auto-scroll after the user returns to bottom', async () => {
    isMobile = true
    const { viewport } = setupHook()
    viewport.scrollTop = 1500

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })
    await triggerResize()
    expect(viewport.scrollTop).toBe(1500)

    viewport.scrollTop = 1600
    fireEvent.scroll(viewport)
    await triggerResize()

    expect(viewport.scrollTop).toBe(2000)
  })

  it('keeps non-scrollable chats at bottom after upward wheel gestures', () => {
    const { getByTestId, viewport } = setupHook({ isSending: false })
    defineReadonlyNumber(viewport, 'clientHeight', 600)
    defineReadonlyNumber(viewport, 'scrollHeight', 500)

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })

    expect(getByTestId('is-at-bottom')).toHaveTextContent('true')
  })

  it('marks scrollable chats as away from bottom after upward wheel gestures', () => {
    const { getByTestId, viewport } = setupHook({ isSending: false })
    defineReadonlyNumber(viewport, 'clientHeight', 400)
    defineReadonlyNumber(viewport, 'scrollHeight', 2000)
    viewport.scrollTop = 1500

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })

    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')
  })

  it('resets stale away-from-bottom state when content no longer overflows', async () => {
    const { getByTestId, viewport } = setupHook({ isSending: false })
    defineReadonlyNumber(viewport, 'clientHeight', 400)
    defineReadonlyNumber(viewport, 'scrollHeight', 2000)
    viewport.scrollTop = 1500

    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    })

    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')

    defineReadonlyNumber(viewport, 'scrollHeight', 350)
    await triggerResize()

    expect(getByTestId('is-at-bottom')).toHaveTextContent('true')
  })
})

describe('useScrollManagement session scroll retention (issue #594)', () => {
  beforeEach(() => {
    isMobile = false
    resizeObserverCallbacks = []
    __resetSessionScrollStateForTests()
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock,
    })
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: IntersectionObserverMock,
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function scrollTo(options: ScrollToOptions) {
        if (typeof options.top === 'number') {
          this.scrollTop = options.top
        }
      },
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(performance.now())
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetSessionScrollStateForTests()
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: originalResizeObserver,
    })
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: originalIntersectionObserver,
    })
  })

  it('saves scroll position while scrolling a session', () => {
    const { viewport } = setupHook({
      isSending: false,
      activeSessionId: 'session-a',
      messages: makeMessages(5),
    })

    // Start from the post-mount tail position, then scroll up so follow mode
    // clears the same way a real wheel-up gesture would.
    expect(viewport.scrollTop).toBe(2000)
    viewport.scrollTop = 1234
    fireEvent.scroll(viewport)

    expect(getSessionScrollState('session-a')?.scrollTop).toBe(1234)
    expect(getSessionScrollState('session-a')?.isFollowingTail).toBe(false)
  })

  it('does not overwrite a snapshot while content is not ready', () => {
    saveSessionScrollState('session-a', {
      scrollTop: 800,
      isFollowingTail: false,
      visibleCount: 30,
    })

    const { viewport } = setupHook({
      isSending: false,
      activeSessionId: 'session-a',
      contentReady: false,
      messages: makeMessages(5),
    })

    viewport.scrollTop = 0
    fireEvent.scroll(viewport)

    expect(getSessionScrollState('session-a')?.scrollTop).toBe(800)
    expect(getSessionScrollState('session-a')?.isFollowingTail).toBe(false)
  })

  it('restores a non-tail position when returning to a session', () => {
    saveSessionScrollState('session-a', {
      scrollTop: 900,
      isFollowingTail: false,
      visibleCount: 40,
    })

    const { viewport, getByTestId } = setupHook({
      isSending: false,
      activeSessionId: 'session-a',
      contentReady: true,
      messages: makeMessages(8),
    })

    expect(viewport.scrollTop).toBe(900)
    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')
  })

  it('pins to bottom for sessions that were following the tail', () => {
    saveSessionScrollState('session-a', {
      scrollTop: 100,
      isFollowingTail: true,
      visibleCount: 20,
    })

    const { viewport, getByTestId } = setupHook({
      isSending: false,
      activeSessionId: 'session-a',
      contentReady: true,
      messages: makeMessages(8),
    })

    expect(viewport.scrollTop).toBe(2000)
    expect(getByTestId('is-at-bottom')).toHaveTextContent('true')
  })

  it('restores after content becomes ready following a session switch', () => {
    saveSessionScrollState('session-b', {
      scrollTop: 700,
      isFollowingTail: false,
      visibleCount: 25,
    })

    const { viewport, getByTestId, rerenderSession } = setupHook({
      isSending: false,
      activeSessionId: 'session-a',
      contentReady: true,
      messages: makeMessages(5),
    })

    // Switch away: content not ready (Loading placeholder)
    act(() => {
      rerenderSession({
        sessionId: 'session-b',
        ready: false,
        msgs: makeMessages(5),
      })
    })

    // Content mounts for session-b — restore saved offset
    act(() => {
      rerenderSession({
        sessionId: 'session-b',
        ready: true,
        msgs: makeMessages(5),
      })
    })

    expect(viewport.scrollTop).toBe(700)
    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')
  })

  it('saves on leave and restores after a full session round-trip', () => {
    // Do not pre-seed with saveSessionScrollState — the leave layout effect
    // (persistCurrentSessionScroll) must capture the outgoing session.
    const { viewport, getByTestId, rerenderSession } = setupHook({
      isSending: false,
      activeSessionId: 'session-a',
      contentReady: true,
      messages: makeMessages(8),
    })

    expect(viewport.scrollTop).toBe(2000)

    // Scroll session-a away from the tail the same way a real gesture would.
    viewport.scrollTop = 1234
    fireEvent.scroll(viewport)

    // Switch to session-b: save-on-leave should snapshot session-a first.
    act(() => {
      rerenderSession({
        sessionId: 'session-b',
        ready: false,
        msgs: makeMessages(5),
      })
    })

    expect(getSessionScrollState('session-a')?.scrollTop).toBe(1234)
    expect(getSessionScrollState('session-a')?.isFollowingTail).toBe(false)

    act(() => {
      rerenderSession({
        sessionId: 'session-b',
        ready: true,
        msgs: makeMessages(5),
      })
    })

    // New / unvisited sessions default to the tail.
    expect(viewport.scrollTop).toBe(2000)
    expect(getByTestId('is-at-bottom')).toHaveTextContent('true')

    // Switch back to session-a through the loading → ready path and assert
    // the leave-time snapshot is restored (not a pre-seeded value).
    act(() => {
      rerenderSession({
        sessionId: 'session-a',
        ready: false,
        msgs: makeMessages(8),
      })
    })

    act(() => {
      rerenderSession({
        sessionId: 'session-a',
        ready: true,
        msgs: makeMessages(8),
      })
    })

    expect(viewport.scrollTop).toBe(1234)
    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')
  })

  it('keeps a saved restore pending until the expanded history window mounts', async () => {
    saveSessionScrollState('session-b', {
      scrollTop: 700,
      isFollowingTail: false,
      visibleCount: 40,
    })

    const { viewport, getByTestId, rerenderSession, setScrollHeight } = setupHook({
      isSending: false,
      activeSessionId: 'session-a',
      messages: makeMessages(10),
    })

    // The new session first renders with the previous session's short history
    // window, so there is temporarily no scrollable overflow.
    setScrollHeight(400)
    act(() => {
      rerenderSession({
        sessionId: 'session-b',
        msgs: makeMessages(40),
      })
    })

    expect(viewport.scrollTop).toBe(0)
    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')

    // VirtualizedMessageList then applies session-b's saved visibleCount.
    setScrollHeight(2000)
    await triggerResize()

    expect(viewport.scrollTop).toBe(700)
    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')
  })

  it('gives up on an unreachable restore and re-enables tail-following', async () => {
    // Saved offset can never be reached (history cleared / compacted).
    // Deferred restore must not latch pendingRestore forever and leave the
    // floating Bottom button + streaming auto-scroll stuck off.
    saveSessionScrollState('session-a', {
      scrollTop: 5000,
      isFollowingTail: false,
      visibleCount: 80,
    })

    const { getByTestId } = setupHook({
      isSending: false,
      activeSessionId: 'session-a',
      contentReady: true,
      messages: makeMessages(3),
      // clientHeight is 400 in the harness — no overflow, target unreachable.
      scrollHeight: 400,
    })

    expect(getByTestId('is-at-bottom')).toHaveTextContent('false')

    // Burn the deferred-restore budget via ResizeObserver (and any stall
    // retries that fire between ticks). Cap is 20 attempts.
    for (let i = 0; i < 25; i++) {
      await triggerResize()
    }

    expect(getByTestId('is-at-bottom')).toHaveTextContent('true')
  })

  it('defaults new sessions to the bottom', () => {
    const { viewport, getByTestId } = setupHook({
      isSending: false,
      activeSessionId: 'brand-new',
      contentReady: true,
      messages: makeMessages(3),
    })

    expect(viewport.scrollTop).toBe(2000)
    expect(getByTestId('is-at-bottom')).toHaveTextContent('true')
  })
})
