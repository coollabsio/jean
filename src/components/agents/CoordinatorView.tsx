import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PanelRight, PanelRightClose, X } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet'
import { MODAL_TERMINAL_PRIMARY_ROW_CLASS } from '@/components/chat/modal-terminal-layout'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import {
  useAgentsList,
  useProjectCoordinator,
  type AgentSummary,
} from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { Project } from '@/types/projects'
import { AgentMemoryView } from './AgentMemoryView'
import { AgentSchedules } from './AgentSchedules'
import { AgentSettings } from './AgentSettings'
import { CoordinatorWorktrees } from './CoordinatorWorktrees'
import { useAgentsEnabledServers } from './agents-feature'

const ChatWindow = lazy(() =>
  import('@/components/chat/ChatWindow').then(mod => ({
    default: mod.ChatWindow,
  }))
)

type DetailsTab = 'sessions' | 'memory' | 'schedules' | 'settings'

const TABS: { id: DetailsTab; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'memory', label: 'Memory' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'settings', label: 'Settings' },
]

const MIN_SIDEBAR_WIDTH = 280
const MAX_SIDEBAR_WIDTH = 640

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function unavailableMessage(error: unknown): string {
  return String(error).includes('Unknown command')
    ? 'The coordinator needs a newer Jean server. Update the server and reload.'
    : `The coordinator is unavailable: ${String(error)}`
}

