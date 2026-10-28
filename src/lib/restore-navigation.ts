import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

/**
 * Show the blank project-picker page with nothing selected.
 *
 * Used when the last session in a worktree is closed (issue #501)
 * so Jean does not auto-recreate a session or leave the user on an empty chat.
 *
 * @param worktreeId - When provided, clears that worktree's active session id
 */
export function navigateToProjectPicker(worktreeId?: string | null): void {
  useUIStore.getState().setSessionChatModalOpen(false)
  useChatStore.getState().clearActiveWorktree()
  useProjectsStore.getState().selectProject(null)

  if (worktreeId) {
    useChatStore.setState(state => {
      if (!(worktreeId in state.activeSessionIds)) return state
      const { [worktreeId]: _removed, ...rest } = state.activeSessionIds
      return { activeSessionIds: rest }
    })
  }
}
