import { useCallback, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { dragHasFiles } from '@/lib/drag-drop-utils'
import {
  classifyAttachmentFile,
  saveImageFileToDisk,
} from '../attachment-processing'

/**
 * Quote a path the way a native terminal does on file-drop, so Claude Code's
 * path detection still receives a single token. Bare path when it has no
 * whitespace (what Claude Code expects); POSIX single-quoted otherwise
 * (e.g. macOS "Application Support"). Always trailed by a space so multiple
 * dropped images stay separated.
 */
export function formatPathForPty(path: string): string {
  if (!/\s/.test(path)) return `${path} `
  return `'${path.replace(/'/g, `'\\''`)}' `
}

/** Write dropped file paths into a terminal's pty (Claude Code attaches them). */
export async function writePathsToTerminal(
  terminalId: string,
  paths: string[]
): Promise<void> {
  if (paths.length === 0) return
  const data = paths.map(formatPathForPty).join('')
  try {
    await invoke('terminal_write', { terminalId, data })
  } catch (error) {
    console.error('Failed to write image path to terminal:', error)
    toast.error('Failed to insert image into terminal', {
      description: String(error),
    })
  }
}

interface TerminalImageDropHandlers {
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void
  onDrop: (event: ReactDragEvent<HTMLElement>) => void
}

interface UseTerminalImageDropResult {
  /** True while image files are dragged over the terminal area */
  isDraggingImage: boolean
  dropHandlers: TerminalImageDropHandlers
}

/**
 * Handle image files dropped onto a terminal: save each to disk and write its
 * absolute path into the pty (stdin), mirroring how a native terminal inserts a
 * dropped file's path. Claude Code CLI then attaches the image automatically.
 *
 * Stops propagation so the global drop net and the chat image-drop handler do
 * not also act on the same drop.
 */
export function useTerminalImageDrop(
  terminalId: string
): UseTerminalImageDropResult {
  const [isDraggingImage, setIsDraggingImage] = useState(false)

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!dragHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setIsDraggingImage(true)
  }, [])

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // Ignore leave events that move to a child of the terminal area
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setIsDraggingImage(false)
  }, [])

  const onDrop = useCallback(
    async (event: ReactDragEvent<HTMLElement>) => {
      if (!dragHasFiles(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      setIsDraggingImage(false)

      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) return

      const imageFiles = files.filter(
        file =>
          classifyAttachmentFile(file) === 'raster' ||
          file.name.toLowerCase().endsWith('.svg')
      )
      if (imageFiles.length === 0) {
        toast.error('No image detected', {
          description: 'Only PNG, JPEG, GIF, WebP, SVG files are accepted',
        })
        return
      }

      const saved = await Promise.all(imageFiles.map(saveImageFileToDisk))
      await writePathsToTerminal(terminalId, saved.filter(Boolean) as string[])
    },
    [terminalId]
  )

  return {
    isDraggingImage,
    dropHandlers: { onDragOver, onDragLeave, onDrop },
  }
}
