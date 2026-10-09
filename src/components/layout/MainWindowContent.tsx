import {
  Suspense,
  lazy,
  memo,
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
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Plus, Loader2 } from '@/components/icons/reicon'
import { WelcomeProjectGrid } from './WelcomeProjectGrid'
import { isFolder } from '@/types/projects'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { scheduleIdleWork } from '@/lib/idle'
import { useIsMobile } from '@/hooks/use-mobile'
import { JeanLoadingScreen } from '@/components/shared/JeanLoadingScreen'

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
  sidebarSwipeIndicator?: {
    isSwiping: boolean
    translateX: number
    progress: number
  }
}

export const MainWindowContent = memo(function MainWindowContent({
  children,
  className,
  sidebarSwipeContainerRef,
  sidebarSwipeIndicator,
}: MainWindowContentProps) {
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const showAgents = useUIStore(state => state.railSection === 'agents')
  const isMobile = useIsMobile()

  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const setAddProjectDialogOpen = useProjectsStore(
    state => state.setAddProjectDialogOpen
  )
  const { data: projects = [], isError: projectsLoadError } = useProjects()
  const selectedProject = projects.find(
    project => project.id === selectedProjectId
  )
  const [backendCheckReady, setBackendCheckReady] = useState(false)
  useEffect(() => scheduleIdleWork(() => setBackendCheckReady(true), 1500), [])

  const realProjects = projects.filter(p => !isFolder(p))

  const showWelcome =
    !showAgents && !activeWorktreePath && !selectedProjectId && !children
  const shouldCheckBackends = backendCheckReady && showWelcome
  const { installedBackends, isLoading: backendsLoading } =
    useInstalledBackends({
      enabled: shouldCheckBackends,
    })
  const awaitingBackendCheck = showWelcome && !backendCheckReady
  const setupIncomplete =
    shouldCheckBackends && !backendsLoading && installedBackends.length === 0
  const showAddButton =
    showWelcome &&
    projects.length === 0 &&
    !projectsLoadError &&
    !setupIncomplete

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

  const nonChatContent =
    selectedProjectId && selectedProject ? (
      <Suspense fallback={<JeanLoadingScreen />}>
        <ProjectCanvasView
          key={selectedProjectId}
          projectId={selectedProjectId}
          project={selectedProject}
        />
      </Suspense>
    ) : selectedProjectId ? (
      <JeanLoadingScreen />
    ) : children ? (
      children
    ) : projectsLoadError && projects.length === 0 ? (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center font-sans"
        role="alert"
      >
        <h1 className="text-2xl font-bold text-foreground">
          Unable to load Jean projects
        </h1>
        <p className="text-sm text-muted-foreground">
          Check the projects sidebar for recovery details.
        </p>
      </div>
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
      {sidebarSwipeIndicator?.isSwiping && (
        <div
          className="pointer-events-none absolute top-1/2 z-[60] flex -translate-y-1/2 items-center justify-center"
          style={{ left: sidebarSwipeIndicator.translateX - 8 }}
          data-testid="mobile-sidebar-swipe-indicator"
        >
          <div
            className="rounded-full bg-muted-foreground/30 transition-transform"
            style={{
              width: 8 + sidebarSwipeIndicator.progress * 24,
              height: 8 + sidebarSwipeIndicator.progress * 24,
              opacity: 0.3 + sidebarSwipeIndicator.progress * 0.7,
            }}
          />
        </div>
      )}
      {activeWorktreePath && !showAgents ? (
        <div
          ref={isMobile ? sidebarSwipeContainerRef : undefined}
          className="relative h-full w-full"
          data-testid="mobile-swipe-chat"
        >
          <div className="relative h-full min-h-0 w-full">
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
          {showAgents ? (
            <div className="flex flex-1 items-center justify-center font-sans">
              <p className="text-lg text-muted-foreground">
                Agents are coming...
              </p>
            </div>
          ) : (
            nonChatContent
          )}
        </div>
      )}
    </div>
  )
})

export default MainWindowContent
