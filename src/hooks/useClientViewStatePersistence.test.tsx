import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIENT_VIEW_STATE_STORAGE_KEY,
  defaultClientViewState,
} from '@/lib/client-view-state'
import { useProjectsStore } from '@/store/projects-store'
import { useClientViewStatePersistence } from './useClientViewStatePersistence'

describe('useClientViewStatePersistence', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    vi.mocked(localStorage.getItem).mockImplementation(
      key => storage.get(key) ?? null
    )
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      storage.set(key, value)
    })
    useProjectsStore.setState({
      expandedWorktreeIds: new Set(),
      projectCanvasActiveFilters: {},
      sidebarActiveTab: 'projects',
    })
  })

  it('restores client-owned state and saves later changes synchronously', async () => {
    storage.set(
      CLIENT_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({
        ...defaultClientViewState,
        expanded_worktree_ids: ['server:worktree-1'],
        project_canvas_active_filters: { 'server:project-1': 'manual' },
        sidebar_active_tab: 'recent',
      })
    )

    renderHook(() => useClientViewStatePersistence(true))

    await waitFor(() => {
      expect(useProjectsStore.getState().expandedWorktreeIds).toEqual(
        new Set(['server:worktree-1'])
      )
      expect(useProjectsStore.getState().sidebarActiveTab).toBe('recent')
    })

    useProjectsStore
      .getState()
      .setProjectCanvasActiveFilter('server:project-1', 'issues')
    useProjectsStore
      .getState()
      .setProjectCanvasWorktreeSortMode('server:project-1', 'last_activity')

    expect(
      JSON.parse(storage.get(CLIENT_VIEW_STATE_STORAGE_KEY) ?? '{}')
    ).toMatchObject({
      project_canvas_active_filters: {
        'server:project-1': 'issues',
      },
      project_canvas_settings: {
        'server:project-1': {
          worktree_sort_mode: 'last_activity',
        },
      },
    })
  })
})
