/**
 * PI CLI management service.
 */

import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import type {
  PiAuthStatus,
  PiCliStatus,
  PiModelInfo,
  PiReleaseInfo,
} from '@/types/pi-cli'
import { hasBackendTransport } from '@/lib/environment'
import { preferencesQueryKeys } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'

const isTauri = hasBackendTransport

export const piCliQueryKeys = {
  all: ['pi-cli'] as const,
  status: () => [...piCliQueryKeys.all, 'status'] as const,
  auth: () => [...piCliQueryKeys.all, 'auth'] as const,
  versions: () => [...piCliQueryKeys.all, 'versions'] as const,
  models: () => [...piCliQueryKeys.all, 'models'] as const,
}

export function usePiPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...piCliQueryKeys.all, 'path-detection'],
    queryFn: async (): Promise<{
      found: boolean
      path: string | null
      version: string | null
      package_manager: string | null
    }> => {
      if (!isTauri()) {
        return {
          found: false,
          path: null,
          version: null,
          package_manager: null,
        }
      }
      try {
        return await invoke('detect_pi_in_path')
      } catch (error) {
        logger.debug('PI path detection failed', { error })
        return {
          found: false,
          path: null,
          version: null,
          package_manager: null,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function usePiCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: piCliQueryKeys.status(),
    queryFn: async (): Promise<PiCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invoke<PiCliStatus>('check_pi_cli_installed')
      } catch (error) {
        logger.error('Failed to check PI CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function usePiCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: piCliQueryKeys.auth(),
    queryFn: async (): Promise<PiAuthStatus> => {
      if (!isTauri())
        return { authenticated: false, error: 'Not in Tauri context' }
      try {
        return await invoke<PiAuthStatus>('check_pi_cli_auth')
      } catch (error) {
        logger.error('Failed to check PI CLI auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useAvailablePiVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: piCliQueryKeys.versions(),
    queryFn: async (): Promise<PiReleaseInfo[]> => {
      if (!isTauri()) return []
      return await invoke<PiReleaseInfo[]>('get_available_pi_versions')
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useAvailablePiModels(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: piCliQueryKeys.models(),
    queryFn: async (): Promise<PiModelInfo[]> => {
      if (!isTauri()) return []
      return await invoke<PiModelInfo[]>('list_pi_models')
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })

  useEffect(() => {
    if (!isTauri() || !query.data?.length) return

    const models = query.data
    const availableValues = models.map(model => `pi/${model.id}`)
    const preferredValue =
      models.find(model => model.is_default)?.id ?? models[0]?.id
    if (!preferredValue) return
    const preferred = `pi/${preferredValue}`

    let cancelled = false
    async function syncPiDefaultModel() {
      try {
        const preferences = await invoke<AppPreferences>('load_preferences')
        if (cancelled) return
        const selected = preferences.selected_pi_model
        if (selected && availableValues.includes(selected)) return
        await invoke('patch_preferences', {
          patch: { selected_pi_model: preferred },
        })
        if (!cancelled) {
          queryClient.invalidateQueries({
            queryKey: preferencesQueryKeys.preferences(),
          })
        }
      } catch (error) {
        logger.debug('Failed to sync PI default model from available models', {
          error,
        })
      }
    }

    void syncPiDefaultModel()
    return () => {
      cancelled = true
    }
  }, [query.data, queryClient])

  return query
}

export function useInstallPiCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version?: string) =>
      invoke('install_pi_cli', { version: version ?? null }),
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: piCliQueryKeys.all })
      toast.success('PI CLI installed successfully')
    },
    onError: error => {
      toast.error('Failed to install PI CLI', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function usePiCliSetup() {
  const status = usePiCliStatus()
  const versions = useAvailablePiVersions()
  const installMutation = useInstallPiCli()

  const install = (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => {
    installMutation.mutate(version, {
      onSuccess: () => options?.onSuccess?.(),
      onError: error => options?.onError?.(error),
    })
  }

  const checkManualVersion = (version: string) =>
    invoke<boolean>('check_pi_cli_version_exists', { version })

  return {
    status: status.data,
    isStatusLoading: status.isLoading,
    versions: versions.data ?? [],
    isVersionsLoading: versions.isFetching,
    isVersionsError: versions.isError,
    refetchVersions: versions.refetch,
    needsSetup: !status.isLoading && !status.data?.installed,
    isInstalling: installMutation.isPending,
    installError: installMutation.error,
    progress: null,
    install,
    checkManualVersion,
    refetchStatus: status.refetch,
  }
}
