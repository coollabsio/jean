import { useRef, useState, type ReactNode, type TouchEvent } from 'react'
import { cn } from '@/lib/utils'

const ACTION_WIDTH = 88
// Movement needed before we know if the gesture is a swipe or a scroll
const LOCK_DISTANCE = 8

export type SwipeEndResult = 'trigger' | 'open' | 'reset'

/** What a swipe ends in, from its leftward distance and the row width. */
export function resolveSwipeEnd(
  offset: number,
  rowWidth: number
): SwipeEndResult {
  const distance = -offset
  if (distance >= rowWidth * 0.5) return 'trigger'
  if (distance >= ACTION_WIDTH / 2) return 'open'
  return 'reset'
}

interface SwipeActionRowProps {
  children: ReactNode
  actionLabel: string
  onAction: () => void
  enabled?: boolean
}

/**
 * Swipe left to show a destructive action (iOS style). A long swipe runs
 * the action directly. A short swipe keeps the action button visible.
 */
export function SwipeActionRow({
  children,
  actionLabel,
  onAction,
  enabled = true,
}: SwipeActionRowProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const gesture = useRef<{
    startX: number
    startY: number
    baseOffset: number
    axis: 'x' | 'y' | null
  } | null>(null)
  // Blocks the click that follows a swipe, so the row does not open
  const suppressClick = useRef(false)

  if (!enabled) return <>{children}</>

  const handleTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    suppressClick.current = false
    gesture.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      baseOffset: offset,
      axis: null,
    }
  }

  const handleTouchMove = (e: TouchEvent) => {
    const g = gesture.current
    const touch = e.touches[0]
    if (!g || !touch) return
    const dx = touch.clientX - g.startX
    const dy = touch.clientY - g.startY
    if (!g.axis) {
      if (Math.abs(dx) < LOCK_DISTANCE && Math.abs(dy) < LOCK_DISTANCE) return
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (g.axis === 'x') setDragging(true)
    }
    if (g.axis !== 'x') return
    setOffset(Math.min(0, g.baseOffset + dx))
  }

  const handleTouchEnd = () => {
    const g = gesture.current
    gesture.current = null
    if (!g || g.axis !== 'x') {
      // A tap on an open row closes it instead of opening the session
      if (offset !== 0 && g?.axis === null) {
        suppressClick.current = true
        setOffset(0)
      }
      return
    }
    suppressClick.current = true
    setDragging(false)
    const result = resolveSwipeEnd(offset, rowRef.current?.offsetWidth ?? 0)
    setOffset(result === 'open' ? -ACTION_WIDTH : 0)
    if (result === 'trigger') onAction()
  }

  return (
    <div ref={rowRef} className="relative overflow-hidden rounded-md">
      <button
        type="button"
        onClick={() => {
          setOffset(0)
          onAction()
        }}
        className="absolute inset-y-0 right-0 flex items-center justify-end bg-destructive pr-5 text-sm font-medium text-white"
        style={{ width: Math.max(ACTION_WIDTH, -offset) }}
        tabIndex={offset === 0 ? -1 : 0}
        aria-hidden={offset === 0}
      >
        {actionLabel}
      </button>
      <div
        className={cn(
          'relative touch-pan-y bg-background',
          !dragging && 'transition-transform duration-200 ease-out'
        )}
        style={{ transform: `translateX(${offset}px)` }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onClickCapture={e => {
          if (!suppressClick.current) return
          suppressClick.current = false
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {children}
      </div>
    </div>
  )
}
