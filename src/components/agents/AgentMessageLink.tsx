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
import {
  useAgentDetails,
  useAgentsList,
  useAgentWorkdir,
  type AgentSummary,
} from '@/services/agents'
import { useAgentsEnabledServers } from './agents-feature'
import {
  conversationEntries,
  findRequestTask,
  sameAgentId,
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

function LinkRow({
  label,
  participant,
  onClick,
}: {
  label: string
  participant: Participant
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-auto flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="shrink-0">{label}</span>
      {participant.icon}
      <span className="truncate">{participant.name}</span>
    </button>
  )
}

/** Sender side: "Messaged <agent or session>". Opens the conversation. */
export function AgentMessageLinkRow({
  link,
  sentAt,
  worktreeId,
}: {
  link: AgentMessageLink
  /** Unix seconds of the assistant message that sent it */
  sentAt: number
  /** Worktree of the sending agent's session */
  worktreeId: string | null | undefined
}) {
  const [open, setOpen] = useState(false)
  const agents = useAgents()
  const senderAgent = agents.find(
    a => a.worktreeId === worktreeId || a.tasksWorktreeId === worktreeId
  )
  const sender = agentParticipant(senderAgent, 'Agent')
  const targetAgent =
    link.kind === 'agent'
      ? agents.find(a => sameAgentId(a.id, link.agentId))
      : undefined
  const target =
    link.kind === 'agent'
      ? agentParticipant(targetAgent, 'Agent')
      : sessionParticipant(link.name ?? 'Session')

  return (
    <>
      <LinkRow
        label="Messaged"
        participant={target}
        onClick={() => setOpen(true)}
      />
      {open &&
        (link.kind === 'agent' ? (
          <AgentRequestConversation
            sender={sender}
            target={target}
            targetAgent={targetAgent}
            senderName={sender.name}
            sentAt={sentAt}
            request={link.message}
            onClose={() => setOpen(false)}
          />
        ) : (
          <AgentConversationDialog
            sender={sender}
            target={target}
            sessionId={link.sessionId}
            worktreeId={link.worktreeId ?? null}
            worktreePath={link.worktreePath ?? null}
            request={link.message}
            onClose={() => setOpen(false)}
          />
        ))}
    </>
  )
}

/** `message_agent`: the answer lives in a task session of the target agent. */
function AgentRequestConversation({
  targetAgent,
  senderName,
  sentAt,
  ...props
}: {
  sender: Participant
  target: Participant
  targetAgent: AgentSummary | undefined
  senderName: string
  sentAt: number
  request: string
  onClose: () => void
}) {
  const { data: details } = useAgentDetails(targetAgent?.id ?? null)
  const { data: workdir } = useAgentWorkdir(targetAgent?.id ?? null)
  const task = details
    ? findRequestTask(details.tasks, senderName, sentAt)
    : undefined
  return (
    <AgentConversationDialog
      {...props}
      sessionId={task?.sessionId ?? null}
      worktreeId={targetAgent?.tasksWorktreeId ?? null}
      worktreePath={workdir ?? null}
    />
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
        className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
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
