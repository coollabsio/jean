import { useEffect } from 'react'
import { toast } from 'sonner'
import { isLocalBackend } from '@/lib/environment'
import { useChatStore } from '@/store/chat-store'
import {
  classifyAttachmentFile,
  type AttachmentFileKind,
} from '@/components/chat/attachment-processing'
import {
  processDroppedImage,
  processDroppedSvg,
} from '@/components/chat/hooks/useDragAndDropImages'
import { writePathsToTerminal } from '@/components/chat/hooks/useTerminalImageDrop'

interface LinuxFileDropPayload {
  paths: string[]
  /** Drop position in webview device pixels (from GTK drag-drop) */
  x: number
  y: number
}

/** Classify a dropped path by extension (reusing the chat attachment rules). */
function classifyPath(path: string): AttachmentFileKind {
  return classifyAttachmentFile({ name: path, type: '' })
}

interface DropTarget {
  terminalId: string | null
  sessionId: string | null
}

/** Resolve what is under the drop point: a terminal and/or a chat session. */
function dropTargetAtPoint(x: number, y: number): DropTarget {
  const cssX = x / window.devicePixelRatio
  const cssY = y / window.devicePixelRatio
  const el = document.elementFromPoint(cssX, cssY)
  return {
    terminalId:
      el?.closest('[data-terminal-id]')?.getAttribute('data-terminal-id') ??
      null,
    sessionId:
      el
        ?.closest('[data-chat-session-id]')
        ?.getAttribute('data-chat-session-id') ?? null,
  }
}

/** Active chat session from the store (fallback when the drop point has none). */
function activeSessionId(): string | undefined {
  const { activeWorktreeId, activeSessionIds } = useChatStore.getState()
  return activeWorktreeId ? activeSessionIds[activeWorktreeId] : undefined
}

/** Attach dropped images to a chat session. */
function routeToChat(paths: string[], sessionId: string | undefined): void {
  if (!sessionId) {
    toast.error('No active session', {
      description: 'Open a session to attach a dropped image',
    })
    return
  }

  let handled = false
  for (const path of paths) {
    const kind = classifyPath(path)
    if (kind === 'raster') {
      processDroppedImage(path, sessionId)
      handled = true
    } else if (kind === 'svg') {
      processDroppedSvg(path, sessionId)
      handled = true
    }
  }
  if (!handled) {
    toast.error('No image detected', {
      description: 'Only PNG, JPEG, GIF, WebP, SVG files are accepted',
    })
  }
}

/**
 * Handle OS file drops on Linux/WebKitGTK.
 *
 * On Linux, WebKitGTK handles file drops natively (DOM drag-drop does not
 * fire usable events — tauri-apps/tauri#12052), so the Rust side intercepts
 * the drop, prevents the default navigation, and emits `linux-file-drop` with
 * the file paths + drop position. Here we route by position: a drop over a
 * terminal writes the path into its pty; anywhere else attaches the image to
 * the active chat session.
 */
export function useLinuxFileDrop(): void {
  useEffect(() => {
    if (!isLocalBackend()) return

    let unlisten: (() => void) | null = null
    let cancelled = false

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<LinuxFileDropPayload>('linux-file-drop', event => {
        const { paths, x, y } = event.payload
        if (!paths || paths.length === 0) return

        const { terminalId, sessionId } = dropTargetAtPoint(x, y)
        if (terminalId) {
          writePathsToTerminal(terminalId, paths)
        } else {
          routeToChat(paths, sessionId ?? activeSessionId())
        }
      }).then(fn => {
        if (cancelled) fn()
        else unlisten = fn
      })
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
