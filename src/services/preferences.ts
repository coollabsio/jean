import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke, invokeForServer } from '@/lib/transport'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import type { AppPreferences } from '@/types/preferences'
import {
  defaultPreferences,
  normalizeClaudeModel,
  normalizeCodexModel,
} from '@/types/preferences'
import { DEFAULT_KEYBINDINGS, type KeybindingsMap } from '@/types/keybindings'
import type { ServerPreferencesEnvelope } from '@/types/server-preferences'
import {
  readClientPreferences,
  splitClientPreferencePatch,
  updateClientPreferences,
} from '@/lib/client-preferences'
import { useSettingsTargetServerId } from '@/lib/settings-target'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

// Old default keybindings that have been changed - used for migration
// When a default changes, add the old value here so stored prefs get updated
const MIGRATED_KEYBINDINGS: Partial<
  Record<keyof KeybindingsMap, string | string[]>
> = {
  toggle_left_sidebar: 'mod+1', // Changed to 'mod+b'
  open_provider_dropdown: 'alt+p', // Changed to 'mod+shift+p' (macOS dead key fix)
  open_model_dropdown: 'alt+m', // Changed to 'mod+shift+m' (macOS dead key fix)
  open_thinking_dropdown: 'alt+e', // Changed to 'mod+shift+e' (macOS dead key fix)
  toggle_browser: 'mod+alt+b', // Changed to 'mod+shift+backquote'
  // Changed to free CMD+SHIFT+T, then corrected to the serializer's modifier order.
  restore_last_archived: ['mod+shift+t', 'mod+alt+shift+t'],
}

// Migrate keybindings: if a stored value matches an old default, use the new default
function migrateKeybindings(
  stored: KeybindingsMap | undefined
): KeybindingsMap {
  if (!stored) return DEFAULT_KEYBINDINGS

  const migrated = { ...stored }
  for (const [action, oldDefault] of Object.entries(MIGRATED_KEYBINDINGS)) {
    const oldDefaults = Array.isArray(oldDefault) ? oldDefault : [oldDefault]
    if (oldDefaults.includes(stored[action])) {
      // User had the old default, update to new default
      const newDefault = DEFAULT_KEYBINDINGS[action]
      if (newDefault) {
        migrated[action] = newDefault
      }
    }
  }
  return migrated
}

import { hasBackend, hasBackendTransport } from '@/lib/environment'
import { preserveQueryCacheOnError } from '@/lib/query-error'

const isTauri = hasBackend

// Query keys for preferences
export const preferencesQueryKeys = {
  all: ['preferences'] as const,
  preferences: (serverId: string = LOCAL_SERVER_ID) =>
    serverId === LOCAL_SERVER_ID
      ? ([...preferencesQueryKeys.all] as const)
      : ([...preferencesQueryKeys.all, 'server', serverId] as const),
}

export function useServerPreferences() {
  const serverId = useSettingsTargetServerId()
  return useQuery({
    queryKey: ['server-preferences', serverId],
    queryFn: () =>
      serverId === LOCAL_SERVER_ID
        ? invoke<ServerPreferencesEnvelope>('get_server_preferences')
        : invokeForServer<ServerPreferencesEnvelope>(
            serverId,
            'get_server_preferences'
          ),
    enabled: hasBackendTransport(),
    staleTime: 1000 * 60 * 5,
    retry: false,
  })
}

export function useUpdateServerPreferences() {
  const queryClient = useQueryClient()
  const serverId = useSettingsTargetServerId()
  return useMutation({
    mutationFn: ({
      patch,
      expectedRevision,
    }: {
      patch: Partial<AppPreferences>
      expectedRevision: string
    }) => {
      const args = { patch, expectedRevision }
      return serverId === LOCAL_SERVER_ID
        ? invoke<ServerPreferencesEnvelope>('update_server_preferences', args)
        : invokeForServer<ServerPreferencesEnvelope>(
            serverId,
            'update_server_preferences',
            args
          )
    },
    onSuccess: envelope => {
      queryClient.setQueryData(['server-preferences', serverId], envelope)
      queryClient.invalidateQueries({ queryKey: preferencesQueryKeys.all })
    },
  })
}

