import { Suspense, lazy, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Play, PauseCircle, Trash2 } from '@/components/icons/reicon'
import { AgentIcon } from '@/components/icons/JeanAgentIcon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  useAgentWorkdir,
  useDeleteAgent,
  useUpdateAgent,
  type AgentSummary,
} from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { agentStatusLabel, useSelectedAgent } from './agents'
import { AgentActivity, PendingApprovals } from './AgentActivity'
import { AgentMemoryView } from './AgentMemoryView'
import { AgentTasks } from './AgentTasks'
import { AgentSchedules } from './AgentSchedules'
import { AgentInbox } from './AgentInbox'

const ChatWindow = lazy(() =>
  import('@/components/chat/ChatWindow').then(mod => ({
    default: mod.ChatWindow,
  }))
)

const LOADING = (
  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
    Loading agent…
  </div>
)

type AgentTab = 'chat' | 'inbox' | 'tasks' | 'schedules' | 'activity' | 'memory'

function unavailableMessage(error: unknown): string {
  return String(error).includes('Unknown command')
    ? 'Agents need a newer Jean server. Update the server and reload.'
    : `Agents are unavailable: ${String(error)}`
}

/** Agents page: header, tabs and content of the selected agent. */
export function AgentPage() {
  const { agent, isLoading, error } = useSelectedAgent()
  if (error) {
    return (
      <div
        className="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive"
        role="alert"
      >
        {unavailableMessage(error)}
      </div>
    )
  }
  if (isLoading || !agent) return LOADING
  return <AgentPageContent key={agent.id} agent={agent} />
}

function AgentPageContent({ agent }: { agent: AgentSummary }) {
  const [tab, setTab] = useState<AgentTab>('chat')
  const { data: workdir, error } = useAgentWorkdir(agent.id)
  // The chat tab always shows the agent's current chat (a long chat
  // continues in a new one).
  useEffect(() => {
    if (!agent.homeSessionId) return
    const chat = useChatStore.getState()
    if (chat.activeSessionIds[agent.worktreeId] !== agent.homeSessionId) {
      chat.setActiveSession(agent.worktreeId, agent.homeSessionId)
    }
  }, [agent.worktreeId, agent.homeSessionId])
  const updateAgent = useUpdateAgent()
  const deleteAgent = useDeleteAgent()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const togglePaused = () =>
    updateAgent.mutate(
      { agentId: agent.id, patch: { paused: !agent.paused } },
      {
        onSuccess: () =>
          toast.success(
            agent.paused ? `${agent.name} resumed` : `${agent.name} stopped`
          ),
        onError: e => toast.error(`Failed: ${e}`),
      }
    )

  const handleDelete = () =>
    deleteAgent.mutate(
      { agentId: agent.id },
      {
        onSuccess: () => {
          useUIStore.getState().setSelectedAgentId('jean')
          toast.success(`Agent ${agent.name} deleted`)
        },
        onError: e => toast.error(`Failed to delete agent: ${e}`),
      }
    )

  const tabs: {
    id: AgentTab
    label: string
    badge?: number
    /** Amber = needs the user; muted = information only */
    muted?: boolean
  }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'inbox', label: 'Inbox', badge: agent.unreadNotifications },
    { id: 'tasks', label: 'Tasks', badge: agent.runningTasks, muted: true },
    { id: 'schedules', label: 'Schedules' },
    { id: 'activity', label: 'Activity', badge: agent.pendingApprovals },
    { id: 'memory', label: 'Memory' },
  ]

  return (
    <div className="flex h-full min-h-0 w-full flex-col font-sans">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <AgentIcon icon={agent.icon} className="size-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-baseline gap-2 text-base font-semibold leading-tight text-foreground">
            <span className="truncate">{agent.name}</span>
            <span
              className={cn(
                'shrink-0 text-xs font-normal',
                agent.pendingApprovals > 0 || agent.status === 'waiting'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
              )}
            >
              {agentStatusLabel(agent)}
            </span>
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {agent.serverId !== LOCAL_SERVER_ID && (
              <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5">
                on {agent.serverName}
              </span>
            )}
            {agent.description}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={togglePaused}
          disabled={updateAgent.isPending}
          title={
            agent.paused
              ? 'Resume: deliver updates and run schedules again'
              : 'Stop: cancel the running turn and hold updates and schedules'
          }
        >
          {agent.paused ? <Play /> : <PauseCircle />}
          <span className="hidden sm:inline">
            {agent.paused ? 'Resume' : 'Stop'}
          </span>
        </Button>
        {!agent.builtin && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirmDelete(true)}
            aria-label="Delete agent"
          >
            <Trash2 />
          </Button>
        )}
      </header>
      <div
        className="flex shrink-0 gap-1 border-b px-3 py-1.5"
        role="tablist"
        aria-label="Agent view"
      >
        {tabs.map(({ id, label, badge, muted }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              tab === id
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
            onClick={() => setTab(id)}
          >
            {label}
            {badge ? (
              <span
                className={cn(
                  'rounded-full px-1.5 text-[10px] leading-4',
                  muted
                    ? 'bg-muted-foreground/20 text-foreground'
                    : 'bg-amber-500 text-white'
                )}
              >
                {badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tab === 'chat' ? (
          <>
            {agent.pendingApprovals > 0 && (
              <PendingApprovals agentId={agent.id} />
            )}
            {error ? (
              <div
                className="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive"
                role="alert"
              >
                {unavailableMessage(error)}
              </div>
            ) : workdir ? (
              <Suspense fallback={LOADING}>
                <ChatWindow
                  isModal
                  worktreeId={agent.worktreeId}
                  worktreePath={workdir}
                />
              </Suspense>
            ) : (
              LOADING
            )}
          </>
        ) : tab === 'inbox' ? (
          <AgentInbox agent={agent} />
        ) : tab === 'schedules' ? (
          <AgentSchedules agent={agent} />
        ) : tab === 'tasks' ? (
          <AgentTasks agent={agent} workdir={workdir} />
        ) : tab === 'activity' ? (
          <AgentActivity agent={agent} />
        ) : (
          <AgentMemoryView agent={agent} />
        )}
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the agent, its memory, schedules and pending updates.
              Sessions it started in your projects stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
