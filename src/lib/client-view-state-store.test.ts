import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectsStore } from '@/store/projects-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import {
  applyClientViewState,
  captureClientViewState,
  scopeClientViewStateResources,
} from './client-view-state-store'
import { defaultClientViewState } from './client-view-state'

describe('client view state store bridge', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      expandedProjectIds: new Set(),
      expandedFolderIds: new Set(),
      expandedWorktreeIds: new Set(),
      projectAccessTimestamps: {},
      dashboardWorktreeCollapseOverrides: {},
      projectCanvasSettings: {},
      projectCanvasActiveFilters: {},
      sidebarServerFilter: null,
      sidebarActiveTab: 'projects',
      pinnedRecentSessionIds: [],
    })
  })

  it('adds the active server to raw legacy resource IDs', () => {
    const scoped = scopeClientViewStateResources(
      {
        ...defaultClientViewState,
        project_canvas_settings: { project: {} },
        expanded_project_ids: ['project', 'other:project'],
        expanded_worktree_ids: ['worktree'],
        terminal_visible_by_worktree: { worktree: true },
        browser_modal_open: { worktree: true },
      },
      'remote-1'
    )

    expect(scoped.project_canvas_settings).toEqual({ 'remote-1:project': {} })
    expect(scoped.expanded_project_ids).toEqual([
      'remote-1:project',
      'other:project',
    ])
    expect(scoped.expanded_worktree_ids).toEqual(['remote-1:worktree'])
    expect(scoped.terminal_visible_by_worktree).toEqual({
      'remote-1:worktree': true,
    })
    expect(scoped.browser_modal_open).toEqual({ 'remote-1:worktree': true })
  })

  it('captures and restores scoped client display state', () => {
    useProjectsStore.setState({
      expandedProjectIds: new Set(['server:project']),
      expandedWorktreeIds: new Set(['server:worktree']),
      projectAccessTimestamps: { 'server:project': 123 },
      projectCanvasActiveFilters: { 'server:project': 'manual' },
      sidebarServerFilter: 'server',
      sidebarActiveTab: 'recent',
      pinnedRecentSessionIds: ['server:session'],
    })
    useUIStore.setState({
      rightSidebarVisible: true,
      zenMode: true,
      railSection: 'agents',
      selectedAgentId: 'reviewer',
      agentsServerFilter: 'server',
    })
    useTerminalStore.setState({
      terminalVisibleByWorktree: { 'server:worktree': true },
    })
    const captured = captureClientViewState()
    useProjectsStore.setState({
      expandedProjectIds: new Set(),
      expandedWorktreeIds: new Set(),
      projectCanvasActiveFilters: {},
      sidebarServerFilter: null,
      sidebarActiveTab: 'projects',
      pinnedRecentSessionIds: ['server:authoritative-session'],
    })
    useUIStore.setState({
      rightSidebarVisible: false,
      zenMode: false,
      railSection: 'workspace',
      selectedAgentId: 'jean',
      agentsServerFilter: 'all',
    })
    useTerminalStore.setState({ terminalVisibleByWorktree: {} })

    applyClientViewState(captured)

    expect(useUIStore.getState().railSection).toBe('agents')
    expect(useUIStore.getState().selectedAgentId).toBe('reviewer')
    expect(useUIStore.getState().agentsServerFilter).toBe('server')

    expect(useProjectsStore.getState().expandedProjectIds).toEqual(
      new Set(['server:project'])
    )
    expect(useProjectsStore.getState().expandedWorktreeIds).toEqual(
      new Set(['server:worktree'])
    )
    expect(useProjectsStore.getState().projectCanvasActiveFilters).toEqual({
      'server:project': 'manual',
    })
    expect(useProjectsStore.getState().sidebarServerFilter).toBe('server')
    expect(useProjectsStore.getState().sidebarActiveTab).toBe('recent')
    expect(useProjectsStore.getState().pinnedRecentSessionIds).toEqual([
      'server:authoritative-session',
    ])
    expect(useUIStore.getState().rightSidebarVisible).toBe(true)
    expect(useUIStore.getState().zenMode).toBe(true)
    expect(useTerminalStore.getState().terminalVisibleByWorktree).toEqual({
      'server:worktree': true,
    })
  })
})
