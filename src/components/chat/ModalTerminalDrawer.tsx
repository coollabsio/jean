import { memo, useCallback, useRef } from 'react'
import { Terminal } from '@/components/icons/reicon'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { useTerminalStore } from '@/store/terminal-store'
import type { ModalTerminalDockMode } from '@/types/ui-state'
import { TerminalView } from './TerminalView'
import { DrawerHeader } from './DrawerHeader'

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
    'absolute z-10 after:absolute after:bg-transparent after:transition-colors after:duration-150 hover:after:bg-foreground/25 hover:after:delay-75 active:after:bg-foreground/40',
    dockMode === 'left' &&
      'right-0 top-0 bottom-0 w-1.5 cursor-ew-resize after:inset-y-0 after:right-0 after:w-px',
    dockMode === 'right' &&
      'left-0 top-0 bottom-0 w-1.5 cursor-ew-resize after:inset-y-0 after:left-0 after:w-px',
    dockMode === 'bottom' &&
      'left-0 right-0 top-0 h-1.5 cursor-ns-resize after:inset-x-0 after:top-0 after:h-px',
    isFloating &&
      'left-0 top-0 bottom-0 w-1.5 cursor-ew-resize after:inset-y-0 after:left-0 after:w-px'
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

      <DrawerHeader
        title="Terminal"
        icon={Terminal}
        dockMode={dockMode}
        onDockModeChange={handleSetDockMode}
        onClose={handleClose}
      />

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
