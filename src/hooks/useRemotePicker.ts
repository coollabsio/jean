import { useCallback } from 'react'
import { useUIStore } from '@/store/ui-store'
import { getGitRemotes } from '@/services/git-status'

/**
 * Returns a function that checks remote count before executing an action.
 * - 0 remotes: calls action with "origin" (let git handle the error)
 * - 1 remote: calls action immediately with that remote name
 * - 2+ remotes: opens RemotePickerModal, action runs after user selects
 */
export function useRemotePicker(repoPath: string | null | undefined) {
  const openRemotePicker = useUIStore(state => state.openRemotePicker)

  const pickRemoteOrRun = useCallback(
    async (action: (remote: string) => void) => {
      if (!repoPath) {
        action('origin')
        return
      }

      try {
        const remotes = await getGitRemotes(repoPath)
        if (remotes.length <= 1) {
          action(remotes[0]?.name ?? 'origin')
        } else {
          openRemotePicker(repoPath, action)
        }
      } catch {
        // If we can't list remotes, fall back to origin
        action('origin')
      }
    },
    [repoPath, openRemotePicker]
  )

  return pickRemoteOrRun
}
