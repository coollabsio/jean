import { useCallback, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { isLocalBackend } from '@/lib/environment'
import { dragHasFiles } from '@/lib/drag-drop-utils'
import { saveAttachmentFileToDisk } from '../attachment-processing'
import {
  clearDragPaths,
  dragPathsMatchFiles,
  primeDragPaths,
  takeDragPaths,
} from '../drag-path-cache'

/**
 * Characters that are safe to write into a shell unquoted. Anything else —
 * whitespace, `$`, backticks, `;`, `&`, `(`, quotes — must be quoted: dropped
 * paths are user-controlled, and `$(id).pdf` would otherwise become command
 * substitution as soon as the user presses Enter.
 */
const PTY_SAFE_PATH = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Quote a path the way a native terminal does on file-drop, so Claude Code's
 * path detection still receives a single token. Bare path when every character
 * is shell-safe (what Claude Code expects); POSIX single-quoted otherwise
 * (e.g. macOS "Application Support"). Always trailed by a space so multiple
 * dropped files stay separated.
 */
export function formatPathForPty(path: string): string {
  if (PTY_SAFE_PATH.test(path)) return `${path} `
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
    console.error('Failed to write file path to terminal:', error)
    toast.error('Failed to insert file into terminal', {
      description: String(error),
    })
  }
}

interface TerminalFileDropHandlers {
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void
  onDrop: (event: ReactDragEvent<HTMLElement>) => void
}

interface UseTerminalFileDropResult {
  /** True while files are dragged over the terminal area */
  isDraggingFile: boolean
  dropHandlers: TerminalFileDropHandlers
}

/**
 * Handle files dropped onto a terminal: write each file's absolute path into
 * the pty (stdin), mirroring how a native terminal inserts a dropped file's
 * path. On the local desktop backend the real path is used; otherwise the file
 * is saved to app data first. Claude Code CLI then attaches it automatically.
 *
 * Stops propagation so the global drop net and the chat file-drop handler do
 * not also act on the same drop.
 */
export function useTerminalFileDrop(
  terminalId: string
): UseTerminalFileDropResult {
  const [isDraggingFile, setIsDraggingFile] = useState(false)

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!dragHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    if (isLocalBackend()) primeDragPaths()
    setIsDraggingFile(true)
  }, [])

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // Ignore leave events that move to a child of the terminal area
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    clearDragPaths()
    setIsDraggingFile(false)
  }, [])

  const onDrop = useCallback(
    async (event: ReactDragEvent<HTMLElement>) => {
      if (!dragHasFiles(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      setIsDraggingFile(false)
      // Consume before any early return so a drop we ignore cannot leave its
      // paths behind for the next drag.
      const dragPaths = isLocalBackend() ? takeDragPaths() : null

      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) return

      if (dragPaths) {
        const entries = await dragPaths
        // A stale drag pasteboard must not insert the previous drag's paths.
        if (dragPathsMatchFiles(entries, files)) {
          await writePathsToTerminal(
            terminalId,
            entries.map(e => e.path)
          )
          return
        }
      }

      const saved = await Promise.all(files.map(saveAttachmentFileToDisk))
      await writePathsToTerminal(terminalId, saved.filter(Boolean) as string[])
    },
    [terminalId]
  )

  return {
    isDraggingFile,
    dropHandlers: { onDragOver, onDragLeave, onDrop },
  }
}
