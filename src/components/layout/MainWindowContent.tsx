import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useState,
  type RefObject,
} from 'react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useProjects } from '@/services/projects'
import { useUIStore } from '@/store/ui-store'
import { useTerminalStore } from '@/store/terminal-store'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Plus, Loader2 } from 'lucide-react'
import { WelcomeProjectGrid } from './WelcomeProjectGrid'
import { isFolder } from '@/types/projects'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { scheduleIdleWork } from '@/lib/idle'
import {
  closeChatTerminal,
  isChatTerminalOpen,
  openChatTerminal,
} from '@/lib/terminal-gesture'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSwipeBack } from '@/hooks/useSwipeBack'

const ChatWindow = lazy(() =>
  import('@/components/chat/ChatWindow').then(mod => ({
    default: mod.ChatWindow,
  }))
)

const ProjectCanvasView = lazy(() =>
  import('@/components/dashboard/ProjectCanvasView').then(mod => ({
    default: mod.ProjectCanvasView,
  }))
)

interface MainWindowContentProps {
  children?: React.ReactNode
  className?: string
  sidebarSwipeContainerRef?: RefObject<HTMLDivElement | null>
}

export function MainWindowContent({
  children,
  className,
  sidebarSwipeContainerRef,
}: MainWindowContentProps) {
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const isMobile = useIsMobile()
  // Subscribe so swipe-back can prefer closing terminal over navigating away
  const terminalPanelOpen = useTerminalStore(state =>
    activeWorktreeId
      ? (state.terminalPanelOpen[activeWorktreeId] ?? false)
      : false
  )
  const terminalVisible = useTerminalStore(state => state.terminalVisible)
  const isPanelTerminalOpen =
    !!activeWorktreeId && terminalPanelOpen && terminalVisible

  // Full ChatWindow (active worktree path): edge swipe right →
  // close terminal if open, otherwise back to project
  const swipeBackCallback = useCallback(() => {
    const worktreeId = useChatStore.getState().activeWorktreeId
    if (worktreeId && isChatTerminalOpen(worktreeId, 'panel')) {
      closeChatTerminal(worktreeId, 'panel')
      return
    }
    useChatStore.getState().clearActiveWorktree()
  }, [])
  const swipeBack = useSwipeBack({
    onSwipeBack: swipeBackCallback,
    enabled: isMobile && !!activeWorktreePath,
    // Closing terminal is an overlay dismiss — no full content slide-off
    animateToEnd: !isPanelTerminalOpen,
  })

  // Full ChatWindow: right-edge swipe left → open terminal
  const swipeOpenTerminalCallback = useCallback(() => {
    const worktreeId = useChatStore.getState().activeWorktreeId
    if (!worktreeId) return
    openChatTerminal(worktreeId, 'panel')
  }, [])
  const canSwipeOpenTerminal =
    isMobile &&
    !!activeWorktreePath &&
    !!activeWorktreeId &&
    !isPanelTerminalOpen
  const swipeOpenTerminal = useSwipeBack({
    onSwipeBack: swipeOpenTerminalCallback,
    enabled: canSwipeOpenTerminal,
    animateToEnd: false,
    visualFeedback: true,
    edge: 'right',
  })

  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const setAddProjectDialogOpen = useProjectsStore(
    state => state.setAddProjectDialogOpen
  )
  const { data: projects = [] } = useProjects()
  const [backendCheckReady, setBackendCheckReady] = useState(false)
  useEffect(() => scheduleIdleWork(() => setBackendCheckReady(true), 1500), [])

  const realProjects = projects.filter(p => !isFolder(p))

  const showWelcome = !activeWorktreePath && !selectedProjectId && !children
  const shouldCheckBackends = backendCheckReady && showWelcome
  const { installedBackends, isLoading: backendsLoading } =
    useInstalledBackends({
      enabled: shouldCheckBackends,
    })
  const awaitingBackendCheck = showWelcome && !backendCheckReady
  const setupIncomplete =
    shouldCheckBackends && !backendsLoading && installedBackends.length === 0
  const showAddButton = showWelcome && projects.length === 0 && !setupIncomplete

  const handleProjectClick = useCallback((projectId: string) => {
    const { selectProject, expandProject } = useProjectsStore.getState()
    selectProject(projectId)
    expandProject(projectId)
  }, [])

  // Enter key opens add project dialog on welcome screen
  useEffect(() => {
    if (!showAddButton) return
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if a modal is open
      if (useUIStore.getState().featureTourOpen) return
      // Don't intercept Enter from input elements (e.g. preferences font size)
      const tag = (e.target as HTMLElement)?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return
      if (e.key === 'Enter') {
        e.preventDefault()
        setAddProjectDialogOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showAddButton, setAddProjectDialogOpen])

  const nonChatContent = selectedProjectId ? (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading project…
        </div>
      }
    >
      <ProjectCanvasView
        key={selectedProjectId}
        projectId={selectedProjectId}
      />
    </Suspense>
  ) : children ? (
    children
  ) : realProjects.length > 0 ? (
    <WelcomeProjectGrid
      projects={realProjects}
      onProjectClick={handleProjectClick}
      onAddProject={() => setAddProjectDialogOpen(true)}
    />
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 font-sans">
      <h1 className="text-4xl font-bold text-foreground">Welcome to Jean!</h1>
      {awaitingBackendCheck || backendsLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Calling Jean…</span>
        </div>
      ) : setupIncomplete ? (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">
            Complete setup to start adding projects.
          </p>
          <Button
            variant="outline"
            size="lg"
            onClick={() =>
              useUIStore.setState({
                onboardingManuallyTriggered: true,
                onboardingDismissed: false,
                onboardingOpen: true,
              })
            }
          >
            Complete Setup
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="lg"
          onClick={() => setAddProjectDialogOpen(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Your First Project
          <Kbd className="ml-2 h-5 px-1.5 text-[10px]">↵</Kbd>
        </Button>
      )}
    </div>
  )

  return (
    <div
      className={cn(
        'relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-background',
        className
      )}
    >
      {activeWorktreePath ? (
        <div
          ref={isMobile ? swipeBack.containerRef : undefined}
          className="relative h-full w-full"
          data-testid="mobile-swipe-chat"
          style={
            isMobile && (swipeBack.isSwiping || swipeBack.translateX !== 0)
              ? {
                  transform: `translateX(${swipeBack.translateX}px)`,
                  transition: swipeBack.transitionStyle || undefined,
                  willChange: swipeBack.isSwiping ? 'transform' : undefined,
                }
              : undefined
          }
        >
          {/* Inner layer owns right-edge swipe → open terminal */}
          <div
            ref={isMobile ? swipeOpenTerminal.containerRef : undefined}
            className="relative h-full min-h-0 w-full"
            data-testid="mobile-swipe-open-terminal"
            style={
              isMobile &&
              (swipeOpenTerminal.isSwiping ||
                swipeOpenTerminal.translateX !== 0)
                ? {
                    transform: `translateX(${swipeOpenTerminal.translateX}px)`,
                    transition: swipeOpenTerminal.transitionStyle || undefined,
                    willChange: swipeOpenTerminal.isSwiping
                      ? 'transform'
                      : undefined,
                  }
                : undefined
            }
          >
            {isMobile && (
              <>
                <div
                  className={cn(
                    'absolute left-0 top-1/2 z-50 h-10 w-1 -translate-y-1/2 rounded-r-full bg-muted-foreground/20 transition-opacity duration-300',
                    swipeBack.isSwiping ? 'opacity-0' : 'opacity-100'
                  )}
                  aria-hidden
                />
                {canSwipeOpenTerminal && (
                  <div
                    className="pointer-events-none absolute right-0 top-1/2 z-50 h-10 w-1 -translate-y-1/2 rounded-l-full bg-muted-foreground/20"
                    aria-hidden
                  />
                )}
              </>
            )}
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading chat…
                </div>
              }
            >
              <ChatWindow />
            </Suspense>
          </div>
        </div>
      ) : (
        <div
          ref={isMobile ? sidebarSwipeContainerRef : undefined}
          className="relative flex h-full w-full min-w-0 flex-col bg-background"
          data-testid="mobile-swipe-open-sidebar"
        >
          {sidebarSwipeContainerRef && (
            <div
              className="pointer-events-none absolute left-0 top-1/2 z-50 h-10 w-1 -translate-y-1/2 rounded-r-full bg-muted-foreground/20"
              aria-hidden
            />
          )}
          {nonChatContent}
        </div>
      )}
    </div>
  )
}

export default MainWindowContent
