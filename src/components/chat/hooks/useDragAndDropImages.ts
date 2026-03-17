import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import type { SaveImageResponse, SaveTextResponse } from '@/types/chat'
import { MAX_IMAGE_SIZE } from '../image-constants'
import { isNativeApp } from '@/lib/environment'

/** Allowed file extensions for dropped images */
const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

/** Extensions handled as text files (vector formats) */
const TEXT_IMAGE_EXTENSIONS = ['svg']

interface UseDragAndDropImagesOptions {
  /** Whether drag-and-drop is disabled */
  disabled?: boolean
}

interface UseDragAndDropImagesResult {
  /** Whether files are currently being dragged over the window */
  isDragging: boolean
  /** Absolute paths of non-image files that were just dropped */
  droppedFilePaths: string[]
  /** Clear the dropped file paths after they've been consumed */
  clearDroppedFilePaths: () => void
}

/**
 * Hook to handle drag-and-drop of image files using Tauri's native file drop.
 *
 * Uses Tauri's onDragDropEvent which provides direct file paths,
 * more efficient than JavaScript's DataTransfer API.
 */
export function useDragAndDropImages(
  sessionId: string | undefined,
  options?: UseDragAndDropImagesOptions
): UseDragAndDropImagesResult {
  const [isDragging, setIsDragging] = useState(false)
  const [droppedFilePaths, setDroppedFilePaths] = useState<string[]>([])
  const clearDroppedFilePaths = useCallback(() => setDroppedFilePaths([]), [])

  useEffect(() => {
    if (options?.disabled || !isNativeApp()) return

    let cancelled = false
    let unlisten: (() => void) | null = null

    const setup = async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const appWindow = getCurrentWindow()

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

          if (!sessionId) {
            toast.error('No active session')
            return
          }

          const paths = event.payload.paths
          const imagePaths: string[] = []
          const svgPaths: string[] = []
          const otherPaths: string[] = []
          for (const path of paths) {
            const ext = path.split('.').pop()?.toLowerCase() ?? ''
            if (ALLOWED_EXTENSIONS.includes(ext)) imagePaths.push(path)
            else if (TEXT_IMAGE_EXTENSIONS.includes(ext)) svgPaths.push(path)
            else otherPaths.push(path)
          }

          // Process raster images
          for (const sourcePath of imagePaths) {
            processDroppedImage(sourcePath, sessionId)
          }

          // Process SVGs as text files
          for (const sourcePath of svgPaths) {
            processDroppedSvg(sourcePath, sessionId)
          }

          // Insert non-image file paths into chat input
          if (otherPaths.length > 0) {
            setDroppedFilePaths(otherPaths)
          }
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

  return { isDragging, droppedFilePaths, clearDroppedFilePaths }
}

/**
 * Process a dropped SVG file by reading its text content and saving as a text file.
 */
async function processDroppedSvg(
  sourcePath: string,
  sessionId: string
): Promise<void> {
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const svgText = await readTextFile(sourcePath)

    const result = await invoke<SaveTextResponse>('save_pasted_text', {
      content: svgText,
    })

    const { addPendingTextFile } = useChatStore.getState()
    addPendingTextFile(sessionId, {
      id: result.id,
      path: result.path,
      filename: sourcePath.split('/').pop() ?? result.filename,
      size: result.size,
      content: svgText,
    })
  } catch (error) {
    console.error('Failed to save dropped SVG:', error)
    toast.error('Failed to save SVG', {
      description: String(error),
    })
  }
}

/**
 * Process a dropped image file by saving it via Tauri and adding to pending images.
 */
async function processDroppedImage(
  sourcePath: string,
  sessionId: string
): Promise<void> {
  // Add loading placeholder immediately
  const placeholderId = `loading-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { addPendingImage, updatePendingImage, removePendingImage } =
    useChatStore.getState()
  addPendingImage(sessionId, {
    id: placeholderId,
    path: '',
    filename: 'Processing...',
    loading: true,
  })

  try {
    const result = await invoke<SaveImageResponse>('save_dropped_image', {
      sourcePath,
    })

    updatePendingImage(sessionId, placeholderId, {
      id: result.id,
      path: result.path,
      filename: result.filename,
      loading: false,
    })
  } catch (error) {
    console.error('Failed to save dropped image:', error)
    removePendingImage(sessionId, placeholderId)

    // Parse error message for user-friendly display
    const errorStr = String(error)
    if (errorStr.includes('too large')) {
      toast.error('Image too large', {
        description: `Maximum size: ${MAX_IMAGE_SIZE / 1024 / 1024}MB`,
      })
    } else if (errorStr.includes('Invalid image type')) {
      toast.error('Unsupported image type', {
        description: 'Accepted types: PNG, JPEG, GIF, WebP',
      })
    } else {
      toast.error('Failed to save image', {
        description: errorStr,
      })
    }
  }
}
