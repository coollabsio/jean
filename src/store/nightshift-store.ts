import { create } from 'zustand'

interface NightshiftState {
  /** Currently active runs (projectId -> runId) */
  activeRuns: Record<string, string>
  /** Real-time check progress (runId -> checkId being executed) */
  runningChecks: Record<string, string>
  /** Whether the runs modal is open */
  runsModalOpen: boolean
  /** Project ID for the runs modal */
  runsModalProjectId: string | null

  // Actions
  setActiveRun: (projectId: string, runId: string) => void
  clearActiveRun: (projectId: string) => void
  setRunningCheck: (runId: string, checkId: string) => void
  clearRunningCheck: (runId: string) => void
  openRunsModal: (projectId: string) => void
  closeRunsModal: () => void
}

export const useNightshiftStore = create<NightshiftState>()((set) => ({
  activeRuns: {},
  runningChecks: {},
  runsModalOpen: false,
  runsModalProjectId: null,

  setActiveRun: (projectId, runId) =>
    set((state) => {
      if (state.activeRuns[projectId] === runId) return state
      return { activeRuns: { ...state.activeRuns, [projectId]: runId } }
    }),

  clearActiveRun: (projectId) =>
    set((state) => {
      if (!(projectId in state.activeRuns)) return state
      const { [projectId]: _, ...rest } = state.activeRuns
      return { activeRuns: rest }
    }),

  setRunningCheck: (runId, checkId) =>
    set((state) => {
      if (state.runningChecks[runId] === checkId) return state
      return { runningChecks: { ...state.runningChecks, [runId]: checkId } }
    }),

  clearRunningCheck: (runId) =>
    set((state) => {
      if (!(runId in state.runningChecks)) return state
      const { [runId]: _, ...rest } = state.runningChecks
      return { runningChecks: rest }
    }),

  openRunsModal: (projectId) =>
    set({ runsModalOpen: true, runsModalProjectId: projectId }),

  closeRunsModal: () =>
    set({ runsModalOpen: false, runsModalProjectId: null }),
}))
