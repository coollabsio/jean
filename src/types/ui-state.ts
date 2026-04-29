// Types that match the Rust UIState struct
// Contains ephemeral UI state that should be restored on app restart
// Note: Field names use snake_case to match Rust struct exactly
//
// Session-specific state (answered_questions, submitted_answers, fixed_findings,
// pending_permission_denials, denied_message_context, reviewing_sessions) is now
// stored in the Session files. See useSessionStatePersistence.
// Review results are also stored in Session files (review_results field).

export interface ProjectCanvasSettingsState {
  worktree_sort_mode?: 'created' | 'last_activity'
}

export type ModalTerminalDockMode = 'floating' | 'left' | 'right' | 'bottom'

export type ModalBrowserDockMode = 'floating' | 'left' | 'right' | 'bottom'

export interface BrowserTabPersisted {
  id: string
  url: string
  title?: string
}

export interface UIState {
  active_worktree_id: string | null
  active_worktree_path: string | null
  last_active_worktree_id: string | null
  active_project_id: string | null
  expanded_project_ids: string[]
  expanded_folder_ids: string[]
  /** Left sidebar width in pixels, defaults to 250 */
  left_sidebar_size?: number
  /** Left sidebar visibility, defaults to false */
  left_sidebar_visible?: boolean
  /** Active session ID per worktree (for restoring open tabs) */
  active_session_ids: Record<string, string>
  /** Whether the review sidebar is visible */
  review_sidebar_visible?: boolean
  /** Session IDs that completed while out of focus, need digest on open */
  pending_digest_session_ids: string[]
  /** Modal terminal drawer open state per worktree */
  modal_terminal_open?: Record<string, boolean>
  /** Modal terminal dock mode */
  modal_terminal_dock_mode?: ModalTerminalDockMode
  /** Legacy pinned state; maps to right dock when true */
  modal_terminal_pinned?: boolean
  /** Modal terminal width in pixels for left/right dock */
  modal_terminal_width?: number
  /** Modal terminal height in pixels for bottom dock */
  modal_terminal_height?: number
  /** Browser tabs persisted per worktree */
  browser_tabs?: Record<string, BrowserTabPersisted[]>
  /** Active browser tab id per worktree */
  browser_active_tab_ids?: Record<string, string>
  /** Browser side-pane open state per worktree */
  browser_side_pane_open?: Record<string, boolean>
  /** Browser side-pane width in pixels (global) */
  browser_side_pane_width?: number
  /** Browser modal drawer open state per worktree */
  browser_modal_open?: Record<string, boolean>
  /** Browser modal drawer dock mode */
  browser_modal_dock_mode?: ModalBrowserDockMode
  /** Browser modal drawer width in pixels for left/right dock */
  browser_modal_width?: number
  /** Browser modal drawer height in pixels for bottom dock */
  browser_modal_height?: number
  /** Browser bottom panel open state per worktree */
  browser_bottom_panel_open?: Record<string, boolean>
  /** Browser bottom panel height in pixels (global) */
  browser_bottom_panel_height?: number
  /** Last-accessed timestamps per project for recency sorting: projectId → unix ms */
  project_access_timestamps?: Record<string, number>
  /** Dashboard worktree collapse overrides: worktreeId → collapsed (true/false) */
  dashboard_worktree_collapse_overrides?: Record<string, boolean>
  /** Project canvas settings per project */
  project_canvas_settings?: Record<string, ProjectCanvasSettingsState>
  /** Last opened worktree+session per project: projectId → { worktree_id, session_id } */
  last_opened_per_project?: Record<
    string,
    { worktree_id: string; session_id: string }
  >
  /** Git diff modal file list view mode */
  git_diff_view_mode?: 'list' | 'tree'
  version: number
}

export const defaultUIState: UIState = {
  active_worktree_id: null,
  active_worktree_path: null,
  last_active_worktree_id: null,
  active_project_id: null,
  expanded_project_ids: [],
  expanded_folder_ids: [],
  left_sidebar_size: 250,
  left_sidebar_visible: false,
  active_session_ids: {},
  pending_digest_session_ids: [],
  modal_terminal_open: {},
  modal_terminal_dock_mode: 'floating',
  modal_terminal_width: 400,
  modal_terminal_height: 280,
  modal_terminal_pinned: false,
  browser_tabs: {},
  browser_active_tab_ids: {},
  browser_side_pane_open: {},
  browser_side_pane_width: 520,
  browser_modal_open: {},
  browser_modal_dock_mode: 'floating',
  browser_modal_width: 520,
  browser_modal_height: 400,
  browser_bottom_panel_open: {},
  browser_bottom_panel_height: 360,
  git_diff_view_mode: 'list',
  version: 1,
}
