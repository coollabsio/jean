import { memo, useCallback, useEffect, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'
import { useBrowserStore } from '@/store/browser-store'
import { isNativeApp } from '@/lib/environment'
import { BrowserView } from './BrowserView'

const MIN_WIDTH = 320
const MAX_WIDTH = 1400

/**
 * Right-side dedicated browser pane. Renders the active worktree's tabs.
 * Native-only: in web-access mode child webviews don't exist; component returns null.
 */
export const BrowserSidePane = memo(function BrowserSidePane() {
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const isOpen = useBrowserStore(state =>
    activeWorktreeId ? (state.sidePaneOpen[activeWorktreeId] ?? false) : false
  )
  const width = useBrowserStore(state => state.sidePaneWidth)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleClose = useCallback(() => {
    if (!activeWorktreeId) return
    useBrowserStore.getState().setSidePaneOpen(activeWorktreeId, false)
  }, [activeWorktreeId])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = useBrowserStore.getState().sidePaneWidth
    let nextWidth = startWidth
    const onMove = (m: MouseEvent) => {
      // Pane is on the right edge — drag left = wider
      const delta = startX - m.clientX
      nextWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta))
      if (containerRef.current) {
        containerRef.current.style.width = `${nextWidth}px`
      }
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      useBrowserStore.getState().setSidePaneWidth(nextWidth)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // Sync inline style with persisted width when it changes externally
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.style.width = `${width}px`
    }
  }, [width])

  if (!isNativeApp()) return null
  if (!isOpen || !activeWorktreeId) return null

  return (
    <>
      {/* Resize handle (1px visual + wider hit area) */}
      <div
        role="separator"
        tabIndex={-1}
        aria-orientation="vertical"
        aria-label="Resize browser pane"
        className="relative h-full w-px shrink-0 bg-border"
        onMouseDown={handleResizeStart}
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize" />
      </div>
      <div
        ref={containerRef}
        className="h-full shrink-0 overflow-hidden bg-card"
        style={{ width }}
      >
        <BrowserView
          worktreeId={activeWorktreeId}
          isVisible={true}
          onClose={handleClose}
        />
      </div>
    </>
  )
})
