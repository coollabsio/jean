import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import type { VirtualizedMessageListHandle } from '../VirtualizedMessageList'
import type { ChatMessage } from '@/types/chat'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  getDefaultVisibleCount,
  getSessionScrollState,
  saveSessionScrollState,
  updateSessionScrollState,
} from '../session-scroll-state'

interface UseScrollManagementOptions {
  /** Messages array for finding findings index */
  messages: ChatMessage[] | undefined
  /** Ref to virtualized list for scrolling to specific message index */
  virtualizedListRef: RefObject<VirtualizedMessageListHandle | null>
  /**
   * Session whose transcript is currently displayed (deferred session id).
   * Used as the key for per-session scroll restoration (issue #594).
   */
  activeSessionId: string | null | undefined
  /**
   * False while the message list is unmounted (session switch loading
   * placeholder, initial load). Prevents saving a zero scrollTop from the
   * short "Loading..." content over a real snapshot.
   */
  contentReady?: boolean
  /** Whether a message is currently being streamed — enables ResizeObserver auto-scroll */
  isSending?: boolean
}

interface UseScrollManagementReturn {
  /** Ref for ScrollArea viewport */
  scrollViewportRef: RefObject<HTMLDivElement | null>
  /** Whether user is at bottom of scroll */
  isAtBottom: boolean
  /** Whether findings are visible in viewport */
  areFindingsVisible: boolean
  /** Scroll to bottom with auto-scroll flag. Pass `true` for instant (no animation). */
  scrollToBottom: (instant?: boolean) => void
  /** Mark scroll state as "at bottom" without performing any physical scroll. */
  markAtBottom: () => void
  /** Scroll to findings element */
  scrollToFindings: () => void
  /** Handler for onScroll event */
  handleScroll: (e: React.UIEvent<HTMLDivElement>) => void
  /** Callback when scroll-to-bottom is handled */
  handleScrollToBottomHandled: () => void
  /** Begin a user-initiated keyboard scroll: cancels auto-scroll, blocks handleScroll updates */
  beginKeyboardScroll: () => void
  /** End a user-initiated keyboard scroll: unblocks handleScroll updates */
  endKeyboardScroll: () => void
}

const BOTTOM_THRESHOLD_PX = 100
const SCROLL_EPSILON_PX = 2
/** Cap deferred non-tail restores so an unreachable scrollTop cannot latch forever. */
const MAX_PENDING_RESTORE_ATTEMPTS = 20
/** Re-check a still-pending restore when ResizeObserver goes quiet (history trim, etc.). */
const PENDING_RESTORE_RETRY_MS = 50

function hasScrollableOverflow(viewport: HTMLDivElement) {
  return viewport.scrollHeight - viewport.clientHeight > SCROLL_EPSILON_PX
}

function isViewportAtBottom(viewport: HTMLDivElement) {
  if (!hasScrollableOverflow(viewport)) {
    return true
  }

  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
    BOTTOM_THRESHOLD_PX
  )
}

function scrollToTail(viewport: HTMLDivElement) {
  viewport.scrollTop = viewport.scrollHeight
}

