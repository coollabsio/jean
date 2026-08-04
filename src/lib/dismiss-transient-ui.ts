/**
 * Dismiss open overlays when the remote/WebSocket connection is lost.
 *
 * Open Radix dialogs, menus, and popovers sit above recovery UI (or leave
 * body pointer-events locked) so Retry / Switch to Local become unusable
 * until Jean is restarted (issue #623).
 */

import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useBrowserStore } from '@/store/browser-store'

/** Fired so locally-managed overlays (e.g. RemoteConnectionsDialog) can close. */
export const DISMISS_TRANSIENT_UI_EVENT = 'jean:dismiss-transient-ui'

/**
 * Close store-driven modals/dialogs and ask uncontrolled Radix layers to
 * dismiss (Escape). Safe to call repeatedly; no-ops when nothing is open.
 */
export function dismissTransientUi(): void {
  // Batch-close every store flag that mounts a dialog, sheet, or modal.
  // Leave shell chrome (sidebars, file browser pane) alone — recovery covers
  // the viewport; navigation state is restored on reconnect/reload.
  useUIStore.setState({
    commandPaletteOpen: false,
    preferencesOpen: false,
    preferencesPane: null,
    commitModalOpen: false,
    // Setup wizard is a Dialog with body pointer-events lock; keep recovery usable.
    onboardingOpen: false,
    openInModalOpen: false,
    remotePickerOpen: false,
    remotePickerRepoPath: null,
    loadContextModalOpen: false,
    linkedProjectsModalOpen: false,
    magicModalOpen: false,
    resolveConflictsDialogOpen: false,
    newWorktreeModalOpen: false,
    newWorktreeModalDefaultTab: null,
    releaseNotesModalOpen: false,
    updatePrModalOpen: false,
    reviewCommentsModalOpen: false,
    workflowRunsModalOpen: false,
    workflowRunsModalProjectPath: null,
    workflowRunsModalBranch: null,
    cliUpdateModalOpen: false,
    cliUpdateModalType: null,
    cliLoginModalOpen: false,
    cliLoginModalType: null,
    cliLoginModalCommand: null,
    cliLoginModalCommandArgs: null,
    cliLoginModalAction: 'login',
    sessionChatModalOpen: false,
    sessionChatModalWorktreeId: null,
    newSessionModeTarget: null,
    gitDiffModalOpen: false,
    planDialogOpen: false,
    contextViewerOpen: false,
    featureTourOpen: false,
    jeanMcpIntroOpen: false,
    chatSearchOpen: false,
    githubDashboardOpen: false,
    viewingFilePath: null,
    // App update prompt is non-critical during connection recovery.
    updateModalVersion: null,
  })

  // Clear remote picker callback held outside store state.
  useUIStore.getState().closeRemotePicker()

  const projects = useProjectsStore.getState()
  if (projects.projectSettingsDialogOpen) projects.closeProjectSettings()
  if (projects.addProjectDialogOpen) projects.setAddProjectDialogOpen(false)
  if (projects.gitInitModalOpen) projects.closeGitInitModal()
  if (projects.cloneModalOpen) projects.closeCloneModal()
  if (projects.jeanConfigWizardOpen) projects.closeJeanConfigWizard()

  // Close any open browser modal drawers (portal/fixed layers).
  const browser = useBrowserStore.getState()
  const modalOpen = browser.modalOpen
  const openModalIds = Object.keys(modalOpen).filter(id => modalOpen[id])
  if (openModalIds.length > 0) {
    const nextModal = { ...modalOpen }
    for (const id of openModalIds) nextModal[id] = false
    useBrowserStore.setState({ modalOpen: nextModal })
  }

  // Uncontrolled Radix ContextMenu / DropdownMenu / Select / Popover layers.
  dispatchEscapeToDismissFloatingLayers()

  // Local-state dialogs (RemoteConnectionsDialog, etc.)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DISMISS_TRANSIENT_UI_EVENT))
  }

  // Safety net: clear scroll/pointer locks if a dialog unmount races the
  // recovery overlay (Radix RemoveScroll can leave body pointer-events:none).
  scheduleBodyLockCleanup()
}

function dispatchEscapeToDismissFloatingLayers(): void {
  if (typeof document === 'undefined') return

  const target = document.activeElement ?? document.body
  const eventInit: KeyboardEventInit = {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true,
  }

  target.dispatchEvent(new KeyboardEvent('keydown', eventInit))
  document.dispatchEvent(new KeyboardEvent('keydown', eventInit))
}

function scheduleBodyLockCleanup(): void {
  if (typeof document === 'undefined') return

  const clear = () => {
    // Only clear when no dialog/sheet overlay remains mounted.
    const hasBlockingOverlay = document.querySelector(
      '[data-slot="dialog-overlay"], [data-slot="sheet-overlay"], [data-slot="alert-dialog-overlay"]'
    )
    if (hasBlockingOverlay) return

    if (document.body.style.pointerEvents === 'none') {
      document.body.style.pointerEvents = ''
    }
    if (document.body.hasAttribute('data-scroll-locked')) {
      document.body.removeAttribute('data-scroll-locked')
    }
    // Radix RemoveScroll sometimes sets these on <html> as well.
    if (document.documentElement.style.pointerEvents === 'none') {
      document.documentElement.style.pointerEvents = ''
    }
  }

  // After React flushes closed dialog unmounts.
  queueMicrotask(clear)
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      clear()
      requestAnimationFrame(clear)
    })
  }
  setTimeout(clear, 50)
}
