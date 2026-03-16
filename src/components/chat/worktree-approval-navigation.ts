import type { Worktree } from '@/types/projects'

type ApprovedWorktree = Pick<Worktree, 'id' | 'path' | 'project_id'>

interface ApprovedWorktreeNavigationContext {
  activeWorktreePath: string | null
  sessionChatModalOpen: boolean
}

interface ApprovedWorktreeNavigationActions {
  expandProject: (projectId: string) => void
  selectWorktree: (worktreeId: string) => void
  registerWorktreePath: (worktreeId: string, worktreePath: string) => void
  setActiveWorktree: (worktreeId: string, worktreePath: string) => void
  openWorktreeModal: (worktreeId: string, worktreePath: string) => void
}

/**
 * Preserve the modal/canvas presentation for approved worktrees so the
 * session header stays visible when that is how the user entered the flow.
 */
export function navigateToApprovedWorktree(
  worktree: ApprovedWorktree,
  context: ApprovedWorktreeNavigationContext,
  actions: ApprovedWorktreeNavigationActions
): 'modal' | 'chat' {
  actions.expandProject(worktree.project_id)
  actions.selectWorktree(worktree.id)
  actions.registerWorktreePath(worktree.id, worktree.path)

  if (context.sessionChatModalOpen || !context.activeWorktreePath) {
    actions.openWorktreeModal(worktree.id, worktree.path)
    return 'modal'
  }

  actions.setActiveWorktree(worktree.id, worktree.path)
  return 'chat'
}
