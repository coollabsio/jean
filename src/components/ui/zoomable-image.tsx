import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const MAX_SCALE = 5
const DOUBLE_TAP_SCALE = 2.5
const DOUBLE_TAP_MS = 300

interface Point {
  x: number
  y: number
}

interface View {
  scale: number
  x: number
  y: number
}

const IDENTITY: View = { scale: 1, x: 0, y: 0 }

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Pinch-zoom, drag-pan, and double-tap/double-click zoom for its children.
 * The page viewport disables browser zoom, so images need their own.
 */
export function ZoomableImage({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const [view, setView] = useState<View>(IDENTITY)
  const viewRef = useRef(view)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{
    start: View
    origin: Point
    spread: number
  } | null>(null)
  const tap = useRef({ downAt: 0, moved: false, lastTapAt: -Infinity })

  const apply = (next: View) => {
    viewRef.current = next
    setView(next)
  }

  /** Pointer position relative to the container center. */
  const local = (event: PointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    }
  }

  /** Restart the gesture from the current view and active pointers. */
  const beginGesture = () => {
    const [a, b] = [...pointers.current.values()]
    if (!a) {
      gesture.current = null
      return
    }
    gesture.current = {
      start: viewRef.current,
      origin: b ? midpoint(a, b) : a,
      spread: b ? distance(a, b) : 0,
    }
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Touch pointers are already bound to their target. Capturing them here
    // would hide pointerup from the context menu's long-press timer.
    if (event.pointerType === 'mouse') {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    pointers.current.set(event.pointerId, local(event))
    if (pointers.current.size === 1) {
      tap.current.downAt = event.timeStamp
      tap.current.moved = false
    } else {
      tap.current.moved = true
    }
    beginGesture()
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return
    pointers.current.set(event.pointerId, local(event))
    const { start, origin, spread } = gesture.current
    const [a, b] = [...pointers.current.values()]
    if (!a) return

    if (b && spread > 0) {
      const center = midpoint(a, b)
      const scale = Math.min(
        MAX_SCALE,
        Math.max(1, start.scale * (distance(a, b) / spread))
      )
      const ratio = scale / start.scale
      // Keep the content point under the fingers fixed while zooming.
      apply({
        scale,
        x: center.x - (origin.x - start.x) * ratio,
        y: center.y - (origin.y - start.y) * ratio,
      })
      return
    }

    const dx = a.x - origin.x
    const dy = a.y - origin.y
    if (Math.hypot(dx, dy) > 8) tap.current.moved = true
    if (start.scale > 1) {
      apply({ ...start, x: start.x + dx, y: start.y + dy })
    }
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return
    const { scale, x, y } = viewRef.current
    if (pointers.current.size === 0) {
      const isTap =
        !tap.current.moved &&
        event.timeStamp - tap.current.downAt < DOUBLE_TAP_MS
      if (isTap && event.timeStamp - tap.current.lastTapAt < DOUBLE_TAP_MS) {
        tap.current.lastTapAt = -Infinity
        if (scale > 1) {
          apply(IDENTITY)
        } else {
          const point = local(event)
          apply({
            scale: DOUBLE_TAP_SCALE,
            x: point.x - point.x * DOUBLE_TAP_SCALE,
            y: point.y - point.y * DOUBLE_TAP_SCALE,
          })
        }
      } else {
        tap.current.lastTapAt = isTap ? event.timeStamp : -Infinity
        if (scale <= 1 && (x !== 0 || y !== 0)) apply(IDENTITY)
      }
    }
    beginGesture()
  }

  return (
    <div
      data-testid="zoomable-image"
      className={cn(
        'flex touch-none select-none items-center justify-center overflow-hidden',
        view.scale > 1 ? 'cursor-grab' : 'cursor-zoom-in',
        className
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDragStart={event => event.preventDefault()}
    >
      <div
        className="flex max-h-full max-w-full items-center justify-center"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        {children}
      </div>
    </div>
  )
}
