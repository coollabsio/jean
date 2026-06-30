import type { Worktree } from '@/types/projects'

type ForkedWorktree = Pick<Worktree, 'id' | 'path' | 'project_id'>
type ForkedSession = { id: string }

interface ForkSessionNavigationContext {
  activeWorktreePath: string | null
  sessionChatModalOpen: boolean
}

interface ForkSessionNavigationActions {
  expandProject: (projectId: string) => void
  selectWorktree: (worktreeId: string) => void
  registerWorktreePath: (worktreeId: string, worktreePath: string) => void
  setActiveWorktree: (worktreeId: string, worktreePath: string) => void
  setActiveSession: (worktreeId: string, sessionId: string) => void
  addUserInitiatedSession: (sessionId: string) => void
  openWorktreeModal: (worktreeId: string, worktreePath: string) => void
}

/**
 * Navigate to a forked session while preserving the current presentation.
 * Canvas/modal flows must stay in SessionChatModal so the worktree header and
 * session tabs remain visible; inline chat flows should continue inline.
 */
export function navigateToForkedSession(
  worktree: ForkedWorktree,
  session: ForkedSession,
  context: ForkSessionNavigationContext,
  actions: ForkSessionNavigationActions
): 'modal' | 'chat' {
  actions.expandProject(worktree.project_id)
  actions.selectWorktree(worktree.id)
  actions.registerWorktreePath(worktree.id, worktree.path)
  actions.setActiveSession(worktree.id, session.id)
  actions.addUserInitiatedSession(session.id)

  if (context.sessionChatModalOpen || !context.activeWorktreePath) {
    actions.openWorktreeModal(worktree.id, worktree.path)
    return 'modal'
  }

  actions.setActiveWorktree(worktree.id, worktree.path)
  return 'chat'
}
