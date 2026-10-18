import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTheme } from '@/hooks/use-theme'
import { isNativeApp } from '@/lib/environment'
import {
  Toaster as Sonner,
  toast,
  useSonner,
  type Action,
  type ToasterProps,
  type ToastT,
} from 'sonner'

const POINTER_DISMISS_THRESHOLD = 28
const WHEEL_DISMISS_THRESHOLD = 32
const WHEEL_DISMISS_RESET_MS = 180
const TOASTER_Z_INDEX = 2147483647
const MOBILE_BREAKPOINT = 768
export const TOASTER_EXPAND_BY_DEFAULT = false

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a'))
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        'input, textarea, [contenteditable="true"], [contenteditable=""]'
      )
    )
  )
}

function getToastElement(target: EventTarget | null): Element | null {
  return (target as Element | null)?.closest?.('[data-sonner-toast]') ?? null
}

function getToastsForPosition(
  toasts: ToastT[],
  position: ToasterProps['position']
): ToastT[] {
  return toasts.filter(currentToast => {
    if (!currentToast.position) return true
    return currentToast.position === position
  })
}

function ToastGestureDismiss({ position }: Pick<ToasterProps, 'position'>) {
  const { toasts } = useSonner()
  const toastsRef = useRef(toasts)
  const positionRef = useRef(position)
  const pointerStateRef = useRef<{
    element: Element | null
    pointerId: number | null
    startX: number
    startY: number
  }>({ element: null, pointerId: null, startX: 0, startY: 0 })
  const wheelStateRef = useRef<{
    element: Element | null
    distance: number
    timeout: ReturnType<typeof setTimeout> | null
  }>({ element: null, distance: 0, timeout: null })

  useEffect(() => {
    toastsRef.current = toasts
  }, [toasts])

  useEffect(() => {
    positionRef.current = position
  }, [position])

  useEffect(() => {
    const resetWheelState = () => {
      const state = wheelStateRef.current
      if (state.timeout) clearTimeout(state.timeout)
      wheelStateRef.current = { element: null, distance: 0, timeout: null }
    }

    const resetPointerState = () => {
      pointerStateRef.current = {
        element: null,
        pointerId: null,
        startX: 0,
        startY: 0,
      }
    }

    const dismissToastFromElement = (toastElement: Element) => {
      const index = Number(toastElement.getAttribute('data-index'))
      if (!Number.isInteger(index)) return

      const positionedToasts = getToastsForPosition(
        toastsRef.current,
        positionRef.current
      )
      const targetToast = positionedToasts[index]
      if (!targetToast || targetToast.dismissible === false) return

      toast.dismiss(targetToast.id)
      resetWheelState()
      resetPointerState()
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 2 || isInteractiveTarget(event.target)) return
      const toastElement = getToastElement(event.target)
      if (!toastElement) return

      pointerStateRef.current = {
        element: toastElement,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      }
    }

    const handlePointerUp = (event: PointerEvent) => {
      const state = pointerStateRef.current
      if (!state.element || state.pointerId !== event.pointerId) return

      const distance = Math.max(
        Math.abs(event.clientX - state.startX),
        Math.abs(event.clientY - state.startY)
      )
      const toastElement = state.element
      resetPointerState()

      if (distance >= POINTER_DISMISS_THRESHOLD) {
        dismissToastFromElement(toastElement)
      }
    }

    const handleWheel = (event: WheelEvent) => {
      if (isInteractiveTarget(event.target)) return
      const toastElement = getToastElement(event.target)
      if (!toastElement) return

      const state = wheelStateRef.current
      if (state.element !== toastElement) {
        resetWheelState()
        wheelStateRef.current.element = toastElement
      }

      const nextState = wheelStateRef.current
      const distance = Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY))
      nextState.distance += distance
      if (nextState.timeout) clearTimeout(nextState.timeout)
      nextState.timeout = setTimeout(resetWheelState, WHEEL_DISMISS_RESET_MS)

      if (nextState.distance >= WHEEL_DISMISS_THRESHOLD) {
        event.preventDefault()
        dismissToastFromElement(toastElement)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', resetPointerState)
    document.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      resetWheelState()
      resetPointerState()
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', resetPointerState)
      document.removeEventListener('wheel', handleWheel)
    }
  }, [])

  return null
}

function isToastAction(action: ToastT['action']): action is Action {
  return (
    typeof action === 'object' &&
    action !== null &&
    'onClick' in action &&
    typeof action.onClick === 'function'
  )
}

export function triggerLatestToastAction(toasts: ToastT[]): boolean {
  for (let index = toasts.length - 1; index >= 0; index -= 1) {
    const targetToast = toasts[index]
    if (!targetToast) continue

    const action = targetToast.action
    if (!isToastAction(action)) continue

    action.onClick(
      new MouseEvent('click') as unknown as React.MouseEvent<
        HTMLButtonElement,
        MouseEvent
      >
    )
    toast.dismiss(targetToast.id)
    return true
  }

  return false
}

export function shouldEnableToastActionHotkey(
  viewportWidth = typeof window === 'undefined'
    ? MOBILE_BREAKPOINT
    : window.innerWidth
): boolean {
  return isNativeApp() && viewportWidth >= MOBILE_BREAKPOINT
}

function ToastActionHotkey() {
  const { toasts } = useSonner()
  const toastsRef = useRef(toasts)

  useEffect(() => {
    toastsRef.current = toasts
  }, [toasts])

  useEffect(() => {
    if (!shouldEnableToastActionHotkey()) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.code === 'Enter' &&
        !isEditableTarget(event.target)
      ) {
        if (triggerLatestToastAction(toastsRef.current)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  return null
}

const Toaster = ({
  position,
  style,
  expand = TOASTER_EXPAND_BY_DEFAULT,
  ...props
}: ToasterProps) => {
  const { theme = 'system' } = useTheme()
  const resolvedPosition = position ?? 'bottom-right'

  const content = (
    <>
      <Sonner
        theme={theme as ToasterProps['theme']}
        position={resolvedPosition}
        expand={expand}
        className="toaster group"
        style={
          {
            '--normal-bg': 'var(--toast-background)',
            '--normal-text': 'var(--popover-foreground)',
            '--normal-border': 'var(--toast-border, var(--border))',
            ...style,
            zIndex: TOASTER_Z_INDEX,
          } as React.CSSProperties
        }
        {...props}
      />
      <ToastGestureDismiss position={resolvedPosition} />
      <ToastActionHotkey />
    </>
  )

  if (typeof document === 'undefined') return content

  return createPortal(content, document.body)
}

export { Toaster }
