import { useEffect } from 'react'
import { MessageSquare, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { invoke, listen } from '@/lib/transport'
import { useUIStore } from '@/store/ui-store'
import { SingleTerminalView } from './TerminalView'

interface FullScreenTerminalSurfaceProps {
  worktreeId: string
  worktreePath: string
  terminalId: string
  sessionId?: string
  isActive?: boolean
  className?: string
  showHeader?: boolean
}

export function FullScreenTerminalSurface({
  worktreeId,
  worktreePath,
  terminalId,
  sessionId,
  isActive = true,
  className,
  showHeader = false,
}: FullScreenTerminalSurfaceProps) {
  const switchToChat = () => {
    if (sessionId) {
      useUIStore.getState().setSessionPrimarySurface(sessionId, 'chat')
    }
  }

  // While this terminal session is on screen, the user is viewing it: clear the
  // Claude Code "needs attention" signal as soon as it fires (window focused),
  // and when the window regains focus if an attention arrived while it was
  // blurred — so the session you're looking at never lingers as "waiting" in the
  // bell / list. Leaving the surface unmounts this effect, so a backgrounded
  // session can still surface in the bell.
  useEffect(() => {
    if (!sessionId) return
    const markViewed = () => {
      void invoke('set_session_last_opened', { sessionId })
        .then(() =>
          window.dispatchEvent(
            new CustomEvent('session-opened', {
              detail: { sessionIds: [sessionId] },
            })
          )
        )
        .catch(() => undefined)
    }
    // Only clear on focus when an attention signal is actually pending for this
    // session, so an unrelated window focus never triggers a backend write.
    let pendingAttention = false
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listen<{ sessionId: string }>('terminal:attention', event => {
      if (event.payload?.sessionId !== sessionId) return
      if (document.hasFocus()) markViewed()
      else pendingAttention = true
    })
      .then(fn => {
        // The effect may have been cleaned up before listen() resolved; if so,
        // dispose immediately so the listener can't leak.
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => undefined)
    const onFocus = () => {
      if (!pendingAttention) return
      pendingAttention = false
      markViewed()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      unlisten?.()
      window.removeEventListener('focus', onFocus)
    }
  }, [sessionId])

  return (
    <div
      data-terminal-root="true"
      data-terminal-surface="session"
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background',
        className
      )}
    >
      {showHeader && (
        <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Terminal className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">Terminal</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={switchToChat}
          >
            <MessageSquare className="size-3.5" />
            Chat
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <SingleTerminalView
          terminalId={terminalId}
          worktreeId={worktreeId}
          worktreePath={worktreePath}
          isActive={isActive}
          isWorktreeActive={isActive}
        />
      </div>
    </div>
  )
}
