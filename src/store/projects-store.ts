import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { LabelData } from '@/types/chat'
import type { Project, WorktreeSortMode } from '@/types/projects'

export interface ProjectCanvasSettings {
  worktreeSortMode?: WorktreeSortMode
  pinnedLabels?: LabelData[]
  labels?: LabelData[]
}

/** Panel view inside the Workspace rail section. */
export type SidebarTab = 'projects' | 'recent'

interface ProjectsUIState {
  // Selection state
  selectedProjectId: string | null
  selectedWorktreeId: string | null

  // Expansion state for tree view (projects)
  expandedProjectIds: Set<string>

  // Expansion state for worktrees (sidebar session list)
  expandedWorktreeIds: Set<string>

  // Dashboard worktree collapse overrides (list view): true=collapsed, false=expanded
  dashboardWorktreeCollapseOverrides: Record<string, boolean>

  // Expansion state for folders
  expandedFolderIds: Set<string>

  // Last-accessed timestamps per project (for recency sorting in command palette)
  projectAccessTimestamps: Record<string, number>

  // Project canvas settings per project
  projectCanvasSettings: Record<string, ProjectCanvasSettings>
  projectCanvasActiveFilters: Record<string, string>
  sidebarServerFilter: string | null
  sidebarActiveTab: SidebarTab
  pinnedRecentSessionIds: string[]

  // Add project dialog state
  addProjectDialogOpen: boolean
  addProjectParentFolderId: string | null

  // Add/edit server dialog state (null = closed, no project = add)
  serverDialog: { project?: Project } | null

  // Project settings dialog state
  projectSettingsDialogOpen: boolean
  projectSettingsProjectId: string | null
  projectSettingsInitialPane: string | null

  // Git init modal state
  gitInitModalOpen: boolean
  gitInitModalPath: string | null

  // Clone project modal state
  cloneModalOpen: boolean

  // Jean.json config wizard state
  jeanConfigWizardOpen: boolean
  jeanConfigWizardProjectId: string | null

  // Folder editing state (for auto-rename on create)
  editingFolderId: string | null

  // Actions
  selectProject: (id: string | null) => void
  selectWorktree: (id: string | null) => void
  toggleProjectExpanded: (id: string) => void
  setProjectExpanded: (id: string, expanded: boolean) => void
  expandProject: (id: string) => void
  collapseProject: (id: string) => void

  // Worktree expansion actions
  toggleWorktreeExpanded: (id: string) => void

  // Dashboard collapse actions
  toggleDashboardWorktreeCollapsed: (
    id: string,
    defaultCollapsed: boolean
  ) => void
  setDashboardWorktreeCollapseOverrides: (
    overrides: Record<string, boolean>
  ) => void

  // Folder expansion actions
  toggleFolderExpanded: (id: string) => void
  expandFolder: (id: string) => void
  collapseFolder: (id: string) => void

  // Bulk expansion actions
  expandAllFolders: (ids: string[]) => void
  collapseAllFolders: () => void
  expandAllProjects: (ids: string[]) => void
  collapseAllProjects: () => void

  setAddProjectDialogOpen: (
    open: boolean,
    parentFolderId?: string | null
  ) => void
  setServerDialog: (serverDialog: { project?: Project } | null) => void
  setSidebarActiveTab: (tab: SidebarTab) => void
  openProjectSettings: (projectId: string, pane?: string) => void
  closeProjectSettings: () => void
  openGitInitModal: (path: string) => void
  closeGitInitModal: () => void
  openCloneModal: () => void
  closeCloneModal: () => void
  openJeanConfigWizard: (projectId: string) => void
  closeJeanConfigWizard: () => void
  setEditingFolderId: (id: string | null) => void
  setProjectAccessTimestamps: (timestamps: Record<string, number>) => void
  setProjectCanvasSettings: (
    settings: Record<string, ProjectCanvasSettings>
  ) => void
  setProjectCanvasWorktreeSortMode: (
    projectId: string,
    sortMode: WorktreeSortMode
  ) => void
  setProjectCanvasPinnedLabels: (
    projectId: string,
    pinnedLabels: LabelData[]
  ) => void
  setProjectCanvasLabels: (projectId: string, labels: LabelData[]) => void
  setProjectCanvasActiveFilter: (projectId: string, filter: string) => void
  setSidebarServerFilter: (serverId: string | null) => void
  setPinnedRecentSessionIds: (sessionIds: string[]) => void
}

