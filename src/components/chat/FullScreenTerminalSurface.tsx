import { useEffect } from 'react'
import { MessageSquare, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { invoke, listen } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
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
  useEffect(() => {
    if (!sessionId || !isActive) return
    let pendingAttention = false
    let cancelled = false
    let unlisten: (() => void) | undefined

    const markViewed = () => {
      // Viewing acknowledges terminal attention; clear local waiting immediately
      // so a focused session does not flash "waiting" after terminal:attention.
      useChatStore.getState().setWaitingForInput(sessionId, false)
      void invoke('set_session_last_opened', { sessionId }).catch(
        () => undefined
      )
    }
    if (document.hasFocus()) markViewed()
    void listen<{ sessionId: string }>('terminal:attention', event => {
      if (event.payload?.sessionId !== sessionId) return
      if (document.hasFocus()) {
        // Run after the global terminal:attention handler (which sets waiting)
        // so a focused terminal stays acknowledged.
        queueMicrotask(markViewed)
      } else {
        pendingAttention = true
      }
    })
      .then(dispose => {
        if (cancelled) dispose()
        else unlisten = dispose
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
  }, [isActive, sessionId])

  const switchToChat = () => {
    if (sessionId) {
      useUIStore.getState().setSessionPrimarySurface(sessionId, 'chat')
    }
  }

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
