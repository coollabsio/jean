import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { CliType } from '@/lib/cli-update'

export type PreferencePane =
  | 'general'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'pi'
  | 'commandcode'
  | 'grok'
  | 'kimi'
  | 'github'
  | 'coderabbit'
  | 'appearance'
  | 'keybindings'
  | 'terminal'
  | 'magic-prompts'
  | 'mcp-servers'
  | 'providers'
  | 'usage'
  | 'integrations'
  | 'experimental'
  | 'web-access'
  | 'opinionated'

export type OnboardingStartStep = 'claude' | 'gh' | null

export type WorktreePrimarySurface = 'chat' | 'terminal'
export type NewSessionModeOrigin = 'chat' | 'modal' | 'canvas'
export type NewSessionModeIntent = 'picker' | 'default'

export interface NewSessionModeTarget {
  worktreeId: string
  worktreePath: string
  origin: NewSessionModeOrigin
  intent?: NewSessionModeIntent
}

export type CliUpdateModalType =
  | 'claude'
  | 'gh'
  | 'codex'
  | 'opencode'
  | 'pi'
  | 'coderabbit'
  | 'commandcode'
  | 'grok'
  | 'kimi'
  | null

export interface PendingCliUpdate {
  type: CliType
  currentVersion: string
  latestVersion: string
  cliSource?: 'jean' | 'path'
  cliPath?: string | null
  packageManager?: string | null
}

/** Sticky jean-server update offer for remote / Web Access clients. */
export interface PendingServerUpdate {
  latestVersion: string
  currentVersion: string
  canUpdate: boolean
  reason?: string | null
}

export type CliLoginModalType =
  | 'claude'
  | 'gh'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'pi'
  | 'commandcode'
  | 'grok'
  | 'kimi'
  | 'coderabbit'
  | null

