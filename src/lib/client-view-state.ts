import type { LabelData } from '@/types/chat'
import type {
  ModalBrowserDockMode,
  ModalTerminalDockMode,
  ProjectCanvasSettingsState,
} from '@/types/ui-state'

export const CLIENT_VIEW_STATE_STORAGE_KEY = 'jean-client-view-state-v1'
export const CLIENT_VIEW_STATE_VERSION = 1

export interface ClientViewState {
  version: 1
  project_canvas_settings: Record<string, ProjectCanvasSettingsState>
  project_canvas_active_filters: Record<string, string>
  expanded_project_ids: string[]
  expanded_folder_ids: string[]
  expanded_worktree_ids: string[]
  project_access_timestamps: Record<string, number>
  dashboard_worktree_collapse_overrides: Record<string, boolean>
  sidebar_server_filter: string | null
  sidebar_active_tab: 'projects' | 'recent'
  pinned_recent_session_ids: string[]
  left_sidebar_visible: boolean
  left_sidebar_size: number
  file_browser_visible: boolean
  file_browser_size: number
  right_sidebar_visible: boolean
  zen_mode: boolean
  terminal_visible_by_worktree: Record<string, boolean>
  terminal_panel_open: Record<string, boolean>
  terminal_visible: boolean
  terminal_height: number
  modal_terminal_open: Record<string, boolean>
  modal_terminal_dock_mode: ModalTerminalDockMode
  modal_terminal_width: number
  modal_terminal_height: number
  browser_side_pane_open: Record<string, boolean>
  browser_side_pane_width: number
  browser_modal_open: Record<string, boolean>
  browser_modal_dock_mode: ModalBrowserDockMode
  browser_modal_width: number
  browser_modal_height: number
  browser_bottom_panel_open: Record<string, boolean>
  browser_bottom_panel_height: number
}

export const defaultClientViewState: ClientViewState = {
  version: CLIENT_VIEW_STATE_VERSION,
  project_canvas_settings: {},
  project_canvas_active_filters: {},
  expanded_project_ids: [],
  expanded_folder_ids: [],
  expanded_worktree_ids: [],
  project_access_timestamps: {},
  dashboard_worktree_collapse_overrides: {},
  sidebar_server_filter: null,
  sidebar_active_tab: 'projects',
  pinned_recent_session_ids: [],
  left_sidebar_visible: false,
  left_sidebar_size: 250,
  file_browser_visible: false,
  file_browser_size: 280,
  right_sidebar_visible: false,
  zen_mode: false,
  terminal_visible_by_worktree: {},
  terminal_panel_open: {},
  terminal_visible: false,
  terminal_height: 30,
  modal_terminal_open: {},
  modal_terminal_dock_mode: 'floating',
  modal_terminal_width: 400,
  modal_terminal_height: 280,
  browser_side_pane_open: {},
  browser_side_pane_width: 520,
  browser_modal_open: {},
  browser_modal_dock_mode: 'floating',
  browser_modal_width: 520,
  browser_modal_height: 400,
  browser_bottom_panel_open: {},
  browser_bottom_panel_height: 360,
}

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function recordOf<T>(
  value: unknown,
  validate: (entry: unknown) => entry is T
): Record<string, T> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, T] =>
      validate(entry[1])
    )
  )
}

const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean'
const isString = (value: unknown): value is string => typeof value === 'string'
const isCanvasFilter = (value: unknown): value is string =>
  value === 'all' ||
  value === 'manual' ||
  value === 'issues' ||
  value === 'prs' ||
  value === 'security' ||
  value === 'auto_fix' ||
  (typeof value === 'string' && value.startsWith('label:') && value.length > 6)
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const isDockMode = (
  value: unknown
): value is ModalTerminalDockMode | ModalBrowserDockMode =>
  value === 'floating' ||
  value === 'left' ||
  value === 'right' ||
  value === 'bottom'

function isLabel(value: unknown): value is LabelData {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.color === 'string' &&
    (value.pinned === undefined || typeof value.pinned === 'boolean')
  )
}

function isCanvasSettings(value: unknown): value is ProjectCanvasSettingsState {
  if (!isRecord(value)) return false
  const sortMode = value.worktree_sort_mode
  if (
    sortMode !== undefined &&
    sortMode !== 'created' &&
    sortMode !== 'last_activity' &&
    sortMode !== 'manual'
  ) {
    return false
  }
  return [value.pinned_labels, value.labels].every(
    labels =>
      labels === undefined || (Array.isArray(labels) && labels.every(isLabel))
  )
}

