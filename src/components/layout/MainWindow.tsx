import {
  useMemo,
  useCallback,
  useRef,
  useEffect,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
} from 'react'
import { cn } from '@/lib/utils'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { useIsMobile } from '@/hooks/use-mobile'
import { useIsTouchDevice } from '@/hooks/use-touch-device'
import { useSwipeDown } from '@/hooks/useSwipeDown'
import { DevModeBanner } from './DevModeBanner'
import { SidebarWidthProvider } from './SidebarWidthContext'
import { MainWindowContent } from './MainWindowContent'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { QuitConfirmationDialog } from './QuitConfirmationDialog'
import { BranchConflictDialog } from '@/components/worktree/BranchConflictDialog'
import { TeardownOutputDialog } from '@/components/worktree/TeardownOutputDialog'
import { WindowResizeHandles } from './WindowResizeHandles'

// Lazy-loaded heavy modals (code splitting)
const LeftSideBar = lazy(() =>
  import('./LeftSideBar').then(mod => ({
    default: mod.LeftSideBar,
  }))
)
const PreferencesDialog = lazy(() =>
  import('@/components/preferences/PreferencesDialog').then(mod => ({
    default: mod.PreferencesDialog,
  }))
)
const ProjectSettingsDialog = lazy(() =>
  import('@/components/projects/ProjectSettingsDialog').then(mod => ({
    default: mod.ProjectSettingsDialog,
  }))
)
const CommitModal = lazy(() =>
  import('@/components/commit/CommitModal').then(mod => ({
    default: mod.CommitModal,
  }))
)
const OnboardingDialog = lazy(() =>
  import('@/components/onboarding/OnboardingDialog').then(mod => ({
    default: mod.OnboardingDialog,
  }))
)
const FeatureTourDialog = lazy(() =>
  import('@/components/onboarding/FeatureTourDialog').then(mod => ({
    default: mod.FeatureTourDialog,
  }))
)
const JeanConfigWizard = lazy(() =>
  import('@/components/onboarding/JeanConfigWizard').then(mod => ({
    default: mod.JeanConfigWizard,
  }))
)
const JeanMcpIntroDialog = lazy(() =>
  import('@/components/onboarding/JeanMcpIntroDialog').then(mod => ({
    default: mod.JeanMcpIntroDialog,
  }))
)
const CliUpdateModal = lazy(() =>
  import('@/components/layout/CliUpdateModal').then(mod => ({
    default: mod.CliUpdateModal,
  }))
)
const UpdateAvailableModal = lazy(() =>
  import('@/components/layout/UpdateAvailableModal').then(mod => ({
    default: mod.UpdateAvailableModal,
  }))
)
const CliLoginModal = lazy(() =>
  import('@/components/preferences/CliLoginModal').then(mod => ({
    default: mod.CliLoginModal,
  }))
)
const OpenInModal = lazy(() =>
  import('@/components/open-in/OpenInModal').then(mod => ({
    default: mod.OpenInModal,
  }))
)
const RemotePickerModal = lazy(() =>
  import('@/components/magic/RemotePickerModal').then(mod => ({
    default: mod.RemotePickerModal,
  }))
)
const UpdatePrDialog = lazy(() =>
  import('@/components/magic/UpdatePrDialog').then(mod => ({
    default: mod.UpdatePrDialog,
  }))
)
const ReviewCommentsDialog = lazy(() =>
  import('@/components/magic/ReviewCommentsDialog').then(mod => ({
    default: mod.ReviewCommentsDialog,
  }))
)
const NewWorktreeModal = lazy(() =>
  import('@/components/worktree/NewWorktreeModal').then(mod => ({
    default: mod.NewWorktreeModal,
  }))
)
const AddProjectDialog = lazy(() =>
  import('@/components/projects/AddProjectDialog').then(mod => ({
    default: mod.AddProjectDialog,
  }))
)
const GitInitModal = lazy(() =>
  import('@/components/projects/GitInitModal').then(mod => ({
    default: mod.GitInitModal,
  }))
)
const CloneProjectModal = lazy(() =>
  import('@/components/projects/CloneProjectModal').then(mod => ({
    default: mod.CloneProjectModal,
  }))
)
const ArchivedModal = lazy(() =>
  import('@/components/archive/ArchivedModal').then(mod => ({
    default: mod.ArchivedModal,
  }))
)
const ReleaseNotesDialog = lazy(() =>
  import('@/components/magic/ReleaseNotesDialog').then(mod => ({
    default: mod.ReleaseNotesDialog,
  }))
)
const WorkflowRunsModal = lazy(() =>
  import('@/components/shared/WorkflowRunsModal').then(mod => ({
    default: mod.WorkflowRunsModal,
  }))
)
const MagicModal = lazy(() =>
  import('@/components/magic/MagicModal').then(mod => ({
    default: mod.MagicModal,
  }))
)
const ResolveConflictsDialog = lazy(() =>
  import('@/components/magic/ResolveConflictsDialog').then(mod => ({
    default: mod.ResolveConflictsDialog,
  }))
)
const GitHubDashboardModal = lazy(() =>
  import('@/components/github-dashboard').then(mod => ({
    default: mod.GitHubDashboardModal,
  }))
)
const NewSessionModeModal = lazy(() =>
  import('@/components/chat/NewSessionModeModal').then(mod => ({
    default: mod.NewSessionModeModal,
  }))
)
const CloseWorktreeDialog = lazy(() =>
  import('@/components/chat/CloseWorktreeDialog').then(mod => ({
    default: mod.CloseWorktreeDialog,
  }))
)
import { FloatingDock } from '@/components/ui/floating-dock'
import { Toaster } from '@/components/ui/sonner'
import { MobileLeftSidebar } from './MobileLeftSidebar'
import { BrowserSidePane } from '@/components/browser/BrowserSidePane'
import { BrowserPanel } from '@/components/browser/BrowserPanel'
import { useBrowserEvents } from '@/hooks/useBrowserPane'
import { useToasterOffset } from '@/hooks/useToasterOffset'
import { useWindowMaximized } from '@/hooks/use-window-maximized'
import { useTerminalThemeSync } from '@/hooks/useTerminalThemeSync'
import { useSwipeBack } from '@/hooks/useSwipeBack'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useMainWindowEventListeners } from '@/hooks/useMainWindowEventListeners'
import { useGlobalInputSanitizer } from '@/hooks/useGlobalInputSanitizer'
import { useCloseSessionOrWorktreeKeybinding } from '@/services/chat'
import { useUIStatePersistence } from '@/hooks/useUIStatePersistence'
import { useSessionStatePersistence } from '@/hooks/useSessionStatePersistence'
import { useSessionPrefetch } from '@/hooks/useSessionPrefetch'
import { useRestoreLastArchived } from '@/hooks/useRestoreLastArchived'
import { useArchiveCleanup } from '@/hooks/useArchiveCleanup'
import { usePrWorktreeSweep } from '@/hooks/usePrWorktreeSweep'
import {
  useAppFocusTracking,
  useGitStatusEvents,
  useWorktreePolling,
  type WorktreePollingInfo,
} from '@/services/git-status'
import {
  useWorktree,
  useProjects,
  useCreateWorktreeKeybinding,
  useWorktreeEvents,
} from '@/services/projects'
import { isNativeApp } from '@/lib/environment'
import { isLinux, isWindows } from '@/lib/platform'

