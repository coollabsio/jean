import { useCallback, useEffect, useMemo, useState } from 'react'
import { BellDot } from '@/components/icons/reicon'
import {
  isAgentUpdateMessage,
  isChatContinuedMessage,
  splitAgentUpdateTurns,
} from '@/components/chat/message-content-utils'
import { formatLocalTime } from '@/components/chat/time-utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Markdown } from '@/components/ui/markdown'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import type { AgentSummary } from '@/services/agents'
import { useSession } from '@/services/chat'
import { useUIStore } from '@/store/ui-store'
import type { ChatMessage } from '@/types/chat'
import { formatRelative } from './AgentActivity'

/**
 * The agent's replies to Jean's automatic updates (sessions that finished,
 * failed, or wait for input), newest first, plus how many are new. An update
 * is new when it is newer than the last one the user saw and their last message.
 */
export function agentUpdateFeed(
  messages: ChatMessage[],
  seenAt: number
): { updates: ChatMessage[]; unread: number } {
  const updates = splitAgentUpdateTurns(messages)
    .updates.filter(m => m.content.trim().length > 0)
    .reverse()
  let lastPromptAt = 0
  for (const m of messages) {
    if (
      m.role === 'user' &&
      !isAgentUpdateMessage(m.content) &&
      !isChatContinuedMessage(m.content)
    ) {
      lastPromptAt = Math.max(lastPromptAt, m.timestamp)
    }
  }
  const readUntil = Math.max(seenAt, lastPromptAt)
  return {
    updates,
    unread: updates.filter(m => m.timestamp > readUntil).length,
  }
}

/** Opens the agent's session updates, kept out of its chat. */
export function AgentUpdatesButton({
  agent,
  workdir,
}: {
  agent: AgentSummary
  workdir: string | undefined
}) {
  const { data: session } = useSession(
    agent.homeSessionId,
    agent.worktreeId,
    workdir ?? null
  )
  const seenAt = useUIStore(state => state.agentUpdatesSeenAt[agent.id] ?? 0)
  const { updates, unread } = useMemo(
    () => agentUpdateFeed(session?.messages ?? [], seenAt),
    [session?.messages, seenAt]
  )
  const [open, setOpen] = useState(false)
  const newest = updates[0]?.timestamp ?? 0

  // Mark as seen up to now, not up to the newest message: the saved copy of a
  // streamed reply carries its run end time, which is later than the live one
  const markSeen = useCallback(() => {
    const now = Math.floor(Date.now() / 1000)
    useUIStore.getState().markAgentUpdatesSeen(agent.id, Math.max(newest, now))
  }, [agent.id, newest])

  // Updates that arrive while the panel is open are seen
  useEffect(() => {
    if (open && newest > 0) markSeen()
  }, [open, newest, markSeen])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) markSeen()
      setOpen(next)
    },
    [markSeen]
  )

  // Shown only when there is something new (kept while the panel is open)
  if (unread === 0 && !open) return null

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        aria-label={unread ? `Updates, ${unread} new` : 'Updates'}
      >
        <BellDot className="size-3.5" />
        Updates
        {unread > 0 && (
          <span className="min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 text-white tabular-nums">
            {unread}
          </span>
        )}
      </Button>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="gap-0 sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>Updates</SheetTitle>
            <SheetDescription>
              {agent.name}&apos;s notes on the sessions it follows.
            </SheetDescription>
          </SheetHeader>
          <ol className="min-h-0 flex-1 divide-y overflow-y-auto">
            {updates.map(update => (
              <li
                key={update.id}
                className={cn(
                  'px-4 py-3',
                  update.timestamp > seenAt && 'bg-amber-500/5'
                )}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="mb-1 text-[11px] text-muted-foreground tabular-nums">
                      {formatRelative(update.timestamp)}
                    </p>
                  </TooltipTrigger>
                  <TooltipContent>
                    {formatLocalTime(update.timestamp)}
                  </TooltipContent>
                </Tooltip>
                <Markdown className="text-sm">{update.content}</Markdown>
              </li>
            ))}
          </ol>
        </SheetContent>
      </Sheet>
    </>
  )
}
