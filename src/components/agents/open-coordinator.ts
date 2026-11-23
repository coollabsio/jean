import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

/** Shows a project with its coordinator chat as the main panel. */
export function openProjectCoordinator(projectId: string): void {
  useChatStore.getState().clearActiveWorktree()
  useProjectsStore.getState().selectProject(projectId)
  useUIStore.getState().setProjectViewMode(projectId, 'coordinator')
}
