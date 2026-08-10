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

  const { setNewWorktreeModalDefaultTab, setNewWorktreeModalOpen } =
    useUIStore.getState()
  setNewWorktreeModalDefaultTab(tab)
  setNewWorktreeModalOpen(true)
}
