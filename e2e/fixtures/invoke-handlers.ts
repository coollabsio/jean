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
  created_at: 2_000,
  order: 0,
})
const worktree2 = createWorktree(project.id, {
  name: 'calm-dolphin',
  branch: 'calm-dolphin',
  created_at: 1_000,
  order: 1,
  path: '/tmp/e2e-test-project/.worktrees/calm-dolphin',
})

// UI state with project expanded
const uiState = {
  ...mockUIState,
  active_project_id: project.id,
  expanded_project_ids: [project.id],
  project_canvas_settings: {
    [project.id]: {
      worktree_sort_mode: 'manual',
    },
  },
}

/**
 * Static response map: command name → JSON-serializable response.
 * For commands that need args-dependent behavior, tests should
 * use invokeOverrides in the fixture.
 */
export const defaultResponses: Record<string, unknown> = {
  get_acp_permission_requests: [],
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
  list_unread_sessions: { entries: [] },
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
  get_native_client_id: '11111111-1111-4111-8111-111111111111',
  load_ui_state: uiState,
  save_ui_state: null,
  get_pinned_recent_session_ids: [],
  set_recent_session_pinned: [],

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
  list_codex_skills: [],
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
  list_unmanaged_worktrees: [
    {
      path: '/tmp/e2e-test-project/.worktrees/feature-login',
      branch: 'feature/login',
      head: 'a1b2c3d4e5f67890',
      headShort: 'a1b2c3d',
      prunable: false,
      locked: false,
      detached: false,
      bare: false,
    },
    {
      path: '/tmp/e2e-test-project/.worktrees/hotfix',
      branch: null,
      head: 'deadbeefcafebabe',
      headShort: 'deadbee',
      prunable: false,
      locked: true,
      detached: true,
      bare: false,
    },
  ],
  import_worktree: {
    id: 'imported-worktree',
    project_id: project.id,
    name: 'feature-login',
    path: '/tmp/e2e-test-project/.worktrees/feature-login',
    branch: 'feature/login',
    created_at: 3_000,
    order: 2,
    session_type: 'worktree',
  },
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
  list_pending_wakeups: [],
  get_run_states: [],

  // Misc
  get_package_scripts: [],
  get_run_scripts: [],
  save_emergency_data: null,
  load_emergency_data: null,
}

/**
 * Sub-session fixture for `fuzzy-tiger`, enabled by opening `/?fixture=delegation`
 * (one running and one finished sub-session) or `/?fixture=delegation-finished`
 * (both finished, so the lead can collapse). Off by default so specs that count
 * sessions keep an empty worktree.
 */
function delegationSessions(childRunning: boolean) {
  const now = Math.floor(Date.now() / 1000)
  const lead = {
    id: 'session-lead',
    name: 'Plan the release',
    order: 0,
    created_at: now - 600,
    updated_at: now - 60,
    message_count: 4,
    messages: [],
    last_run_status: 'completed',
  }
  const delegatedBy = {
    origin_session_id: lead.id,
    origin_worktree_id: worktree1.id,
    origin_name: lead.name,
  }
  return [
    lead,
    {
      id: 'session-child-changelog',
      name: 'Write changelog',
      order: 1,
      created_at: now - 300,
      updated_at: now - 30,
      message_count: 2,
      messages: [],
      last_run_status: childRunning ? 'running' : 'completed',
      last_run_execution_mode: 'build',
      delegated_by: delegatedBy,
    },
    {
      id: 'session-child-ci',
      name: 'Check CI',
      order: 2,
      created_at: now - 280,
      updated_at: now - 120,
      message_count: 2,
      messages: [],
      last_run_status: 'completed',
      delegated_by: {
        ...delegatedBy,
        outcome: {
          status: 'done',
          body: 'CI is green on main.',
          ended_at: now - 120,
          reported_at: now - 100,
        },
      },
    },
    {
      id: 'session-normal',
      name: 'Fix flaky test',
      order: 3,
      created_at: now - 900,
      updated_at: now - 90,
      message_count: 3,
      messages: [],
      last_run_status: 'completed',
    },
  ]
}

export const sessionFixtures: Record<
  string,
  { worktreeId: string; sessions: Record<string, unknown>[] }
> = {
  delegation: { worktreeId: worktree1.id, sessions: delegationSessions(true) },
  'delegation-finished': {
    worktreeId: worktree1.id,
    sessions: delegationSessions(false),
  },
}

export { project, worktree1, worktree2 }
