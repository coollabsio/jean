import { useCallback, useEffect, useRef, useState } from 'react'

interface SwipeBackOptions {
  onSwipeBack: () => void
  enabled?: boolean
  edgeWidth?: number
  threshold?: number
  /**
   * When true (default), a completed swipe animates content fully off-screen
   * before firing the callback (good for "go back" navigation).
   * When false, fires immediately without moving content (good for opening an
   * overlay drawer that has its own enter animation).
   */
  animateToEnd?: boolean
  /**
   * When false, skip translateX visual feedback during the drag. Use with
   * animateToEnd: false when the consumer only needs gesture detection.
   * Defaults to true when animateToEnd is true, false when animateToEnd is false.
   */
  visualFeedback?: boolean
  /**
   * Which screen edge starts the gesture.
   * - `left` (default): start near left edge, swipe right (iOS back / open left drawer)
   * - `right`: start near right edge, swipe left (open right panel / terminal)
   */
  edge?: 'left' | 'right'
}

interface SwipeBackResult {
  containerRef: React.RefObject<HTMLDivElement | null>
  translateX: number
  isSwiping: boolean
  progress: number
  transitionStyle: string
}

export function useSwipeBack({
  onSwipeBack,
  enabled = true,
  edgeWidth = 24,
  threshold = 0.35,
  animateToEnd = true,
  visualFeedback,
  edge = 'left',
}: SwipeBackOptions): SwipeBackResult {
  // Overlay-style gestures (open drawer) default to no content drag
  const showVisual = visualFeedback ?? animateToEnd

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [translateX, setTranslateX] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)
  const [progress, setProgress] = useState(0)
  const [transitionStyle, setTransitionStyle] = useState('')

  const startXRef = useRef(0)
  const startTimeRef = useRef(0)
  const lastXRef = useRef(0)
  const lastTimeRef = useRef(0)
  const swipingRef = useRef(false)
  const firedRef = useRef(false)

  const onSwipeBackRef = useRef(onSwipeBack)
  useEffect(() => {
    onSwipeBackRef.current = onSwipeBack
  }, [onSwipeBack])

  const animateToEndRef = useRef(animateToEnd)
  useEffect(() => {
    animateToEndRef.current = animateToEnd
  }, [animateToEnd])

  const showVisualRef = useRef(showVisual)
  useEffect(() => {
    showVisualRef.current = showVisual
  }, [showVisual])

  const edgeRef = useRef(edge)
  useEffect(() => {
    edgeRef.current = edge
  }, [edge])

  const isInEdgeZone = useCallback(
    (clientX: number, containerWidth: number) => {
      if (edgeRef.current === 'right') {
        return clientX >= containerWidth - edgeWidth
      }
      return clientX <= edgeWidth
    },
    [edgeWidth]
  )

  /** Positive progress in the gesture direction (right for left-edge, left for right-edge). */
  const progressDelta = useCallback((startX: number, currentX: number) => {
    if (edgeRef.current === 'right') {
      return Math.max(0, startX - currentX)
    }
    return Math.max(0, currentX - startX)
  }, [])

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (firedRef.current) return
      const touch = e.touches[0]
      if (!touch) return

      const container = containerRef.current
      const containerWidth = container?.offsetWidth ?? window.innerWidth
      if (!isInEdgeZone(touch.clientX, containerWidth)) return

      // Claim this edge gesture so nested parent swipe handlers (e.g. project
      // canvas open-sidebar under SessionChatModal) do not also start.
      e.stopPropagation()

      startXRef.current = touch.clientX
      startTimeRef.current = Date.now()
      lastXRef.current = touch.clientX
      lastTimeRef.current = Date.now()
      swipingRef.current = true
      setIsSwiping(true)
      if (showVisualRef.current) {
        setTransitionStyle('')
      }
    },
    [isInEdgeZone]
  )

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!swipingRef.current) return
      e.stopPropagation()
      if (e.cancelable) e.preventDefault()

      const touch = e.touches[0]
      if (!touch) return
      lastXRef.current = touch.clientX
      lastTimeRef.current = Date.now()
      const containerWidth =
        containerRef.current?.offsetWidth ?? window.innerWidth
      setProgress(
        Math.min(
          1,
          progressDelta(startXRef.current, touch.clientX) /
            (containerWidth * threshold)
        )
      )
      if (showVisualRef.current) {
        // Keep the drawer edge under the finger. Using only the distance from
        // touch start leaves it behind by the width of the edge start zone.
        const delta =
          edgeRef.current === 'right'
            ? Math.max(0, containerWidth - touch.clientX)
            : Math.max(0, touch.clientX)
        // Visual still uses positive translateX for left-edge swipe-right.
        // Right-edge swipe-left uses negative translateX.
        setTranslateX(edgeRef.current === 'right' ? -delta : delta)
      }
    },
    [progressDelta, threshold]
  )

  /** Abort an in-progress gesture without firing, snapping content back. */
  const cancelSwipe = useCallback(() => {
    swipingRef.current = false
    if (showVisualRef.current) {
      setTransitionStyle('transform 200ms ease-out')
      setTranslateX(0)
      setTimeout(() => {
        setIsSwiping(false)
        setProgress(0)
        setTransitionStyle('')
      }, 200)
    } else {
      setIsSwiping(false)
      setProgress(0)
    }
  }, [])

  // iOS cancels touches it claims for system gestures (e.g. edge swipe);
  // without this the gesture stays "swiping" and pins the drawer open.
  const handleTouchCancel = useCallback(
    (e: TouchEvent) => {
      if (!swipingRef.current) return
      e.stopPropagation()
      cancelSwipe()
    },
    [cancelSwipe]
  )

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (!swipingRef.current) return
      e.stopPropagation()
      swipingRef.current = false

      const container = containerRef.current
      if (!container) {
        setIsSwiping(false)
        setProgress(0)
        if (showVisualRef.current) setTranslateX(0)
        return
      }

      const containerWidth = container.offsetWidth
      const elapsed = Date.now() - startTimeRef.current
      const signedVelocity =
        elapsed > 0
          ? ((lastXRef.current - startXRef.current) / elapsed) * 1000
          : 0
      // Velocity in the gesture direction (positive = completing the gesture)
      const velocity =
        edgeRef.current === 'right' ? -signedVelocity : signedVelocity
      const currentProgress = progressDelta(startXRef.current, lastXRef.current)
      const shouldComplete =
        currentProgress > containerWidth * threshold || velocity > 500

      if (shouldComplete) {
        firedRef.current = true
        if (animateToEndRef.current && showVisualRef.current) {
          setTransitionStyle('transform 200ms ease-out')
          setTranslateX(
            edgeRef.current === 'right' ? -containerWidth : containerWidth
          )
          setTimeout(() => {
            onSwipeBackRef.current()
            // Reset after callback
            setTranslateX(0)
            setIsSwiping(false)
            setProgress(0)
            setTransitionStyle('')
            firedRef.current = false
          }, 200)
        } else {
          // Overlay open: hand off to the drawer and clear any finger-tracked
          // content offset immediately.
          onSwipeBackRef.current()
          if (showVisualRef.current) setTranslateX(0)
          setIsSwiping(false)
          setProgress(0)
          firedRef.current = false
        }
      } else {
        cancelSwipe()
      }
    },
    [threshold, progressDelta, cancelSwipe]
  )

  useEffect(() => {
    if (!enabled) return
    const el = containerRef.current
    if (!el) return

    // Tell the browser that vertical scrolling is allowed, but horizontal
    // movement belongs to this gesture. This avoids waiting for the browser's
    // native pan decision before the drawer starts following the finger.
    const previousTouchAction = el.style.touchAction
    el.style.touchAction = 'pan-y'

    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })
    el.addEventListener('touchcancel', handleTouchCancel, { passive: true })

    return () => {
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
      el.removeEventListener('touchcancel', handleTouchCancel)
      el.style.touchAction = previousTouchAction
      // Disabled (or re-bound) mid-gesture: the closing touchend never
      // reaches us, so drop the gesture instead of leaving it stuck.
      if (swipingRef.current) cancelSwipe()
    }
  }, [
    enabled,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
    cancelSwipe,
  ])

  return { containerRef, translateX, isSwiping, progress, transitionStyle }
}
