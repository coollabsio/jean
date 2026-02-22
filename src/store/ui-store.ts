import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type PreferencePane =
  | 'general'
  | 'appearance'
  | 'keybindings'
  | 'magic-prompts'
  | 'mcp-servers'
  | 'providers'
  | 'experimental'
  | 'web-access'
  | 'connection'

export type OnboardingStartStep = 'claude' | 'gh' | null

export type CliUpdateModalType = 'claude' | 'gh' | 'codex' | 'opencode' | null

export type CliLoginModalType = 'claude' | 'gh' | 'codex' | 'opencode' | null

interface UIState {
  leftSidebarVisible: boolean
  leftSidebarSize: number // Width in pixels, persisted across sessions
  rightSidebarVisible: boolean
  commandPaletteOpen: boolean
  preferencesOpen: boolean
  preferencesPane: PreferencePane | null
  commitModalOpen: boolean
  onboardingOpen: boolean
  onboardingStartStep: OnboardingStartStep
  openInModalOpen: boolean
  remotePickerOpen: boolean
  remotePickerRepoPath: string | null
  remotePickerCallback: ((remote: string) => void) | null
  loadContextModalOpen: boolean
  magicModalOpen: boolean
  newWorktreeModalOpen: boolean
  newWorktreeModalDefaultTab: 'quick' | 'issues' | 'prs' | null
  releaseNotesModalOpen: boolean
  updatePrModalOpen: boolean
  workflowRunsModalOpen: boolean
  workflowRunsModalProjectPath: string | null
  workflowRunsModalBranch: string | null
  cliUpdateModalOpen: boolean
  cliUpdateModalType: CliUpdateModalType
  cliLoginModalOpen: boolean
  cliLoginModalType: CliLoginModalType
  cliLoginModalCommand: string | null
  /** Worktree IDs that should auto-trigger investigate-issue when created */
  autoInvestigateWorktreeIds: Set<string>
  /** Worktree IDs that should auto-trigger investigate-pr when created */
  autoInvestigatePRWorktreeIds: Set<string>
  /** Counter for background worktree creations (CMD+Click) — skip auto-navigation */
  pendingBackgroundCreations: number
  /** Worktree IDs that should auto-open first session modal when canvas mounts */
  autoOpenSessionWorktreeIds: Set<string>
  /** Specific session ID to auto-open per worktree (overrides first-session default) */
  pendingAutoOpenSessionIds: Record<string, string>
  /** Project ID for the Session Board modal (null = closed) */
  sessionBoardProjectId: string | null
  /** Whether a session chat modal is open (for magic command keybinding checks) */
  sessionChatModalOpen: boolean
  /** Which worktree the session chat modal is for (for magic command worktree resolution) */
  sessionChatModalWorktreeId: string | null
  /** Whether a plan dialog is open (blocks canvas approve keybindings) */
  planDialogOpen: boolean
  /** Whether the feature tour dialog is open */
  featureTourOpen: boolean
  /** Whether UI state has been restored from persisted storage */
  uiStateInitialized: boolean
  /** Pending app update that user skipped — shown as indicator in title bar */
  pendingUpdateVersion: string | null
  /** When non-null, shows the update available modal */
  updateModalVersion: string | null
  /** Pending auto-investigate type — ChatWindow picks this up when it mounts */
  pendingInvestigateType: 'issue' | 'pr' | null

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
  setOnboardingStartStep: (step: OnboardingStartStep) => void
  setOpenInModalOpen: (open: boolean) => void
  openRemotePicker: (
    repoPath: string,
    callback: (remote: string) => void
  ) => void
  closeRemotePicker: () => void
  setLoadContextModalOpen: (open: boolean) => void
  setMagicModalOpen: (open: boolean) => void
  setNewWorktreeModalOpen: (open: boolean) => void
  setNewWorktreeModalDefaultTab: (
    tab: 'quick' | 'issues' | 'prs' | null
  ) => void
  setReleaseNotesModalOpen: (open: boolean) => void
  setUpdatePrModalOpen: (open: boolean) => void
  setWorkflowRunsModalOpen: (
    open: boolean,
    projectPath?: string | null,
    branch?: string | null
  ) => void
  openCliUpdateModal: (type: 'claude' | 'gh' | 'codex' | 'opencode') => void
  closeCliUpdateModal: () => void
  openCliLoginModal: (
    type: 'claude' | 'gh' | 'codex' | 'opencode',
    command: string
  ) => void
  closeCliLoginModal: () => void
  incrementPendingBackgroundCreations: () => void
  consumePendingBackgroundCreation: () => boolean
  markWorktreeForAutoInvestigate: (worktreeId: string) => void
  consumeAutoInvestigate: (worktreeId: string) => boolean
  markWorktreeForAutoInvestigatePR: (worktreeId: string) => void
  consumeAutoInvestigatePR: (worktreeId: string) => boolean
  markWorktreeForAutoOpenSession: (
    worktreeId: string,
    sessionId?: string
  ) => void
  consumeAutoOpenSession: (worktreeId: string) => {
    shouldOpen: boolean
    sessionId?: string
  }
  openSessionBoardModal: (projectId: string) => void
  closeSessionBoardModal: () => void
  setSessionChatModalOpen: (open: boolean, worktreeId?: string | null) => void
  setPlanDialogOpen: (open: boolean) => void
  setFeatureTourOpen: (open: boolean) => void
  setUIStateInitialized: (initialized: boolean) => void
  setPendingUpdateVersion: (version: string | null) => void
  setUpdateModalVersion: (version: string | null) => void
  setPendingInvestigateType: (type: 'issue' | 'pr' | null) => void
  consumePendingInvestigateType: () => 'issue' | 'pr' | null
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
      onboardingStartStep: null,
      openInModalOpen: false,
      remotePickerOpen: false,
      remotePickerRepoPath: null,
      remotePickerCallback: null,
      loadContextModalOpen: false,
      magicModalOpen: false,
      newWorktreeModalOpen: false,
      newWorktreeModalDefaultTab: null,
      releaseNotesModalOpen: false,
      updatePrModalOpen: false,
      workflowRunsModalOpen: false,
      workflowRunsModalProjectPath: null,
      workflowRunsModalBranch: null,
      cliUpdateModalOpen: false,
      cliUpdateModalType: null,
      cliLoginModalOpen: false,
      cliLoginModalType: null,
      cliLoginModalCommand: null,
      autoInvestigateWorktreeIds: new Set(),
      autoInvestigatePRWorktreeIds: new Set(),
      pendingBackgroundCreations: 0,
      autoOpenSessionWorktreeIds: new Set(),
      pendingAutoOpenSessionIds: {},
      sessionBoardProjectId: null,
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
      planDialogOpen: false,
      featureTourOpen: false,
      uiStateInitialized: false,
      pendingUpdateVersion: null,
      updateModalVersion: null,
      pendingInvestigateType: null,

