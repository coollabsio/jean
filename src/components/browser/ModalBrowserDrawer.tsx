import { memo, useCallback, useRef } from 'react'
import {
  Globe,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelRightDashed,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { cn } from '@/lib/utils'
import { isNativeApp } from '@/lib/environment'
import { useBrowserStore } from '@/store/browser-store'
import type { ModalBrowserDockMode } from '@/types/browser'
import { MODAL_TERMINAL_PRIMARY_ROW_CLASS } from '@/components/chat/modal-terminal-layout'
import { BrowserView } from './BrowserView'

const WIDTH_MIN = 320
const HEIGHT_MIN = 220

interface ModalBrowserDrawerProps {
  /** Worktree this drawer instance is for (per-worktree tab list). */
  worktreeId: string
  /** Which placement this instance renders. Mount 4 instances per worktree
   * (left/right/bottom/floating) — each only renders when active dockMode
   * matches and modalOpen[worktreeId] is true. Mirrors ModalTerminalDrawer. */
  dockMode: ModalBrowserDockMode
}

export const ModalBrowserDrawer = memo(function ModalBrowserDrawer({
  worktreeId,
  dockMode,
}: ModalBrowserDrawerProps) {
  const isOpen = useBrowserStore(state => state.modalOpen[worktreeId] ?? false)
  const activeDockMode = useBrowserStore(state => state.modalDockMode)
  const width = useBrowserStore(state => state.modalWidth)
  const height = useBrowserStore(state => state.modalHeight)
  const isResizing = useRef(false)

  const isFloating = dockMode === 'floating'
  const isBottom = dockMode === 'bottom'

  const handleClose = useCallback(() => {
    useBrowserStore.getState().setModalOpen(worktreeId, false)
  }, [worktreeId])

  const handleSetDockMode = useCallback((next: ModalBrowserDockMode) => {
    useBrowserStore.getState().setModalDockMode(next)
  }, [])

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isResizing.current = true
      const onMove = (m: MouseEvent) => {
        if (!isResizing.current) return
        if (dockMode === 'bottom') {
          const next = window.innerHeight - m.clientY
          const max = Math.floor(window.innerHeight * 0.85)
          useBrowserStore
            .getState()
            .setModalHeight(Math.max(HEIGHT_MIN, Math.min(max, next)))
          return
        }
        const next =
          dockMode === 'left' ? m.clientX : window.innerWidth - m.clientX
        const max = Math.floor(window.innerWidth * 0.95)
        useBrowserStore
          .getState()
          .setModalWidth(Math.max(WIDTH_MIN, Math.min(max, next)))
      }
      const onUp = () => {
        isResizing.current = false
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [dockMode]
  )

  const resizeHandleClass = cn(
    'absolute z-10 hover:bg-blue-500/50',
    dockMode === 'left' && 'right-0 top-0 bottom-0 w-1 cursor-ew-resize',
    dockMode === 'right' && 'left-0 top-0 bottom-0 w-1 cursor-ew-resize',
    dockMode === 'bottom' && 'left-0 right-0 top-0 h-1 cursor-ns-resize',
    isFloating && 'left-0 top-0 bottom-0 w-1 cursor-ew-resize'
  )

  // Only render when this instance's dockMode matches the active mode AND
  // the drawer is open AND we're in native (child webview) mode.
  if (!isNativeApp()) return null
  if (dockMode === 'floating') {
    // Floating instance shows whenever modal is open regardless of dockMode
    if (activeDockMode !== 'floating') return null
  } else if (activeDockMode !== dockMode) {
    return null
  }
  if (!isOpen) return null

  const header = (
    <div className="shrink-0 border-b">
      <div
        className={cn(
          'flex items-center justify-between gap-2 px-4 py-2',
          MODAL_TERMINAL_PRIMARY_ROW_CLASS
        )}
      >
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4" />
          {isFloating ? (
            <SheetTitle className="text-sm">Browser</SheetTitle>
          ) : (
            <div className="text-sm font-semibold">Browser</div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center rounded-md border bg-muted/30 p-0.5">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 w-7 p-0',
                dockMode === 'floating' && 'bg-muted'
              )}
              onClick={() => handleSetDockMode('floating')}
              aria-label="Float browser"
              title="Float browser"
            >
              <PanelRightDashed className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 w-7 p-0', dockMode === 'left' && 'bg-muted')}
              onClick={() => handleSetDockMode('left')}
              aria-label="Dock browser left"
              title="Dock browser left"
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 w-7 p-0', dockMode === 'right' && 'bg-muted')}
              onClick={() => handleSetDockMode('right')}
              aria-label="Dock browser right"
              title="Dock browser right"
            >
              <PanelRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 w-7 p-0', dockMode === 'bottom' && 'bg-muted')}
              onClick={() => handleSetDockMode('bottom')}
              aria-label="Dock browser bottom"
              title="Dock browser bottom"
            >
              <PanelBottom className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ModalCloseButton size="sm" onClick={handleClose} />
        </div>
      </div>
    </div>
  )

  const content = (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div
        role="separator"
        tabIndex={-1}
        aria-label="Resize browser drawer"
        className={resizeHandleClass}
        onMouseDown={handleResizeStart}
      />
      {header}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-hidden',
          // Inset BrowserView away from the resize handle so the native
          // child webview (which paints over DOM) doesn't cover the handle.
          dockMode === 'left' && 'pr-1',
          dockMode === 'right' && 'pl-1',
          dockMode === 'bottom' && 'pt-1',
          isFloating && 'pl-1'
        )}
      >
        <BrowserView
          worktreeId={worktreeId}
          isVisible={isOpen}
          relayoutNonce={`${dockMode}:${width}:${height}`}
        />
      </div>
    </div>
  )

  if (!isFloating) {
    return (
      <div
        className={cn(
          'shrink-0',
          dockMode === 'left' && 'h-full border-r',
          dockMode === 'right' && 'h-full border-l',
          dockMode === 'bottom' && 'w-full border-t'
        )}
        style={
          isBottom
            ? { height: `${height}px`, maxHeight: '85vh' }
            : { width: `${width}px`, maxWidth: '95vw' }
        }
      >
        {content}
      </div>
    )
  }

  return (
    <Sheet open={isOpen} onOpenChange={open => !open && handleClose()}>
      <SheetContent
        side="right"
        modal={false}
        showCloseButton={false}
        className="p-0"
        style={{ width: `${width}px`, maxWidth: '95vw' }}
        data-browser-host="true"
      >
        {content}
      </SheetContent>
    </Sheet>
  )
})
