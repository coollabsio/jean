import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'

/**
 * Check if the user is currently on a canvas view (ProjectCanvasView).
 * Returns false if on chat view (restore is not allowed from chat view).
 */
export function isOnCanvasView(): boolean {
  const { activeWorktreePath } = useChatStore.getState()
  const { selectedProjectId } = useProjectsStore.getState()

  // On project canvas if no active worktree and a project is selected
  return !activeWorktreePath && !!selectedProjectId
}

/**
 * Navigate to a restored item on ProjectCanvasView.
 *
 * Ensures the user is on ProjectCanvasView and preselects the session if provided.
 */
export function navigateToRestoredItem(
  worktreeId: string,
  _worktreePath: string,
  sessionId?: string
): void {
  const { clearActiveWorktree, setActiveSession } = useChatStore.getState()
  const { selectWorktree } = useProjectsStore.getState()

  // Preselect the session if provided
  if (sessionId) {
    setActiveSession(worktreeId, sessionId)
  }

  // Navigate to ProjectCanvasView
  selectWorktree(worktreeId)
  clearActiveWorktree()
}
