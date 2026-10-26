import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { toast } from 'sonner'
import { Trash2, X } from '@/components/icons/reicon'
import {
  AGENT_ICON_COLORS,
  AgentIcon,
  type AgentIconKey,
} from '@/components/icons/JeanAgentIcon'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  useAgentWorkdir,
  useDeleteAgent,
  type AgentSummary,
} from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import {
  agentStatusLabel,
  useSelectedAgent,
  visibleAgentTabs,
  type AgentTab,
} from './agents'
import { AgentActivity, PendingApprovals } from './AgentActivity'
import { AgentMemoryView } from './AgentMemoryView'
import { AgentTasks } from './AgentTasks'
import { AgentSchedules } from './AgentSchedules'
import { AgentInbox } from './AgentInbox'
import { AgentSettings } from './AgentSettings'
import { AgentSubagentTypes } from './AgentSubagentTypes'
import { AgentUpdatesButton } from './AgentUpdates'
import { agentRunSummary } from './agent-config'

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

function unavailableMessage(error: unknown): string {
  return String(error).includes('Unknown command')
    ? 'Agents need a newer Jean server. Update the server and reload.'
    : `Agents are unavailable: ${String(error)}`
}

/** Agents page: the selected agent's chat, with its details in a side panel. */
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
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedTab, setTab] = useState<AgentTab>(() =>
    agent.unreadNotifications > 0 ? 'inbox' : 'schedules'
  )
  const advanced = useUIStore(state => state.agentsAdvanced)
  const shownTabs = visibleAgentTabs(advanced, agent, selectedTab)
  // Turning Advanced off while on an advanced-only section returns to Schedules
  const tab = shownTabs.includes(selectedTab) ? selectedTab : 'schedules'
  const { data: workdir, error } = useAgentWorkdir(agent.id)
  // The chat always shows the agent's current chat (a long chat continues
  // in a new one).
  useEffect(() => {
    if (!agent.homeSessionId) return
    const chat = useChatStore.getState()
    if (chat.activeSessionIds[agent.worktreeId] !== agent.homeSessionId) {
      chat.setActiveSession(agent.worktreeId, agent.homeSessionId)
    }
  }, [agent.worktreeId, agent.homeSessionId])
  const deleteAgent = useDeleteAgent()
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The header floats over the chat, so messages scroll beneath it
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)

  useEffect(() => {
    const header = headerRef.current
    if (!header) return
    const observer = new ResizeObserver(() =>
      setHeaderHeight(header.offsetHeight)
    )
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

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

  const allTabs: {
    id: AgentTab
    label: string
    badge?: number
    /** Amber = needs the user; muted = information only */
    muted?: boolean
  }[] = [
    { id: 'inbox', label: 'Inbox', badge: agent.unreadNotifications },
    { id: 'tasks', label: 'Tasks', badge: agent.runningTasks, muted: true },
    { id: 'subagents', label: 'Subagents' },
    { id: 'schedules', label: 'Schedules' },
    { id: 'activity', label: 'Activity', badge: agent.pendingApprovals },
    { id: 'memory', label: 'Memory' },
    { id: 'settings', label: 'Settings' },
  ]
  const tabs = allTabs.filter(item => shownTabs.includes(item.id))
  const needsUser =
    agent.unreadNotifications > 0 ||
    agent.pendingApprovals > 0 ||
    agent.status === 'waiting'
  const statusLabel = agentStatusLabel(agent)

  return (
    <div
      className="relative flex h-full min-h-0 w-full font-sans"
      style={
        {
          // Fills the user's prompt bubbles with this agent's strong color
          '--agent-accent': (AGENT_ICON_COLORS[agent.icon as AgentIconKey] ??
            AGENT_ICON_COLORS.yellow)[2],
          '--agent-accent-fg': '#ffffff',
          '--chat-top-inset': `${headerHeight}px`,
        } as CSSProperties
      }
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={headerRef}
          className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col"
        >
          <div className="flex shrink-0 justify-center gap-2 bg-gradient-to-b from-background via-background/70 to-transparent px-3 pt-2 pb-3">
            <button
              type="button"
              className={cn(
                'pointer-events-auto flex h-9 max-w-full min-w-0 items-center gap-2 rounded-full border bg-background/80 pl-1.5 pr-3.5 text-sm font-medium text-foreground backdrop-blur-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                panelOpen && 'bg-muted'
              )}
              onClick={() => setPanelOpen(open => !open)}
              aria-expanded={panelOpen}
              aria-label={`${agent.name} details`}
            >
              <AgentIcon icon={agent.icon} className="size-6 shrink-0" />
              <span className="truncate" data-testid="agent-header-name">
                {agent.name}
              </span>
              {statusLabel && (
                <span
                  className={cn(
                    'shrink-0 whitespace-nowrap text-xs font-normal',
                    needsUser
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground'
                  )}
                  data-testid="agent-header-status"
                >
                  {statusLabel}
                </span>
              )}
            </button>
            <div className="pointer-events-auto flex items-center rounded-full border bg-background/80 backdrop-blur-md empty:hidden">
              <AgentUpdatesButton agent={agent} workdir={workdir} />
            </div>
          </div>
          {agent.pendingApprovals > 0 && (
            <div className="pointer-events-auto -mt-3 bg-background">
              <PendingApprovals agentId={agent.id} />
            </div>
          )}
        </div>
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
              workingLabel={advanced ? undefined : `${agent.name} is working`}
            />
          </Suspense>
        ) : (
          LOADING
        )}
      </div>
      {panelOpen && (
        <aside
          className="absolute inset-0 z-30 flex min-h-0 flex-col bg-background sm:static sm:w-[28rem] sm:shrink-0 sm:border-l"
          aria-label={`${agent.name} details`}
        >
          <div className="flex shrink-0 justify-end gap-1 px-3 pt-3">
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
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(false)}
              aria-label="Close details"
            >
              <X />
            </Button>
          </div>
          <div className="flex shrink-0 flex-col items-center gap-1 px-6 pb-3 text-center">
            <AgentIcon icon={agent.icon} className="mb-1 size-14" />
            <h1 className="max-w-full truncate text-base font-semibold text-foreground">
              {agent.name}
            </h1>
            <p
              className={cn(
                'text-xs',
                agent.pendingApprovals > 0 || agent.status === 'waiting'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
              )}
            >
              {agentStatusLabel(agent)}
            </p>
            <p className="text-xs text-muted-foreground">
              {agent.serverId !== LOCAL_SERVER_ID && (
                <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5">
                  on {agent.serverName}
                </span>
              )}
              {[agent.description, agentRunSummary(agent)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div
            className="flex shrink-0 flex-wrap justify-center gap-1 border-b px-3 pb-2"
            role="tablist"
            aria-label="Agent details"
          >
            {tabs.map(({ id, label, badge, muted }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={cn(
                  'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
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
                      'min-w-4 rounded-full px-1 text-center text-[10px] tabular-nums leading-4',
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
          <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
            {tab === 'inbox' ? (
              <AgentInbox agent={agent} />
            ) : tab === 'subagents' ? (
              <AgentSubagentTypes agent={agent} />
            ) : tab === 'schedules' ? (
              <AgentSchedules agent={agent} />
            ) : tab === 'tasks' ? (
              <AgentTasks agent={agent} workdir={workdir} />
            ) : tab === 'activity' ? (
              <AgentActivity agent={agent} />
            ) : tab === 'memory' ? (
              <AgentMemoryView agent={agent} />
            ) : (
              <AgentSettings agent={agent} />
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground select-none hover:text-foreground">
                <Checkbox
                  checked={advanced}
                  onCheckedChange={value =>
                    useUIStore.getState().setAgentsAdvanced(value === true)
                  }
                  aria-label="Advanced"
                />
                Advanced
              </label>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              Show tasks, subagents, activity, memory, settings, and tool
              activity in chat
            </TooltipContent>
          </Tooltip>
        </aside>
      )}
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
