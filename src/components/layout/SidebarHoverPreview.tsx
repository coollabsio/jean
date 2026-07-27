import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils'

const OPEN_DELAY_MS = 200
const CLOSE_DELAY_MS = 300
const TRANSITION_MS = 180

const INTERACTIVE_POPUP_SELECTOR = [
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="context-menu-sub-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="select-content"]',
].join(',')

const BLOCKING_OVERLAY_SELECTOR = [
  '[data-slot="dialog-overlay"][data-state="open"]',
  '[data-slot="alert-dialog-overlay"][data-state="open"]',
  '[data-slot="sheet-overlay"][data-state="open"]',
].join(',')

function isPreviewSurface(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        `[data-sidebar-hover-preview], ${INTERACTIVE_POPUP_SELECTOR}`
      )
    )
  )
}

function findInteractivePopup(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest(INTERACTIVE_POPUP_SELECTOR)
    : null
}

interface SidebarHoverPreviewProps {
  enabled: boolean
  width: number
  children: ReactNode
}

export function SidebarHoverPreview({
  enabled,
  width,
  children,
}: Readonly<SidebarHoverPreviewProps>) {
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animationFrame = useRef<number | null>(null)
  const pointerInside = useRef(false)
  const pointerInPopup = useRef(false)
  const activePopup = useRef<Element | null>(null)
  const dragging = useRef(false)

  const clearTimer = useCallback(
    (timer: React.RefObject<ReturnType<typeof setTimeout> | null>) => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    },
    []
  )

  const cancelClose = useCallback(() => {
    clearTimer(closeTimer)
    clearTimer(unmountTimer)
  }, [clearTimer])

  const closePreview = useCallback(() => {
    clearTimer(openTimer)
    clearTimer(closeTimer)
    setOpen(false)
    clearTimer(unmountTimer)
    unmountTimer.current = setTimeout(() => {
      unmountTimer.current = null
      setMounted(false)
    }, TRANSITION_MS)
  }, [clearTimer])

  const scheduleClose = useCallback(() => {
    clearTimer(openTimer)
    if (dragging.current || pointerInside.current || pointerInPopup.current) {
      return
    }

    clearTimer(closeTimer)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      if (
        !dragging.current &&
        !pointerInside.current &&
        !pointerInPopup.current
      ) {
        closePreview()
      }
    }, CLOSE_DELAY_MS)
  }, [clearTimer, closePreview])

  const handleHotspotEnter = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') return

      pointerInside.current = true
      cancelClose()
      clearTimer(openTimer)
      openTimer.current = setTimeout(() => {
        openTimer.current = null
        setMounted(true)
      }, OPEN_DELAY_MS)
    },
    [cancelClose, clearTimer]
  )

  const handleHotspotLeave = useCallback(() => {
    pointerInside.current = false
    if (!mounted) {
      clearTimer(openTimer)
      return
    }
    scheduleClose()
  }, [clearTimer, mounted, scheduleClose])

  const handlePreviewEnter = useCallback(() => {
    pointerInside.current = true
    cancelClose()
  }, [cancelClose])

  const handlePreviewLeave = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      pointerInside.current = false
      if (isPreviewSurface(event.relatedTarget)) {
        activePopup.current = findInteractivePopup(event.relatedTarget)
        pointerInPopup.current = activePopup.current !== null
        cancelClose()
        return
      }
      scheduleClose()
    },
    [cancelClose, scheduleClose]
  )

  useEffect(() => {
    if (!mounted) return

    animationFrame.current = requestAnimationFrame(() => {
      animationFrame.current = null
      setOpen(true)
    })

    return () => {
      if (animationFrame.current !== null) {
        cancelAnimationFrame(animationFrame.current)
        animationFrame.current = null
      }
    }
  }, [mounted])

  useEffect(() => {
    if (!mounted) return

    const handlePointerOver = (event: PointerEvent) => {
      const popup = findInteractivePopup(event.target)
      if (!popup) return
      activePopup.current = popup
      pointerInPopup.current = true
      cancelClose()
    }
    const handleDocumentMutation = () => {
      if (document.querySelector(BLOCKING_OVERLAY_SELECTOR)) {
        pointerInside.current = false
        closePreview()
        return
      }

      const popup = activePopup.current
      if (
        popup &&
        popup.isConnected &&
        popup.getAttribute('data-state') !== 'closed'
      ) {
        return
      }
      activePopup.current = null
      pointerInPopup.current = false
      scheduleClose()
    }
    const handleDragStart = () => {
      dragging.current = true
      cancelClose()
    }
    const handleDragOver = (event: DragEvent) => {
      pointerInside.current = isPreviewSurface(event.target)
    }
    const handleDragEnd = () => {
      dragging.current = false
      scheduleClose()
    }

    document.addEventListener('pointerover', handlePointerOver)
    document.addEventListener('dragstart', handleDragStart, true)
    document.addEventListener('dragover', handleDragOver, true)
    document.addEventListener('dragend', handleDragEnd, true)
    const documentObserver = new MutationObserver(handleDocumentMutation)
    documentObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    })

    return () => {
      document.removeEventListener('pointerover', handlePointerOver)
      document.removeEventListener('dragstart', handleDragStart, true)
      document.removeEventListener('dragover', handleDragOver, true)
      document.removeEventListener('dragend', handleDragEnd, true)
      documentObserver.disconnect()
    }
  }, [cancelClose, closePreview, mounted, scheduleClose])

  useEffect(() => {
    if (enabled) return

    pointerInside.current = false
    pointerInPopup.current = false
    activePopup.current = null
    dragging.current = false
    clearTimer(openTimer)
    clearTimer(closeTimer)
    clearTimer(unmountTimer)
    setOpen(false)
    setMounted(false)
  }, [clearTimer, enabled])

  useEffect(
    () => () => {
      clearTimer(openTimer)
      clearTimer(closeTimer)
      clearTimer(unmountTimer)
    },
    [clearTimer]
  )

  if (!enabled) return null

  return (
    <>
      {!mounted && (
        <div
          data-testid="sidebar-hover-hotspot"
          className="fixed top-8 bottom-0 left-0 z-45 w-4"
          onPointerEnter={handleHotspotEnter}
          onPointerLeave={handleHotspotLeave}
        />
      )}
      {mounted && (
        <div
          data-sidebar-hover-preview
          data-testid="sidebar-hover-preview"
          data-open={open}
          className={cn(
            'fixed top-8 bottom-2 left-2 z-40 overflow-hidden border rounded-lg bg-sidebar' +
              ' shadow-xl',
            'transition-transform duration-180 ease-out motion-reduce:transition-none',
            open ? 'translate-x-0' : '-translate-x-full'
          )}
          style={{ width }}
          onPointerEnter={handlePreviewEnter}
          onPointerLeave={handlePreviewLeave}
        >
          {children}
        </div>
      )}
    </>
  )
}
