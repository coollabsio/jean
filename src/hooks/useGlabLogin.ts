import { useCallback } from 'react'
import { useGlabCliStatus } from '@/services/glab-cli'
import { useUIStore } from '@/store/ui-store'

/**
 * Hook that provides a triggerLogin() function to open the GitLab CLI login modal.
 */
export function useGlabLogin() {
  const { data: glabStatus } = useGlabCliStatus()
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const triggerLogin = useCallback(() => {
    if (!glabStatus?.path) return

    openCliLoginModal('glab', glabStatus.path, ['auth', 'login'])
  }, [glabStatus?.path, openCliLoginModal])

  return { triggerLogin, isGlabInstalled: !!glabStatus?.installed }
}
