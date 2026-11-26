import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore, type RightPanelTab } from '@/store/ui-store'

interface RightPanelWorktreeSources {
  sessionChatModalOpen: boolean
  sessionChatModalWorktreeId: string | null
  activeWorktreeId: string | null
  selectedWorktreeId: string | null
}

/** Worktree whose terminal, browser and scripts the right panel shows. */
export function resolveRightPanelWorktreeId(
  sources: RightPanelWorktreeSources
): string | null {
  if (sources.sessionChatModalOpen && sources.sessionChatModalWorktreeId) {
    return sources.sessionChatModalWorktreeId
  }
  return sources.activeWorktreeId ?? sources.selectedWorktreeId
}

export function currentRightPanelWorktreeId(): string | null {
  const ui = useUIStore.getState()
  return resolveRightPanelWorktreeId({
    sessionChatModalOpen: ui.sessionChatModalOpen,
    sessionChatModalWorktreeId: ui.sessionChatModalWorktreeId,
    activeWorktreeId: useChatStore.getState().activeWorktreeId,
    selectedWorktreeId: useProjectsStore.getState().selectedWorktreeId,
  })
}

export function isRightPanelShowing(tab: RightPanelTab): boolean {
  const ui = useUIStore.getState()
  return ui.fileBrowserVisible && ui.rightPanelTab === tab
}

/**
 * Mirror a terminal/browser open or close request onto the right panel.
 * A close only hides the panel when it shows that tab for this worktree.
 */
export function syncRightPanelSurface(
  worktreeId: string,
  tab: RightPanelTab,
  open: boolean
): void {
  const ui = useUIStore.getState()
  if (open) {
    ui.openRightPanelTab(tab)
    return
  }
  if (
    isRightPanelShowing(tab) &&
    currentRightPanelWorktreeId() === worktreeId
  ) {
    ui.setFileBrowserVisible(false)
  }
}