function parseClientViewState(value: unknown): ClientViewState {
  if (!isRecord(value) || value.version !== CLIENT_VIEW_STATE_VERSION) {
    return { ...defaultClientViewState }
  }

  const state = { ...defaultClientViewState }
  const assign = <K extends keyof ClientViewState>(
    key: K,
    parsed: ClientViewState[K] | undefined
  ) => {
    if (parsed !== undefined) state[key] = parsed
  }

  assign(
    'project_canvas_settings',
    recordOf(value.project_canvas_settings, isCanvasSettings)
  )
  assign(
    'project_canvas_active_filters',
    recordOf(value.project_canvas_active_filters, isCanvasFilter)
  )
  assign('expanded_project_ids', stringArray(value.expanded_project_ids))
  assign('expanded_folder_ids', stringArray(value.expanded_folder_ids))
  assign('expanded_worktree_ids', stringArray(value.expanded_worktree_ids))
  assign(
    'project_access_timestamps',
    recordOf(value.project_access_timestamps, isNumber)
  )
  assign(
    'dashboard_worktree_collapse_overrides',
    recordOf(value.dashboard_worktree_collapse_overrides, isBoolean)
  )
  if (
    value.sidebar_server_filter === null ||
    isString(value.sidebar_server_filter)
  )
    assign('sidebar_server_filter', value.sidebar_server_filter)
  if (
    value.sidebar_active_tab === 'projects' ||
    value.sidebar_active_tab === 'recent'
  )
    assign('sidebar_active_tab', value.sidebar_active_tab)
  // The old Servers tab is now a section of the Projects view
  else if (value.sidebar_active_tab === 'servers')
    assign('sidebar_active_tab', 'projects')
  assign(
    'pinned_recent_session_ids',
    stringArray(value.pinned_recent_session_ids)
  )

  for (const key of [
    'left_sidebar_visible',
    'file_browser_visible',
    'right_sidebar_visible',
    'zen_mode',
    'terminal_visible',
  ] as const) {
    if (isBoolean(value[key])) assign(key, value[key])
  }
  for (const key of [
    'left_sidebar_size',
    'file_browser_size',
    'terminal_height',
    'modal_terminal_width',
    'modal_terminal_height',
    'browser_side_pane_width',
    'browser_modal_width',
    'browser_modal_height',
    'browser_bottom_panel_height',
  ] as const) {
    if (isNumber(value[key])) assign(key, value[key])
  }
  for (const key of [
    'terminal_visible_by_worktree',
    'terminal_panel_open',
    'modal_terminal_open',
    'browser_side_pane_open',
    'browser_modal_open',
    'browser_bottom_panel_open',
  ] as const) {
    assign(key, recordOf(value[key], isBoolean))
  }
  if (isDockMode(value.modal_terminal_dock_mode))
    assign('modal_terminal_dock_mode', value.modal_terminal_dock_mode)
  if (isDockMode(value.browser_modal_dock_mode))
    assign('browser_modal_dock_mode', value.browser_modal_dock_mode)
  return state
}

export function loadClientViewState(): ClientViewState {
  return loadStoredClientViewState() ?? { ...defaultClientViewState }
}

export function loadStoredClientViewState(): ClientViewState | null {
  if (typeof globalThis.localStorage === 'undefined') {
    return null
  }
  try {
    const stored = globalThis.localStorage.getItem(
      CLIENT_VIEW_STATE_STORAGE_KEY
    )
    if (stored === null) return null
    const parsed = JSON.parse(stored)
    if (!isRecord(parsed) || parsed.version !== CLIENT_VIEW_STATE_VERSION) {
      return null
    }
    return parseClientViewState(parsed)
  } catch {
    return null
  }
}

export function saveClientViewState(state: ClientViewState): void {
  if (typeof globalThis.localStorage === 'undefined') return
  try {
    globalThis.localStorage.setItem(
      CLIENT_VIEW_STATE_STORAGE_KEY,
      JSON.stringify(state)
    )
  } catch {
    // The in-memory view state remains usable when storage is unavailable.
  }
}
