import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  focusTerminal,
  writeTerminalInput,
} from '@/lib/terminal-instances'
import {
  ARROW_GESTURE_CANCEL_MOVE_PX,
  ARROW_GESTURE_DEADZONE_PX,
  ARROW_GESTURE_LONG_PRESS_MS,
  ARROW_KEY_SEQUENCES,
  arrowRepeatIntervalMs,
  resolveArrowDirection,
  resolveArrowSpeedGear,
  setArrowGestureActive,
  type ArrowDirection,
  type ArrowSpeedGear,
} from '@/lib/terminal-arrow-gesture'

interface TerminalArrowGestureProps {
  terminalId: string
  /** Element that receives the long-press + drag gesture (terminal surface). */
  surfaceRef: RefObject<HTMLElement | null>
  enabled?: boolean
}

/** Pad size in CSS px — keep in sync with the rendered box. */
export const ARROW_GESTURE_PAD_SIZE = 96

const DIRECTION_ICONS = {
  up: ArrowUp,
  down: ArrowDown,
  left: ArrowLeft,
  right: ArrowRight,
} as const

const DIRECTION_CHEVRONS = {
  up: ChevronUp,
  down: ChevronDown,
  left: ChevronLeft,
  right: ChevronRight,
} as const

/**
 * Termius-style motion pad: long-press the terminal, drag up/down/left/right
 * to send arrow keys (history / cursor). Pull farther for 3 speed gears.
 *
 * Render this as a flex sibling *above* the terminal surface so the pad sits
 * in its own chrome row and never covers emulator text.
 */
export function TerminalArrowGesture({
  terminalId,
  surfaceRef,
  enabled = true,
}: TerminalArrowGestureProps) {
  const [active, setActive] = useState(false)
  const [direction, setDirection] = useState<ArrowDirection | null>(null)
  const [gear, setGear] = useState<ArrowSpeedGear>(0)
  const activeRef = useRef(false)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const directionRef = useRef<ArrowDirection | null>(null)
  const distanceRef = useRef(0)
  const gearRef = useRef<ArrowSpeedGear>(0)
  /** True until the first auto-repeat after entering a direction. */
  const awaitingFirstRepeatRef = useRef(false)

  useEffect(() => {
    if (!enabled) return
    const surface = surfaceRef.current
    if (!surface) return

    const clearLongPressTimer = () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
    }

    const clearRepeatTimer = () => {
      if (repeatTimerRef.current) {
        clearTimeout(repeatTimerRef.current)
        repeatTimerRef.current = null
      }
    }

    const sendArrow = (dir: ArrowDirection) => {
      writeTerminalInput(terminalId, ARROW_KEY_SEQUENCES[dir])
    }

    /** Start (or restart) auto-repeat. Interval is re-read each tick for gears. */
    const scheduleRepeat = () => {
      clearRepeatTimer()
      const isFirst = awaitingFirstRepeatRef.current
      const interval = arrowRepeatIntervalMs(distanceRef.current, isFirst)
      repeatTimerRef.current = setTimeout(() => {
        const dir = directionRef.current
        if (!activeRef.current || !dir) return
        awaitingFirstRepeatRef.current = false
        sendArrow(dir)
        scheduleRepeat()
      }, interval)
    }

    const activate = (x: number, y: number) => {
      activeRef.current = true
      setArrowGestureActive(terminalId, true)
      // Drag origin stays at the finger so direction tracks movement from press.
      originRef.current = { x, y }
      directionRef.current = null
      distanceRef.current = 0
      gearRef.current = 0
      awaitingFirstRepeatRef.current = false
      setDirection(null)
      setGear(0)
      setActive(true)
      focusTerminal(terminalId)
    }

    const deactivate = () => {
      clearLongPressTimer()
      clearRepeatTimer()
      activeRef.current = false
      setArrowGestureActive(terminalId, false)
      originRef.current = null
      directionRef.current = null
      distanceRef.current = 0
      gearRef.current = 0
      awaitingFirstRepeatRef.current = false
      setDirection(null)
      setGear(0)
      setActive(false)
    }

    const updateDirection = (clientX: number, clientY: number) => {
      const origin = originRef.current
      if (!origin || !activeRef.current) return

      const dx = clientX - origin.x
      const dy = clientY - origin.y
      const distance = Math.hypot(dx, dy)
      distanceRef.current = distance

      const nextDir = resolveArrowDirection(dx, dy, ARROW_GESTURE_DEADZONE_PX)
      const nextGear = nextDir
        ? resolveArrowSpeedGear(distance)
        : (0 as ArrowSpeedGear)
      const prevDir = directionRef.current
      const prevGear = gearRef.current

      if (nextGear !== prevGear) {
        gearRef.current = nextGear
        setGear(nextGear)
      }

      if (nextDir !== prevDir) {
        directionRef.current = nextDir
        setDirection(nextDir)
        if (nextDir) {
          // One deliberate step immediately; auto-repeat follows gear timing.
          sendArrow(nextDir)
          awaitingFirstRepeatRef.current = true
          scheduleRepeat()
        } else {
          clearRepeatTimer()
          awaitingFirstRepeatRef.current = false
        }
      }
      // Same direction: distance/gear refs update; next tick picks new interval.
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        deactivate()
        return
      }
      // Don't steal touches that start on the extra-keys bar.
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('[data-testid="terminal-extra-keys-bar"]')
      ) {
        return
      }

      const touch = event.touches[0]
      if (!touch) return
      clearLongPressTimer()
      originRef.current = { x: touch.clientX, y: touch.clientY }

      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        const origin = originRef.current
        if (!origin) return
        activate(origin.x, origin.y)
        // Soft haptic when available (iOS Safari / some Android).
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate(10)
          } catch {
            // ignore
          }
        }
      }, ARROW_GESTURE_LONG_PRESS_MS)
    }

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        deactivate()
        return
      }
      const touch = event.touches[0]
      if (!touch) return

      if (activeRef.current) {
        event.preventDefault()
        updateDirection(touch.clientX, touch.clientY)
        return
      }

      // Cancel pending long-press if the user is clearly scrolling.
      const origin = originRef.current
      if (origin && longPressTimerRef.current) {
        const moved = Math.hypot(
          touch.clientX - origin.x,
          touch.clientY - origin.y
        )
        if (moved > ARROW_GESTURE_CANCEL_MOVE_PX) {
          clearLongPressTimer()
          originRef.current = null
        }
      }
    }

    const onTouchEnd = () => {
      deactivate()
    }

    surface.addEventListener('touchstart', onTouchStart, { passive: true })
    surface.addEventListener('touchmove', onTouchMove, { passive: false })
    surface.addEventListener('touchend', onTouchEnd, { passive: true })
    surface.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      deactivate()
      surface.removeEventListener('touchstart', onTouchStart)
      surface.removeEventListener('touchmove', onTouchMove)
      surface.removeEventListener('touchend', onTouchEnd)
      surface.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [enabled, surfaceRef, terminalId])

  // Keep mounted while inactive so touch listeners stay registered; only the
  // chrome row is omitted so the pad never overlays terminal text.
  if (!active) return null

  return (
    <div
      data-testid="terminal-arrow-gesture-pad"
      data-gear={gear}
      data-direction={direction ?? ''}
      role="presentation"
      aria-hidden
      className="pointer-events-none flex shrink-0 justify-end px-2 pt-1.5 pb-0.5"
    >
      <div
        className={cn(
          'grid grid-cols-3 grid-rows-3 rounded-2xl',
          'border border-border/80 bg-background/90 shadow-lg backdrop-blur-md'
        )}
        style={{
          width: ARROW_GESTURE_PAD_SIZE,
          height: ARROW_GESTURE_PAD_SIZE,
        }}
      >
        <PadCell />
        <PadCell
          direction="up"
          active={direction === 'up'}
          gear={direction === 'up' ? gear : 0}
        />
        <PadCell />
        <PadCell
          direction="left"
          active={direction === 'left'}
          gear={direction === 'left' ? gear : 0}
        />
        <PadCell center gear={direction ? gear : 0} hasDirection={!!direction} />
        <PadCell
          direction="right"
          active={direction === 'right'}
          gear={direction === 'right' ? gear : 0}
        />
        <PadCell />
        <PadCell
          direction="down"
          active={direction === 'down'}
          gear={direction === 'down' ? gear : 0}
        />
        <PadCell />
      </div>
    </div>
  )
}

