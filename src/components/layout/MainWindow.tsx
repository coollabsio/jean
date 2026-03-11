import { useMemo, useCallback, useRef, useEffect, useState, lazy, Suspense } from 'react'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { DevModeBanner } from './DevModeBanner'
import { SidebarWidthProvider } from './SidebarWidthContext'
import { MainWindowContent } from './MainWindowContent'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { QuitConfirmationDialog } from './QuitConfirmationDialog'
import { BranchConflictDialog } from '@/components/worktree/BranchConflictDialog'
import { TeardownOutputDialog } from '@/components/worktree/TeardownOutputDialog'

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
const GitHubDashboardModal = lazy(() =>
  import('@/components/github-dashboard').then(mod => ({
    default: mod.GitHubDashboardModal,
  }))
)
const CloseWorktreeDialog = lazy(() =>
  import('@/components/chat/CloseWorktreeDialog').then(mod => ({
    default: mod.CloseWorktreeDialog,
  }))
)
import { FloatingDock } from '@/components/ui/floating-dock'
import { Toaster } from '@/components/ui/sonner'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useMainWindowEventListeners } from '@/hooks/useMainWindowEventListeners'
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
  const leftSidebarVisible = useUIStore(state => state.leftSidebarVisible)
  const leftSidebarSize = useUIStore(state => state.leftSidebarSize)
  const setLeftSidebarSize = useUIStore(state => state.setLeftSidebarSize)
  const preferencesOpen = useUIStore(state => state.preferencesOpen)
  const commitModalOpen = useUIStore(state => state.commitModalOpen)
  const onboardingOpen = useUIStore(state => state.onboardingOpen)
  const featureTourOpen = useUIStore(state => state.featureTourOpen)
  const openInModalOpen = useUIStore(state => state.openInModalOpen)
  const remotePickerOpen = useUIStore(state => state.remotePickerOpen)
  const magicModalOpen = useUIStore(state => state.magicModalOpen)
  const newWorktreeModalOpen = useUIStore(state => state.newWorktreeModalOpen)
  const releaseNotesModalOpen = useUIStore(state => state.releaseNotesModalOpen)
  const updatePrModalOpen = useUIStore(state => state.updatePrModalOpen)
  const workflowRunsModalOpen = useUIStore(state => state.workflowRunsModalOpen)
  const cliUpdateModalOpen = useUIStore(state => state.cliUpdateModalOpen)
  const cliLoginModalOpen = useUIStore(state => state.cliLoginModalOpen)
  const updateModalVersion = useUIStore(state => state.updateModalVersion)
  const githubDashboardOpen = useUIStore(state => state.githubDashboardOpen)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const addProjectDialogOpen = useProjectsStore(state => state.addProjectDialogOpen)
  const projectSettingsDialogOpen = useProjectsStore(
    state => state.projectSettingsDialogOpen
  )
  const gitInitModalOpen = useProjectsStore(state => state.gitInitModalOpen)
  const cloneModalOpen = useProjectsStore(state => state.cloneModalOpen)
  const jeanConfigWizardOpen = useProjectsStore(
    state => state.jeanConfigWizardOpen
  )

  // Fetch worktree data for polling initialization
  const { data: worktree } = useWorktree(selectedWorktreeId ?? null)
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null

  // Compute window title based on selected project/worktree
  const windowTitle = useMemo(() => {
    if (!project || !worktree) return 'Jean'
    const branchSuffix =
      worktree.branch !== worktree.name ? ` (${worktree.branch})` : ''

    return `${project.name} › ${worktree.name}${branchSuffix}`
  }, [project, worktree])

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

  // Handle CMD+W keybinding to close session or worktree (with optional confirmation)
  const [closeConfirmBranch, setCloseConfirmBranch] = useState<
    string | undefined
  >()
  const [closeConfirmMode, setCloseConfirmMode] = useState<'worktree' | 'session'>('worktree')
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const handleConfirmRequired = useCallback((branchName?: string, mode?: 'worktree' | 'session') => {
    setCloseConfirmBranch(branchName)
    setCloseConfirmMode(mode ?? 'worktree')
    setCloseConfirmOpen(true)
  }, [])
  const { executeClose } = useCloseSessionOrWorktreeKeybinding(
    handleConfirmRequired
  )

  // Handle CMD+SHIFT+T to restore last archived item
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
  const shouldRenderCliUpdateModal = useRetainedMount(cliUpdateModalOpen)
  const shouldRenderUpdateAvailableModal = useRetainedMount(
    updateModalVersion !== null
  )
  const shouldRenderCliLoginModal = useRetainedMount(cliLoginModalOpen)
  const shouldRenderOpenInModal = useRetainedMount(openInModalOpen)
  const shouldRenderRemotePickerModal = useRetainedMount(remotePickerOpen)
  const shouldRenderUpdatePrDialog = useRetainedMount(updatePrModalOpen)
  const shouldRenderWorkflowRunsModal = useRetainedMount(workflowRunsModalOpen)
  const shouldRenderMagicModal = useRetainedMount(magicModalOpen)
  const shouldRenderReleaseNotesDialog = useRetainedMount(
    releaseNotesModalOpen
  )
  const shouldRenderNewWorktreeModal = useRetainedMount(newWorktreeModalOpen)
  const shouldRenderAddProjectDialog = useRetainedMount(addProjectDialogOpen)
  const shouldRenderGitInitModal = useRetainedMount(gitInitModalOpen)
  const shouldRenderCloneProjectModal = useRetainedMount(cloneModalOpen)
  const shouldRenderArchivedModal = useRetainedMount(archivedModalOpen)
  const shouldRenderCloseWorktreeDialog = useRetainedMount(closeConfirmOpen)
  const shouldRenderGitHubDashboardModal = useRetainedMount(githubDashboardOpen)

  return (
    <div
      className={`flex h-dvh w-full flex-col overflow-hidden bg-background ${isNativeApp() ? 'rounded-xl' : ''}`}
    >
      {/* Title Bar */}
      <TitleBar title={windowTitle} />

      {/* Dev Mode Banner */}
      <DevModeBanner />

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar with pixel-based width - only render after UI state is initialized */}
        {leftSidebarVisible && isInitialized && (
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

        {/* Custom resize handle for left sidebar */}
        {leftSidebarVisible && isInitialized && (
          <div
            className="relative h-full w-px hover:bg-border"
            onMouseDown={handleResizeStart}
          >
            {/* Invisible wider hit area for easier clicking */}
            <div className="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize" />
          </div>
        )}

        {/* Main Content - flex-1 to fill remaining space */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <MainWindowContent />
          <FloatingDock />
        </div>
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
      {shouldRenderNewWorktreeModal && (
        <Suspense fallback={null}>
          <NewWorktreeModal />
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
        offset="52px"
        expand={true}
        toastOptions={{
          classNames: {
            toast:
              'group toast group-[.toaster]:bg-sidebar group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
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
