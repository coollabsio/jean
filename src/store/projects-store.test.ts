import { describe, it, expect, beforeEach } from 'vitest'
import { useProjectsStore } from './projects-store'

describe('ProjectsStore', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      selectedProjectId: null,
      selectedWorktreeId: null,
      expandedProjectIds: new Set<string>(),
      expandedFolderIds: new Set<string>(),
      projectCanvasSettings: {},
      projectCanvasActiveFilters: {},
      sidebarServerFilter: null,
      sidebarActiveTab: 'projects',
      pinnedRecentSessionIds: [],
      addProjectDialogOpen: false,
      projectSettingsDialogOpen: false,
      projectSettingsProjectId: null,
      gitInitModalOpen: false,
      gitInitModalPath: null,
      editingFolderId: null,
    })
  })

  describe('selection', () => {
    it('selects a project and clears worktree selection', () => {
      const { selectProject, selectWorktree } = useProjectsStore.getState()

      selectWorktree('worktree-1')
      expect(useProjectsStore.getState().selectedWorktreeId).toBe('worktree-1')

      selectProject('project-1')
      const state = useProjectsStore.getState()
      expect(state.selectedProjectId).toBe('project-1')
      expect(state.selectedWorktreeId).toBeNull()
    })

    it('selects a worktree', () => {
      const { selectWorktree } = useProjectsStore.getState()

      selectWorktree('worktree-1')
      expect(useProjectsStore.getState().selectedWorktreeId).toBe('worktree-1')
    })

    it('clears selection with null', () => {
      const { selectProject, selectWorktree } = useProjectsStore.getState()

      selectProject('project-1')
      selectWorktree('worktree-1')

      selectProject(null)
      expect(useProjectsStore.getState().selectedProjectId).toBeNull()

      selectWorktree(null)
      expect(useProjectsStore.getState().selectedWorktreeId).toBeNull()
    })
  })

  describe('project expansion', () => {
    it('toggles project expanded state', () => {
      const { toggleProjectExpanded } = useProjectsStore.getState()

      toggleProjectExpanded('project-1')
      expect(
        useProjectsStore.getState().expandedProjectIds.has('project-1')
      ).toBe(true)

      toggleProjectExpanded('project-1')
      expect(
        useProjectsStore.getState().expandedProjectIds.has('project-1')
      ).toBe(false)
    })

    it('expands project directly', () => {
      const { expandProject } = useProjectsStore.getState()

      expandProject('project-1')
      expect(
        useProjectsStore.getState().expandedProjectIds.has('project-1')
      ).toBe(true)

      // Expanding again should be idempotent
      expandProject('project-1')
      expect(
        useProjectsStore.getState().expandedProjectIds.has('project-1')
      ).toBe(true)
    })

    it('collapses project directly', () => {
      const { expandProject, collapseProject } = useProjectsStore.getState()

      expandProject('project-1')
      collapseProject('project-1')
      expect(
        useProjectsStore.getState().expandedProjectIds.has('project-1')
      ).toBe(false)

      // Collapsing non-expanded should be safe
      collapseProject('project-2')
      expect(
        useProjectsStore.getState().expandedProjectIds.has('project-2')
      ).toBe(false)
    })

    it('sets project expanded state explicitly', () => {
      const { setProjectExpanded } = useProjectsStore.getState()

      setProjectExpanded('project-1', true)
      expect(
        useProjectsStore.getState().expandedProjectIds.has('project-1')
      ).toBe(true)

      setProjectExpanded('project-1', false)
      expect(
        useProjectsStore.getState().expandedProjectIds.has('project-1')
      ).toBe(false)
    })

    it('handles multiple expanded projects', () => {
      const { expandProject } = useProjectsStore.getState()

      expandProject('project-1')
      expandProject('project-2')
      expandProject('project-3')

      const { expandedProjectIds } = useProjectsStore.getState()
      expect(expandedProjectIds.size).toBe(3)
      expect(expandedProjectIds.has('project-1')).toBe(true)
      expect(expandedProjectIds.has('project-2')).toBe(true)
      expect(expandedProjectIds.has('project-3')).toBe(true)
    })
  })

  describe('folder expansion', () => {
    it('toggles folder expanded state', () => {
      const { toggleFolderExpanded } = useProjectsStore.getState()

      toggleFolderExpanded('folder-1')
      expect(
        useProjectsStore.getState().expandedFolderIds.has('folder-1')
      ).toBe(true)

      toggleFolderExpanded('folder-1')
      expect(
        useProjectsStore.getState().expandedFolderIds.has('folder-1')
      ).toBe(false)
    })

    it('expands folder directly', () => {
      const { expandFolder } = useProjectsStore.getState()

      expandFolder('folder-1')
      expect(
        useProjectsStore.getState().expandedFolderIds.has('folder-1')
      ).toBe(true)
    })

    it('collapses folder directly', () => {
      const { expandFolder, collapseFolder } = useProjectsStore.getState()

      expandFolder('folder-1')
      collapseFolder('folder-1')
      expect(
        useProjectsStore.getState().expandedFolderIds.has('folder-1')
      ).toBe(false)
    })
  })

  describe('add project dialog', () => {
    it('opens and closes add project dialog', () => {
      const { setAddProjectDialogOpen } = useProjectsStore.getState()

      setAddProjectDialogOpen(true)
      expect(useProjectsStore.getState().addProjectDialogOpen).toBe(true)

      setAddProjectDialogOpen(false)
      expect(useProjectsStore.getState().addProjectDialogOpen).toBe(false)
    })
  })

  describe('project settings dialog', () => {
    it('opens project settings with project ID', () => {
      const { openProjectSettings } = useProjectsStore.getState()

      openProjectSettings('project-1')
      const state = useProjectsStore.getState()
      expect(state.projectSettingsDialogOpen).toBe(true)
      expect(state.projectSettingsProjectId).toBe('project-1')
    })

    it('closes project settings and clears project ID', () => {
      const { openProjectSettings, closeProjectSettings } =
        useProjectsStore.getState()

      openProjectSettings('project-1')
      closeProjectSettings()

      const state = useProjectsStore.getState()
      expect(state.projectSettingsDialogOpen).toBe(false)
      expect(state.projectSettingsProjectId).toBeNull()
    })
  })

  describe('git init modal', () => {
    it('opens git init modal with path', () => {
      const { openGitInitModal } = useProjectsStore.getState()

      openGitInitModal('/path/to/project')
      const state = useProjectsStore.getState()
      expect(state.gitInitModalOpen).toBe(true)
      expect(state.gitInitModalPath).toBe('/path/to/project')
    })

    it('closes git init modal and clears path', () => {
      const { openGitInitModal, closeGitInitModal } =
        useProjectsStore.getState()

      openGitInitModal('/path/to/project')
      closeGitInitModal()

      const state = useProjectsStore.getState()
      expect(state.gitInitModalOpen).toBe(false)
      expect(state.gitInitModalPath).toBeNull()
    })
  })

  describe('folder editing', () => {
    it('sets editing folder ID', () => {
      const { setEditingFolderId } = useProjectsStore.getState()

      setEditingFolderId('folder-1')
      expect(useProjectsStore.getState().editingFolderId).toBe('folder-1')

      setEditingFolderId(null)
      expect(useProjectsStore.getState().editingFolderId).toBeNull()
    })
  })

  describe('project canvas settings', () => {
    it('stores client view filters by scoped owner', () => {
      const state = useProjectsStore.getState()

      state.setProjectCanvasActiveFilter('server-1:project-1', 'manual')
      state.setSidebarServerFilter('server-1')

      expect(useProjectsStore.getState().projectCanvasActiveFilters).toEqual({
        'server-1:project-1': 'manual',
      })
      expect(useProjectsStore.getState().sidebarServerFilter).toBe('server-1')
    })

    it('stores the selected sidebar tab', () => {
      useProjectsStore.getState().setSidebarActiveTab('recent')

      expect(useProjectsStore.getState().sidebarActiveTab).toBe('recent')
    })

    it('stores worktree sort mode per project', () => {
      const { setProjectCanvasWorktreeSortMode } = useProjectsStore.getState()

      setProjectCanvasWorktreeSortMode('project-1', 'last_activity')
      setProjectCanvasWorktreeSortMode('project-2', 'created')
      setProjectCanvasWorktreeSortMode('project-3', 'manual')

      const state = useProjectsStore.getState()
      expect(state.projectCanvasSettings['project-1']?.worktreeSortMode).toBe(
        'last_activity'
      )
      expect(state.projectCanvasSettings['project-2']?.worktreeSortMode).toBe(
        'created'
      )
      expect(state.projectCanvasSettings['project-3']?.worktreeSortMode).toBe(
        'manual'
      )
    })

    it('stores pinned label filters per project without changing sort mode', () => {
      const { setProjectCanvasWorktreeSortMode, setProjectCanvasPinnedLabels } =
        useProjectsStore.getState()

      setProjectCanvasWorktreeSortMode('project-1', 'manual')
      setProjectCanvasPinnedLabels('project-1', [
        { name: 'Bug', color: '#eab308', pinned: true },
      ])

      expect(
        useProjectsStore.getState().projectCanvasSettings['project-1']
      ).toEqual({
        worktreeSortMode: 'manual',
        pinnedLabels: [{ name: 'Bug', color: '#eab308', pinned: true }],
      })
    })
  })
})
