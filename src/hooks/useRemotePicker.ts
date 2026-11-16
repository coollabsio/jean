import { useCallback } from 'react'
import { useUIStore } from '@/store/ui-store'
import { getGitRemotes, type GitRepoOwner } from '@/services/git-status'

export function pushNeedsRemotePicker(prNumber?: number | null) {
  return prNumber == null
}

/**
 * Returns a function that checks remote count before executing an action.
 * - 0 remotes: calls action with "origin" (let git handle the error)
 * - 1 remote: calls action immediately with that remote name
 * - 2+ remotes: opens RemotePickerModal, action runs after user selects
 */
export function useRemotePicker(
  repoPath: string | null | undefined,
  owner: GitRepoOwner | null | undefined
) {
  const openRemotePicker = useUIStore(state => state.openRemotePicker)
  const worktreeId = owner?.worktreeId
  const projectId = owner?.projectId

  const pickRemoteOrRun = useCallback(
    async (action: (remote: string) => void) => {
      const repoOwner: GitRepoOwner | null = worktreeId
        ? { worktreeId }
        : projectId
          ? { projectId }
          : null
      if (!repoPath || !repoOwner) {
        action('origin')
        return
      }

      try {
        const remotes = await getGitRemotes(repoOwner, repoPath)
        if (remotes.length <= 1) {
          action(remotes[0]?.name ?? 'origin')
        } else {
          openRemotePicker(repoPath, repoOwner, action)
        }
      } catch {
        // If we can't list remotes, fall back to origin
        action('origin')
      }
    },
    [repoPath, worktreeId, projectId, openRemotePicker]
  )

  return pickRemoteOrRun
}
