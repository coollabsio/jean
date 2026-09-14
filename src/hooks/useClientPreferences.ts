import { useCallback, useSyncExternalStore } from 'react'
import type { ClientPreferences } from '@/types/client-preferences'
import {
  readClientPreferences,
  subscribeToClientPreferences,
  updateClientPreferences,
} from '@/lib/client-preferences'

export function useClientPreferences() {
  const preferences = useSyncExternalStore(
    subscribeToClientPreferences,
    readClientPreferences,
    readClientPreferences
  )
  const update = useCallback((patch: Partial<ClientPreferences>) => {
    return updateClientPreferences(patch)
  }, [])
  return { preferences, update }
}
