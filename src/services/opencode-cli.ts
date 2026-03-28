/**
 * OpenCode CLI management service.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { listen } from '@/lib/transport'
import { toast } from 'sonner'
import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type {
  OpencodeAuthStatus,
  OpencodeCliStatus,
  OpencodeInstallProgress,
  OpencodeReleaseInfo,
} from '@/types/opencode-cli'
import { hasBackend } from '@/lib/environment'

const isTauri = hasBackend

export const opencodeCliQueryKeys = {
  all: ['opencode-cli'] as const,
  status: () => [...opencodeCliQueryKeys.all, 'status'] as const,
  auth: () => [...opencodeCliQueryKeys.all, 'auth'] as const,
  versions: () => [...opencodeCliQueryKeys.all, 'versions'] as const,
  models: () => [...opencodeCliQueryKeys.all, 'models'] as const,
}

// Backward-compatible alias used by existing components.
export const openCodeCliQueryKeys = opencodeCliQueryKeys

/**
 * Hook to detect OpenCode CLI in system PATH
 */
export function useOpencodePathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...opencodeCliQueryKeys.all, 'path-detection'],
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
        const result = await invoke<{
          found: boolean
          path: string | null
          version: string | null
          package_manager: string | null
        }>('detect_opencode_in_path')
        console.debug('[ONBOARDING:SVC] opencode path detection:', result)
        return result
      } catch (err) {
        console.debug('[ONBOARDING:SVC] opencode path detection failed:', err)
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
export const useOpenCodePathDetection = useOpencodePathDetection

export function useOpencodeCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: opencodeCliQueryKeys.status(),
    queryFn: async (): Promise<OpencodeCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        console.debug('[ONBOARDING:SVC] opencode: checking installed status...')
        const status = await invoke<OpencodeCliStatus>(
          'check_opencode_cli_installed'
        )
        console.debug('[ONBOARDING:SVC] opencode: status =', status)
        return status
      } catch (error) {
        console.debug('[ONBOARDING:SVC] opencode: status check FAILED:', error)
        logger.error('Failed to check OpenCode CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}
export const useOpenCodeCliStatus = useOpencodeCliStatus

export function useOpencodeCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: opencodeCliQueryKeys.auth(),
    queryFn: async (): Promise<OpencodeAuthStatus> => {
      if (!isTauri()) {
        return { authenticated: false, error: 'Not in Tauri context' }
      }
      try {
        console.debug('[ONBOARDING:SVC] opencode: checking auth status...')
        const status = await invoke<OpencodeAuthStatus>(
          'check_opencode_cli_auth'
        )
        console.debug('[ONBOARDING:SVC] opencode: auth =', status)
        return status
      } catch (error) {
        console.debug('[ONBOARDING:SVC] opencode: auth check FAILED:', error)
        logger.error('Failed to check OpenCode CLI auth', { error })
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
export const useOpenCodeCliAuth = useOpencodeCliAuth

export function useAvailableOpencodeVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: opencodeCliQueryKeys.versions(),
    queryFn: async (): Promise<OpencodeReleaseInfo[]> => {
      if (!isTauri()) return []
      return await invoke<OpencodeReleaseInfo[]>(
        'get_available_opencode_versions'
      )
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15, // Cache for 15 minutes to avoid rate limiting
    gcTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 60, // Re-check every hour
  })
}
export const useAvailableOpenCodeVersions = useAvailableOpencodeVersions

export function useAvailableOpencodeModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: opencodeCliQueryKeys.models(),
    queryFn: async (): Promise<string[]> => {
      if (!isTauri()) return []
      try {
        return await invoke<string[]>('list_opencode_models')
      } catch (error) {
        logger.error('Failed to list OpenCode models', { error })
        return []
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useInstallOpencodeCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version?: string) => {
      await invoke('install_opencode_cli', { version: version ?? null })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: opencodeCliQueryKeys.status() })
      toast.success('OpenCode CLI installed successfully')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to install OpenCode CLI', { description: message })
    },
  })
}
export const useInstallOpenCodeCli = useInstallOpencodeCli

export function useOpencodeInstallProgress(): [
  OpencodeInstallProgress | null,
  () => void,
] {
  const [progress, setProgress] = useState<OpencodeInstallProgress | null>(null)
  const resetProgress = useCallback(() => setProgress(null), [])

  useEffect(() => {
    if (!isTauri()) return
    let unlistenFn: (() => void) | null = null

    const setup = async () => {
      unlistenFn = await listen<OpencodeInstallProgress>(
        'opencode-cli:install-progress',
        event => setProgress(event.payload)
      )
    }
    setup()

    return () => {
      if (unlistenFn) unlistenFn()
    }
  }, [])

  return [progress, resetProgress]
}
export const useOpenCodeInstallProgress = useOpencodeInstallProgress

export function useOpencodeCliSetup() {
  const status = useOpencodeCliStatus()
  const versions = useAvailableOpencodeVersions()
  const installMutation = useInstallOpencodeCli()
  const [progress, resetProgress] = useOpencodeInstallProgress()

  const install = (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => {
    resetProgress()
    installMutation.mutate(version, {
      onSuccess: () => options?.onSuccess?.(),
      onError: error => options?.onError?.(error),
    })
  }

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
    progress,
    install,
    refetchStatus: status.refetch,
  }
}

// Backward-compatible alias for existing OpenCode naming in UI components.
export const useOpenCodeCliSetup = useOpencodeCliSetup
