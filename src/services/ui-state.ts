import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { defaultUIState, type UIState } from '@/types/ui-state'

import { hasBackend } from '@/lib/environment'

const isTauri = hasBackend

// Query keys for UI state
export const uiStateQueryKeys = {
  all: ['ui-state'] as const,
  state: () => [...uiStateQueryKeys.all] as const,
}

// TanStack Query hooks following the architectural patterns
export function useUIState() {
  return useQuery({
    queryKey: uiStateQueryKeys.state(),
    queryFn: async (): Promise<UIState> => {
      // Return defaults when running outside Tauri (e.g., bun run dev in browser)
      if (!isTauri()) {
        logger.debug('Not in Tauri context, using default UI state')
        return defaultUIState
      }

      try {
        logger.debug('Loading UI state from backend')
        const uiState = await invoke<UIState>('load_ui_state')
        logger.info('UI state loaded successfully', { uiState })
        return uiState
      } catch (error) {
        // Return defaults if UI state file doesn't exist yet
        logger.warn('Failed to load UI state, using defaults', { error })
        return defaultUIState
      }
    },
    staleTime: Infinity, // UI state doesn't need refetching - only updates via setQueryData
    gcTime: 1000 * 60 * 60, // 1 hour
  })
}

export function useSaveUIState() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (uiState: UIState) => {
      // Skip persistence when running outside Tauri (e.g., bun run dev in browser)
      if (!isTauri()) {
        logger.debug('Not in Tauri context, UI state not persisted to disk', {
          uiState,
        })
        return
      }

      try {
        logger.debug('Saving UI state to backend', { uiState })
        await invoke('save_ui_state', { uiState })
        logger.debug('UI state saved successfully')
      } catch (error) {
        // Silent fail for UI state saves - don't bother user with errors
        logger.error('Failed to save UI state', { error, uiState })
        throw error
      }
    },
    onSuccess: (_, uiState) => {
      // Update the cache with the new UI state
      queryClient.setQueryData(uiStateQueryKeys.state(), uiState)
      logger.debug('UI state cache updated')
      // No toast for UI state - silent operation
    },
  })
}