interface UIState {
  leftSidebarVisible: boolean
  leftSidebarSize: number // Width in pixels, persisted across sessions
  rightSidebarVisible: boolean
  commandPaletteOpen: boolean
  preferencesOpen: boolean
  preferencesPane: PreferencePane | null
  commitModalOpen: boolean
  onboardingOpen: boolean
  onboardingDismissed: boolean
  onboardingManuallyTriggered: boolean
  onboardingStartStep: OnboardingStartStep
  openInModalOpen: boolean
  remotePickerOpen: boolean
  remotePickerRepoPath: string | null
  loadContextModalOpen: boolean
  linkedProjectsModalOpen: boolean
  magicModalOpen: boolean
  resolveConflictsDialogOpen: boolean
  newWorktreeModalOpen: boolean
  newWorktreeModalDefaultTab:
    | 'quick'
    | 'issues'
    | 'prs'
    | 'security'
    | 'branches'
    | 'linear'
    | 'sentry'
    | null
  releaseNotesModalOpen: boolean
  updatePrModalOpen: boolean
  reviewCommentsModalOpen: boolean
  workflowRunsModalOpen: boolean
  workflowRunsModalProjectPath: string | null
  workflowRunsModalBranch: string | null
  cliUpdateModalOpen: boolean
  cliUpdateModalType: CliUpdateModalType
  cliLoginModalOpen: boolean
  cliLoginModalType: CliLoginModalType
  cliLoginModalCommand: string | null
  cliLoginModalCommandArgs: string[] | null
  cliLoginModalAction: 'login' | 'update' | 'install'
  /** Worktree IDs that should auto-trigger investigate-issue when created */
  autoInvestigateWorktreeIds: Set<string>
  /** Worktree IDs that should auto-trigger investigate-pr when created */
  autoInvestigatePRWorktreeIds: Set<string>
  /** Worktree IDs that should auto-trigger investigate-security-alert when created */
  autoInvestigateSecurityAlertWorktreeIds: Set<string>
  /** Worktree IDs that should auto-trigger investigate-advisory when created */
  autoInvestigateAdvisoryWorktreeIds: Set<string>
  /** Worktree IDs that should auto-trigger investigate-linear-issue when created */
  autoInvestigateLinearIssueWorktreeIds: Set<string>
  /** Worktree IDs that should auto-trigger Sentry issue investigation */
  autoInvestigateSentryIssueWorktreeIds: Set<string>
  /** Counter for background worktree creations (CMD+Click) — skip auto-navigation */
  pendingBackgroundCreations: number
  /** Worktree IDs that should auto-open first session modal when canvas mounts */
  autoOpenSessionWorktreeIds: Set<string>
  /** Specific session ID to auto-open per worktree (overrides first-session default) */
  pendingAutoOpenSessionIds: Record<string, string>
  /** Whether a session chat modal is open (for magic command keybinding checks) */
  sessionChatModalOpen: boolean
  /** Whether the chat toolbar is mounted — used to hide the global FloatingDock
   *  because its burger-menu counterpart now lives in the chat toolbar. */
  chatToolbarMounted: boolean
  /** Which worktree the session chat modal is for (for magic command worktree resolution) */
  sessionChatModalWorktreeId: string | null
  /** Per-session primary surface shown inside the chat bounds */
  sessionPrimarySurface: Record<string, WorktreePrimarySurface>
  /** Terminal instance ID owned by a terminal session */
  sessionTerminalIds: Record<string, string>
  /** New session mode picker target; null means closed */
  newSessionModeTarget: NewSessionModeTarget | null
  /** Whether a git diff modal is open (blocks execute_run keybinding) */
  gitDiffModalOpen: boolean
  /** File paths selected for commit in GitDiffModal (uncommitted tab only) */
  gitDiffSelectedFiles: Set<string>
  /** Whether a plan dialog is open (blocks canvas approve keybindings) */
  planDialogOpen: boolean
  /** Whether the context viewer dialog is open (blocks SessionChatModal ESC close) */
  contextViewerOpen: boolean
  /** Whether the feature tour dialog is open */
  featureTourOpen: boolean
  /** Whether the one-time Jean MCP introduction dialog is open */
  jeanMcpIntroOpen: boolean
  /** Whether UI state has been restored from persisted storage */
  uiStateInitialized: boolean
  /** Pending app update that user skipped — shown as indicator in title bar */
  pendingUpdateVersion: string | null
  /** When non-null, shows the update available modal */
  updateModalVersion: string | null
  /**
   * App update package installed but not applied yet — title bar shows Restart.
   * Prevents re-download loops while the old binary is still running (#507).
   */
  updateReadyVersion: string | null
  /** True while downloadAndInstall is in progress */
  isUpdateInstalling: boolean
  /**
   * Pending jean-server update (remote / Web Access) — sticky title-bar
   * indicator so dismissing the toast does not lose the offer.
   */
  pendingServerUpdate: PendingServerUpdate | null
  /** CLI updates detected — shown as badge+popover in title bar */
  availableCliUpdates: PendingCliUpdate[]
  toggleLeftSidebar: () => void
  setLeftSidebarVisible: (visible: boolean) => void
  setLeftSidebarSize: (size: number) => void
  toggleRightSidebar: () => void
  setRightSidebarVisible: (visible: boolean) => void
  toggleCommandPalette: () => void
  setCommandPaletteOpen: (open: boolean) => void
  togglePreferences: () => void
  setPreferencesOpen: (open: boolean) => void
  openPreferencesPane: (pane: PreferencePane) => void
  setCommitModalOpen: (open: boolean) => void
  setOnboardingOpen: (open: boolean) => void
  setOnboardingManuallyTriggered: (triggered: boolean) => void
  setOnboardingStartStep: (step: OnboardingStartStep) => void
  setOpenInModalOpen: (open: boolean) => void
  openRemotePicker: (
    repoPath: string,
    callback: (remote: string) => void
  ) => void
  closeRemotePicker: () => void
  setLoadContextModalOpen: (open: boolean) => void
  setLinkedProjectsModalOpen: (open: boolean) => void
  setMagicModalOpen: (open: boolean) => void
  setResolveConflictsDialogOpen: (open: boolean) => void
  setNewWorktreeModalOpen: (open: boolean) => void
  setNewWorktreeModalDefaultTab: (
    tab:
      | 'quick'
      | 'issues'
      | 'prs'
      | 'security'
      | 'branches'
      | 'linear'
      | 'sentry'
      | null
  ) => void
  setReleaseNotesModalOpen: (open: boolean) => void
  setUpdatePrModalOpen: (open: boolean) => void
  setReviewCommentsModalOpen: (open: boolean) => void
  setWorkflowRunsModalOpen: (
    open: boolean,
    projectPath?: string | null,
    branch?: string | null
  ) => void
  openCliUpdateModal: (type: Exclude<CliUpdateModalType, null>) => void
  closeCliUpdateModal: () => void
  openCliLoginModal: (
    type: Exclude<CliLoginModalType, null>,
    command: string,
    commandArgs?: string[],
    action?: 'login' | 'update' | 'install'
  ) => void
  closeCliLoginModal: () => void
  incrementPendingBackgroundCreations: () => void
  consumePendingBackgroundCreation: () => boolean
  markWorktreeForAutoInvestigate: (worktreeId: string) => void
  consumeAutoInvestigate: (worktreeId: string) => boolean
  markWorktreeForAutoInvestigatePR: (worktreeId: string) => void
  consumeAutoInvestigatePR: (worktreeId: string) => boolean
  markWorktreeForAutoInvestigateSecurityAlert: (worktreeId: string) => void
  consumeAutoInvestigateSecurityAlert: (worktreeId: string) => boolean
  markWorktreeForAutoInvestigateAdvisory: (worktreeId: string) => void
  consumeAutoInvestigateAdvisory: (worktreeId: string) => boolean
  markWorktreeForAutoInvestigateLinearIssue: (worktreeId: string) => void
  consumeAutoInvestigateLinearIssue: (worktreeId: string) => boolean
  markWorktreeForAutoInvestigateSentryIssue: (worktreeId: string) => void
  consumeAutoInvestigateSentryIssue: (worktreeId: string) => boolean
  markWorktreeForAutoOpenSession: (
    worktreeId: string,
    sessionId?: string
  ) => void
  consumeAutoOpenSession: (worktreeId: string) => {
    shouldOpen: boolean
    sessionId?: string
  }
  setSessionChatModalOpen: (open: boolean, worktreeId?: string | null) => void
  setSessionPrimarySurface: (
    sessionId: string,
    surface: WorktreePrimarySurface
  ) => void
  setSessionTerminalId: (sessionId: string, terminalId: string) => void
  clearSessionTerminalSurface: (sessionId: string) => string | undefined
  openNewSessionModeModal: (target: NewSessionModeTarget) => void
  closeNewSessionModeModal: () => void
  setChatToolbarMounted: (mounted: boolean) => void
  setGitDiffModalOpen: (open: boolean) => void
  toggleGitDiffSelectedFile: (filePath: string) => void
  clearGitDiffSelectedFiles: () => void
  setPlanDialogOpen: (open: boolean) => void
  setContextViewerOpen: (open: boolean) => void
  setFeatureTourOpen: (open: boolean) => void
  setJeanMcpIntroOpen: (open: boolean) => void
  setUIStateInitialized: (initialized: boolean) => void
  setPendingUpdateVersion: (version: string | null) => void
  setUpdateModalVersion: (version: string | null) => void
  setUpdateReadyVersion: (version: string | null) => void
  setIsUpdateInstalling: (installing: boolean) => void
  setPendingServerUpdate: (update: PendingServerUpdate | null) => void
  setAvailableCliUpdates: (updates: PendingCliUpdate[]) => void
  dismissCliUpdateNotice: (type: PendingCliUpdate['type']) => void
  chatSearchOpen: boolean
  setChatSearchOpen: (open: boolean) => void
  githubDashboardOpen: boolean
  setGitHubDashboardOpen: (open: boolean) => void
}

