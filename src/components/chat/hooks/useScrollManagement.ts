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

  // Auto-scroll during streaming using ResizeObserver.
  // Fires when the scroll content container grows (frame-perfect tracking).
  // Uses instant scroll (not smooth) to avoid cascading animation issues.
  useEffect(() => {
    if (!isSending) return

    const viewport = scrollViewportRef.current
    if (!viewport || !viewport.firstElementChild) return

    const observer = new ResizeObserver(() => {
      // Respect cooldown after user scrolled up
      if (Date.now() < userScrollUpUntilRef.current) return
      // Don't scroll if user has scrolled away from bottom
      if (!isAtBottomRef.current) return

      // If a plan is visible during streaming, pin it to the top of the viewport
      const planEl = viewport.querySelector('[data-plan-display]')
      if (planEl) {
        isAutoScrollingRef.current = true
        planEl.scrollIntoView({ block: 'start' })
        requestAnimationFrame(() => {
          isAutoScrollingRef.current = false
        })
      } else {
        viewport.scrollTop = viewport.scrollHeight
      }
    })

    observer.observe(viewport.firstElementChild)
    return () => observer.disconnect()
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

  // Handle scroll events to track if user is at bottom and if findings are visible
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

    // Check if findings element is visible in the viewport
    const findingsEl = target.querySelector('[data-review-findings="unfixed"]')
    if (findingsEl) {
      const rect = findingsEl.getBoundingClientRect()
      const containerRect = target.getBoundingClientRect()
      const isVisible =
        rect.top < containerRect.bottom && rect.bottom > containerRect.top
      setAreFindingsVisible(prev => (prev === isVisible ? prev : isVisible))
    } else {
      setAreFindingsVisible(prev => (prev === true ? prev : true))
    }
  }, [])

  // Handle scroll-to-bottom completion from VirtualizedMessageList
  const handleScrollToBottomHandled = useCallback(() => {
    isAtBottomRef.current = true
    setIsAtBottom(true)
  }, [])

  // Scroll to bottom helper
  // Pass instant=true for user-initiated actions (answering questions, approving plans)
  // where DOM changes immediately and smooth scroll would target stale scrollHeight.
  // Default smooth is for auto-scroll during streaming.
  const scrollToBottom = useCallback((instant?: boolean) => {
    const viewport = scrollViewportRef.current
    if (!viewport) return

    // Clear existing timeout to prevent memory leaks
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
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

    scrollTimeoutRef.current = setTimeout(() => {
      isAutoScrollingRef.current = false

      if (viewport) {
        // Correct scroll position if smooth scroll ended at wrong spot
        // (DOM changes during animation can cause stale scrollHeight targeting)
        const { scrollTop, scrollHeight, clientHeight } = viewport
        if (scrollHeight - scrollTop - clientHeight > 2) {
          viewport.scrollTo({ top: scrollHeight, behavior: 'instant' })
        }

        // Check findings visibility after scroll completes
        const findingsEl = viewport.querySelector(
          '[data-review-findings="unfixed"]'
        )
        if (findingsEl) {
          const rect = findingsEl.getBoundingClientRect()
          const containerRect = viewport.getBoundingClientRect()
          const isVisible =
            rect.top < containerRect.bottom && rect.bottom > containerRect.top
          setAreFindingsVisible(isVisible)
        } else {
          setAreFindingsVisible(true)
        }
      }
    }, 350)
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
