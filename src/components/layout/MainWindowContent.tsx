import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useProjects } from '@/services/projects'
import { useUIStore } from '@/store/ui-store'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Plus, Loader2 } from 'lucide-react'
import { WelcomeProjectGrid } from './WelcomeProjectGrid'
import { isFolder } from '@/types/projects'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { scheduleIdleWork } from '@/lib/idle'

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
}

export function MainWindowContent({
  children,
  className,
}: MainWindowContentProps) {
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
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

  return (
    <div
      className={cn(
        'relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-background',
        className
      )}
    >
      {activeWorktreePath ? (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading chat…
            </div>
          }
        >
          <ChatWindow />
        </Suspense>
      ) : selectedProjectId ? (
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
          <h1 className="text-4xl font-bold text-foreground">
            Welcome to Jean!
          </h1>
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
      )}
    </div>
  )
}

export default MainWindowContent
