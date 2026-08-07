import { memo, useCallback, useRef } from 'react'
import {
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelRightDashed,
  Terminal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { cn } from '@/lib/utils'
import { useTerminalStore } from '@/store/terminal-store'
import type { ModalTerminalDockMode } from '@/types/ui-state'
import { TerminalView } from './TerminalView'
import { MODAL_TERMINAL_PRIMARY_ROW_CLASS } from './modal-terminal-layout'

interface ModalTerminalDrawerProps {
  worktreeId: string
  worktreePath: string
  dockMode: ModalTerminalDockMode
}

const WIDTH_MIN = 300
const HEIGHT_MIN = 180

export const ModalTerminalDrawer = memo(function ModalTerminalDrawer({
  worktreeId,
  worktreePath,
  dockMode,
}: ModalTerminalDrawerProps) {
  const isOpen = useTerminalStore(
    state => state.modalTerminalOpen[worktreeId] ?? false
  )
  const width = useTerminalStore(state => state.modalTerminalWidth)
  const height = useTerminalStore(state => state.modalTerminalHeight)

  const isResizing = useRef(false)
  const isFloating = dockMode === 'floating'
  const isBottom = dockMode === 'bottom'

  const handleClose = useCallback(() => {
    useTerminalStore.getState().setModalTerminalOpen(worktreeId, false)
  }, [worktreeId])

  const handleSetDockMode = useCallback(
    (nextDockMode: ModalTerminalDockMode) => {
      useTerminalStore.getState().setModalTerminalDockMode(nextDockMode)
    },
    []
  )

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isResizing.current = true

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizing.current) return

        if (dockMode === 'bottom') {
          const newHeight = window.innerHeight - moveEvent.clientY
          const maxHeight = Math.floor(window.innerHeight * 0.8)
          useTerminalStore
            .getState()
            .setModalTerminalHeight(
              Math.max(HEIGHT_MIN, Math.min(maxHeight, newHeight))
            )
          return
        }

        const newWidth =
          dockMode === 'left'
            ? moveEvent.clientX
            : window.innerWidth - moveEvent.clientX
        const maxWidth = Math.floor(window.innerWidth * 0.95)
        useTerminalStore
          .getState()
          .setModalTerminalWidth(
            Math.max(WIDTH_MIN, Math.min(maxWidth, newWidth))
          )
      }

      const handleMouseUp = () => {
        isResizing.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
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

  const title = isFloating ? (
    <SheetTitle className="text-sm">Terminal</SheetTitle>
  ) : (
    <div className="text-sm font-semibold">Terminal</div>
  )

  const content = (
    <div
      data-terminal-root="true"
      className="relative flex h-full min-h-0 min-w-0 flex-col gap-0 bg-background"
    >
      <div
        role="separator"
        tabIndex={-1}
        aria-label="Resize terminal drawer"
        className={resizeHandleClass}
        onMouseDown={handleResizeStart}
      />

      <div className="shrink-0 border-b">
        <div
          className={cn(
            'flex items-center justify-between gap-2 px-4 py-2',
            MODAL_TERMINAL_PRIMARY_ROW_CLASS
          )}
        >
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            {title}
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
                aria-label="Float terminal"
                title="Float terminal"
              >
                <PanelRightDashed className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 w-7 p-0', dockMode === 'left' && 'bg-muted')}
                onClick={() => handleSetDockMode('left')}
                aria-label="Dock terminal left"
                title="Dock terminal left"
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-7 w-7 p-0',
                  dockMode === 'right' && 'bg-muted'
                )}
                onClick={() => handleSetDockMode('right')}
                aria-label="Dock terminal right"
                title="Dock terminal right"
              >
                <PanelRight className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-7 w-7 p-0',
                  dockMode === 'bottom' && 'bg-muted'
                )}
                onClick={() => handleSetDockMode('bottom')}
                aria-label="Dock terminal bottom"
                title="Dock terminal bottom"
              >
                <PanelBottom className="h-3.5 w-3.5" />
              </Button>
            </div>
            <ModalCloseButton size="sm" onClick={handleClose} />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <TerminalView
          worktreeId={worktreeId}
          worktreePath={worktreePath}
          isWorktreeActive={isOpen}
          hideControls
        />
      </div>
    </div>
  )

  if (!isOpen) return null

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
            ? { height: `${height}px`, maxHeight: '80vh' }
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
        data-terminal-host="true"
      >
        {content}
      </SheetContent>
    </Sheet>
  )
})
