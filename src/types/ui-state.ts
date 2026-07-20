// Types that match the Rust UIState struct
// Contains ephemeral UI state that should be restored on app restart
// Note: Field names use snake_case to match Rust struct exactly
//
// Durable session state (answered_questions, submitted_answers, fixed_findings,
// pending_permission_denials, denied_message_context, reviewing_sessions) is
// stored in Session files. Lightweight unsent input drafts (textarea text plus
// image / large-text paste attachment metadata) stay here so session composers
// survive a full UI reload. Attachment file bytes live on disk; only metadata
// is stored in UI state.
// Review results are also stored in Session files (review_results field).

import type { LabelData } from '@/types/chat'

export interface ProjectCanvasSettingsState {
  worktree_sort_mode?: 'created' | 'last_activity' | 'manual'
  pinned_labels?: LabelData[]
  labels?: LabelData[]
}

export type ModalTerminalDockMode = 'floating' | 'left' | 'right' | 'bottom'

export type ModalBrowserDockMode = 'floating' | 'left' | 'right' | 'bottom'

export interface PersistedTerminalInstance {
  id: string
  command: string | null
  command_args?: string[] | null
  label: string
  kind?: 'panel' | 'session'
}

export interface BrowserTabPersisted {
  id: string
  url: string
  title?: string
}

/** Persisted unsent image attachment (file already saved to disk) */
export interface PendingImageDraft {
  id: string
  path: string
  filename: string
}

/**
 * Persisted unsent large-text paste attachment.
 * `content` is optional so older saves / stripped payloads can rehydrate from disk.
 */
export interface PendingTextFileDraft {
  id: string
  path: string
  filename: string
  size: number
  /** Optional; omitted when persisting to keep UI state small */
  content?: string
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
  /** Unsent chat textarea content per session */
  input_drafts?: Record<string, string>
  /**
   * Unsent image attachments per session (files already on disk).
   * Only fully-saved images are persisted — loading placeholders are omitted.
   */
  pending_images?: Record<string, PendingImageDraft[]>
  /**
   * Unsent large-text paste attachments per session (files already on disk).
   * Content is optional in persistence; restore re-reads from disk when missing.
   */
  pending_text_files?: Record<string, PendingTextFileDraft[]>
  /** Whether the review sidebar is visible */
  review_sidebar_visible?: boolean
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
  /** Terminal instances persisted per worktree for restoration after web refresh */
  terminal_instances?: Record<string, PersistedTerminalInstance[]>
  /** Active terminal id per worktree */
  terminal_active_ids?: Record<string, string>
  /** Terminal panel open state per worktree */
  terminal_panel_open?: Record<string, boolean>
  /** Global terminal panel expanded/collapsed state */
  terminal_visible?: boolean
  /** Terminal panel height percentage */
  terminal_height?: number
  /** Session terminal id per session for full-screen terminal surfaces */
  session_terminal_ids?: Record<string, string>
  /** Session primary surface per session */
  session_primary_surface?: Record<string, 'chat' | 'terminal'>
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
  /** Favorited projects shown first in the GitHub Dashboard */
  github_dashboard_favorite_project_ids?: string[]
  /** Last opened worktree+session per project: projectId → { worktree_id, session_id } */
  last_opened_per_project?: Record<
    string,
    { worktree_id: string; session_id: string }
  >
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
  input_drafts: {},
  pending_images: {},
  pending_text_files: {},
  modal_terminal_open: {},
  modal_terminal_dock_mode: 'floating',
  modal_terminal_width: 400,
  modal_terminal_height: 280,
  modal_terminal_pinned: false,
  terminal_instances: {},
  terminal_active_ids: {},
  terminal_panel_open: {},
  terminal_visible: false,
  terminal_height: 30,
  session_terminal_ids: {},
  session_primary_surface: {},
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
  github_dashboard_favorite_project_ids: [],
  version: 1,
}
