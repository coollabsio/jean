/**
 * Factory functions for E2E mock data.
 * Field names use snake_case to match Rust serialization (Pattern A).
 */

let counter = 0
function nextId(): string {
  return `e2e-${++counter}-${Date.now()}`
}

export function createProject(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId(),
    name: 'Test Project',
    path: '/tmp/e2e-test-project',
    default_branch: 'main',
    added_at: Date.now() / 1000,
    order: 0,
    ...overrides,
  }
}

export function createWorktree(
  projectId: string,
  overrides: Record<string, unknown> = {}
) {
  const id = nextId()
  return {
    id,
    project_id: projectId,
    name: 'fuzzy-tiger',
    path: `/tmp/e2e-test-project/.worktrees/fuzzy-tiger`,
    branch: 'fuzzy-tiger',
    created_at: Date.now() / 1000,
    order: 0,
    session_type: 'worktree',
    status: 'ready',
    ...overrides,
  }
}

export function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId(),
    name: 'Session 1',
    order: 0,
    created_at: Date.now() / 1000,
    messages: [],
    ...overrides,
  }
}

export const mockPreferences = {
  theme: 'system',
  selected_model: 'sonnet',
  thinking_level: 'think',
  default_effort_level: 'high',
  terminal: 'terminal',
  editor: 'cursor',
  open_in: 'editor',
  auto_branch_naming: true,
  auto_session_naming: true,
  ui_font_size: 13,
  chat_font_size: 13,
  ui_font: 'inter',
  chat_font: 'jetbrains-mono',
  git_poll_interval: 5,
  remote_poll_interval: 60,
  keybindings: {},
  sidebar_width: 240,
  session_sort: 'manual',
  zoom_level: 1.0,
  auto_pull_base_branch: false,
  auto_investigate: true,
  auto_archive_on_merge: false,
  magic_prompts: [],
  custom_providers: [],
  web_access_enabled: false,
  web_access_auto_start: false,
  web_access_port: 3100,
  web_access_token: '',
  mcp_servers_enabled: false,
  experimental_features: {},
}

export const mockUIState = {
  active_worktree_id: null as string | null,
  active_worktree_path: null as string | null,
  last_active_worktree_id: null as string | null,
  active_project_id: null as string | null,
  expanded_project_ids: [] as string[],
  expanded_folder_ids: [] as string[],
  active_session_ids: {} as Record<string, string>,
  pending_digest_session_ids: [] as string[],
  version: 1,
}
