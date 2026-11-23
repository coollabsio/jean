import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PanelRight, PanelRightClose } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { MODAL_TERMINAL_PRIMARY_ROW_CLASS } from '@/components/chat/modal-terminal-layout'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { useAgentsList, useProjectCoordinator } from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { Project } from '@/types/projects'
import { AgentMemoryView } from './AgentMemoryView'
import { AgentSchedules } from './AgentSchedules'
import { AgentSettings } from './AgentSettings'
import { useAgentsEnabledServers } from './agents-feature'

const ChatWindow = lazy(() =>
  import('@/components/chat/ChatWindow').then(mod => ({
    default: mod.ChatWindow,
  }))
)

type CoordinatorTab = 'chat' | 'memory' | 'schedules' | 'settings'

const TABS: { id: CoordinatorTab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
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

/**
 * A project with its coordinator chat as the main panel, tabs for its memory,
 * schedules and settings, and the project's worktrees in a right sidebar.
 * `worktrees` stays mounted while the sidebar is closed (and on mobile, where
 * it never shows) because its session modal opens the coordinator's spawns.
 */
export function CoordinatorView({
  project,
  viewSwitch,
  worktrees,
}: {
  project: Project
  /** Coordinator | Sessions switch for the header */
  viewSwitch: ReactNode
  worktrees: ReactNode
}) {
  const isMobile = useIsMobile()
  const [tab, setTab] = useState<CoordinatorTab>('chat')
  const { data: coordinator, error } = useProjectCoordinator(project.id)
  const agent = useAgentsList(useAgentsEnabledServers()).data?.find(
    item => item.projectId === project.id
  )
  const advanced = useUIStore(state => state.agentsAdvanced)
  const sidebarOpen =
    useUIStore(state => state.coordinatorSidebarOpen) && !isMobile
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
      const ui = useUIStore.getState()
      ui.setCoordinatorSidebarOpen(!ui.coordinatorSidebarOpen)
    }
    window.addEventListener('toggle-coordinator-sidebar', toggle)
    return () =>
      window.removeEventListener('toggle-coordinator-sidebar', toggle)
  }, [])

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
  ) : tab === 'chat' ? (
    coordinator ? (
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
  ) : !agent ? (
    <Placeholder>Loading coordinator…</Placeholder>
  ) : (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      {tab === 'memory' ? (
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
  )

  return (
    <div className="relative flex h-full min-h-0 w-full font-sans">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={cn(
            'grid shrink-0 grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-border/20 px-4 sm:gap-4',
            MODAL_TERMINAL_PRIMARY_ROW_CLASS
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-normal text-muted-foreground">
              {project.name}
            </h2>
            {viewSwitch}
          </div>
          <div
            className="scrollbar-hide flex min-w-0 items-center justify-center gap-0.5 overflow-x-auto"
            role="tablist"
            aria-label="Coordinator"
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
          <div className="flex justify-end">
            {!isMobile && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={sidebarOpen ? 'Hide worktrees' : 'Show worktrees'}
                aria-pressed={sidebarOpen}
                title={sidebarOpen ? 'Hide worktrees' : 'Show worktrees'}
                onClick={() =>
                  useUIStore.getState().setCoordinatorSidebarOpen(!sidebarOpen)
                }
              >
                {sidebarOpen ? <PanelRightClose /> : <PanelRight />}
              </Button>
            )}
          </div>
        </div>
        {body}
      </div>
      {sidebarOpen && (
        <div
          role="separator"
          tabIndex={-1}
          aria-orientation="vertical"
          aria-label="Resize worktrees sidebar"
          className="relative h-full w-px shrink-0 bg-border/40"
          onMouseDown={handleResizeStart}
        >
          <div className="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize" />
        </div>
      )}
      <aside
        ref={sidebarRef}
        aria-label="Worktrees"
        className={cn(
          'h-full min-h-0 shrink-0 overflow-hidden',
          !sidebarOpen && 'hidden'
        )}
        style={{ width: sidebarWidth }}
      >
        {worktrees}
      </aside>
    </div>
  )
}
