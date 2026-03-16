import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import type { AppPreferences } from '@/types/preferences'
import { defaultPreferences, normalizeCodexModel } from '@/types/preferences'
import { DEFAULT_KEYBINDINGS, type KeybindingsMap } from '@/types/keybindings'

// Old default keybindings that have been changed - used for migration
// When a default changes, add the old value here so stored prefs get updated
const MIGRATED_KEYBINDINGS: Partial<Record<keyof KeybindingsMap, string>> = {
  toggle_left_sidebar: 'mod+1', // Changed to 'mod+b'
  open_provider_dropdown: 'alt+p', // Changed to 'mod+shift+p' (macOS dead key fix)
  open_model_dropdown: 'alt+m', // Changed to 'mod+shift+m' (macOS dead key fix)
  open_thinking_dropdown: 'alt+e', // Changed to 'mod+shift+e' (macOS dead key fix)
}

// Migrate keybindings: if a stored value matches an old default, use the new default
function migrateKeybindings(
  stored: KeybindingsMap | undefined
): KeybindingsMap {
  if (!stored) return DEFAULT_KEYBINDINGS

  const migrated = { ...stored }
  for (const [action, oldDefault] of Object.entries(MIGRATED_KEYBINDINGS)) {
    if (stored[action] === oldDefault) {
      // User had the old default, update to new default
      const newDefault = DEFAULT_KEYBINDINGS[action]
      if (newDefault) {
        migrated[action] = newDefault
      }
    }
  }
  return migrated
}

import { hasBackend } from '@/lib/environment'

const isTauri = hasBackend

// Query keys for preferences
export const preferencesQueryKeys = {
  all: ['preferences'] as const,
  preferences: () => [...preferencesQueryKeys.all] as const,
}

// TanStack Query hooks following the architectural patterns
export function usePreferences() {
  return useQuery({
    queryKey: preferencesQueryKeys.preferences(),
    queryFn: async (): Promise<AppPreferences> => {
      // Return defaults when running outside Tauri (e.g., bun run dev in browser)
      if (!isTauri()) {
        logger.debug('Not in Tauri context, using default preferences')
        return defaultPreferences
      }

      try {
        logger.debug('Loading preferences from backend')
        const preferences = await invoke<AppPreferences>('load_preferences')
        logger.info('Preferences loaded successfully', { preferences })
        // Migrate old defaults and merge with new defaults
        const migratedBindings = migrateKeybindings(preferences.keybindings)
        const merged = { ...DEFAULT_KEYBINDINGS, ...migratedBindings }
        // Drop stale keys (renamed/removed actions) that persist in saved prefs
        const validKeys = new Set(Object.keys(DEFAULT_KEYBINDINGS))
        const keybindings: KeybindingsMap = {}
        for (const [key, value] of Object.entries(merged)) {
          if (validKeys.has(key)) keybindings[key] = value
        }
        return {
          ...preferences,
          selected_codex_model: normalizeCodexModel(
            preferences.selected_codex_model
          ),
          keybindings,
        }
      } catch (error) {
        // Return defaults if preferences file doesn't exist yet
        logger.warn('Failed to load preferences, using defaults', { error })
        return defaultPreferences
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

/**
 * Atomically patch preferences on the backend (read-merge-write).
 * Use this for single/few-field updates to avoid race conditions.
 */
export function usePatchPreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (patch: Partial<AppPreferences>) => {
      if (!isTauri()) {
        logger.debug(
          'Not in Tauri context, preferences not persisted to disk',
          { patch }
        )
        return
      }

      try {
        logger.debug('Patching preferences on backend', { patch })
        await invoke('patch_preferences', { patch })
        logger.info('Preferences patched successfully')
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'Unknown error occurred'
        logger.error('Failed to patch preferences', { error, patch })
        toast.error('Failed to save preferences', { description: message })
        throw error
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: preferencesQueryKeys.preferences(),
      })
      logger.info('Preferences cache invalidated after patch')
    },
  })
}

export function useSavePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (preferences: AppPreferences) => {
      // Skip persistence when running outside Tauri (e.g., bun run dev in browser)
      if (!isTauri()) {
        logger.debug(
          'Not in Tauri context, preferences not persisted to disk',
          { preferences }
        )
        return
      }

      try {
        logger.debug('Saving preferences to backend', { preferences })
        await invoke('save_preferences', { preferences })
        logger.info('Preferences saved successfully')
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'Unknown error occurred'
        logger.error('Failed to save preferences', { error, preferences })
        toast.error('Failed to save preferences', { description: message })
        throw error
      }
    },
    onSuccess: (_, preferences) => {
      // Optimistically update cache, then refetch to get backend-populated fields (e.g., file_path)
      queryClient.setQueryData(preferencesQueryKeys.preferences(), preferences)
      queryClient.invalidateQueries({
        queryKey: preferencesQueryKeys.preferences(),
      })
      logger.info('Preferences cache updated')
    },
  })
}