function PadCell({
  active,
  direction,
  gear = 0,
  center,
  hasDirection,
}: {
  active?: boolean
  direction?: ArrowDirection
  gear?: ArrowSpeedGear
  center?: boolean
  hasDirection?: boolean
}) {
  if (center) {
    // Three-step pull meter: fills 1 / 2 / 3 segments as you pull farther.
    return (
      <div className="flex items-center justify-center">
        <div
          className="flex gap-0.5"
          data-testid="terminal-arrow-gear-meter"
          data-gear={hasDirection ? gear : -1}
        >
          {([0, 1, 2] as const).map(level => (
            <span
              key={level}
              className={cn(
                'size-1.5 rounded-full transition-colors',
                hasDirection && gear >= level
                  ? level === 0
                    ? 'bg-primary/70'
                    : level === 1
                      ? 'bg-primary/85'
                      : 'bg-primary'
                  : 'bg-muted-foreground/30'
              )}
            />
          ))}
        </div>
      </div>
    )
  }

  if (!direction) {
    return <div className="flex items-center justify-center" />
  }

  const Icon = DIRECTION_ICONS[direction]
  const Chevron = DIRECTION_CHEVRONS[direction]
  // Gear 0 = single arrow; gear 1–2 stack extra chevrons so pull depth is visible.
  const chevronCount = active ? gear : 0

  return (
    <div
      className={cn(
        'flex items-center justify-center transition-transform',
        active && 'text-primary scale-105',
        !active && 'text-muted-foreground/75'
      )}
      data-testid={active ? `terminal-arrow-active-${direction}` : undefined}
      data-gear={active ? gear : undefined}
    >
      <span
        className={cn(
          'flex flex-col items-center justify-center rounded-md transition-colors',
          direction === 'left' || direction === 'right'
            ? 'flex-row'
            : 'flex-col',
          active && 'bg-primary/15 px-0.5 py-0.5'
        )}
      >
        {active && chevronCount >= 2 && (
          <Chevron
            className={cn(
              'size-2.5 opacity-70',
              (direction === 'down' || direction === 'right') && 'order-last'
            )}
            strokeWidth={2.5}
          />
        )}
        {active && chevronCount >= 1 && (
          <Chevron
            className={cn(
              'size-3 opacity-85',
              (direction === 'down' || direction === 'right') && 'order-last'
            )}
            strokeWidth={2.5}
          />
        )}
        <Icon className="size-4" strokeWidth={active ? 2.5 : 2} />
      </span>
    </div>
  )
}
