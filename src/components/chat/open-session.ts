import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { Worktree } from '@/types/projects'

/**
 * Open a session from anywhere in the app: select its project and worktree,
 * then let the project canvas open it in the session modal.
 */
export function openSessionInWorktree(
  worktree: Pick<Worktree, 'id' | 'path' | 'project_id'>,
  sessionId: string
): void {
  const { selectProject, selectWorktree } = useProjectsStore.getState()
  selectProject(worktree.project_id)
  selectWorktree(worktree.id)
  const chat = useChatStore.getState()
  chat.registerWorktreePath(worktree.id, worktree.path)
  chat.clearActiveWorktree()
  chat.setActiveSession(worktree.id, sessionId)
  const ui = useUIStore.getState()
  ui.markWorktreeForAutoOpenSession(worktree.id, sessionId)
  // Leave the Agents page so the project canvas can open the session
  ui.setRailSection('workspace')
}
