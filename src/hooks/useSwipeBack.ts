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
      if (showVisualRef.current) {
        const delta = progressDelta(startXRef.current, touch.clientX)
        // Visual still uses positive translateX for left-edge swipe-right.
        // Right-edge swipe-left uses negative translateX.
        setTranslateX(edgeRef.current === 'right' ? -delta : delta)
      }
    },
    [progressDelta]
  )

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (!swipingRef.current) return
      e.stopPropagation()
      swipingRef.current = false

      const container = containerRef.current
      if (!container) {
        setIsSwiping(false)
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
            setTransitionStyle('')
            firedRef.current = false
          }, 200)
        } else {
          // Overlay open: hand off to the drawer and clear any finger-tracked
          // content offset immediately.
          onSwipeBackRef.current()
          if (showVisualRef.current) setTranslateX(0)
          setIsSwiping(false)
          firedRef.current = false
        }
      } else {
        if (showVisualRef.current) {
          setTransitionStyle('transform 200ms ease-out')
          setTranslateX(0)
          setTimeout(() => {
            setIsSwiping(false)
            setTransitionStyle('')
          }, 200)
        } else {
          setIsSwiping(false)
        }
      }
    },
    [threshold, progressDelta]
  )

  useEffect(() => {
    if (!enabled) return
    const el = containerRef.current
    if (!el) return

    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
    }
  }, [enabled, handleTouchStart, handleTouchMove, handleTouchEnd])

  return { containerRef, translateX, isSwiping, transitionStyle }
}
