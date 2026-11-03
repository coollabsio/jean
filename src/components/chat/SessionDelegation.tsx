import { useCallback, useState } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  FolderGit2,
  MinusCircle,
  XCircle,
  type LucideIcon,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Markdown } from '@/components/ui/markdown'
import { scopeLikeOwner } from '@/lib/server-resource'
import { cn } from '@/lib/utils'
import { useWorktree } from '@/services/projects'
import type { SessionDelegator } from '@/types/chat'
import { openSessionInWorktree } from './open-session'
import type { SessionUpdate, SessionUpdateStatus } from './session-update'

const STATUS_DISPLAY: Record<
  SessionUpdateStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  done: { label: 'Finished', icon: CheckCircle2, className: 'text-success' },
  failed: { label: 'Failed', icon: XCircle, className: 'text-destructive' },
  cancelled: {
    label: 'Cancelled',
    icon: MinusCircle,
    className: 'text-muted-foreground',
  },
  waiting_plan: {
    label: 'Waiting for plan approval',
    icon: ClipboardList,
    className: 'text-warning',
  },
  question: {
    label: 'Asking a question',
    icon: CircleHelp,
    className: 'text-info',
  },
}

/** Opens the session once its worktree is known, or null while loading. */
function useOpenSession(
  worktreeId: string,
  sessionId: string
): (() => void) | null {
  const { data: worktree } = useWorktree(worktreeId)
  const open = useCallback(() => {
    if (worktree) openSessionInWorktree(worktree, sessionId)
  }, [worktree, sessionId])
  return worktree ? open : null
}

/** Shown in place of the update a delegated session sends to its starter. */
export function SessionUpdateCard({
  update,
  ownerSessionId,
}: {
  update: SessionUpdate
  /** Session that received the update; its ids are raw on the same server */
  ownerSessionId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const open = useOpenSession(
    scopeLikeOwner(ownerSessionId, update.worktreeId),
    scopeLikeOwner(ownerSessionId, update.sessionId)
  )
  const status = STATUS_DISPLAY[update.status]
  const StatusIcon = status.icon
  const name = update.name || 'Session'

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="w-full min-w-0 rounded-lg border border-border/60 bg-muted/20 text-sm"
      data-testid="session-update-card"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <CollapsibleTrigger
          disabled={!update.body}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
        >
          <StatusIcon
            className={cn('size-4 shrink-0', status.className)}
            aria-hidden
          />
          <span className="truncate font-medium text-foreground">{name}</span>
          <span className={cn('shrink-0 text-xs', status.className)}>
            {status.label}
          </span>
          {update.body && (
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
              aria-hidden
            />
          )}
        </CollapsibleTrigger>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 text-xs"
          disabled={!open}
          onClick={() => open?.()}
        >
          Open session
        </Button>
      </div>
      <CollapsibleContent className="border-t border-border/50 px-3 py-2">
        <Markdown className="text-sm text-muted-foreground">
          {update.body}
        </Markdown>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** "Started by <session>" at the top of a session another session started. */
export function DelegatedByRow({ delegator }: { delegator: SessionDelegator }) {
  const open = useOpenSession(
    delegator.origin_worktree_id,
    delegator.origin_session_id
  )
  const name = delegator.origin_name || 'another session'
  return (
    <div className="flex justify-center py-1">
      <button
        type="button"
        aria-label={`Started by ${name}`}
        disabled={!open}
        onClick={() => open?.()}
        className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none"
      >
        <span className="shrink-0">Started by</span>
        <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{name}</span>
      </button>
    </div>
  )
}
