import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIENT_VIEW_STATE_STORAGE_KEY,
  defaultClientViewState,
  loadClientViewState,
  loadStoredClientViewState,
  saveClientViewState,
} from './client-view-state'

describe('client view state', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    vi.mocked(localStorage.getItem).mockImplementation(
      key => storage.get(key) ?? null
    )
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      storage.set(key, value)
    })
  })

  it('round-trips client-owned view settings', () => {
    const state = {
      ...defaultClientViewState,
      expanded_project_ids: ['server-a:project-1'],
      expanded_folder_ids: ['server-a:folder-1'],
      expanded_worktree_ids: ['server-a:worktree-1'],
      project_access_timestamps: { 'server-a:project-1': 123 },
      dashboard_worktree_collapse_overrides: { 'server-a:worktree-1': true },
      project_canvas_settings: {
        'server-a:project-1': {
          worktree_sort_mode: 'manual' as const,
          pinned_labels: [{ name: 'Important', color: '#ff0000' }],
          labels: [{ name: 'Important', color: '#ff0000' }],
        },
      },
      project_canvas_active_filters: {
        'server-a:project-1': 'label:Important',
      },
      sidebar_server_filter: 'server-a',
      sidebar_active_tab: 'recent' as const,
      pinned_recent_session_ids: ['server-a:session-1'],
      left_sidebar_visible: true,
      left_sidebar_size: 320,
      file_browser_visible: true,
      file_browser_size: 360,
      right_sidebar_visible: true,
      zen_mode: true,
      terminal_visible_by_worktree: { 'server-a:worktree-1': true },
      terminal_height: 42,
      modal_terminal_open: { 'server-a:worktree-1': true },
      modal_terminal_dock_mode: 'right' as const,
      modal_terminal_width: 480,
      modal_terminal_height: 300,
      browser_side_pane_open: { 'server-a:worktree-1': true },
      browser_side_pane_width: 560,
      browser_modal_open: { 'server-a:worktree-1': false },
      browser_modal_dock_mode: 'bottom' as const,
      browser_modal_width: 600,
      browser_modal_height: 440,
      browser_bottom_panel_open: { 'server-a:worktree-1': true },
      browser_bottom_panel_height: 390,
    }

    saveClientViewState(state)

    expect(loadClientViewState()).toEqual(state)
  })

  it('opens the Projects view for a saved Servers tab', () => {
    saveClientViewState({ ...defaultClientViewState })
    const saved = JSON.parse(storage.get(CLIENT_VIEW_STATE_STORAGE_KEY) ?? '{}')
    storage.set(
      CLIENT_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({ ...saved, sidebar_active_tab: 'servers' })
    )

    expect(loadClientViewState().sidebar_active_tab).toBe('projects')
  })

  it('returns defaults for missing, malformed, or unsupported data', () => {
    expect(loadStoredClientViewState()).toBeNull()
    expect(loadClientViewState()).toEqual(defaultClientViewState)

    localStorage.setItem(CLIENT_VIEW_STATE_STORAGE_KEY, '{not json')
    expect(loadClientViewState()).toEqual(defaultClientViewState)

    localStorage.setItem(
      CLIENT_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({ version: 99, left_sidebar_visible: true })
    )
    expect(loadClientViewState()).toEqual(defaultClientViewState)
  })

  it('keeps valid fields and falls back for invalid fields', () => {
    localStorage.setItem(
      CLIENT_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        expanded_project_ids: ['project-1', 2],
        left_sidebar_visible: true,
        left_sidebar_size: 'wide',
        terminal_visible_by_worktree: { good: false, bad: 'yes' },
        modal_terminal_dock_mode: 'top',
        project_canvas_settings: {
          good: { worktree_sort_mode: 'created' },
          bad: { worktree_sort_mode: 'newest' },
        },
        project_canvas_active_filters: {
          good: 'all',
          label: 'label:Important',
          badType: 4,
          badValue: 'newest',
        },
      })
    )

    expect(loadClientViewState()).toEqual({
      ...defaultClientViewState,
      expanded_project_ids: ['project-1'],
      left_sidebar_visible: true,
      terminal_visible_by_worktree: { good: false },
      project_canvas_settings: {
        good: { worktree_sort_mode: 'created' },
      },
      project_canvas_active_filters: {
        good: 'all',
        label: 'label:Important',
      },
    })
  })

  it('does not throw when client storage is unavailable', () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadClientViewState()).toEqual(defaultClientViewState)

    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error('full')
    })
    expect(() => saveClientViewState(defaultClientViewState)).not.toThrow()
  })
})