/** The coordinator's details: its sessions, memory, schedules, settings. */
function CoordinatorDetails({
  project,
  agent,
  agentId,
  onClose,
  onOpenSession,
}: {
  project: Project
  agent: AgentSummary | undefined
  agentId: string | undefined
  onClose: () => void
  onOpenSession?: () => void
}) {
  const [tab, setTab] = useState<DetailsTab>('sessions')
  const advanced = useUIStore(state => state.agentsAdvanced)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/20 px-2 py-1.5">
        <div
          className="scrollbar-hide flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          role="tablist"
          aria-label="Coordinator details"
        >
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={cn(
                'flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                tab === id
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          onClick={onClose}
          aria-label="Close details"
        >
          <X />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === 'sessions' ? (
          <CoordinatorWorktrees
            project={project}
            agentId={agentId}
            onOpen={onOpenSession}
          />
        ) : !agent ? (
          <Placeholder>Loading coordinator…</Placeholder>
        ) : tab === 'memory' ? (
          <AgentMemoryView agent={agent} />
        ) : tab === 'schedules' ? (
          <AgentSchedules agent={agent} />
        ) : (
          <>
            <AgentSettings agent={agent} />
            <label className="flex shrink-0 cursor-pointer items-center gap-2 px-4 pb-6 text-sm text-muted-foreground select-none hover:text-foreground">
              <Checkbox
                checked={advanced}
                onCheckedChange={value =>
                  useUIStore.getState().setAgentsAdvanced(value === true)
                }
              />
              Show tool calls in the chat
            </label>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * A project with its coordinator chat as the main panel and its details in a
 * right sidebar (a full-screen sheet on mobile). `sessionModalHost` stays
 * mounted and hidden; it covers this view only while its session modal shows
 * a session the header, the coordinator or the Sessions tab opened.
 */
export function CoordinatorView({
  project,
  viewSwitch,
  sessionModalHost,
}: {
  project: Project
  /** Coordinator | Sessions switch for the header */
  viewSwitch: ReactNode
  sessionModalHost: ReactNode
}) {
  const isMobile = useIsMobile()
  const { data: coordinator, error } = useProjectCoordinator(project.id)
  const agent = useAgentsList(useAgentsEnabledServers()).data?.find(
    item => item.projectId === project.id
  )
  const advanced = useUIStore(state => state.agentsAdvanced)
  // Mobile opens the details as a sheet each time; the stored state is the
  // desktop sidebar's
  const [mobileOpen, setMobileOpen] = useState(false)
  const storedOpen = useUIStore(state => state.coordinatorSidebarOpen)
  const sidebarOpen = !isMobile && storedOpen
  const detailsOpen = isMobile ? mobileOpen : storedOpen
  const setDetailsOpen = (open: boolean) => {
    if (isMobile) setMobileOpen(open)
    else useUIStore.getState().setCoordinatorSidebarOpen(open)
  }
  const sidebarWidth = useUIStore(state => state.coordinatorSidebarWidth)
  const sidebarRef = useRef<HTMLElement>(null)

  // The chat always shows the coordinator's current chat (a long chat
  // continues in a new one).
  const worktreeId = coordinator?.worktreeId
  const chatSessionId = coordinator?.chatSessionId
  useEffect(() => {
    if (!worktreeId || !chatSessionId) return
    const chat = useChatStore.getState()
    if (chat.activeSessionIds[worktreeId] !== chatSessionId)
      chat.setActiveSession(worktreeId, chatSessionId)
  }, [worktreeId, chatSessionId])

  useEffect(() => {
    useUIStore.getState().setCoordinatorViewOpen(true)
    return () => useUIStore.getState().setCoordinatorViewOpen(false)
  }, [])

  useEffect(() => {
    const toggle = () => {
      if (isMobile) setMobileOpen(open => !open)
      else {
        const ui = useUIStore.getState()
        ui.setCoordinatorSidebarOpen(!ui.coordinatorSidebarOpen)
      }
    }
    window.addEventListener('toggle-coordinator-sidebar', toggle)
    return () =>
      window.removeEventListener('toggle-coordinator-sidebar', toggle)
  }, [isMobile])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = useUIStore.getState().coordinatorSidebarWidth
    let nextWidth = startWidth
    const onMove = (m: MouseEvent) => {
      // Sidebar is on the right edge: drag left = wider
      nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + startX - m.clientX)
      )
      if (sidebarRef.current) sidebarRef.current.style.width = `${nextWidth}px`
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      useUIStore.getState().setCoordinatorSidebarWidth(nextWidth)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const body = error ? (
    <Placeholder>
      <span className="text-destructive" role="alert">
        {unavailableMessage(error)}
      </span>
    </Placeholder>
  ) : coordinator ? (
    <Suspense fallback={<Placeholder>Loading coordinator…</Placeholder>}>
      <ChatWindow
        isModal
        worktreeId={coordinator.worktreeId}
        worktreePath={coordinator.worktreePath}
        workingLabel={advanced ? undefined : 'Coordinator is working'}
        agentChat
      />
    </Suspense>
  ) : (
    <Placeholder>Loading coordinator…</Placeholder>
  )

  const details = (
    <CoordinatorDetails
      project={project}
      agent={agent}
      agentId={coordinator?.agentId}
      onClose={() => setDetailsOpen(false)}
      onOpenSession={isMobile ? () => setMobileOpen(false) : undefined}
    />
  )

  return (
    <div className="relative flex h-full min-h-0 w-full font-sans">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={cn(
            'flex shrink-0 justify-between items-center gap-2 border-b border-border/20 px-4 sm:gap-4',
            MODAL_TERMINAL_PRIMARY_ROW_CLASS
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-normal text-muted-foreground">
              {project.name}
            </h2>
            {viewSwitch}
          </div>
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={detailsOpen ? 'Hide details' : 'Show details'}
              aria-pressed={detailsOpen}
              title={detailsOpen ? 'Hide details' : 'Show details'}
              onClick={() => setDetailsOpen(!detailsOpen)}
            >
              {detailsOpen ? <PanelRightClose /> : <PanelRight />}
            </Button>
          </div>
        </div>
        {body}
      </div>
      {sidebarOpen && (
        <div
          role="separator"
          tabIndex={-1}
          aria-orientation="vertical"
          aria-label="Resize details sidebar"
          className="relative h-full w-px shrink-0 bg-border/40"
          onMouseDown={handleResizeStart}
        >
          <div className="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize" />
        </div>
      )}
      {sidebarOpen && (
        <aside
          ref={sidebarRef}
          aria-label="Coordinator details"
          className="h-full min-h-0 shrink-0 overflow-hidden"
          style={{ width: sidebarWidth }}
        >
          {details}
        </aside>
      )}
      {isMobile && (
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="w-full gap-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:max-w-none"
            aria-label="Coordinator details"
          >
            <SheetTitle className="shrink-0 truncate px-3 pt-3 text-sm">
              {project.name}
            </SheetTitle>
            <SheetDescription className="sr-only">
              Coordinator sessions, memory, schedules and settings
            </SheetDescription>
            {details}
          </SheetContent>
        </Sheet>
      )}
      {sessionModalHost}
    </div>
  )
}
