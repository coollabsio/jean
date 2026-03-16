import { useCallback } from 'react'
import { useGhCliStatus } from '@/services/gh-cli'
import { useUIStore } from '@/store/ui-store'

/**
 * Hook that provides a triggerLogin() function to open the GitHub CLI login modal.
 */
export function useGhLogin() {
  const { data: ghStatus } = useGhCliStatus()
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const triggerLogin = useCallback(() => {
    if (!ghStatus?.path) return

    openCliLoginModal('gh', ghStatus.path, ['auth', 'login'])
  }, [ghStatus?.path, openCliLoginModal])

  return { triggerLogin, isGhInstalled: !!ghStatus?.installed }
}
