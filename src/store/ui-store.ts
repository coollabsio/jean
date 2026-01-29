import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type PreferencePane = 'general' | 'appearance' | 'keybindings' | 'magic-prompts' | 'experimental'

export type OnboardingStartStep = 'claude' | 'gh' | null

export type CliUpdateModalType = 'claude' | 'gh' | 'glab' | null

export type CliLoginModalType = 'claude' | 'gh' | 'glab' | null

/** Data for the path conflict modal when worktree creation finds an existing directory */
export interface PathConflictData {
  projectId: string
  path: string
  suggestedName: string
  /** If the path matches an archived worktree, its ID */
  archivedWorktreeId?: string
  /** Name of the archived worktree */
  archivedWorktreeName?: string
  /** Issue context to pass when creating a new worktree */
  issueContext?: {
    number: number
    title: string
    body?: string
    comments: Array<{
      author: { login: string }
      body: string
      createdAt: string
    }>
  }
}

/** Data for the branch conflict modal when worktree creation finds an existing branch */
export interface BranchConflictData {
  projectId: string
  branch: string
  suggestedName: string
  /** Issue context to pass when creating a new worktree */
  issueContext?: {
    number: number
    title: string
    body?: string
    comments: Array<{
      author: { login: string }
      body: string
      createdAt: string
    }>
  }
  /** PR context to pass when creating a new worktree */
  prContext?: {
    number: number
    title: string
    body?: string
    headRefName: string
    baseRefName: string
    comments: Array<{
      author: { login: string }
      body: string
      createdAt: string
    }>
    reviews: Array<{
      author: { login: string }
      body: string
      state: string
      submittedAt: string
    }>
    diff?: string
  }
}

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
  magicModalOpen: boolean
  newWorktreeModalOpen: boolean
  checkoutPRModalOpen: boolean
  cliUpdateModalOpen: boolean
  cliUpdateModalType: CliUpdateModalType
  cliLoginModalOpen: boolean
  cliLoginModalType: CliLoginModalType
  cliLoginModalCommand: string | null
  /** Data for the path conflict modal */
  pathConflictData: PathConflictData | null
  /** Data for the branch conflict modal */
  branchConflictData: BranchConflictData | null
  /** Worktree IDs that should auto-trigger investigate-issue when created */
  autoInvestigateWorktreeIds: Set<string>
  /** Worktree IDs that should auto-trigger investigate-pr when created */
  autoInvestigatePRWorktreeIds: Set<string>
  /** Project ID for the Session Board modal (null = closed) */
  sessionBoardProjectId: string | null

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
  setMagicModalOpen: (open: boolean) => void
  setNewWorktreeModalOpen: (open: boolean) => void
  setCheckoutPRModalOpen: (open: boolean) => void
  openCliUpdateModal: (type: 'claude' | 'gh' | 'glab') => void
  closeCliUpdateModal: () => void
  openCliLoginModal: (type: 'claude' | 'gh' | 'glab', command: string) => void
  closeCliLoginModal: () => void
  openPathConflictModal: (data: PathConflictData) => void
  closePathConflictModal: () => void
  openBranchConflictModal: (data: BranchConflictData) => void
  closeBranchConflictModal: () => void
  markWorktreeForAutoInvestigate: (worktreeId: string) => void
  consumeAutoInvestigate: (worktreeId: string) => boolean
  markWorktreeForAutoInvestigatePR: (worktreeId: string) => void
  consumeAutoInvestigatePR: (worktreeId: string) => boolean
  openSessionBoardModal: (projectId: string) => void
  closeSessionBoardModal: () => void
}

export const useUIStore = create<UIState>()(
  devtools(
    set => ({
      leftSidebarVisible: true,
      leftSidebarSize: 250, // Default width in pixels
      rightSidebarVisible: false,
      commandPaletteOpen: false,
      preferencesOpen: false,
      preferencesPane: null,
      commitModalOpen: false,
      onboardingOpen: false,
      onboardingStartStep: null,
      openInModalOpen: false,
      magicModalOpen: false,
      newWorktreeModalOpen: false,
      checkoutPRModalOpen: false,
      cliUpdateModalOpen: false,
      cliUpdateModalType: null,
      cliLoginModalOpen: false,
      cliLoginModalType: null,
      cliLoginModalCommand: null,
      pathConflictData: null,
      branchConflictData: null,
      autoInvestigateWorktreeIds: new Set(),
      autoInvestigatePRWorktreeIds: new Set(),
      sessionBoardProjectId: null,

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

      setMagicModalOpen: open =>
        set({ magicModalOpen: open }, undefined, 'setMagicModalOpen'),

      setNewWorktreeModalOpen: open =>
        set({ newWorktreeModalOpen: open }, undefined, 'setNewWorktreeModalOpen'),

      setCheckoutPRModalOpen: open =>
        set({ checkoutPRModalOpen: open }, undefined, 'setCheckoutPRModalOpen'),

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
          { cliLoginModalOpen: true, cliLoginModalType: type, cliLoginModalCommand: command },
          undefined,
          'openCliLoginModal'
        ),

      closeCliLoginModal: () =>
        set(
          { cliLoginModalOpen: false, cliLoginModalType: null, cliLoginModalCommand: null },
          undefined,
          'closeCliLoginModal'
        ),

      openPathConflictModal: data =>
        set({ pathConflictData: data }, undefined, 'openPathConflictModal'),

      closePathConflictModal: () =>
        set({ pathConflictData: null }, undefined, 'closePathConflictModal'),

      openBranchConflictModal: data =>
        set({ branchConflictData: data }, undefined, 'openBranchConflictModal'),

      closeBranchConflictModal: () =>
        set({ branchConflictData: null }, undefined, 'closeBranchConflictModal'),

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

      openSessionBoardModal: projectId =>
        set({ sessionBoardProjectId: projectId }, undefined, 'openSessionBoardModal'),

      closeSessionBoardModal: () =>
        set({ sessionBoardProjectId: null }, undefined, 'closeSessionBoardModal'),
    }),
    {
      name: 'ui-store',
    }
  )
)
