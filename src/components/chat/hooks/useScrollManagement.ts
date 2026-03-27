import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'
import type { VirtualizedMessageListHandle } from '../VirtualizedMessageList'
import type { ChatMessage } from '@/types/chat'

interface UseScrollManagementOptions {
  /** Messages array for finding findings index */
  messages: ChatMessage[] | undefined
  /** Ref to virtualized list for scrolling to specific message index */
  virtualizedListRef: RefObject<VirtualizedMessageListHandle | null>
  /** Active worktree ID — used to scroll to bottom before paint on switch */
  activeWorktreeId: string | null
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

export function useScrollManagement({
  messages,
  virtualizedListRef,
  activeWorktreeId,
  isSending,
}: UseScrollManagementOptions): UseScrollManagementReturn {
  const scrollViewportRef = useRef<HTMLDivElement>(null)

  // State for tracking if user is at the bottom of scroll area
  const [isAtBottom, setIsAtBottom] = useState(true)
  // Ref to track scroll position without re-renders (for auto-scroll logic)
  const isAtBottomRef = useRef(true)
  // Ref to track if we're currently auto-scrolling (to avoid race conditions)
  const isAutoScrollingRef = useRef(false)
  // State for tracking if findings are visible in viewport
  const [areFindingsVisible, setAreFindingsVisible] = useState(true)
  // Ref for scroll timeout cleanup
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cooldown: when user scrolls up, block handleScroll from re-setting isAtBottom for a short period
  const userScrollUpUntilRef = useRef(0)

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

    const intersectionObs = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          setAreFindingsVisible(entry.isIntersecting)
        }
      },
      { root: viewport, threshold: 0 }
    )

    const observeFindings = () => {
      const el = viewport.querySelector('[data-review-findings="unfixed"]')
      if (el !== currentTarget) {
        if (currentTarget) intersectionObs.unobserve(currentTarget)
        currentTarget = el
        if (el) {
          intersectionObs.observe(el)
        } else {
          // No findings element → treat as visible (hides "scroll to findings" button)
          setAreFindingsVisible(true)
        }
      }
    }

    // Initial check
    observeFindings()

    // Re-check when DOM changes (findings may appear/disappear)
    const mutationObs = new MutationObserver(observeFindings)
    mutationObs.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-review-findings'],
    })

    return () => {
      intersectionObs.disconnect()
      mutationObs.disconnect()
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
        isAtBottomRef.current = false
        setIsAtBottom(false)
        userScrollUpUntilRef.current = Date.now() + 1000
      } else if (e.deltaY > 0) {
        // User scrolling down — clear cooldown so bottom detection works
        userScrollUpUntilRef.current = 0
      }
    }

    viewport.addEventListener('wheel', handleWheel, { passive: true })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [])

  // [Tier 2 + 5] Auto-scroll during streaming using ResizeObserver.
  // rAF-coalesced: at most one scroll per animation frame.
  // Plan elements use direct scrollTop instead of scrollIntoView.
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
        // Don't scroll if user has scrolled away from bottom
        if (!isAtBottomRef.current) return

        // [Tier 5] If a plan is visible, pin it to the top using direct scrollTop
        const planEl = viewport.querySelector(
          '[data-plan-display]'
        ) as HTMLElement | null
        if (planEl) {
          // Accumulate offsetTop up the offsetParent chain to the viewport
          let offset = 0
          let el: HTMLElement | null = planEl
          while (el && el !== viewport) {
            offset += el.offsetTop
            el = el.offsetParent as HTMLElement | null
          }
          viewport.scrollTop = offset
        } else {
          viewport.scrollTop = viewport.scrollHeight
        }
      })
    })

    observer.observe(viewport.firstElementChild)
    return () => {
      cancelAnimationFrame(rafId)
      observer.disconnect()
    }
  }, [isSending])

  // [Tier 4] Scroll management on streaming transitions.
  // - Start: scroll to bottom so auto-scroll works for queued messages
  //   (queue processor doesn't have access to scrollToBottom).
  // - End: pin to actual bottom to catch late layout shifts from
  //   streaming → final content reflow (double-rAF ≈ 33ms).
  const wasSendingRef = useRef(false)
  useEffect(() => {
    // Streaming just started — ensure we're at bottom so ResizeObserver auto-scroll works.
    // Covers: queued messages executed by useQueueProcessor, plan approvals, direct sends.
    // Single rAF is sufficient because PlanDisplay now collapses instantly (skipAnimation)
    // when triggered programmatically, so no second layout shift to wait for.
    if (!wasSendingRef.current && isSending) {
      isAtBottomRef.current = true
      setIsAtBottom(true)
      let cancelled = false
      const viewport = scrollViewportRef.current
      if (viewport) {
        requestAnimationFrame(() => {
          if (cancelled) return
          if (isAtBottomRef.current) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
          }
        })
      }
      wasSendingRef.current = !!isSending
      return () => {
        cancelled = true
      }
    }

    // Streaming just ended — pin to actual bottom
    if (wasSendingRef.current && !isSending && isAtBottomRef.current) {
      let cancelled = false
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return
          const viewport = scrollViewportRef.current
          if (viewport && isAtBottomRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = viewport
            if (scrollHeight - scrollTop - clientHeight > 1) {
              viewport.scrollTo({ top: scrollHeight, behavior: 'instant' })
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

  // Scroll to bottom before paint when switching worktrees to prevent flash of top content
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [activeWorktreeId])

  // Scroll to bottom when messages first load for a session (async data arrival).
  // Without this, opening a session shows the top of the message list.
  const prevMessageLengthRef = useRef(messages?.length ?? 0)
  useLayoutEffect(() => {
    const currentLength = messages?.length ?? 0
    const prevLength = prevMessageLengthRef.current
    prevMessageLengthRef.current = currentLength

    if (prevLength === 0 && currentLength > 0) {
      const viewport = scrollViewportRef.current
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight
      }
    }
  }, [messages?.length])

  // [Tier 1] Handle scroll events — findings visibility removed (handled by IntersectionObserver)
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    // Skip updating isAtBottom during auto-scroll to avoid race conditions
    // This prevents the smooth scroll animation from incorrectly marking us as "not at bottom"
    if (isAutoScrollingRef.current) {
      return
    }

    const target = e.target as HTMLDivElement
    const { scrollTop, scrollHeight, clientHeight } = target
    // Consider "at bottom" if within 100px of the bottom
    const atBottom = scrollHeight - scrollTop - clientHeight < 100

    // During cooldown after user scrolled up, only allow transitions to NOT-at-bottom
    if (Date.now() < userScrollUpUntilRef.current && atBottom) {
      return
    }

    isAtBottomRef.current = atBottom
    // PERFORMANCE: Functional setState skips re-render when value hasn't changed
    setIsAtBottom(prev => (prev === atBottom ? prev : atBottom))
  }, [])

  // Handle scroll-to-bottom completion from VirtualizedMessageList
  const handleScrollToBottomHandled = useCallback(() => {
    isAtBottomRef.current = true
    setIsAtBottom(true)
  }, [])

  // [Tier 4] Scroll to bottom helper — uses scrollend event instead of 350ms timeout.
  // Findings visibility check removed (handled by IntersectionObserver).
  // Pass instant=true for user-initiated actions (answering questions, approving plans)
  // where DOM changes immediately and smooth scroll would target stale scrollHeight.
  // Default smooth is for auto-scroll during streaming.
  const scrollToBottom = useCallback((instant?: boolean) => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    // Clear existing timeout to prevent memory leaks
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }

    isAtBottomRef.current = true
    setIsAtBottom(true)

    if (instant) {
      // Instant scroll — no animation, no correction needed
      isAutoScrollingRef.current = false
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' })
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
        viewport.scrollTo({ top: scrollHeight, behavior: 'instant' })
      }
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
  }, [])

  // Mark scroll state as "at bottom" without performing any physical scroll.
  // Used when sending a message so VirtualizedMessageList's gentle scrollIntoView
  // handles the actual scrolling.
  const markAtBottom = useCallback(() => {
    isAtBottomRef.current = true
    setIsAtBottom(true)
  }, [])

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
    isAtBottomRef.current = false
    setIsAtBottom(false)
  }, [])

  // End a user-initiated keyboard scroll.
  // Unblocks handleScroll and syncs isAtBottom with actual scroll position.
  const endKeyboardScroll = useCallback(() => {
    isAutoScrollingRef.current = false
    const viewport = scrollViewportRef.current
    if (viewport) {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      const atBottom = scrollHeight - scrollTop - clientHeight < 100
      isAtBottomRef.current = atBottom
      setIsAtBottom(prev => (prev === atBottom ? prev : atBottom))
    }
  }, [])

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
