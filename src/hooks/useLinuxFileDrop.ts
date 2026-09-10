import { useEffect } from 'react'
import { toast } from 'sonner'
import { isLocalBackend } from '@/lib/environment'
import { useChatStore } from '@/store/chat-store'
import { attachDroppedPaths } from '@/components/chat/attachment-processing'
import { writePathsToTerminal } from '@/components/chat/hooks/useTerminalFileDrop'

interface LinuxFileDropPayload {
  paths: string[]
  /** Drop position in webview device pixels (from GTK drag-drop) */
  x: number
  y: number
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

/** Attach dropped files to a chat session. */
function routeToChat(paths: string[], sessionId: string | undefined): void {
  if (!sessionId) {
    toast.error('No active session', {
      description: 'Open a session to attach a dropped file',
    })
    return
  }
  // ponytail: GTK payload is bare paths, so Linux drops can't tell dirs apart yet.
  attachDroppedPaths(
    paths.map(path => ({ path, isDir: false })),
    sessionId
  )
}

/**
 * Handle OS file drops on Linux/WebKitGTK.
 *
 * On Linux, WebKitGTK handles file drops natively (DOM drag-drop does not
 * fire usable events — tauri-apps/tauri#12052), so the Rust side intercepts
 * the drop, prevents the default navigation, and emits `linux-file-drop` with
 * the file paths + drop position. Here we route by position: a drop over a
 * terminal writes the path into its pty; anywhere else attaches the file to
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
