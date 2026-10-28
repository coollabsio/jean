import { useState } from 'react'
import { ChevronRight } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
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
import { formatRelative } from '@/lib/relative-time'
import {
  AgentEmpty,
  AgentList,
  AgentLoading,
  AgentSection,
  AgentTabBody,
  AGENT_ROW,
} from './agent-ui'

const LEVEL_DOTS: Record<string, string> = {
  action: 'bg-warning',
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
          AGENT_ROW,
          'flex w-full items-center gap-2 text-left text-sm focus-visible:bg-muted/30 focus-visible:outline-none',
          notification.readAt !== null && 'text-muted-foreground'
        )}
        onClick={() => onOpen(notification)}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={levelLabel(notification.level)}
              className={cn(
                'size-2 shrink-0 rounded-full',
                LEVEL_DOTS[notification.level] ?? LEVEL_DOTS.info
              )}
            />
          </TooltipTrigger>
          <TooltipContent>{levelLabel(notification.level)}</TooltipContent>
        </Tooltip>
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            notification.readAt === null
              ? 'font-medium text-foreground'
              : 'text-muted-foreground'
          )}
        >
          {notificationPreview(notification.message)}
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
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
    <AgentTabBody>
      <AgentSection
        actions={
          agent.unreadNotifications > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs text-muted-foreground"
              disabled={markRead.isPending}
              onClick={() => markRead.mutate({ agentId: agent.id })}
            >
              Mark all read
            </Button>
          ) : null
        }
      >
        {isLoading ? (
          <AgentLoading label="Loading inbox…" />
        ) : unread.length === 0 && read.length === 0 ? (
          <AgentEmpty title="No messages yet." />
        ) : unread.length > 0 ? (
          <AgentList>
            {unread.map(notification => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onOpen={setOpenNotification}
              />
            ))}
          </AgentList>
        ) : (
          <AgentEmpty title="You're all caught up." />
        )}
        {read.length > 0 && (
          <Collapsible open={readOpen} onOpenChange={setReadOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              <ChevronRight
                className={cn(
                  'size-3.5 transition-transform',
                  readOpen && 'rotate-90'
                )}
              />
              Read
              <span className="font-normal tabular-nums text-muted-foreground/70">
                {read.length}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1">
              <AgentList>
                {read.map(notification => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onOpen={setOpenNotification}
                  />
                ))}
              </AgentList>
            </CollapsibleContent>
          </Collapsible>
        )}
      </AgentSection>
      <NotificationDialog
        notification={openNotification}
        onClose={() => setOpenNotification(null)}
      />
    </AgentTabBody>
  )
}