      toggleLeftSidebar: () =>
        set(
          state => ({ leftSidebarVisible: !state.leftSidebarVisible }),
          undefined,
          'toggleLeftSidebar'
        ),

      setLeftSidebarVisible: visible =>
        set(
          { leftSidebarVisible: visible },
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
        set({ leftSidebarSize: size }, undefined, 'setLeftSidebarSize'),

      setRightSidebarVisible: visible =>
        set(
          { rightSidebarVisible: visible },
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
        set({ commandPaletteOpen: open }, undefined, 'setCommandPaletteOpen'),

      togglePreferences: () =>
        set(
          state => ({ preferencesOpen: !state.preferencesOpen }),
          undefined,
          'togglePreferences'
        ),

      setPreferencesOpen: open =>
        set(
          { preferencesOpen: open, preferencesPane: open ? null : null },
          undefined,
          'setPreferencesOpen'
        ),

      openPreferencesPane: pane =>
        set(
          { preferencesOpen: true, preferencesPane: pane },
          undefined,
          'openPreferencesPane'
        ),

      setCommitModalOpen: open =>
        set({ commitModalOpen: open }, undefined, 'setCommitModalOpen'),

      setOnboardingOpen: open =>
        set({ onboardingOpen: open }, undefined, 'setOnboardingOpen'),

      setOnboardingStartStep: step =>
        set({ onboardingStartStep: step }, undefined, 'setOnboardingStartStep'),

      setOpenInModalOpen: open =>
        set({ openInModalOpen: open }, undefined, 'setOpenInModalOpen'),

      openRemotePicker: (repoPath, callback) =>
        set(
          {
            remotePickerOpen: true,
            remotePickerRepoPath: repoPath,
            remotePickerCallback: callback,
          },
          undefined,
          'openRemotePicker'
        ),

      closeRemotePicker: () =>
        set(
          {
            remotePickerOpen: false,
            remotePickerRepoPath: null,
            remotePickerCallback: null,
          },
          undefined,
          'closeRemotePicker'
        ),

      setLoadContextModalOpen: open =>
        set(
          { loadContextModalOpen: open },
          undefined,
          'setLoadContextModalOpen'
        ),

      setMagicModalOpen: open =>
        set({ magicModalOpen: open }, undefined, 'setMagicModalOpen'),

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
          { releaseNotesModalOpen: open },
          undefined,
          'setReleaseNotesModalOpen'
        ),

      setUpdatePrModalOpen: open =>
        set({ updatePrModalOpen: open }, undefined, 'setUpdatePrModalOpen'),

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

      openCliLoginModal: (type, command) =>
        set(
          {
            cliLoginModalOpen: true,
            cliLoginModalType: type,
            cliLoginModalCommand: command,
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
        const state = useUIStore.getState()
        if (state.autoInvestigateWorktreeIds.has(worktreeId)) {
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
        const state = useUIStore.getState()
        if (state.autoInvestigatePRWorktreeIds.has(worktreeId)) {
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

      markWorktreeForAutoOpenSession: (worktreeId, sessionId) =>
        set(
          state => ({
            autoOpenSessionWorktreeIds: new Set([
              ...state.autoOpenSessionWorktreeIds,
              worktreeId,
            ]),
            pendingAutoOpenSessionIds: sessionId
              ? { ...state.pendingAutoOpenSessionIds, [worktreeId]: sessionId }
              : state.pendingAutoOpenSessionIds,
          }),
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

      openSessionBoardModal: (projectId: string) =>
        set(
          { sessionBoardProjectId: projectId },
          undefined,
          'openSessionBoardModal'
        ),

      closeSessionBoardModal: () =>
        set(
          { sessionBoardProjectId: null },
          undefined,
          'closeSessionBoardModal'
        ),

      setSessionChatModalOpen: (open: boolean, worktreeId?: string | null) =>
        set(
          {
            sessionChatModalOpen: open,
            sessionChatModalWorktreeId: open ? (worktreeId ?? null) : null,
          },
          undefined,
          'setSessionChatModalOpen'
        ),

      setPlanDialogOpen: (open: boolean) =>
        set({ planDialogOpen: open }, undefined, 'setPlanDialogOpen'),

      setFeatureTourOpen: (open: boolean) =>
        set({ featureTourOpen: open }, undefined, 'setFeatureTourOpen'),

      setUIStateInitialized: (initialized: boolean) =>
        set(
          { uiStateInitialized: initialized },
          undefined,
          'setUIStateInitialized'
        ),

      setPendingUpdateVersion: (version: string | null) =>
        set(
          { pendingUpdateVersion: version },
          undefined,
          'setPendingUpdateVersion'
        ),

      setUpdateModalVersion: (version: string | null) =>
        set(
          { updateModalVersion: version },
          undefined,
          'setUpdateModalVersion'
        ),
      setPendingInvestigateType: (type: 'issue' | 'pr' | null) =>
        set(
          { pendingInvestigateType: type },
          undefined,
          'setPendingInvestigateType'
        ),
      consumePendingInvestigateType: () => {
        const current = get().pendingInvestigateType
        if (current) {
          set(
            { pendingInvestigateType: null },
            undefined,
            'consumePendingInvestigateType'
          )
        }
        return current
      },
    }),
    {
      name: 'ui-store',
    }
  )
)
