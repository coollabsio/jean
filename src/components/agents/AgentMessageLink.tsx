import { useState, type ReactNode } from 'react'
import { FolderGit2 } from '@/components/icons/reicon'
import { AgentIcon } from '@/components/icons/JeanAgentIcon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Markdown } from '@/components/ui/markdown'
import { ReplyBubble } from '@/components/chat/ReplyBubble'
import { useSession } from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import { cn } from '@/lib/utils'
import {
  useAgentDetails,
  useAgentsList,
  type AgentSummary,
} from '@/services/agents'
import { useAgentsEnabledServers } from './agents-feature'
import { coordinatorAgentIdForWorktree } from './agents'
import {
  conversationEntries,
  messageSnippet,
  sameAgentId,
  spawnDelegationStatus,
  type AgentMessageLink,
  type AgentSentMessage,
  type ConversationEntry,
} from './agent-messages'

interface Participant {
  name: string
  icon: ReactNode
}

function useAgents(): AgentSummary[] {
  return useAgentsList(useAgentsEnabledServers()).data ?? []
}

function agentParticipant(
  agent: AgentSummary | undefined,
  fallbackName: string
): Participant {
  return {
    name: agent?.name ?? fallbackName,
    icon: <AgentIcon icon={agent?.icon} className="size-4 shrink-0" />,
  }
}

function sessionParticipant(name: string): Participant {
  return {
    name,
    icon: <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />,
  }
}

const STATUS_CHIPS: Record<string, { label: string; className: string }> = {
  active: { label: 'running', className: 'bg-blue-500/10 text-blue-500' },
  waiting: {
    label: 'waiting for input',
    className: 'bg-amber-500/10 text-amber-500',
  },
  done: { label: 'done', className: 'bg-green-500/10 text-green-500' },
  failed: { label: 'failed', className: 'bg-destructive/10 text-destructive' },
  cancelled: {
    label: 'cancelled',
    className: 'bg-muted text-muted-foreground',
  },
}

function StatusChip({ status }: { status: string | null }) {
  const chip = status ? STATUS_CHIPS[status] : undefined
  if (!chip) return null
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 text-xs leading-5',
        chip.className
      )}
    >
      {chip.label}
    </span>
  )
}

function LinkRow({
  label,
  participant,
  detail,
  status = null,
  onClick,
}: {
  label: string
  participant: Participant
  /** Muted text after the name, e.g. the message sent */
  detail?: string
  /** Delegation status of the spawned work */
  status?: string | null
  /** Missing: the target cannot be opened, so the row is plain text */
  onClick?: () => void
}) {
  const content = (
    <>
      <span className="shrink-0">{label}</span>
      {participant.icon}
      <span className="truncate">
        {participant.name}
        {detail && <span className="text-muted-foreground/70">: {detail}</span>}
      </span>
      <StatusChip status={status} />
    </>
  )
  const className =
    'mx-auto flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-sm text-muted-foreground'
  if (!onClick) return <div className={className}>{content}</div>
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        className,
        'transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
      )}
    >
      {content}
    </button>
  )
}

/** Opens a worktree, at `sessionId` when given, in the project's session modal. */
function openWorktreeSession(
  worktreeId: string,
  worktreePath: string,
  sessionId?: string
) {
  if (sessionId) useChatStore.getState().setActiveSession(worktreeId, sessionId)
  window.dispatchEvent(
    new CustomEvent('open-worktree-modal', {
      detail: { worktreeId, worktreePath },
    })
  )
}

/**
 * Sender side, one card per spawn: "→ Created worktree <name>" or
 * "→ Sent to <session>: '<message>'". Opens the worktree's session; old
 * links without one open the conversation.
 */
