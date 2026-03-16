import { memo, useCallback, useRef } from 'react'
import { Terminal } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { useTerminalStore } from '@/store/terminal-store'
import { TerminalView } from './TerminalView'

interface ModalTerminalDrawerProps {
  worktreeId: string
  worktreePath: string
}

export const ModalTerminalDrawer = memo(function ModalTerminalDrawer({
  worktreeId,
  worktreePath,
}: ModalTerminalDrawerProps) {
  const isOpen = useTerminalStore(
    state => state.modalTerminalOpen[worktreeId] ?? false
  )
  const width = useTerminalStore(state => state.modalTerminalWidth)

  const isResizing = useRef(false)

  const handleClose = useCallback(() => {
    useTerminalStore.getState().setModalTerminalOpen(worktreeId, false)
  }, [worktreeId])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const newWidth = window.innerWidth - e.clientX
      // Clamp between 300px and 95% of viewport
      const maxWidth = Math.floor(window.innerWidth * 0.95)
      useTerminalStore
        .getState()
        .setModalTerminalWidth(Math.max(300, Math.min(maxWidth, newWidth)))
    }

    const handleMouseUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  return (
    <Sheet open={isOpen} onOpenChange={open => !open && handleClose()}>
      <SheetContent
        side="right"
        modal={false}
        showCloseButton={false}
        className="flex flex-col gap-0 p-0"
        style={{ width: `${width}px`, maxWidth: '95vw' }}
      >
        {/* Resize handle on left edge */}
        <div
          className="absolute bottom-0 left-0 top-0 z-10 w-1 cursor-ew-resize hover:bg-blue-500/50"
          onMouseDown={handleResizeStart}
        />

        <SheetHeader className="shrink-0 border-b px-3 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              <SheetTitle className="text-sm">Terminal</SheetTitle>
            </div>
            <ModalCloseButton size="sm" onClick={handleClose} />
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          <TerminalView
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            isWorktreeActive={isOpen}
            hideControls
          />
        </div>
      </SheetContent>
    </Sheet>
  )
})
