import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import type { SaveImageResponse } from '@/types/chat'
import { MAX_IMAGE_SIZE } from '../image-constants'

/** Allowed file extensions for dropped images */
const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

interface UseDragAndDropImagesOptions {
  /** Whether drag-and-drop is disabled */
  disabled?: boolean
}

interface UseDragAndDropImagesResult {
  /** Whether files are currently being dragged over the window */
  isDragging: boolean
}

/**
 * Hook to handle drag-and-drop of image files using Tauri's native file drop.
 *
 * Uses Tauri's onDragDropEvent which provides direct file paths,
 * more efficient than JavaScript's DataTransfer API.
 */
export function useDragAndDropImages(
  sessionId: string | undefined,
  _containerRef: React.RefObject<HTMLElement | null>,
  options?: UseDragAndDropImagesOptions
): UseDragAndDropImagesResult {
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (options?.disabled) return

    const window = getCurrentWindow()

    const unlistenPromise = window.onDragDropEvent(event => {
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
        const imagePaths = paths.filter(path => {
          const ext = path.split('.').pop()?.toLowerCase() ?? ''
          return ALLOWED_EXTENSIONS.includes(ext)
        })

        if (imagePaths.length === 0) {
          toast.error('No image detected', {
            description: 'Only PNG, JPEG, GIF, WebP files are accepted',
          })
          return
        }

        // Process each image
        for (const sourcePath of imagePaths) {
          processDroppedImage(sourcePath, sessionId)
        }

        // Notify if some files were skipped
        const skippedCount = paths.length - imagePaths.length
        if (skippedCount > 0) {
          toast.warning(`${skippedCount} file(s) skipped`, {
            description: 'Only images are accepted',
          })
        }
      } else if (event.payload.type === 'leave') {
        // Files left the window
        setIsDragging(false)
      }
    })

    return () => {
      unlistenPromise.then(unlisten => unlisten())
    }
  }, [sessionId, options?.disabled])

  return { isDragging }
}

/**
 * Process a dropped image file by saving it via Tauri and adding to pending images.
 */
async function processDroppedImage(
  sourcePath: string,
  sessionId: string
): Promise<void> {
  try {
    const result = await invoke<SaveImageResponse>('save_dropped_image', {
      sourcePath,
    })

    const { addPendingImage } = useChatStore.getState()
    addPendingImage(sessionId, {
      id: result.id,
      path: result.path,
      filename: result.filename,
    })
  } catch (error) {
    console.error('Failed to save dropped image:', error)

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