// Store callback outside Zustand state to avoid serialization issues with
// devtools and deep-comparison utilities (functions are not serializable).
let _remotePickerCallback: ((remote: string) => void) | null = null

export function getRemotePickerCallback() {
  return _remotePickerCallback
}

export const useUIStore = create<UIState>()(
  devtools(
    (set, get) => ({
      leftSidebarVisible: false,
      leftSidebarSize: 250, // Default width in pixels
      rightSidebarVisible: false,
      commandPaletteOpen: false,
      preferencesOpen: false,
      preferencesPane: null,
      commitModalOpen: false,
      onboardingOpen: false,
      onboardingDismissed: false,
      onboardingManuallyTriggered: false,
      onboardingStartStep: null,
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
      autoInvestigateWorktreeIds: new Set(),
      autoInvestigatePRWorktreeIds: new Set(),
      autoInvestigateSecurityAlertWorktreeIds: new Set(),
      autoInvestigateAdvisoryWorktreeIds: new Set(),
      autoInvestigateLinearIssueWorktreeIds: new Set(),
      autoInvestigateSentryIssueWorktreeIds: new Set(),
      pendingBackgroundCreations: 0,
      autoOpenSessionWorktreeIds: new Set(),
      pendingAutoOpenSessionIds: {},
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
      sessionPrimarySurface: {},
      sessionTerminalIds: {},
      newSessionModeTarget: null,
      chatToolbarMounted: false,
      gitDiffModalOpen: false,
      gitDiffSelectedFiles: new Set<string>(),
      planDialogOpen: false,
      contextViewerOpen: false,
      featureTourOpen: false,
      jeanMcpIntroOpen: false,
      uiStateInitialized: false,
      pendingUpdateVersion: null,
      updateModalVersion: null,
      updateReadyVersion: null,
      isUpdateInstalling: false,
      pendingServerUpdate: null,
      availableCliUpdates: [],
      chatSearchOpen: false,
      githubDashboardOpen: false,
      toggleLeftSidebar: () =>
        set(
          state => ({ leftSidebarVisible: !state.leftSidebarVisible }),
          undefined,
          'toggleLeftSidebar'
        ),

      setLeftSidebarVisible: visible =>
        set(
          state =>
            state.leftSidebarVisible === visible
              ? state
              : { leftSidebarVisible: visible },
          undefined,
          'setLeftSidebarVisible'
        ),

      toggleRightSidebar: () =>
        set(
          state => ({ rightSidebarVisible: !state.rightSidebarVisible }),
          undefined,
          'toggleRightSidebar'
        ),

      setLeftSidebarSize: size =>
        set(
          state =>
            state.leftSidebarSize === size ? state : { leftSidebarSize: size },
          undefined,
          'setLeftSidebarSize'
        ),

      setRightSidebarVisible: visible =>
        set(
          state =>
            state.rightSidebarVisible === visible
              ? state
              : { rightSidebarVisible: visible },
          undefined,
          'setRightSidebarVisible'
        ),

      toggleCommandPalette: () =>
        set(
          state => ({ commandPaletteOpen: !state.commandPaletteOpen }),
          undefined,
          'toggleCommandPalette'
        ),

      setCommandPaletteOpen: open =>
        set(
          state =>
            state.commandPaletteOpen === open
              ? state
              : { commandPaletteOpen: open },
          undefined,
          'setCommandPaletteOpen'
        ),

      togglePreferences: () =>
        set(
          state => ({ preferencesOpen: !state.preferencesOpen }),
          undefined,
          'togglePreferences'
        ),

      setPreferencesOpen: open =>
        set(
          state =>
            state.preferencesOpen === open && state.preferencesPane === null
              ? state
              : { preferencesOpen: open, preferencesPane: null },
          undefined,
          'setPreferencesOpen'
        ),

      openPreferencesPane: pane =>
        set(
          state =>
            state.preferencesOpen && state.preferencesPane === pane
              ? state
              : { preferencesOpen: true, preferencesPane: pane },
          undefined,
          'openPreferencesPane'
        ),

      setCommitModalOpen: open =>
        set(
          state =>
            state.commitModalOpen === open ? state : { commitModalOpen: open },
          undefined,
          'setCommitModalOpen'
        ),

      setOnboardingOpen: open =>
        set(
          state =>
            state.onboardingOpen === open ? state : { onboardingOpen: open },
          undefined,
          'setOnboardingOpen'
        ),

      setOnboardingManuallyTriggered: triggered =>
        set(
          state =>
            state.onboardingManuallyTriggered === triggered
              ? state
              : { onboardingManuallyTriggered: triggered },
          undefined,
          'setOnboardingManuallyTriggered'
        ),

      setOnboardingStartStep: step =>
        set(
          state =>
            state.onboardingStartStep === step
              ? state
              : { onboardingStartStep: step },
          undefined,
          'setOnboardingStartStep'
        ),

      setOpenInModalOpen: open =>
        set(
          state =>
            state.openInModalOpen === open ? state : { openInModalOpen: open },
          undefined,
          'setOpenInModalOpen'
        ),

      openRemotePicker: (repoPath, callback) => {
        _remotePickerCallback = callback
        set(
          {
            remotePickerOpen: true,
            remotePickerRepoPath: repoPath,
          },
          undefined,
          'openRemotePicker'
        )
      },

      closeRemotePicker: () => {
        _remotePickerCallback = null
        set(
          {
            remotePickerOpen: false,
            remotePickerRepoPath: null,
          },
          undefined,
          'closeRemotePicker'
        )
      },

      setLoadContextModalOpen: open =>
        set(
          state =>
            state.loadContextModalOpen === open
              ? state
              : { loadContextModalOpen: open },
          undefined,
          'setLoadContextModalOpen'
        ),
      setLinkedProjectsModalOpen: open =>
        set(
          state =>
            state.linkedProjectsModalOpen === open
              ? state
              : { linkedProjectsModalOpen: open },
          undefined,
          'setLinkedProjectsModalOpen'
        ),

      setMagicModalOpen: open =>
        set(
          state =>
            state.magicModalOpen === open ? state : { magicModalOpen: open },
          undefined,
          'setMagicModalOpen'
        ),

      setResolveConflictsDialogOpen: open =>
        set(
          { resolveConflictsDialogOpen: open },
          undefined,
          'setResolveConflictsDialogOpen'
        ),

      setNewWorktreeModalOpen: open =>
        set(
          {
            newWorktreeModalOpen: open,
            ...(open ? {} : { newWorktreeModalDefaultTab: null }),
          },
          undefined,
          'setNewWorktreeModalOpen'
        ),

      setNewWorktreeModalDefaultTab: tab =>
        set(
          { newWorktreeModalDefaultTab: tab },
          undefined,
          'setNewWorktreeModalDefaultTab'
        ),

      setReleaseNotesModalOpen: open =>
        set(
          state =>
            state.releaseNotesModalOpen === open
              ? state
              : { releaseNotesModalOpen: open },
          undefined,
          'setReleaseNotesModalOpen'
        ),

      setUpdatePrModalOpen: open =>
        set(
          state =>
            state.updatePrModalOpen === open
              ? state
              : { updatePrModalOpen: open },
          undefined,
          'setUpdatePrModalOpen'
        ),
      setReviewCommentsModalOpen: open =>
        set(
          { reviewCommentsModalOpen: open },
          undefined,
          'setReviewCommentsModalOpen'
        ),

      setWorkflowRunsModalOpen: (open, projectPath, branch) =>
        set(
          {
            workflowRunsModalOpen: open,
            workflowRunsModalProjectPath: open ? (projectPath ?? null) : null,
            workflowRunsModalBranch: open ? (branch ?? null) : null,
          },
          undefined,
          'setWorkflowRunsModalOpen'
        ),

      openCliUpdateModal: type =>
        set(
          { cliUpdateModalOpen: true, cliUpdateModalType: type },
          undefined,
          'openCliUpdateModal'
        ),

      closeCliUpdateModal: () =>
        set(
          { cliUpdateModalOpen: false, cliUpdateModalType: null },
          undefined,
          'closeCliUpdateModal'
        ),

      openCliLoginModal: (type, command, commandArgs, action) =>
        set(
          {
            cliLoginModalOpen: true,
            cliLoginModalType: type,
            cliLoginModalCommand: command,
            cliLoginModalCommandArgs: commandArgs ?? null,
            cliLoginModalAction: action ?? 'login',
          },
          undefined,
          'openCliLoginModal'
        ),

      closeCliLoginModal: () =>
        set(
          {
            cliLoginModalOpen: false,
            cliLoginModalType: null,
            cliLoginModalCommand: null,
            cliLoginModalCommandArgs: null,
            cliLoginModalAction: 'login',
          },
          undefined,
          'closeCliLoginModal'
        ),

      incrementPendingBackgroundCreations: () =>
        set(
          state => ({
            pendingBackgroundCreations: state.pendingBackgroundCreations + 1,
          }),
          undefined,
          'incrementPendingBackgroundCreations'
        ),

      consumePendingBackgroundCreation: () => {
        const state = useUIStore.getState()
        if (state.pendingBackgroundCreations > 0) {
          set(
            state => ({
              pendingBackgroundCreations: state.pendingBackgroundCreations - 1,
            }),
            undefined,
            'consumePendingBackgroundCreation'
          )
          return true
        }
        return false
      },

      markWorktreeForAutoInvestigate: worktreeId =>
        set(
          state => ({
            autoInvestigateWorktreeIds: new Set([
              ...state.autoInvestigateWorktreeIds,
              worktreeId,
            ]),
          }),
          undefined,
          'markWorktreeForAutoInvestigate'
        ),

      consumeAutoInvestigate: worktreeId => {
        if (get().autoInvestigateWorktreeIds.has(worktreeId)) {
          set(
            state => {
              const newSet = new Set(state.autoInvestigateWorktreeIds)
              newSet.delete(worktreeId)
              return { autoInvestigateWorktreeIds: newSet }
            },
            undefined,
            'consumeAutoInvestigate'
          )
          return true
        }
        return false
      },

      markWorktreeForAutoInvestigatePR: worktreeId =>
        set(
          state => ({
            autoInvestigatePRWorktreeIds: new Set([
              ...state.autoInvestigatePRWorktreeIds,
              worktreeId,
            ]),
          }),
          undefined,
          'markWorktreeForAutoInvestigatePR'
        ),

      consumeAutoInvestigatePR: worktreeId => {
        if (get().autoInvestigatePRWorktreeIds.has(worktreeId)) {
          set(
            state => {
              const newSet = new Set(state.autoInvestigatePRWorktreeIds)
              newSet.delete(worktreeId)
              return { autoInvestigatePRWorktreeIds: newSet }
            },
            undefined,
            'consumeAutoInvestigatePR'
          )
          return true
        }
        return false
      },

      markWorktreeForAutoInvestigateSecurityAlert: worktreeId =>
        set(
          state => ({
            autoInvestigateSecurityAlertWorktreeIds: new Set([
              ...state.autoInvestigateSecurityAlertWorktreeIds,
              worktreeId,
            ]),
          }),
          undefined,
          'markWorktreeForAutoInvestigateSecurityAlert'
        ),

      consumeAutoInvestigateSecurityAlert: worktreeId => {
        if (get().autoInvestigateSecurityAlertWorktreeIds.has(worktreeId)) {
          set(
            state => {
              const newSet = new Set(
                state.autoInvestigateSecurityAlertWorktreeIds
              )
              newSet.delete(worktreeId)
              return { autoInvestigateSecurityAlertWorktreeIds: newSet }
            },
            undefined,
            'consumeAutoInvestigateSecurityAlert'
          )
          return true
        }
        return false
      },

      markWorktreeForAutoInvestigateAdvisory: worktreeId =>
        set(
          state => ({
            autoInvestigateAdvisoryWorktreeIds: new Set([
              ...state.autoInvestigateAdvisoryWorktreeIds,
              worktreeId,
            ]),
          }),
          undefined,
          'markWorktreeForAutoInvestigateAdvisory'
        ),

      consumeAutoInvestigateAdvisory: worktreeId => {
        if (get().autoInvestigateAdvisoryWorktreeIds.has(worktreeId)) {
          set(
            state => {
              const newSet = new Set(state.autoInvestigateAdvisoryWorktreeIds)
              newSet.delete(worktreeId)
              return { autoInvestigateAdvisoryWorktreeIds: newSet }
            },
            undefined,
            'consumeAutoInvestigateAdvisory'
          )
          return true
        }
        return false
      },

      markWorktreeForAutoInvestigateLinearIssue: worktreeId =>
        set(
          state => ({
            autoInvestigateLinearIssueWorktreeIds: new Set([
              ...state.autoInvestigateLinearIssueWorktreeIds,
              worktreeId,
            ]),
          }),
          undefined,
          'markWorktreeForAutoInvestigateLinearIssue'
        ),

      consumeAutoInvestigateLinearIssue: worktreeId => {
        if (get().autoInvestigateLinearIssueWorktreeIds.has(worktreeId)) {
          set(
            state => {
              const newSet = new Set(
                state.autoInvestigateLinearIssueWorktreeIds
              )
              newSet.delete(worktreeId)
              return { autoInvestigateLinearIssueWorktreeIds: newSet }
            },
            undefined,
            'consumeAutoInvestigateLinearIssue'
          )
          return true
        }
        return false
      },

      markWorktreeForAutoInvestigateSentryIssue: worktreeId =>
        set(
          state => {
            if (state.autoInvestigateSentryIssueWorktreeIds.has(worktreeId)) {
              return state
            }
            return {
              autoInvestigateSentryIssueWorktreeIds: new Set([
                ...state.autoInvestigateSentryIssueWorktreeIds,
                worktreeId,
              ]),
            }
          },
          undefined,
          'markWorktreeForAutoInvestigateSentryIssue'
        ),

      consumeAutoInvestigateSentryIssue: worktreeId => {
        if (!get().autoInvestigateSentryIssueWorktreeIds.has(worktreeId)) {
          return false
        }
        set(
          state => {
            const next = new Set(state.autoInvestigateSentryIssueWorktreeIds)
            next.delete(worktreeId)
            return { autoInvestigateSentryIssueWorktreeIds: next }
          },
          undefined,
          'consumeAutoInvestigateSentryIssue'
        )
        return true
      },

      markWorktreeForAutoOpenSession: (worktreeId, sessionId) =>
        set(
          state => {
            const alreadyQueued =
              state.autoOpenSessionWorktreeIds.has(worktreeId)
            const existingSessionId =
              state.pendingAutoOpenSessionIds[worktreeId]
            if (
              alreadyQueued &&
              (sessionId ? existingSessionId === sessionId : !existingSessionId)
            ) {
              return state
            }

            return {
              autoOpenSessionWorktreeIds: new Set([
                ...state.autoOpenSessionWorktreeIds,
                worktreeId,
              ]),
              pendingAutoOpenSessionIds: sessionId
                ? {
                    ...state.pendingAutoOpenSessionIds,
                    [worktreeId]: sessionId,
                  }
                : state.pendingAutoOpenSessionIds,
            }
          },
          undefined,
          'markWorktreeForAutoOpenSession'
        ),

      consumeAutoOpenSession: worktreeId => {
        const state = useUIStore.getState()
        if (state.autoOpenSessionWorktreeIds.has(worktreeId)) {
          const sessionId = state.pendingAutoOpenSessionIds[worktreeId]
          set(
            state => {
              const newSet = new Set(state.autoOpenSessionWorktreeIds)
              newSet.delete(worktreeId)
              const { [worktreeId]: _, ...restPending } =
                state.pendingAutoOpenSessionIds
              return {
                autoOpenSessionWorktreeIds: newSet,
                pendingAutoOpenSessionIds: restPending,
              }
            },
            undefined,
            'consumeAutoOpenSession'
          )
          return { shouldOpen: true, sessionId }
        }
        return { shouldOpen: false }
      },

      setSessionChatModalOpen: (open: boolean, worktreeId?: string | null) =>
        set(
          {
            sessionChatModalOpen: open,
            sessionChatModalWorktreeId: open ? (worktreeId ?? null) : null,
          },
          undefined,
          'setSessionChatModalOpen'
        ),

      setSessionPrimarySurface: (
        sessionId: string,
        surface: WorktreePrimarySurface
      ) =>
        set(
          state => {
            if (state.sessionPrimarySurface[sessionId] === surface) {
              return state
            }
            return {
              sessionPrimarySurface: {
                ...state.sessionPrimarySurface,
                [sessionId]: surface,
              },
            }
          },
          undefined,
          'setSessionPrimarySurface'
        ),

      setSessionTerminalId: (sessionId: string, terminalId: string) =>
        set(
          state => {
            if (state.sessionTerminalIds[sessionId] === terminalId) {
              return state
            }
            return {
              sessionTerminalIds: {
                ...state.sessionTerminalIds,
                [sessionId]: terminalId,
              },
            }
          },
          undefined,
          'setSessionTerminalId'
        ),

      clearSessionTerminalSurface: (sessionId: string) => {
        const current = get()
        const terminalId = current.sessionTerminalIds[sessionId]
        const hasSurface = sessionId in current.sessionPrimarySurface
        if (!hasSurface && terminalId === undefined) {
          return undefined
        }

        set(
          state => {
            const { [sessionId]: _removedSurface, ...sessionPrimarySurface } =
              state.sessionPrimarySurface
            const { [sessionId]: _removedTerminal, ...sessionTerminalIds } =
              state.sessionTerminalIds
            return { sessionPrimarySurface, sessionTerminalIds }
          },
          undefined,
          'clearSessionTerminalSurface'
        )

        return terminalId
      },

      openNewSessionModeModal: (target: NewSessionModeTarget) =>
        set(
          state =>
            state.newSessionModeTarget?.worktreeId === target.worktreeId &&
            state.newSessionModeTarget?.worktreePath === target.worktreePath &&
            state.newSessionModeTarget?.origin === target.origin &&
            state.newSessionModeTarget?.intent === target.intent
              ? state
              : { newSessionModeTarget: target },
          undefined,
          'openNewSessionModeModal'
        ),

      closeNewSessionModeModal: () =>
        set(
          state =>
            state.newSessionModeTarget === null
              ? state
              : { newSessionModeTarget: null },
          undefined,
          'closeNewSessionModeModal'
        ),

      setChatToolbarMounted: (mounted: boolean) =>
        set(state =>
          state.chatToolbarMounted === mounted
            ? state
            : { chatToolbarMounted: mounted }
        ),

      setGitDiffModalOpen: (open: boolean) =>
        set(
          state =>
            state.gitDiffModalOpen === open
              ? state
              : { gitDiffModalOpen: open },
          undefined,
          'setGitDiffModalOpen'
        ),

      toggleGitDiffSelectedFile: (filePath: string) =>
        set(
          state => {
            const next = new Set(state.gitDiffSelectedFiles)
            if (next.has(filePath)) next.delete(filePath)
            else next.add(filePath)
            return { gitDiffSelectedFiles: next }
          },
          undefined,
          'toggleGitDiffSelectedFile'
        ),

      clearGitDiffSelectedFiles: () =>
        set(
          state => {
            if (state.gitDiffSelectedFiles.size === 0) return state
            return { gitDiffSelectedFiles: new Set<string>() }
          },
          undefined,
          'clearGitDiffSelectedFiles'
        ),

      setPlanDialogOpen: (open: boolean) =>
        set(
          state =>
            state.planDialogOpen === open ? state : { planDialogOpen: open },
          undefined,
          'setPlanDialogOpen'
        ),

      setContextViewerOpen: (open: boolean) =>
        set(
          state =>
            state.contextViewerOpen === open
              ? state
              : { contextViewerOpen: open },
          undefined,
          'setContextViewerOpen'
        ),

      setFeatureTourOpen: (open: boolean) =>
        set(
          state =>
            state.featureTourOpen === open ? state : { featureTourOpen: open },
          undefined,
          'setFeatureTourOpen'
        ),

      setJeanMcpIntroOpen: (open: boolean) =>
        set(
          state =>
            state.jeanMcpIntroOpen === open
              ? state
              : { jeanMcpIntroOpen: open },
          undefined,
          'setJeanMcpIntroOpen'
        ),

      setUIStateInitialized: (initialized: boolean) =>
        set(
          state =>
            state.uiStateInitialized === initialized
              ? state
              : { uiStateInitialized: initialized },
          undefined,
          'setUIStateInitialized'
        ),

      setPendingUpdateVersion: (version: string | null) =>
        set(
          state =>
            state.pendingUpdateVersion === version
              ? state
              : { pendingUpdateVersion: version },
          undefined,
          'setPendingUpdateVersion'
        ),

      setUpdateModalVersion: (version: string | null) =>
        set(
          state =>
            state.updateModalVersion === version
              ? state
              : { updateModalVersion: version },
          undefined,
          'setUpdateModalVersion'
        ),

      setUpdateReadyVersion: (version: string | null) =>
        set(
          state =>
            state.updateReadyVersion === version
              ? state
              : { updateReadyVersion: version },
          undefined,
          'setUpdateReadyVersion'
        ),

      setIsUpdateInstalling: (installing: boolean) =>
        set(
          state =>
            state.isUpdateInstalling === installing
              ? state
              : { isUpdateInstalling: installing },
          undefined,
          'setIsUpdateInstalling'
        ),

      setPendingServerUpdate: (update: PendingServerUpdate | null) =>
        set(
          state => {
            const prev = state.pendingServerUpdate
            if (prev === update) return state
            if (
              prev &&
              update &&
              prev.latestVersion === update.latestVersion &&
              prev.currentVersion === update.currentVersion &&
              prev.canUpdate === update.canUpdate &&
              prev.reason === update.reason
            ) {
              return state
            }
            if (!prev && !update) return state
            return { pendingServerUpdate: update }
          },
          undefined,
          'setPendingServerUpdate'
        ),

      setAvailableCliUpdates: (updates: PendingCliUpdate[]) =>
        set(
          { availableCliUpdates: updates },
          undefined,
          'setAvailableCliUpdates'
        ),

      dismissCliUpdateNotice: (type: PendingCliUpdate['type']) =>
        set(
          state => ({
            availableCliUpdates: state.availableCliUpdates.filter(
              u => u.type !== type
            ),
          }),
          undefined,
          'dismissCliUpdateNotice'
        ),

      setChatSearchOpen: (open: boolean) =>
        set(
          state => {
            if (state.chatSearchOpen === open) return state
            return { chatSearchOpen: open }
          },
          undefined,
          'setChatSearchOpen'
        ),

      setGitHubDashboardOpen: (open: boolean) =>
        set(
          state =>
            state.githubDashboardOpen === open
              ? state
              : { githubDashboardOpen: open },
          undefined,
          'setGitHubDashboardOpen'
        ),
    }),
    {
      name: 'ui-store',
    }
  )
)