// TanStack Query hooks following the architectural patterns
export function usePreferences() {
  const serverId = useSettingsTargetServerId()
  return useQuery({
    queryKey: preferencesQueryKeys.preferences(serverId),
    queryFn: async (): Promise<AppPreferences> => {
      // Return defaults when running outside Tauri (e.g., bun run dev in browser)
      if (!hasBackendTransport()) {
        logger.debug('Not in Tauri context, using default preferences')
        return defaultPreferences
      }

      try {
        logger.debug('Loading preferences from backend')
        const preferences =
          serverId === LOCAL_SERVER_ID
            ? await invoke<AppPreferences>('load_preferences')
            : (
                await invokeForServer<ServerPreferencesEnvelope>(
                  serverId,
                  'get_server_preferences'
                )
              ).preferences
        logger.info('Preferences loaded successfully', { preferences })
        // Migrate old defaults and merge with new defaults
        const completePreferences = {
          ...defaultPreferences,
          ...preferences,
        } as AppPreferences
        const migratedBindings = migrateKeybindings(
          completePreferences.keybindings
        )
        const merged = { ...DEFAULT_KEYBINDINGS, ...migratedBindings }
        // Drop stale keys (renamed/removed actions) that persist in saved prefs
        const validKeys = new Set(Object.keys(DEFAULT_KEYBINDINGS))
        const keybindings: KeybindingsMap = {}
        for (const [key, value] of Object.entries(merged)) {
          if (validKeys.has(key)) keybindings[key] = value
        }
        const normalized = {
          ...completePreferences,
          selected_model: normalizeClaudeModel(
            completePreferences.selected_model,
            {
              // Keep opus/sonnet/haiku when a custom CLI provider is the default
              // so Settings → Claude can show/persist provider-routed models.
              preserveProviderAliases: Boolean(
                completePreferences.default_provider
              ),
            }
          ),
          selected_codex_model: normalizeCodexModel(
            completePreferences.selected_codex_model
          ),
          keybindings,
        }
        return { ...normalized, ...readClientPreferences(normalized) }
      } catch (error) {
        // Return defaults if preferences file doesn't exist yet
        logger.warn('Failed to load preferences, using defaults', { error })
        return preserveQueryCacheOnError(error)
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
  const serverId = useSettingsTargetServerId()
  const queryKey = preferencesQueryKeys.preferences(serverId)

  return useMutation({
    onMutate: patch => {
      const [clientPatch] = splitClientPreferencePatch(patch)
      if (Object.keys(clientPatch).length === 0) return
      queryClient.setQueryData<AppPreferences>(queryKey, current =>
        current ? { ...current, ...clientPatch } : current
      )
    },
    mutationFn: async (patch: Partial<AppPreferences>) => {
      const [clientPatch, serverPatch] = splitClientPreferencePatch(patch)
      if (Object.keys(clientPatch).length > 0) {
        updateClientPreferences(clientPatch)
      }
      if (Object.keys(serverPatch).length === 0) return
      if (!isTauri()) {
        logger.debug(
          'Not in Tauri context, preferences not persisted to disk',
          { patch: serverPatch }
        )
        return
      }

      try {
        logger.debug('Patching preferences on backend', { patch: serverPatch })
        if (serverId === LOCAL_SERVER_ID) {
          await invoke('patch_preferences', { patch: serverPatch })
        } else {
          const current = await invokeForServer<ServerPreferencesEnvelope>(
            serverId,
            'get_server_preferences'
          )
          await invokeForServer(serverId, 'update_server_preferences', {
            patch: serverPatch,
            expectedRevision: current.revision,
          })
        }
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
        queryKey,
      })
      logger.info('Preferences cache invalidated after patch')
    },
  })
}

export function useSavePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (preferences: AppPreferences) => {
      const [clientPreferences] = splitClientPreferencePatch(preferences)
      updateClientPreferences(clientPreferences)
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