export function AgentMessageLinkRow({
  link,
  worktreeId,
}: {
  link: AgentMessageLink
  /** Worktree of the sending agent's session */
  worktreeId: string | null | undefined
}) {
  const [open, setOpen] = useState(false)
  const agents = useAgents()
  const { data: details } = useAgentDetails(
    coordinatorAgentIdForWorktree(worktreeId)
  )
  const status = spawnDelegationStatus(link, details?.delegations)

  if (link.kind === 'worktree') {
    const { worktreeId: id, worktreePath: path } = link
    return (
      <LinkRow
        label="→ Created worktree"
        participant={sessionParticipant(link.name)}
        status={status}
        onClick={id && path ? () => openWorktreeSession(id, path) : undefined}
      />
    )
  }

  const senderAgent = agents.find(a => a.worktreeId === worktreeId)
  const sender = agentParticipant(senderAgent, 'Agent')
  const target =
    link.kind === 'agent'
      ? agentParticipant(
          agents.find(a => sameAgentId(a.id, link.agentId)),
          'Agent'
        )
      : sessionParticipant(link.name ?? 'Session')
  const snippet = messageSnippet(link.message)
  const sessionTarget =
    link.kind === 'session' && link.worktreeId && link.worktreePath
      ? {
          worktreeId: link.worktreeId,
          worktreePath: link.worktreePath,
          sessionId: link.sessionId,
        }
      : null

  return (
    <>
      <LinkRow
        label="→ Sent to"
        participant={target}
        detail={snippet ? `‘${snippet}’` : undefined}
        status={status}
        onClick={() =>
          sessionTarget
            ? openWorktreeSession(
                sessionTarget.worktreeId,
                sessionTarget.worktreePath,
                sessionTarget.sessionId
              )
            : setOpen(true)
        }
      />
      {open && (
        // Old chats only: agents no longer message each other, and links
        // without a worktree cannot open its session.
        <AgentConversationDialog
          sender={sender}
          target={target}
          sessionId={link.kind === 'session' ? link.sessionId : null}
          worktreeId={null}
          worktreePath={null}
          request={link.message}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** Receiver side: "Message from <agent>". Opens the conversation. */
export function AgentMessageFromRow({
  sent,
  sessionId,
  worktreeId,
  worktreePath,
}: {
  sent: AgentSentMessage
  sessionId: string | null | undefined
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
}) {
  const [open, setOpen] = useState(false)
  const agents = useAgents()
  const { data: session } = useSession(
    sessionId ?? null,
    worktreeId ?? null,
    worktreePath ?? null
  )
  const sender = agentParticipant(
    agents.find(a => sameAgentId(a.id, sent.agentId)),
    sent.agentName
  )
  return (
    <>
      <LinkRow
        label="Message from"
        participant={sender}
        onClick={() => setOpen(true)}
      />
      {open && (
        <AgentConversationDialog
          sender={sender}
          target={sessionParticipant(session?.name ?? 'This session')}
          sessionId={sessionId ?? null}
          worktreeId={worktreeId ?? null}
          worktreePath={worktreePath ?? null}
          request={sent.text}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function EntryBubble({
  entry,
  participant,
}: {
  entry: ConversationEntry
  participant: Participant | null
}) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex size-6 shrink-0 items-center justify-center">
        {participant?.icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="px-1 text-xs text-muted-foreground">
          {participant?.name ?? 'You'}
        </span>
        <ReplyBubble>
          <Markdown>{entry.text}</Markdown>
        </ReplyBubble>
      </div>
    </div>
  )
}

/** Conversation between an agent and the session or agent it messaged. */
function AgentConversationDialog({
  sender,
  target,
  sessionId,
  worktreeId,
  worktreePath,
  request,
  onClose,
}: {
  sender: Participant
  target: Participant
  sessionId: string | null
  worktreeId: string | null
  worktreePath: string | null
  /** Shown alone until the receiving session is known */
  request: string
  onClose: () => void
}) {
  const { data: session, isLoading } = useSession(
    sessionId,
    worktreeId,
    worktreePath
  )
  const loaded = session ? conversationEntries(session.messages) : []
  const entries: ConversationEntry[] =
    loaded.length > 0
      ? loaded
      : [{ id: 'request', from: 'sender', text: request }]
  const waiting = !isLoading && loaded.length === 0

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[7.5dvh] bottom-auto flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogTitle className="flex shrink-0 items-center justify-center gap-2 border-b px-4 py-3 text-sm font-medium">
          {sender.icon}
          <span className="truncate">{sender.name}</span>
          <span className="text-muted-foreground" aria-label="and">
            ⇄
          </span>
          {target.icon}
          <span className="truncate">{target.name}</span>
        </DialogTitle>
        <DialogDescription className="sr-only">
          Messages between {sender.name} and {target.name}
        </DialogDescription>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {entries.map(entry => (
            <EntryBubble
              key={entry.id}
              entry={entry}
              participant={
                entry.from === 'sender'
                  ? sender
                  : entry.from === 'target'
                    ? target
                    : null
              }
            />
          ))}
          {waiting && (
            <p className="text-center text-xs text-muted-foreground">
              No reply from {target.name} yet.
            </p>
          )}
        </div>
        <div className="flex shrink-0 justify-center border-t px-4 py-3">
          <Button
            variant="secondary"
            className="rounded-full"
            onClick={onClose}
          >
            Close Chat
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
