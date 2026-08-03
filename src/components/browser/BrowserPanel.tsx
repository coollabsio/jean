import { memo, useCallback, useEffect, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'
import { useBrowserStore } from '@/store/browser-store'
import { isNativeApp } from '@/lib/environment'
import { BrowserView } from './BrowserView'

const MIN_HEIGHT = 200
const MAX_HEIGHT_PCT = 0.85

/**
 * Bottom resizable browser panel. Pinned to the bottom of the parent flex
 * container. Per-worktree open state, global height. Native-only.
 */
export const BrowserPanel = memo(function BrowserPanel() {
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const isOpen = useBrowserStore(state =>
    activeWorktreeId
      ? (state.bottomPanelOpen[activeWorktreeId] ?? false)
      : false
  )
  const height = useBrowserStore(state => state.bottomPanelHeight)
  const containerRef = useRef<HTMLDivElement>(null)
  const isResizing = useRef(false)

  const handleClose = useCallback(() => {
    if (!activeWorktreeId) return
    useBrowserStore.getState().setBottomPanelOpen(activeWorktreeId, false)
  }, [activeWorktreeId])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    const startY = e.clientY
    const startHeight = useBrowserStore.getState().bottomPanelHeight
    let nextHeight = startHeight
    const onMove = (m: MouseEvent) => {
      if (!isResizing.current) return
      // Drag up (smaller clientY) = grow
      const delta = startY - m.clientY
      const max = Math.floor(window.innerHeight * MAX_HEIGHT_PCT)
      nextHeight = Math.max(MIN_HEIGHT, Math.min(max, startHeight + delta))
      if (containerRef.current) {
        containerRef.current.style.height = `${nextHeight}px`
      }
    }
    const onUp = () => {
      isResizing.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      useBrowserStore.getState().setBottomPanelHeight(nextHeight)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.style.height = `${height}px`
    }
  }, [height])

  if (!isNativeApp() || !isOpen || !activeWorktreeId) return null

  return (
    <div
      ref={containerRef}
      className="relative w-full shrink-0 border-t bg-card"
      style={{ height }}
    >
      {/* Resize handle (top edge) */}
      <div
        role="separator"
        tabIndex={-1}
        aria-orientation="horizontal"
        aria-label="Resize browser panel"
        className="absolute left-0 right-0 top-0 z-10 h-1 cursor-ns-resize hover:bg-blue-500/50"
        onMouseDown={handleResizeStart}
      />
      <BrowserView
        worktreeId={activeWorktreeId}
        isVisible={isOpen}
        onClose={handleClose}
      />
    </div>
  )
})
