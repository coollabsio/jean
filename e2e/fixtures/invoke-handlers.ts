/**
 * Default invoke command responses for E2E tests.
 * All values must be JSON-serializable (no closures, no functions).
 */

import {
  createProject,
  createWorktree,
  mockPreferences,
  mockUIState,
} from './mock-data'

// Shared state across handlers within a test
const project = createProject()
const worktree1 = createWorktree(project.id, {
  name: 'fuzzy-tiger',
  branch: 'fuzzy-tiger',
  order: 0,
})
const worktree2 = createWorktree(project.id, {
  name: 'calm-dolphin',
  branch: 'calm-dolphin',
  order: 1,
  path: '/tmp/e2e-test-project/.worktrees/calm-dolphin',
})

// UI state with project expanded
const uiState = {
  ...mockUIState,
  active_project_id: project.id,
  expanded_project_ids: [project.id],
}

/**
 * Static response map: command name → JSON-serializable response.
 * For commands that need args-dependent behavior, tests should
 * use invokeOverrides in the fixture.
 */
export const defaultResponses: Record<string, unknown> = {
  // Projects
  list_projects: [project],
  list_worktrees: [worktree1, worktree2],
  add_project: project,

  // Sessions
  get_sessions: { sessions: [], active_session_id: null },
  get_session: {
    id: 'unknown',
    name: 'Session',
    order: 0,
    created_at: 0,
    messages: [],
  },
  list_all_sessions: { worktrees: {} },
  create_session: {
    id: 'session-new',
    name: 'New Session',
    order: 0,
    created_at: Date.now() / 1000,
    messages: [],
  },

  // Preferences
  load_preferences: mockPreferences,
  save_preferences: null,

  // UI State
  load_ui_state: uiState,
  save_ui_state: null,

  // CLI checks
  check_claude_cli_installed: { installed: true, version: '1.0.0' },
  check_claude_cli_auth: { authenticated: true },
  check_gh_cli_installed: { installed: true },
  check_gh_cli_auth: { authenticated: true },
  get_available_cli_versions: [],
  get_available_gh_versions: [],

  // Terminal
  kill_all_terminals: 0,
  has_active_terminal: false,

  // Sessions lifecycle
  check_resumable_sessions: [],
  list_archived_sessions: [],
  close_session: null,
  archive_session: null,

  // Git
  set_active_worktree_for_polling: null,
  set_all_worktrees_for_polling: null,
  set_pr_worktrees_for_polling: null,
  set_git_poll_interval: null,
  set_remote_poll_interval: null,
  get_git_poll_interval: 5,
  get_remote_poll_interval: 60,
  trigger_immediate_git_poll: null,
  trigger_immediate_remote_poll: null,
  fetch_worktrees_status: null,

  // MCP
  get_mcp_servers: [],
  check_mcp_health: { healthy: true, servers: [] },

  // Skills
  list_claude_skills: [],
  list_claude_commands: [],
  resolve_claude_command: { content: '', allowed_tools: [] },

  // Files
  list_worktree_files: [],

  // GitHub
  list_github_issues: { issues: [], has_next_page: false },
  list_github_prs: [],

  // Recovery
  cleanup_old_recovery_files: 0,
  cleanup_old_archives: { removed: 0 },

  // App
  get_app_data_dir: `${process.env.HOME}/Library/Application Support/com.jean.desktop.test`,
  set_app_focus_state: null,

  // Archives
  list_archived_worktrees: [],
  list_all_archived_sessions: [],

  // Branches
  get_project_branches: [],

  // Session settings
  set_active_session: null,
  set_session_model: null,
  set_session_provider: null,
  broadcast_session_setting: null,
  rename_session: null,
  send_chat_message: null,
  cancel_chat_message: false,

  // Misc
  save_emergency_data: null,
  load_emergency_data: null,
}

export { project, worktree1, worktree2 }
