import { EXECUTION_MODE_CYCLE, type ExecutionMode } from '@/types/chat'

export function collectWorktreePaths(
  worktreesByProject?: Record<string, unknown[]>
): Record<string, string> {
  const paths: Record<string, string> = {}
  if (!worktreesByProject) return paths

  for (const worktrees of Object.values(worktreesByProject)) {
    for (const wt of worktrees) {
      if (
        typeof wt === 'object' &&
        wt !== null &&
        'id' in wt &&
        'path' in wt &&
        typeof wt.id === 'string' &&
        typeof wt.path === 'string' &&
        wt.id &&
        wt.path
      ) {
        paths[wt.id] = wt.path
      }
    }
  }

  return paths
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return EXECUTION_MODE_CYCLE.includes(value as ExecutionMode)
}

function collectFromSessionList(
  sessions: unknown,
  modes: Record<string, ExecutionMode>
): void {
  if (!Array.isArray(sessions)) return

  for (const session of sessions) {
    if (
      typeof session === 'object' &&
      session !== null &&
      'id' in session &&
      'selected_execution_mode' in session &&
      typeof session.id === 'string' &&
      isExecutionMode(session.selected_execution_mode)
    ) {
      modes[session.id] = session.selected_execution_mode
    }
  }
}

export function collectExecutionModes(data: {
  sessionsByWorktree?: Record<string, unknown>
  activeSessions?: Record<string, unknown>
}): Record<string, ExecutionMode> {
  const modes: Record<string, ExecutionMode> = {}

  for (const worktreeSessions of Object.values(data.sessionsByWorktree ?? {})) {
    if (
      typeof worktreeSessions === 'object' &&
      worktreeSessions !== null &&
      'sessions' in worktreeSessions
    ) {
      collectFromSessionList(worktreeSessions.sessions, modes)
    }
  }

  collectFromSessionList(Object.values(data.activeSessions ?? {}), modes)

  return modes
}
