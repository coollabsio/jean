import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { NewSessionTabId } from '@/components/worktree/new-session-draft'

export function openNewWorktree({
  projectId,
  tab = null,
}: {
  projectId?: string | null
  tab?: Exclude<NewSessionTabId, 'quick'> | null
} = {}) {
  if (projectId) useProjectsStore.getState().selectProject(projectId)

  const {
    setLeftSidebarVisible,
    setNewWorktreeModalDefaultTab,
    setNewWorktreeModalOpen,
  } = useUIStore.getState()
  if (typeof window !== 'undefined' && window.innerWidth < 768) {
    setLeftSidebarVisible(false)
  }
  setNewWorktreeModalDefaultTab(tab)
  setNewWorktreeModalOpen(true)
}
