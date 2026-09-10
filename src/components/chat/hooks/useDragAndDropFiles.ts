import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { isLocalBackend } from '@/lib/environment'
import { dragHasFiles } from '@/lib/drag-drop-utils'
import {
  attachDroppedPaths,
  processAttachmentFiles,
} from '../attachment-processing'
import {
  clearDragPaths,
  dragPathsMatchFiles,
  primeDragPaths,
  takeDragPaths,
} from '../drag-path-cache'

interface UseDragAndDropFilesOptions {
  /** Whether drag-and-drop is disabled */
  disabled?: boolean
}

interface UseDragAndDropFilesResult {
  /** Whether files are currently being dragged over the window */
  isDragging: boolean
}

/**
 * Hook to handle drag-and-drop of files into the chat.
 *
 * In Tauri, native onDragDropEvent provides direct file paths when enabled.
 * When Tauri native drag/drop is disabled (required for native browser DnD
 * libraries like Pragmatic drag and drop), this falls back to browser
 * DataTransfer.files. On the local desktop backend it first asks the shell for
 * the dropped files' real paths so non-image files are referenced in place
 * instead of being copied into app data.
 */
export function useDragAndDropFiles(
  sessionId: string | undefined,
  options?: UseDragAndDropFilesOptions
): UseDragAndDropFilesResult {
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (options?.disabled) return

    let browserLastDropTime = 0

    const hasFiles = (event: DragEvent) => dragHasFiles(event.dataTransfer)

    const handleBrowserDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      if (isLocalBackend()) primeDragPaths()
      setIsDragging(true)
    }

    const handleBrowserDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (isLocalBackend()) primeDragPaths()
      setIsDragging(true)
    }

    const handleBrowserDrop = async (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setIsDragging(false)
      // Consume before any early return so a drop we ignore cannot leave its
      // paths behind for the next drag.
      const dragPaths = isLocalBackend() ? takeDragPaths() : null

      const now = Date.now()
      if (now - browserLastDropTime < 500) return
      browserLastDropTime = now

      if (!sessionId) {
        toast.error('No active session')
        return
      }

      const files = event.dataTransfer?.files
      if (!files || files.length === 0) return

      if (dragPaths) {
        const entries = await dragPaths
        // A stale drag pasteboard must not attach the previous drag's files.
        if (dragPathsMatchFiles(entries, files)) {
          await attachDroppedPaths(entries, sessionId)
          return
        }
      }
      await processAttachmentFiles(files, sessionId)
    }

    const handleBrowserDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      if (event.relatedTarget != null) return
      clearDragPaths()
      setIsDragging(false)
    }

    window.addEventListener('dragenter', handleBrowserDragEnter)
    window.addEventListener('dragover', handleBrowserDragOver)
    window.addEventListener('drop', handleBrowserDrop)
    window.addEventListener('dragleave', handleBrowserDragLeave)

    return () => {
      window.removeEventListener('dragenter', handleBrowserDragEnter)
      window.removeEventListener('dragover', handleBrowserDragOver)
      window.removeEventListener('drop', handleBrowserDrop)
      window.removeEventListener('dragleave', handleBrowserDragLeave)
    }
  }, [sessionId, options?.disabled])

  useEffect(() => {
    if (options?.disabled || !isLocalBackend()) return

    let cancelled = false
    let unlisten: (() => void) | null = null

    const setup = async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const appWindow = getCurrentWindow()

      let lastDropTime = 0
      const unlistenFn = await appWindow.onDragDropEvent(event => {
        if (event.payload.type === 'enter') {
          // Files entered the window
          setIsDragging(true)
        } else if (event.payload.type === 'over') {
          // Files are hovering - keep drag state active
          // Note: 'over' event only has position, not paths
        } else if (event.payload.type === 'drop') {
          // Files dropped
          setIsDragging(false)

          // Guard against duplicate drop events (macOS can fire twice)
          const now = Date.now()
          if (now - lastDropTime < 500) return
          lastDropTime = now

          if (!sessionId) {
            toast.error('No active session')
            return
          }

          attachDroppedPaths(
            event.payload.paths.map(path => ({ path, isDir: false })),
            sessionId
          )
        } else if (event.payload.type === 'leave') {
          // Files left the window
          setIsDragging(false)
        }
      })

      if (!cancelled) {
        unlisten = unlistenFn
      } else {
        unlistenFn()
      }
    }

    setup()

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [sessionId, options?.disabled])

  return { isDragging }
}