export const useProjectsStore = create<ProjectsUIState>()(
  devtools(
    set => ({
      // Initial state
      selectedProjectId: null,
      selectedWorktreeId: null,
      expandedProjectIds: new Set<string>(),
      expandedWorktreeIds: new Set<string>(),
      dashboardWorktreeCollapseOverrides: {},
      expandedFolderIds: new Set<string>(),
      projectAccessTimestamps: {},
      projectCanvasSettings: {},
      projectCanvasActiveFilters: {},
      sidebarServerFilter: null,
      sidebarActiveTab: 'projects',
      pinnedRecentSessionIds: [],
      addProjectDialogOpen: false,
      addProjectParentFolderId: null,
      serverDialog: null,
      projectSettingsDialogOpen: false,
      projectSettingsProjectId: null,
      projectSettingsInitialPane: null,
      gitInitModalOpen: false,
      gitInitModalPath: null,
      cloneModalOpen: false,
      jeanConfigWizardOpen: false,
      jeanConfigWizardProjectId: null,
      editingFolderId: null,

      // Selection actions
      selectProject: id =>
        set(
          state => ({
            selectedProjectId: id,
            selectedWorktreeId: null,
            projectAccessTimestamps: id
              ? { ...state.projectAccessTimestamps, [id]: Date.now() }
              : state.projectAccessTimestamps,
          }),
          undefined,
          'selectProject'
        ),

      selectWorktree: id =>
        set(
          state =>
            state.selectedWorktreeId === id
              ? state
              : { selectedWorktreeId: id },
          undefined,
          'selectWorktree'
        ),

      // Expansion actions
      toggleProjectExpanded: id =>
        set(
          state => {
            const newSet = new Set(state.expandedProjectIds)
            if (newSet.has(id)) {
              newSet.delete(id)
            } else {
              newSet.add(id)
            }
            return { expandedProjectIds: newSet }
          },
          undefined,
          'toggleProjectExpanded'
        ),

      setProjectExpanded: (id, expanded) =>
        set(
          state => {
            if (state.expandedProjectIds.has(id) === expanded) return state
            const newSet = new Set(state.expandedProjectIds)
            if (expanded) {
              newSet.add(id)
            } else {
              newSet.delete(id)
            }
            return { expandedProjectIds: newSet }
          },
          undefined,
          'setProjectExpanded'
        ),

      expandProject: id =>
        set(
          state => {
            if (state.expandedProjectIds.has(id)) return state
            const newSet = new Set(state.expandedProjectIds)
            newSet.add(id)
            return { expandedProjectIds: newSet }
          },
          undefined,
          'expandProject'
        ),

      collapseProject: id =>
        set(
          state => {
            if (!state.expandedProjectIds.has(id)) return state
            const newSet = new Set(state.expandedProjectIds)
            newSet.delete(id)
            return { expandedProjectIds: newSet }
          },
          undefined,
          'collapseProject'
        ),

      // Worktree expansion actions
      toggleWorktreeExpanded: id =>
        set(
          state => {
            const newSet = new Set(state.expandedWorktreeIds)
            if (newSet.has(id)) {
              newSet.delete(id)
            } else {
              newSet.add(id)
            }
            return { expandedWorktreeIds: newSet }
          },
          undefined,
          'toggleWorktreeExpanded'
        ),

      // Dashboard collapse actions
      toggleDashboardWorktreeCollapsed: (id, defaultCollapsed) =>
        set(
          state => {
            const current = state.dashboardWorktreeCollapseOverrides[id]
            const isCurrentlyCollapsed = current ?? defaultCollapsed
            return {
              dashboardWorktreeCollapseOverrides: {
                ...state.dashboardWorktreeCollapseOverrides,
                [id]: !isCurrentlyCollapsed,
              },
            }
          },
          undefined,
          'toggleDashboardWorktreeCollapsed'
        ),

      setDashboardWorktreeCollapseOverrides: overrides =>
        set(
          state =>
            state.dashboardWorktreeCollapseOverrides === overrides
              ? state
              : { dashboardWorktreeCollapseOverrides: overrides },
          undefined,
          'setDashboardWorktreeCollapseOverrides'
        ),

      setProjectCanvasSettings: settings =>
        set(
          state => {
            const mergedSettings: Record<string, ProjectCanvasSettings> =
              Object.fromEntries(
                Object.entries(settings).map(([projectId, projectSettings]) => [
                  projectId,
                  {
                    ...projectSettings,
                    worktreeSortMode:
                      state.projectCanvasSettings[projectId]
                        ?.worktreeSortMode ?? projectSettings.worktreeSortMode,
                  },
                ])
              )
            for (const [projectId, projectSettings] of Object.entries(
              state.projectCanvasSettings
            )) {
              if (!(projectId in mergedSettings)) {
                mergedSettings[projectId] = projectSettings
              }
            }
            return { projectCanvasSettings: mergedSettings }
          },
          undefined,
          'setProjectCanvasSettings'
        ),

      setProjectCanvasWorktreeSortMode: (projectId, sortMode) =>
        set(
          state => {
            const currentSortMode =
              state.projectCanvasSettings[projectId]?.worktreeSortMode
            if (currentSortMode === sortMode) return state

            return {
              projectCanvasSettings: {
                ...state.projectCanvasSettings,
                [projectId]: {
                  ...state.projectCanvasSettings[projectId],
                  worktreeSortMode: sortMode,
                },
              },
            }
          },
          undefined,
          'setProjectCanvasWorktreeSortMode'
        ),

      setProjectCanvasPinnedLabels: (projectId, pinnedLabels) =>
        set(
          state => {
            const currentPinnedLabels =
              state.projectCanvasSettings[projectId]?.pinnedLabels ?? []
            if (
              JSON.stringify(currentPinnedLabels) ===
              JSON.stringify(pinnedLabels)
            ) {
              return state
            }

            return {
              projectCanvasSettings: {
                ...state.projectCanvasSettings,
                [projectId]: {
                  ...state.projectCanvasSettings[projectId],
                  pinnedLabels,
                },
              },
            }
          },
          undefined,
          'setProjectCanvasPinnedLabels'
        ),

      setProjectCanvasLabels: (projectId, labels) =>
        set(
          state => {
            const currentLabels =
              state.projectCanvasSettings[projectId]?.labels ?? []
            if (JSON.stringify(currentLabels) === JSON.stringify(labels)) {
              return state
            }

            return {
              projectCanvasSettings: {
                ...state.projectCanvasSettings,
                [projectId]: {
                  ...state.projectCanvasSettings[projectId],
                  labels,
                },
              },
            }
          },
          undefined,
          'setProjectCanvasLabels'
        ),

      setProjectCanvasActiveFilter: (projectId, filter) =>
        set(
          state =>
            state.projectCanvasActiveFilters[projectId] === filter
              ? state
              : {
                  projectCanvasActiveFilters: {
                    ...state.projectCanvasActiveFilters,
                    [projectId]: filter,
                  },
                },
          undefined,
          'setProjectCanvasActiveFilter'
        ),

      setSidebarServerFilter: serverId =>
        set(
          state =>
            state.sidebarServerFilter === serverId
              ? state
              : { sidebarServerFilter: serverId },
          undefined,
          'setSidebarServerFilter'
        ),

      setSidebarActiveTab: tab =>
        set(
          state =>
            state.sidebarActiveTab === tab ? state : { sidebarActiveTab: tab },
          undefined,
          'setSidebarActiveTab'
        ),

      setPinnedRecentSessionIds: sessionIds =>
        set(
          state =>
            JSON.stringify(state.pinnedRecentSessionIds) ===
            JSON.stringify(sessionIds)
              ? state
              : { pinnedRecentSessionIds: sessionIds },
          undefined,
          'setPinnedRecentSessionIds'
        ),

      // Folder expansion actions
      toggleFolderExpanded: id =>
        set(
          state => {
            const newSet = new Set(state.expandedFolderIds)
            if (newSet.has(id)) {
              newSet.delete(id)
            } else {
              newSet.add(id)
            }
            return { expandedFolderIds: newSet }
          },
          undefined,
          'toggleFolderExpanded'
        ),

      expandFolder: id =>
        set(
          state => {
            if (state.expandedFolderIds.has(id)) return state
            const newSet = new Set(state.expandedFolderIds)
            newSet.add(id)
            return { expandedFolderIds: newSet }
          },
          undefined,
          'expandFolder'
        ),

      collapseFolder: id =>
        set(
          state => {
            if (!state.expandedFolderIds.has(id)) return state
            const newSet = new Set(state.expandedFolderIds)
            newSet.delete(id)
            return { expandedFolderIds: newSet }
          },
          undefined,
          'collapseFolder'
        ),

      // Bulk expansion actions
      expandAllFolders: ids =>
        set(
          () => ({ expandedFolderIds: new Set(ids) }),
          undefined,
          'expandAllFolders'
        ),

      collapseAllFolders: () =>
        set(
          state =>
            state.expandedFolderIds.size === 0
              ? state
              : { expandedFolderIds: new Set<string>() },
          undefined,
          'collapseAllFolders'
        ),

      expandAllProjects: ids =>
        set(
          () => ({ expandedProjectIds: new Set(ids) }),
          undefined,
          'expandAllProjects'
        ),

      collapseAllProjects: () =>
        set(
          state =>
            state.expandedProjectIds.size === 0
              ? state
              : { expandedProjectIds: new Set<string>() },
          undefined,
          'collapseAllProjects'
        ),

      // Dialog actions
      setAddProjectDialogOpen: (open, parentFolderId) =>
        set(
          {
            addProjectDialogOpen: open,
            addProjectParentFolderId: open ? (parentFolderId ?? null) : null,
          },
          undefined,
          'setAddProjectDialogOpen'
        ),

      setServerDialog: serverDialog =>
        set({ serverDialog }, undefined, 'setServerDialog'),

      openProjectSettings: (projectId, pane) =>
        set(
          {
            projectSettingsDialogOpen: true,
            projectSettingsProjectId: projectId,
            projectSettingsInitialPane: pane ?? null,
          },
          undefined,
          'openProjectSettings'
        ),

      closeProjectSettings: () =>
        set(
          {
            projectSettingsDialogOpen: false,
            projectSettingsProjectId: null,
            projectSettingsInitialPane: null,
          },
          undefined,
          'closeProjectSettings'
        ),

      openGitInitModal: path =>
        set(
          { gitInitModalOpen: true, gitInitModalPath: path },
          undefined,
          'openGitInitModal'
        ),

      closeGitInitModal: () =>
        set(
          { gitInitModalOpen: false, gitInitModalPath: null },
          undefined,
          'closeGitInitModal'
        ),

      openCloneModal: () =>
        set(
          state => (state.cloneModalOpen ? state : { cloneModalOpen: true }),
          undefined,
          'openCloneModal'
        ),

      closeCloneModal: () =>
        set(
          state => (state.cloneModalOpen ? { cloneModalOpen: false } : state),
          undefined,
          'closeCloneModal'
        ),

      openJeanConfigWizard: projectId =>
        set(
          { jeanConfigWizardOpen: true, jeanConfigWizardProjectId: projectId },
          undefined,
          'openJeanConfigWizard'
        ),

      closeJeanConfigWizard: () =>
        set(
          { jeanConfigWizardOpen: false, jeanConfigWizardProjectId: null },
          undefined,
          'closeJeanConfigWizard'
        ),

      setEditingFolderId: id =>
        set(
          state =>
            state.editingFolderId === id ? state : { editingFolderId: id },
          undefined,
          'setEditingFolderId'
        ),

      setProjectAccessTimestamps: timestamps =>
        set(
          state =>
            state.projectAccessTimestamps === timestamps
              ? state
              : { projectAccessTimestamps: timestamps },
          undefined,
          'setProjectAccessTimestamps'
        ),
    }),
    {
      name: 'projects-store',
    }
  )
)