// Left sidebar resize constraints (pixels)
const MIN_SIDEBAR_WIDTH = 150
const MAX_SIDEBAR_WIDTH = 500

function useRetainedMount(active: boolean) {
  const [shouldMount, setShouldMount] = useState(active)

  useEffect(() => {
    if (active) {
      setShouldMount(true)
    }
  }, [active])

  return shouldMount
}

export function MainWindow() {
  useTerminalThemeSync()
  const isMaximized = useWindowMaximized()
  const toasterOffset = useToasterOffset()
  const leftSidebarVisible = useUIStore(state => state.leftSidebarVisible)
  const leftSidebarSize = useUIStore(state => state.leftSidebarSize)
  const setLeftSidebarSize = useUIStore(state => state.setLeftSidebarSize)
  const setLeftSidebarVisible = useUIStore(state => state.setLeftSidebarVisible)
  const preferencesOpen = useUIStore(state => state.preferencesOpen)
  const commitModalOpen = useUIStore(state => state.commitModalOpen)
  const onboardingOpen = useUIStore(state => state.onboardingOpen)
  const featureTourOpen = useUIStore(state => state.featureTourOpen)
  const jeanMcpIntroOpen = useUIStore(state => state.jeanMcpIntroOpen)
  const openInModalOpen = useUIStore(state => state.openInModalOpen)
  const remotePickerOpen = useUIStore(state => state.remotePickerOpen)
  const magicModalOpen = useUIStore(state => state.magicModalOpen)
  const resolveConflictsDialogOpen = useUIStore(
    state => state.resolveConflictsDialogOpen
  )
  const setResolveConflictsDialogOpen = useUIStore(
    state => state.setResolveConflictsDialogOpen
  )
  const newWorktreeModalOpen = useUIStore(state => state.newWorktreeModalOpen)
  const releaseNotesModalOpen = useUIStore(state => state.releaseNotesModalOpen)
  const updatePrModalOpen = useUIStore(state => state.updatePrModalOpen)
  const reviewCommentsModalOpen = useUIStore(
    state => state.reviewCommentsModalOpen
  )
  const workflowRunsModalOpen = useUIStore(state => state.workflowRunsModalOpen)
  const cliUpdateModalOpen = useUIStore(state => state.cliUpdateModalOpen)
  const cliLoginModalOpen = useUIStore(state => state.cliLoginModalOpen)
  const updateModalVersion = useUIStore(state => state.updateModalVersion)
  const githubDashboardOpen = useUIStore(state => state.githubDashboardOpen)
  const newSessionModeTarget = useUIStore(state => state.newSessionModeTarget)
  const sessionChatModalOpen = useUIStore(state => state.sessionChatModalOpen)
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const addProjectDialogOpen = useProjectsStore(
    state => state.addProjectDialogOpen
  )
  const projectSettingsDialogOpen = useProjectsStore(
    state => state.projectSettingsDialogOpen
  )
  const gitInitModalOpen = useProjectsStore(state => state.gitInitModalOpen)
  const cloneModalOpen = useProjectsStore(state => state.cloneModalOpen)
  const jeanConfigWizardOpen = useProjectsStore(
    state => state.jeanConfigWizardOpen
  )

  const isMobile = useIsMobile()
  const isTouch = useIsTouchDevice()
  const canSwipeOpenSidebar =
    isMobile &&
    !activeWorktreePath &&
    !leftSidebarVisible &&
    !sessionChatModalOpen
  const swipeOpenSidebar = useSwipeBack({
    onSwipeBack: useCallback(() => {
      useUIStore.getState().setLeftSidebarVisible(true)
    }, []),
    enabled: canSwipeOpenSidebar,
  })
  const swipeDown = useSwipeDown({
    onSwipeDown: useCallback(() => {
      useUIStore.getState().setCommandPaletteOpen(true)
    }, []),
    enabled: isTouch,
  })

  // Fetch worktree data for polling initialization
  const { data: worktree } = useWorktree(selectedWorktreeId ?? null)
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null

  // Compute window title based on selected project/worktree
  // On mobile, show only project name (worktree name is in the content header)
  const windowTitle = useMemo(() => {
    if (!project || !worktree) return 'Jean'
    if (isMobile) return project.name
    const branchSuffix =
      worktree.branch !== worktree.name ? ` (${worktree.branch})` : ''

    return `${project.name} › ${worktree.name}${branchSuffix}`
  }, [project, worktree, isMobile])

  // Compute polling info - null if no worktree or data not loaded
  const pollingInfo: WorktreePollingInfo | null = useMemo(() => {
    if (!worktree || !project) return null
    return {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      baseBranch: project.default_branch ?? 'main',
      prNumber: worktree.pr_number,
      prUrl: worktree.pr_url,
    }
  }, [worktree, project])

  // Initialize polling for active worktree (handles startup & worktree changes)
  useWorktreePolling(pollingInfo)

  // Persist UI state (last opened worktree, expanded projects)
  const { isInitialized } = useUIStatePersistence()

  // Persist session-specific state (answered questions, fixed findings, etc.)
  useSessionStatePersistence()

  // Prefetch sessions for the selected or expanded projects after the UI state
  // is restored so the first render path stays light.
  useSessionPrefetch(isInitialized ? projects : undefined)

  // Ref for the sidebar element to update width directly during drag
  const sidebarRef = useRef<HTMLDivElement>(null)

  // Set up global event listeners (keyboard shortcuts, etc.)
  useMainWindowEventListeners()
  useGlobalInputSanitizer()

  // Subscribe to Rust → React browser events (loading/loaded/title/nav/closed)
  useBrowserEvents()

  // Handle CMD+W keybinding to close session or worktree (with optional confirmation)
  const [closeConfirmBranch, setCloseConfirmBranch] = useState<
    string | undefined
  >()
  const [closeConfirmMode, setCloseConfirmMode] = useState<
    'worktree' | 'session'
  >('worktree')
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const handleConfirmRequired = useCallback(
    (branchName?: string, mode?: 'worktree' | 'session') => {
      setCloseConfirmBranch(branchName)
      setCloseConfirmMode(mode ?? 'worktree')
      setCloseConfirmOpen(true)
    },
    []
  )
  const { executeClose } = useCloseSessionOrWorktreeKeybinding(
    handleConfirmRequired
  )

  // Handle restore-last-archived keybinding
  useRestoreLastArchived()

  // Archive modal state (triggered by command palette or sidebar button)
  const [archivedModalOpen, setArchivedModalOpen] = useState(false)
  useEffect(() => {
    const handler = () => setArchivedModalOpen(true)
    window.addEventListener('command:open-archived-modal', handler)
    return () =>
      window.removeEventListener('command:open-archived-modal', handler)
  }, [])

  // Auto-cleanup old archived items on startup
  useArchiveCleanup()

  // Sync all worktrees with open PRs to backend for sweep polling
  usePrWorktreeSweep(projects)

  // Track app focus state for background task manager
  useAppFocusTracking()

  // Listen for git status updates from the background task
  useGitStatusEvents()

  // Listen for background worktree events (creation/deletion) - must be here
  // (not in sidebar) so events are received even when sidebar is closed
  useWorktreeEvents()

  // Handle CMD+N keybinding to create new worktree
  useCreateWorktreeKeybinding()

  // Set browser tab title in web mode (native app sets window title via Tauri)
  useEffect(() => {
    if (!isNativeApp()) {
      document.title = windowTitle
    }
  }, [windowTitle])

  // Handle custom resize for left sidebar (pixel-based)
  // Uses direct DOM manipulation during drag for smooth performance,
  // commits to Zustand only on mouseup
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = leftSidebarSize
      let currentWidth = startWidth

      const handleMouseMove = (moveEvent: MouseEvent) => {
        // Dragging right increases width (sidebar is on left)
        const delta = moveEvent.clientX - startX
        currentWidth = Math.min(
          MAX_SIDEBAR_WIDTH,
          Math.max(MIN_SIDEBAR_WIDTH, startWidth + delta)
        )
        // Update DOM directly for smooth resize (no React re-render)
        if (sidebarRef.current) {
          sidebarRef.current.style.width = `${currentWidth}px`
        }
      }

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        // Commit final width to Zustand state
        setLeftSidebarSize(currentWidth)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [leftSidebarSize, setLeftSidebarSize]
  )

  const shouldRenderPreferencesDialog = useRetainedMount(preferencesOpen)
  const shouldRenderProjectSettingsDialog = useRetainedMount(
    projectSettingsDialogOpen
  )
  const shouldRenderCommitModal = useRetainedMount(commitModalOpen)
  const shouldRenderOnboardingDialog = useRetainedMount(onboardingOpen)
  const shouldRenderFeatureTourDialog = useRetainedMount(featureTourOpen)
  const shouldRenderJeanConfigWizard = useRetainedMount(jeanConfigWizardOpen)
  const shouldRenderJeanMcpIntroDialog = useRetainedMount(jeanMcpIntroOpen)
  const shouldRenderCliUpdateModal = useRetainedMount(cliUpdateModalOpen)
  const shouldRenderUpdateAvailableModal = useRetainedMount(
    updateModalVersion !== null
  )
  const shouldRenderCliLoginModal = useRetainedMount(cliLoginModalOpen)
  const shouldRenderOpenInModal = useRetainedMount(openInModalOpen)
  const shouldRenderRemotePickerModal = useRetainedMount(remotePickerOpen)
  const shouldRenderUpdatePrDialog = useRetainedMount(updatePrModalOpen)
  const shouldRenderReviewCommentsDialog = useRetainedMount(
    reviewCommentsModalOpen
  )
  const shouldRenderWorkflowRunsModal = useRetainedMount(workflowRunsModalOpen)
  const shouldRenderMagicModal = useRetainedMount(magicModalOpen)
  const shouldRenderResolveConflictsDialog = useRetainedMount(
    resolveConflictsDialogOpen
  )
  const shouldRenderReleaseNotesDialog = useRetainedMount(releaseNotesModalOpen)
  const shouldRenderNewWorktreeModal = useRetainedMount(newWorktreeModalOpen)
  const shouldRenderAddProjectDialog = useRetainedMount(addProjectDialogOpen)
  const shouldRenderGitInitModal = useRetainedMount(gitInitModalOpen)
  const shouldRenderCloneProjectModal = useRetainedMount(cloneModalOpen)
  const shouldRenderArchivedModal = useRetainedMount(archivedModalOpen)
  const shouldRenderCloseWorktreeDialog = useRetainedMount(closeConfirmOpen)
  const shouldRenderGitHubDashboardModal = useRetainedMount(githubDashboardOpen)
  const shouldRenderNewSessionModeModal = useRetainedMount(
    newSessionModeTarget !== null
  )

  // On Windows, use smaller border radius and remove it when maximized
  // On other platforms, use rounded-xl only in native app mode
  const roundedClass = isWindows
    ? !isMaximized && 'rounded-sm'
    : isNativeApp() && 'rounded-xl'

  return (
    <div
      ref={isTouch ? swipeDown.containerRef : undefined}
      className={cn(
        'flex h-dvh w-full flex-col overflow-hidden bg-background',
        roundedClass
      )}
    >
      {isNativeApp() && isLinux && <WindowResizeHandles />}

      {/* Touch swipe-down pull indicator */}
      {isTouch && swipeDown.isSwiping && (
        <div
          className="pointer-events-none absolute left-1/2 z-[60] flex -translate-x-1/2 items-center justify-center"
          style={{ top: swipeDown.translateY - 8 }}
        >
          <div
            className="rounded-full bg-muted-foreground/30 transition-transform"
            style={{
              width: 8 + swipeDown.progress * 24,
              height: 8 + swipeDown.progress * 24,
              opacity: 0.3 + swipeDown.progress * 0.7,
            }}
          />
        </div>
      )}

      {/* Title Bar - semi-transparent overlay */}
      <TitleBar title={windowTitle} className="absolute top-0 left-0 right-0" />

      {/* Dev Mode Banner */}
      <DevModeBanner />

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden pt-8">
        {/* Desktop: in-flow left sidebar (shifts layout). Only after UI state init. */}
        {!isMobile && leftSidebarVisible && isInitialized && (
          <SidebarWidthProvider value={leftSidebarSize}>
            <div
              ref={sidebarRef}
              className="h-full overflow-hidden"
              style={{ width: leftSidebarSize }}
            >
              <Suspense fallback={null}>
                <LeftSideBar />
              </Suspense>
            </div>
          </SidebarWidthProvider>
        )}

        {/* Desktop: custom resize handle for left sidebar */}
        {!isMobile && leftSidebarVisible && isInitialized && (
          <div
            className="relative h-full w-px bg-border"
            onMouseDown={handleResizeStart}
          >
            {/* Invisible wider hit area for easier clicking */}
            <div className="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize" />
          </div>
        )}

        {/* Mobile: overlay drawer — does not shift main content; backdrop dismisses */}
        {isMobile && isInitialized && (
          <MobileLeftSidebar
            open={leftSidebarVisible}
            onOpenChange={setLeftSidebarVisible}
            width={leftSidebarSize}
            isDragging={swipeOpenSidebar.isSwiping}
            dragOffset={swipeOpenSidebar.translateX}
            dragTransition={swipeOpenSidebar.transitionStyle}
          />
        )}

        {/* Main Content + bottom browser panel stacked vertically */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-w-0 flex-1 overflow-hidden">
            <MainWindowContent
              sidebarSwipeContainerRef={
                canSwipeOpenSidebar ? swipeOpenSidebar.containerRef : undefined
              }
            />
            <FloatingDock />
          </div>
          {/* Browser bottom panel - native-only, pinned to bottom */}
          <BrowserPanel />
        </div>

        {/* Browser side pane - native-only, mounts on right edge */}
        <BrowserSidePane />
      </div>

      {/* Global UI Components (hidden until triggered) */}
      <CommandPalette />
      {shouldRenderPreferencesDialog && (
        <Suspense fallback={null}>
          <PreferencesDialog />
        </Suspense>
      )}
      {shouldRenderProjectSettingsDialog && (
        <Suspense fallback={null}>
          <ProjectSettingsDialog />
        </Suspense>
      )}
      {shouldRenderCommitModal && (
        <Suspense fallback={null}>
          <CommitModal />
        </Suspense>
      )}
      {shouldRenderOnboardingDialog && (
        <Suspense fallback={null}>
          <OnboardingDialog />
        </Suspense>
      )}
      {shouldRenderFeatureTourDialog && (
        <Suspense fallback={null}>
          <FeatureTourDialog />
        </Suspense>
      )}
      {shouldRenderJeanConfigWizard && (
        <Suspense fallback={null}>
          <JeanConfigWizard />
        </Suspense>
      )}
      {shouldRenderJeanMcpIntroDialog && (
        <Suspense fallback={null}>
          <JeanMcpIntroDialog />
        </Suspense>
      )}
      {shouldRenderCliUpdateModal && (
        <Suspense fallback={null}>
          <CliUpdateModal />
        </Suspense>
      )}
      {shouldRenderUpdateAvailableModal && (
        <Suspense fallback={null}>
          <UpdateAvailableModal />
        </Suspense>
      )}
      {shouldRenderCliLoginModal && (
        <Suspense fallback={null}>
          <CliLoginModal />
        </Suspense>
      )}
      {shouldRenderOpenInModal && (
        <Suspense fallback={null}>
          <OpenInModal />
        </Suspense>
      )}
      {shouldRenderWorkflowRunsModal && (
        <Suspense fallback={null}>
          <WorkflowRunsModal />
        </Suspense>
      )}
      {shouldRenderMagicModal && (
        <Suspense fallback={null}>
          <MagicModal />
        </Suspense>
      )}
      {shouldRenderResolveConflictsDialog && (
        <Suspense fallback={null}>
          <ResolveConflictsDialog
            open={resolveConflictsDialogOpen}
            onOpenChange={setResolveConflictsDialogOpen}
            onConfirm={override => {
              window.dispatchEvent(
                new CustomEvent('magic-command', {
                  detail: { command: 'resolve-conflicts', override },
                })
              )
            }}
          />
        </Suspense>
      )}
      {shouldRenderRemotePickerModal && (
        <Suspense fallback={null}>
          <RemotePickerModal />
        </Suspense>
      )}
      {shouldRenderReleaseNotesDialog && (
        <Suspense fallback={null}>
          <ReleaseNotesDialog />
        </Suspense>
      )}
      {shouldRenderUpdatePrDialog && (
        <Suspense fallback={null}>
          <UpdatePrDialog />
        </Suspense>
      )}
      {shouldRenderReviewCommentsDialog && (
        <Suspense fallback={null}>
          <ReviewCommentsDialog />
        </Suspense>
      )}
      {shouldRenderNewWorktreeModal && (
        <Suspense fallback={null}>
          <NewWorktreeModal />
        </Suspense>
      )}
      {shouldRenderNewSessionModeModal && (
        <Suspense fallback={null}>
          <NewSessionModeModal />
        </Suspense>
      )}
      {shouldRenderAddProjectDialog && (
        <Suspense fallback={null}>
          <AddProjectDialog />
        </Suspense>
      )}
      {shouldRenderGitInitModal && (
        <Suspense fallback={null}>
          <GitInitModal />
        </Suspense>
      )}
      {shouldRenderCloneProjectModal && (
        <Suspense fallback={null}>
          <CloneProjectModal />
        </Suspense>
      )}
      {shouldRenderArchivedModal && (
        <Suspense fallback={null}>
          <ArchivedModal
            open={archivedModalOpen}
            onOpenChange={setArchivedModalOpen}
          />
        </Suspense>
      )}
      {shouldRenderCloseWorktreeDialog && (
        <Suspense fallback={null}>
          <CloseWorktreeDialog
            open={closeConfirmOpen}
            onOpenChange={setCloseConfirmOpen}
            onConfirm={executeClose}
            branchName={closeConfirmBranch}
            mode={closeConfirmMode}
          />
        </Suspense>
      )}
      <QuitConfirmationDialog />
      {shouldRenderGitHubDashboardModal && (
        <Suspense fallback={null}>
          <GitHubDashboardModal />
        </Suspense>
      )}
      <BranchConflictDialog />
      <TeardownOutputDialog />
      <Toaster
        position="bottom-right"
        offset={toasterOffset}
        mobileOffset={toasterOffset}
        expand={true}
        swipeDirections={['left', 'right', 'top', 'bottom']}
        style={{ '--width': '400px' } as CSSProperties}
        toastOptions={{
          classNames: {
            toast:
              'group toast group-[.toaster]:bg-[var(--toast-background)] group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
            description: 'group-[.toast]:text-muted-foreground',
            actionButton:
              'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
            cancelButton:
              'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          },
        }}
      />
    </div>
  )
}

export default MainWindow