export function useScrollManagement({
  messages,
  virtualizedListRef,
  activeSessionId,
  contentReady = true,
  isSending,
}: UseScrollManagementOptions): UseScrollManagementReturn {
  const isMobile = useIsMobile()
  const scrollViewportRef = useRef<HTMLDivElement>(null)

  // State for tracking if user is at the bottom of scroll area
  const [isAtBottom, setIsAtBottom] = useState(true)
  // Ref to track scroll position without re-renders (for auto-scroll logic)
  const isAtBottomRef = useRef(true)
  // Ref to track if we're currently auto-scrolling (to avoid race conditions)
  const isAutoScrollingRef = useRef(false)
  // Explicit "follow live tail" state. This is intentionally separate from
  // isAtBottom because some auto-scroll modes (for example desktop plan
  // pinning) can leave the viewport away from the physical bottom while the
  // user still wants the stream to be followed. Once the user scrolls away,
  // streaming must not fight them until they intentionally return to bottom.
  const isFollowingTailRef = useRef(true)
  // State for tracking if findings are visible in viewport
  const [areFindingsVisible, setAreFindingsVisible] = useState(true)
  // Ref for scroll timeout cleanup
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cooldown: when user scrolls up, block handleScroll from re-setting isAtBottom for a short period
  const userScrollUpUntilRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  const touchStartYRef = useRef<number | null>(null)
  // Last known good scroll snapshot for the displayed session. Updated on every
  // real scroll; used when leaving a session so Loading placeholders cannot
  // overwrite a real position with scrollTop=0.
  const lastKnownScrollRef = useRef({
    sessionId: activeSessionId ?? '',
    scrollTop: 0,
    isFollowingTail: true,
  })
  const prevSessionIdRef = useRef<string | null | undefined>(activeSessionId)
  // When true, the next content-ready layout pass should apply a saved
  // non-tail scrollTop instead of pinning to the bottom.
  const pendingRestoreRef = useRef(false)
  // Bounds deferred restores so an unreachable scrollTop cannot latch forever
  // and permanently disable tail-following (PR #605 review).
  const pendingRestoreAttemptsRef = useRef(0)
  const pendingRestoreRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  const clearPendingRestoreRetry = useCallback(() => {
    if (pendingRestoreRetryTimerRef.current != null) {
      clearTimeout(pendingRestoreRetryTimerRef.current)
      pendingRestoreRetryTimerRef.current = null
    }
  }, [])

  const persistCurrentSessionScroll = useCallback(
    (sessionId: string | null | undefined) => {
      if (!sessionId) return
      const known = lastKnownScrollRef.current
      // Prefer the ref that was continuously updated while this session was
      // displayed; fall back to whatever is already cached.
      if (known.sessionId === sessionId) {
        saveSessionScrollState(sessionId, {
          scrollTop: known.scrollTop,
          isFollowingTail: known.isFollowingTail,
          visibleCount:
            getSessionScrollState(sessionId)?.visibleCount ??
            getDefaultVisibleCount(),
        })
      }
    },
    []
  )

  const rememberScroll = useCallback(
    (scrollTop: number, isFollowingTail: boolean) => {
      const sessionId = activeSessionId
      // Skip while the list is unmounted (Loading placeholder) so we don't
      // overwrite a real snapshot with a collapsed scrollTop.
      if (!sessionId || !contentReady) return
      lastKnownScrollRef.current = {
        sessionId,
        scrollTop,
        isFollowingTail,
      }
      updateSessionScrollState(sessionId, { scrollTop, isFollowingTail })
    },
    [activeSessionId, contentReady]
  )

  const stopFollowingTail = useCallback(() => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    isAutoScrollingRef.current = false
    isFollowingTailRef.current = false
    isAtBottomRef.current = false
    setIsAtBottom(false)
    userScrollUpUntilRef.current = Date.now() + 1000
    const viewport = scrollViewportRef.current
    rememberScroll(viewport?.scrollTop ?? lastKnownScrollRef.current.scrollTop, false)
  }, [rememberScroll])

  // Cleanup scroll timeout on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
    }
  }, [])

  // [Tier 1] IntersectionObserver for findings visibility.
  // Replaces per-scroll getBoundingClientRect() calls with an observer that
  // only fires on visibility boundary crossings.
  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    let currentTarget: Element | null = null
    let disposed = false

    const intersectionObs = new IntersectionObserver(
      entries => {
        if (disposed) return
        for (const entry of entries) {
          setAreFindingsVisible(entry.isIntersecting)
        }
      },
      { root: viewport, threshold: 0 }
    )

    const mutationObs = new MutationObserver(() => {
      if (disposed) return
      const el = viewport.querySelector('[data-review-findings="unfixed"]')
      if (el === currentTarget) return
      if (currentTarget) intersectionObs.unobserve(currentTarget)
      currentTarget = el
      if (el) {
        intersectionObs.observe(el)
      } else {
        // No findings element → treat as visible (hides "scroll to findings" button)
        setAreFindingsVisible(true)
      }
    })

    // Initial check + re-check when DOM changes (findings may appear/disappear)
    mutationObs.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-review-findings'],
    })
    // Seed current findings target (MutationObserver does not fire for existing DOM)
    const initialEl = viewport.querySelector('[data-review-findings="unfixed"]')
    if (initialEl) {
      currentTarget = initialEl
      intersectionObs.observe(initialEl)
    } else {
      setAreFindingsVisible(true)
    }

    return () => {
      disposed = true
      intersectionObs.disconnect()
      mutationObs.disconnect()
      currentTarget = null
    }
  }, [])

  // Detect user scrolling up during auto-scroll and break the lock
  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User scrolling up — cancel auto-scroll and block re-activation for 1s
        if (scrollTimeoutRef.current) {
          clearTimeout(scrollTimeoutRef.current)
          scrollTimeoutRef.current = null
        }
        isAutoScrollingRef.current = false

        // Trackpads can emit upward wheel events even when the chat content
        // does not overflow. In that case no real scroll-away happened, so keep
        // the viewport logically pinned to the bottom and avoid showing the
        // floating "Bottom" button.
        if (!hasScrollableOverflow(viewport)) {
          userScrollUpUntilRef.current = 0
          isFollowingTailRef.current = true
          isAtBottomRef.current = true
          setIsAtBottom(prev => (prev ? prev : true))
          return
        }

        stopFollowingTail()
      } else if (e.deltaY > 0) {
        // User scrolling down — clear cooldown so bottom detection works
        userScrollUpUntilRef.current = 0
        if (isViewportAtBottom(viewport)) {
          isFollowingTailRef.current = true
        }
      }
    }

    viewport.addEventListener('wheel', handleWheel, { passive: true })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [stopFollowingTail])

  // Touch scrolling does not emit wheel events. Disable follow mode when the
  // gesture moves content upward (finger moves down), and resume only when the
  // actual scroll position reaches bottom.
  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    const handleTouchStart = (e: TouchEvent) => {
      touchStartYRef.current = e.touches[0]?.clientY ?? null
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (!hasScrollableOverflow(viewport)) return
      const startY = touchStartYRef.current
      const currentY = e.touches[0]?.clientY
      if (startY == null || currentY == null) return

      // Finger moving down scrolls the content upward / toward older messages.
      if (currentY - startY > 4) {
        stopFollowingTail()
      }
    }

    const handleTouchEnd = () => {
      touchStartYRef.current = null
      if (isViewportAtBottom(viewport)) {
        userScrollUpUntilRef.current = 0
        isFollowingTailRef.current = true
      }
    }

    viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
    viewport.addEventListener('touchmove', handleTouchMove, { passive: true })
    viewport.addEventListener('touchend', handleTouchEnd, { passive: true })
    viewport.addEventListener('touchcancel', handleTouchEnd, { passive: true })
    return () => {
      viewport.removeEventListener('touchstart', handleTouchStart)
      viewport.removeEventListener('touchmove', handleTouchMove)
      viewport.removeEventListener('touchend', handleTouchEnd)
      viewport.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [stopFollowingTail])

  // Apply a saved scroll snapshot (or default to bottom) for the given session.
  // Defined before size-sync / session effects so those closures can capture it
  // directly (no render-time ref smuggling — issue #594 review).
  const applySessionScrollState = useCallback(
    (sessionId: string | null | undefined) => {
      const viewport = scrollViewportRef.current
      if (!viewport) return

      const saved = sessionId ? getSessionScrollState(sessionId) : undefined

      if (!saved || saved.isFollowingTail) {
        isFollowingTailRef.current = true
        isAtBottomRef.current = true
        userScrollUpUntilRef.current = 0
        setIsAtBottom(true)
        scrollToTail(viewport)
        lastScrollTopRef.current = viewport.scrollTop
        if (sessionId) {
          lastKnownScrollRef.current = {
            sessionId,
            scrollTop: viewport.scrollTop,
            isFollowingTail: true,
          }
        }
        pendingRestoreRef.current = false
        pendingRestoreAttemptsRef.current = 0
        clearPendingRestoreRetry()
        return
      }

      // Non-tail restore: pin flags first so streaming auto-scroll does not
      // fight the restored position while content settles.
      isFollowingTailRef.current = false
      isAtBottomRef.current = false
      userScrollUpUntilRef.current = Date.now() + 1000
      setIsAtBottom(false)

      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      const targetTop = Math.min(Math.max(0, saved.scrollTop), maxScroll)
      viewport.scrollTop = targetTop
      lastScrollTopRef.current = targetTop
      lastKnownScrollRef.current = {
        sessionId: sessionId ?? '',
        scrollTop: targetTop,
        isFollowingTail: false,
      }

      // If content is still short (message list not fully mounted / virtualized
      // window not expanded yet), keep pending so ResizeObserver can re-apply
      // the target after the saved history window mounts. A session switch can
      // temporarily render the previous session's smaller visibleCount, so no
      // overflow here does not prove the saved session was following its tail.
      if (!hasScrollableOverflow(viewport)) {
        pendingRestoreRef.current = true
      } else if (
        saved.scrollTop > 0 &&
        maxScroll < saved.scrollTop - SCROLL_EPSILON_PX
      ) {
        pendingRestoreRef.current = true
      } else {
        pendingRestoreRef.current = false
        pendingRestoreAttemptsRef.current = 0
        clearPendingRestoreRetry()
        // Content may have grown such that the saved offset is now at bottom.
        if (isViewportAtBottom(viewport)) {
          isFollowingTailRef.current = true
          isAtBottomRef.current = true
          userScrollUpUntilRef.current = 0
          setIsAtBottom(true)
          lastKnownScrollRef.current = {
            sessionId: sessionId ?? '',
            scrollTop: viewport.scrollTop,
            isFollowingTail: true,
          }
          updateSessionScrollState(sessionId ?? '', {
            scrollTop: viewport.scrollTop,
            isFollowingTail: true,
          })
        }
      }
    },
    [clearPendingRestoreRetry]
  )

  // Keep scroll state honest when content/viewport size changes. If the chat no
  // longer overflows (short message list, window got taller, content collapsed),
  // it is necessarily at the bottom. This clears stale "scrolled away" state
  // without changing behavior for genuinely scrollable chats.
  // Also re-applies a pending non-tail restore once the message list grows tall
  // enough (e.g. VirtualizedMessageList expands its visible window).
  //
  // Pending restores are bounded: if a saved scrollTop never becomes reachable
  // (history cleared, run trimmed, messages compacted), retry only up to
  // MAX_PENDING_RESTORE_ATTEMPTS, then clear the latch so tail-following and
  // the no-overflow self-heal below can run again.
  //
  // useEffectEvent reads the latest activeSessionId / contentReady /
  // applySessionScrollState without re-subscribing the ResizeObserver, and
  // without render-time ref writes (react-hooks/refs).
  // Named function expression so the pending-restore retry can re-enter without
  // reading the const binding before it is initialized (react-hooks/immutability).
  const onViewportSizeChange = useEffectEvent(function onViewportSizeChange() {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    const rePinToTail = () => {
      userScrollUpUntilRef.current = 0
      isFollowingTailRef.current = true
      isAtBottomRef.current = true
      setIsAtBottom(prev => (prev ? prev : true))
    }

    if (pendingRestoreRef.current && contentReady && activeSessionId) {
      if (pendingRestoreAttemptsRef.current < MAX_PENDING_RESTORE_ATTEMPTS) {
        pendingRestoreAttemptsRef.current += 1
        applySessionScrollState(activeSessionId)
        if (pendingRestoreRef.current) {
          // Still waiting for content to grow tall enough. RO re-enters on real
          // growth; also schedule a bounded retry so a stalled, unreachable
          // snapshot cannot latch when no further size events arrive.
          clearPendingRestoreRetry()
          pendingRestoreRetryTimerRef.current = setTimeout(() => {
            pendingRestoreRetryTimerRef.current = null
            onViewportSizeChange()
          }, PENDING_RESTORE_RETRY_MS)
          return
        }
        clearPendingRestoreRetry()
        pendingRestoreAttemptsRef.current = 0
        return
      }
      // Give up on an unreachable snapshot and let the checks below re-pin.
      clearPendingRestoreRetry()
      pendingRestoreRef.current = false
      pendingRestoreAttemptsRef.current = 0
      // Clamped restores often leave the viewport at the end of shorter content;
      // treat that as following the tail again so streaming auto-scroll and the
      // floating Bottom button recover.
      if (!hasScrollableOverflow(viewport) || isViewportAtBottom(viewport)) {
        rePinToTail()
      }
      return
    }
    if (!hasScrollableOverflow(viewport)) {
      rePinToTail()
    }
  })

  useEffect(() => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    let rafId = 0
    const syncViewportSize = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        onViewportSizeChange()
      })
    }

    syncViewportSize()

    const observer = new ResizeObserver(syncViewportSize)
    observer.observe(viewport)
    if (viewport.firstElementChild) {
      observer.observe(viewport.firstElementChild)
    }

    return () => {
      cancelAnimationFrame(rafId)
      clearPendingRestoreRetry()
      observer.disconnect()
    }
    // onViewportSizeChange is an Effect Event — intentionally omitted from deps
    // (identity changes every render; React docs require not listing it).
  }, [clearPendingRestoreRetry])

  // [Tier 2 + 5] Auto-scroll during streaming using ResizeObserver.
  // rAF-coalesced: at most one scroll per animation frame.
  // Plan elements use direct scrollTop instead of scrollIntoView on desktop.
  // On mobile, always follow the live tail: pinning a plan to the top reads as
  // a jump away from the streaming response.
  useEffect(() => {
    if (!isSending) return

    const viewport = scrollViewportRef.current
    if (!viewport || !viewport.firstElementChild) return

    let rafId = 0

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        // Respect cooldown after user scrolled up
        if (Date.now() < userScrollUpUntilRef.current) return
        // Don't scroll if user has intentionally scrolled away from the stream
        if (!isFollowingTailRef.current) return

        // [Tier 5] If a plan is visible on desktop, pin it to the top using
        // direct scrollTop. Mobile should keep following the streaming tail.
        const planEl = viewport.querySelector(
          '[data-plan-display]'
        ) as HTMLElement | null
        if (!isMobile && planEl) {
          // Accumulate offsetTop up the offsetParent chain to the viewport
          let offset = 0
          let el: HTMLElement | null = planEl
          while (el && el !== viewport) {
            offset += el.offsetTop
            el = el.offsetParent as HTMLElement | null
          }
          viewport.scrollTop = offset
        } else {
          scrollToTail(viewport)
        }
      })
    })

    observer.observe(viewport.firstElementChild)
    return () => {
      cancelAnimationFrame(rafId)
      observer.disconnect()
    }
  }, [isSending, isMobile])

  // [Tier 4] Scroll management on streaming transitions.
  // - Start: if user was at bottom, smooth-scroll to follow queued/approved execution.
  //   If user scrolled up, respect their position — ResizeObserver live-tail stays disabled.
  // - End: pin to actual bottom to catch late layout shifts from
  //   streaming → final content reflow (double-rAF ≈ 33ms).
  const wasSendingRef = useRef(false)
  useEffect(() => {
    // Streaming just started.
    if (!wasSendingRef.current && isSending) {
      const viewport = scrollViewportRef.current
      // Only follow if user was already at bottom. Otherwise leave them where they are —
      // FloatingButtons' "Bottom" button is the manual escape hatch.
      if (
        viewport &&
        isFollowingTailRef.current &&
        !isAutoScrollingRef.current
      ) {
        let cancelled = false
        requestAnimationFrame(() => {
          if (cancelled || !isFollowingTailRef.current) return
          isAutoScrollingRef.current = true
          viewport.scrollTo({
            top: viewport.scrollHeight,
            behavior: 'smooth',
          })
          const onEnd = () => {
            isAutoScrollingRef.current = false
            viewport.removeEventListener('scrollend', onEnd)
            if (scrollTimeoutRef.current) {
              clearTimeout(scrollTimeoutRef.current)
              scrollTimeoutRef.current = null
            }
            // Correct any stale-scrollHeight undershoot from DOM changes mid-animation
            const { scrollTop, scrollHeight, clientHeight } = viewport
            if (
              isFollowingTailRef.current &&
              scrollHeight - scrollTop - clientHeight > 2
            ) {
              scrollToTail(viewport)
            }
          }
          viewport.addEventListener('scrollend', onEnd, { once: true })
          scrollTimeoutRef.current = setTimeout(onEnd, 400)
        })
        wasSendingRef.current = !!isSending
        return () => {
          cancelled = true
        }
      }
      wasSendingRef.current = !!isSending
      return
    }

    // Streaming just ended — pin to actual bottom
    if (wasSendingRef.current && !isSending && isFollowingTailRef.current) {
      let cancelled = false
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return
          const viewport = scrollViewportRef.current
          if (viewport && isFollowingTailRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = viewport
            if (scrollHeight - scrollTop - clientHeight > 1) {
              scrollToTail(viewport)
            }
          }
        })
      })
      wasSendingRef.current = !!isSending
      return () => {
        cancelled = true
      }
    }
    wasSendingRef.current = !!isSending
  }, [isSending])

  // Persist the previous session and prepare restore when the displayed session
  // changes (covers both tab switches and worktree switches).
  useLayoutEffect(() => {
    const prevSessionId = prevSessionIdRef.current
    if (prevSessionId && prevSessionId !== activeSessionId) {
      persistCurrentSessionScroll(prevSessionId)
    }
    prevSessionIdRef.current = activeSessionId

    // Fresh session ⇒ fresh restore budget (do not carry exhausted attempts).
    clearPendingRestoreRetry()
    pendingRestoreAttemptsRef.current = 0

    if (!activeSessionId) return

    const saved = getSessionScrollState(activeSessionId)
    pendingRestoreRef.current = Boolean(saved && !saved.isFollowingTail)

    // Only apply immediately when the message list is mounted. Otherwise wait
    // for the contentReady + messages layout effect below. contentReady is read
    // from this render's props (session-change trigger), not a mutable ref.
    if (contentReady) {
      applySessionScrollState(activeSessionId)
    } else if (!saved || saved.isFollowingTail) {
      // Default: treat as following tail so FloatingButtons / auto-scroll stay
      // correct once content mounts.
      isFollowingTailRef.current = true
      isAtBottomRef.current = true
      setIsAtBottom(true)
    } else {
      isFollowingTailRef.current = false
      isAtBottomRef.current = false
      setIsAtBottom(false)
    }
  }, [
    activeSessionId,
    contentReady,
    applySessionScrollState,
    persistCurrentSessionScroll,
    clearPendingRestoreRetry,
  ])

  // Restore (or scroll to bottom) when content becomes ready / messages arrive.
  // Covers: first open of a session, async session load, and return from the
  // session-switch Loading placeholder.
  const prevMessageLengthRef = useRef(messages?.length ?? 0)
  const prevContentReadyRef = useRef(contentReady)
  useLayoutEffect(() => {
    const currentLength = messages?.length ?? 0
    const prevLength = prevMessageLengthRef.current
    prevMessageLengthRef.current = currentLength

    const becameReady = contentReady && !prevContentReadyRef.current
    prevContentReadyRef.current = contentReady

    if (!contentReady || !activeSessionId) return

    const messagesJustLoaded = prevLength === 0 && currentLength > 0
    if (
      becameReady ||
      messagesJustLoaded ||
      pendingRestoreRef.current
    ) {
      applySessionScrollState(activeSessionId)
    }
  }, [
    contentReady,
    messages?.length,
    activeSessionId,
    applySessionScrollState,
  ])

  // [Tier 1] Handle scroll events — findings visibility removed (handled by IntersectionObserver)
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      // Skip updating isAtBottom during auto-scroll to avoid race conditions
      // This prevents the smooth scroll animation from incorrectly marking us as "not at bottom"
      if (isAutoScrollingRef.current) {
        return
      }

      // Session-switch Loading placeholder (or other unmounted list): do not
      // overwrite a real per-session snapshot with a collapsed scrollTop.
      if (!contentReady) {
        return
      }

      const target = e.target as HTMLDivElement
      const previousScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = target.scrollTop

      if (
        hasScrollableOverflow(target) &&
        target.scrollTop < previousScrollTop - SCROLL_EPSILON_PX
      ) {
        isFollowingTailRef.current = false
        userScrollUpUntilRef.current = Date.now() + 1000
      }

      const atBottom = isViewportAtBottom(target)

      if (atBottom) {
        userScrollUpUntilRef.current = 0
        isFollowingTailRef.current = true
      }

      // During cooldown after user scrolled up, only allow transitions to NOT-at-bottom
      if (Date.now() < userScrollUpUntilRef.current && atBottom) {
        rememberScroll(target.scrollTop, false)
        return
      }

      isAtBottomRef.current = atBottom
      // PERFORMANCE: Functional setState skips re-render when value hasn't changed
      setIsAtBottom(prev => (prev === atBottom ? prev : atBottom))
      rememberScroll(target.scrollTop, isFollowingTailRef.current)
    },
    [contentReady, rememberScroll]
  )

  // Handle scroll-to-bottom completion from VirtualizedMessageList
  const handleScrollToBottomHandled = useCallback(() => {
    isFollowingTailRef.current = true
    userScrollUpUntilRef.current = 0
    isAtBottomRef.current = true
    setIsAtBottom(true)
    pendingRestoreRef.current = false
    const viewport = scrollViewportRef.current
    rememberScroll(viewport?.scrollTop ?? lastKnownScrollRef.current.scrollTop, true)
  }, [rememberScroll])

  // [Tier 4] Scroll to bottom helper — uses scrollend event instead of 350ms timeout.
  // Findings visibility check removed (handled by IntersectionObserver).
  // Pass instant=true for user-initiated actions (answering questions, approving plans)
  // where DOM changes immediately and smooth scroll would target stale scrollHeight.
  // Default smooth is for auto-scroll during streaming.
  const scrollToBottom = useCallback(
    (instant?: boolean) => {
      const viewport = scrollViewportRef.current
      if (!viewport) return

      // Clear existing timeout to prevent memory leaks
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
        scrollTimeoutRef.current = null
      }

      isAtBottomRef.current = true
      isFollowingTailRef.current = true
      userScrollUpUntilRef.current = 0
      setIsAtBottom(true)
      pendingRestoreRef.current = false

      if (instant) {
        // Instant scroll — no animation, no correction needed
        isAutoScrollingRef.current = false
        scrollToTail(viewport)
        rememberScroll(viewport.scrollTop, true)
        return
      }

      // Skip if a smooth scroll is already in flight — it will reach bottom.
      // This prevents cascading animations when the auto-scroll effect fires
      // rapidly (e.g. on every streaming content block).
      if (isAutoScrollingRef.current) return

      isAutoScrollingRef.current = true

      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: 'smooth',
      })

      // Use scrollend event to detect when smooth scroll finishes.
      // Fallback to 400ms timeout for environments without scrollend support.
      const onScrollEnd = () => {
        isAutoScrollingRef.current = false
        cleanup()

        // Correct scroll position if smooth scroll ended at wrong spot
        // (DOM changes during animation can cause stale scrollHeight targeting)
        const { scrollTop, scrollHeight, clientHeight } = viewport
        if (scrollHeight - scrollTop - clientHeight > 2) {
          scrollToTail(viewport)
        }
        rememberScroll(viewport.scrollTop, true)
      }

      const cleanup = () => {
        viewport.removeEventListener('scrollend', onScrollEnd)
        if (scrollTimeoutRef.current) {
          clearTimeout(scrollTimeoutRef.current)
          scrollTimeoutRef.current = null
        }
      }

      viewport.addEventListener('scrollend', onScrollEnd, { once: true })
      // Fallback timeout in case scrollend doesn't fire
      scrollTimeoutRef.current = setTimeout(onScrollEnd, 400)
    },
    [rememberScroll]
  )

  // Mark scroll state as "at bottom" without performing any physical scroll.
  // Used when sending a message so VirtualizedMessageList's gentle scrollIntoView
  // handles the actual scrolling.
  const markAtBottom = useCallback(() => {
    isFollowingTailRef.current = true
    userScrollUpUntilRef.current = 0
    isAtBottomRef.current = true
    setIsAtBottom(true)
    pendingRestoreRef.current = false
    const viewport = scrollViewportRef.current
    rememberScroll(viewport?.scrollTop ?? lastKnownScrollRef.current.scrollTop, true)
  }, [rememberScroll])

  // Begin a user-initiated keyboard scroll.
  // Cancels any pending auto-scroll timeout AND keeps isAutoScrollingRef=true
  // so that handleScroll is blocked during the animation (prevents it from
  // re-setting isAtBottom=true on early frames when still near bottom).
  const beginKeyboardScroll = useCallback(() => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    isAutoScrollingRef.current = true
    isFollowingTailRef.current = false
    isAtBottomRef.current = false
    setIsAtBottom(false)
  }, [])

  // End a user-initiated keyboard scroll.
  // Unblocks handleScroll and syncs isAtBottom with actual scroll position.
  const endKeyboardScroll = useCallback(() => {
    isAutoScrollingRef.current = false
    const viewport = scrollViewportRef.current
    if (viewport) {
      const atBottom = isViewportAtBottom(viewport)
      if (atBottom) {
        userScrollUpUntilRef.current = 0
        isFollowingTailRef.current = true
      } else {
        isFollowingTailRef.current = false
      }
      isAtBottomRef.current = atBottom
      setIsAtBottom(prev => (prev === atBottom ? prev : atBottom))
      rememberScroll(viewport.scrollTop, isFollowingTailRef.current)
    }
  }, [rememberScroll])

  // Scroll to findings helper
  // First scroll to the message containing findings using virtualizer, then to the element.
  const scrollToFindings = useCallback(() => {
    // First try to find the element directly (if already rendered)
    const findingsEl = scrollViewportRef.current?.querySelector(
      '[data-review-findings="unfixed"]'
    )
    if (findingsEl) {
      findingsEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }

    // If element not found, find which message has findings and scroll to it.
    const msgs = messages ?? []
    const msgWithFindings = msgs.findIndex(
      msg => msg.role === 'assistant' && msg.content?.includes('<finding')
    )
    if (msgWithFindings >= 0 && virtualizedListRef.current) {
      virtualizedListRef.current.scrollToIndex(msgWithFindings, {
        align: 'start',
      })

      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
      scrollTimeoutRef.current = setTimeout(() => {
        const el = scrollViewportRef.current?.querySelector(
          '[data-review-findings="unfixed"]'
        )
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }, 100)
    }
  }, [messages, virtualizedListRef])

  return {
    scrollViewportRef,
    isAtBottom,
    areFindingsVisible,
    scrollToBottom,
    markAtBottom,
    handleScrollToBottomHandled,
    beginKeyboardScroll,
    endKeyboardScroll,
    scrollToFindings,
    handleScroll,
  }
}
