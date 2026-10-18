import { useState } from 'react'
import { ChevronRight } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import {
  useAgentDetails,
  useMarkAgentNotificationsRead,
  type AgentNotification,
  type AgentSummary,
} from '@/services/agents'
import { formatRelative } from './AgentActivity'

const LEVEL_DOTS: Record<string, string> = {
  action: 'bg-amber-500',
  error: 'bg-destructive',
  info: 'bg-muted-foreground/50',
}

function levelLabel(level: string): string {
  return level === 'action' ? 'Needs you' : level === 'error' ? 'Error' : 'Info'
}

/** First non-empty line of a message, for the one-line row. */
export function notificationPreview(message: string): string {
  return (
    message
      .split('\n')
      .map(line => line.trim())
      .find(line => line.length > 0) ?? ''
  )
}

function NotificationRow({
  notification,
  onOpen,
}: {
  notification: AgentNotification
  onOpen: (notification: AgentNotification) => void
}) {
  return (
    <li>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50',
          notification.readAt !== null && 'opacity-60'
        )}
        onClick={() => onOpen(notification)}
      >
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            LEVEL_DOTS[notification.level] ?? LEVEL_DOTS.info
          )}
          title={levelLabel(notification.level)}
        />
        <span className="min-w-0 flex-1 truncate text-foreground">
          {notificationPreview(notification.message)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelative(notification.createdAt)}
        </span>
      </button>
    </li>
  )
}

function NotificationDialog({
  notification,
  onClose,
}: {
  notification: AgentNotification | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={notification !== null}
      onOpenChange={open => !open && onClose()}
    >
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl">
        {notification && (
          <>
            <DialogHeader>
              <DialogTitle className="truncate pr-6">
                {notificationPreview(notification.message)}
              </DialogTitle>
              <DialogDescription>
                {levelLabel(notification.level)} ·{' '}
                {formatRelative(notification.createdAt)}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Markdown className="text-sm">{notification.message}</Markdown>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Unread first (newest first), read ones apart for the collapsed section. */
export function splitNotifications(notifications: AgentNotification[]): {
  unread: AgentNotification[]
  read: AgentNotification[]
} {
  return {
    unread: notifications.filter(n => n.readAt === null),
    read: notifications.filter(n => n.readAt !== null),
  }
}

/** Messages the agent sent with `notify_user`: results, questions, errors. */
export function AgentInbox({ agent }: { agent: AgentSummary }) {
  const { data, isLoading } = useAgentDetails(agent.id)
  const markRead = useMarkAgentNotificationsRead()
  const [readOpen, setReadOpen] = useState(false)
  const [openNotification, setOpenNotification] =
    useState<AgentNotification | null>(null)
  const { unread, read } = splitNotifications(data?.notifications ?? [])
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Results, questions and errors the agent reports to you.
        </p>
        {agent.unreadNotifications > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={markRead.isPending}
            onClick={() => markRead.mutate({ agentId: agent.id })}
          >
            Mark all read
          </Button>
        )}
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading inbox…</p>
      ) : unread.length === 0 && read.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing yet.</p>
      ) : (
        <>
          {unread.length > 0 ? (
            <ul className="space-y-0.5">
              {unread.map(notification => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onOpen={setOpenNotification}
                />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No new messages.</p>
          )}
          {read.length > 0 && (
            <Collapsible open={readOpen} onOpenChange={setReadOpen}>
              <CollapsibleTrigger className="flex items-center gap-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
                <ChevronRight
                  className={cn(
                    'size-3.5 transition-transform',
                    readOpen && 'rotate-90'
                  )}
                />
                Read ({read.length})
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-2 space-y-0.5">
                  {read.map(notification => (
                    <NotificationRow
                      key={notification.id}
                      notification={notification}
                      onOpen={setOpenNotification}
                    />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
      <NotificationDialog
        notification={openNotification}
        onClose={() => setOpenNotification(null)}
      />
    </div>
  )
}
