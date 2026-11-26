import { useBrowserStore } from '@/store/browser-store'
import { useProjectsStore } from '@/store/projects-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import { parseServerResourceKey, serverResourceKey } from './server-resource'
import {
  CLIENT_VIEW_STATE_VERSION,
  type ClientViewState,
} from './client-view-state'

export function captureClientViewState(): ClientViewState {
  const projects = useProjectsStore.getState()
  const ui = useUIStore.getState()
  const terminal = useTerminalStore.getState()
  const browser = useBrowserStore.getState()

  return {
    version: CLIENT_VIEW_STATE_VERSION,
    project_canvas_settings: Object.fromEntries(
      Object.entries(projects.projectCanvasSettings).map(
        ([projectId, settings]) => [
          projectId,
          {
            worktree_sort_mode: settings.worktreeSortMode,
            pinned_labels: settings.pinnedLabels,
            labels: settings.labels,
          },
        ]
      )
    ),
    project_canvas_active_filters: projects.projectCanvasActiveFilters,
    expanded_project_ids: [...projects.expandedProjectIds],
    expanded_folder_ids: [...projects.expandedFolderIds],
    expanded_worktree_ids: [...projects.expandedWorktreeIds],
    project_access_timestamps: projects.projectAccessTimestamps,
    dashboard_worktree_collapse_overrides:
      projects.dashboardWorktreeCollapseOverrides,
    sidebar_server_filter: projects.sidebarServerFilter,
    sidebar_active_tab: projects.sidebarActiveTab,
    pinned_recent_session_ids: projects.pinnedRecentSessionIds,
    left_sidebar_visible: ui.leftSidebarVisible,
    left_sidebar_size: ui.leftSidebarSize,
    file_browser_visible: ui.fileBrowserVisible,
    file_browser_size: ui.fileBrowserSize,
    right_sidebar_visible: ui.rightSidebarVisible,
    zen_mode: ui.zenMode,
    terminal_visible_by_worktree: terminal.terminalVisibleByWorktree,
    terminal_panel_open: terminal.terminalPanelOpen,
    terminal_visible: terminal.terminalVisible,
    terminal_height: terminal.terminalHeight,
    modal_terminal_open: terminal.modalTerminalOpen,
    modal_terminal_dock_mode: terminal.modalTerminalDockMode,
    modal_terminal_width: terminal.modalTerminalWidth,
    modal_terminal_height: terminal.modalTerminalHeight,
    browser_side_pane_open: browser.sidePaneOpen,
    browser_side_pane_width: browser.sidePaneWidth,
    browser_modal_open: browser.modalOpen,
    browser_modal_dock_mode: browser.modalDockMode,
    browser_modal_width: browser.modalWidth,
    browser_modal_height: browser.modalHeight,
    browser_bottom_panel_open: browser.bottomPanelOpen,
    browser_bottom_panel_height: browser.bottomPanelHeight,
  }
}

export function applyClientViewState(state: ClientViewState): void {
  const currentProjects = useProjectsStore.getState()
  useProjectsStore.setState({
    projectCanvasSettings: {
      ...currentProjects.projectCanvasSettings,
      ...Object.fromEntries(
        Object.entries(state.project_canvas_settings).map(
          ([projectId, settings]) => [
            projectId,
            {
              ...currentProjects.projectCanvasSettings[projectId],
              worktreeSortMode: settings.worktree_sort_mode,
              labels: settings.labels,
            },
          ]
        )
      ),
    },
    projectCanvasActiveFilters: state.project_canvas_active_filters,
    expandedProjectIds: new Set(state.expanded_project_ids),
    expandedFolderIds: new Set(state.expanded_folder_ids),
    expandedWorktreeIds: new Set(state.expanded_worktree_ids),
    projectAccessTimestamps: state.project_access_timestamps,
    dashboardWorktreeCollapseOverrides:
      state.dashboard_worktree_collapse_overrides,
    sidebarServerFilter: state.sidebar_server_filter,
    sidebarActiveTab: state.sidebar_active_tab,
    pinnedRecentSessionIds: currentProjects.pinnedRecentSessionIds,
  })
  useUIStore.setState({
    leftSidebarVisible: state.left_sidebar_visible,
    leftSidebarSize: state.left_sidebar_size,
    fileBrowserVisible: state.file_browser_visible,
    fileBrowserSize: state.file_browser_size,
    rightSidebarVisible: state.right_sidebar_visible,
    zenMode: state.zen_mode,
  })
  useTerminalStore.setState({
    terminalVisibleByWorktree: state.terminal_visible_by_worktree,
    terminalPanelOpen: state.terminal_panel_open,
    terminalVisible: state.terminal_visible,
    terminalHeight: state.terminal_height,
    modalTerminalOpen: state.modal_terminal_open,
    modalTerminalDockMode: state.modal_terminal_dock_mode,
    modalTerminalWidth: state.modal_terminal_width,
    modalTerminalHeight: state.modal_terminal_height,
  })
  useBrowserStore.setState({
    sidePaneOpen: state.browser_side_pane_open,
    sidePaneWidth: state.browser_side_pane_width,
    modalOpen: state.browser_modal_open,
    modalDockMode: state.browser_modal_dock_mode,
    modalWidth: state.browser_modal_width,
    modalHeight: state.browser_modal_height,
    bottomPanelOpen: state.browser_bottom_panel_open,
    bottomPanelHeight: state.browser_bottom_panel_height,
  })
}

/** Add the active server owner to raw IDs from legacy server UI state. */
export function scopeClientViewStateResources(
  state: ClientViewState,
  serverId: string
): ClientViewState {
  const scope = (id: string) =>
    parseServerResourceKey(id)
      ? id
      : serverResourceKey({ serverId, resourceId: id })
  const scopeKeys = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(record).map(([id, value]) => [scope(id), value])
    )

  return {
    ...state,
    project_canvas_settings: scopeKeys(state.project_canvas_settings),
    project_canvas_active_filters: scopeKeys(
      state.project_canvas_active_filters
    ),
    expanded_project_ids: state.expanded_project_ids.map(scope),
    expanded_folder_ids: state.expanded_folder_ids.map(scope),
    expanded_worktree_ids: state.expanded_worktree_ids.map(scope),
    project_access_timestamps: scopeKeys(state.project_access_timestamps),
    dashboard_worktree_collapse_overrides: scopeKeys(
      state.dashboard_worktree_collapse_overrides
    ),
    terminal_visible_by_worktree: scopeKeys(state.terminal_visible_by_worktree),
    terminal_panel_open: scopeKeys(state.terminal_panel_open),
    modal_terminal_open: scopeKeys(state.modal_terminal_open),
    browser_side_pane_open: scopeKeys(state.browser_side_pane_open),
    browser_modal_open: scopeKeys(state.browser_modal_open),
    browser_bottom_panel_open: scopeKeys(state.browser_bottom_panel_open),
  }
}
