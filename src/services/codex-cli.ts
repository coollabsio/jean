/**
 * Codex CLI management service
 *
 * Provides TanStack Query hooks for checking, installing, and managing
 * the embedded Codex CLI binary.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke, useWsConnectionStatus } from '@/lib/transport'
import { listen } from '@/lib/transport'
import { toast } from 'sonner'
import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type {
  CodexCliStatus,
  CodexAuthStatus,
  CodexReleaseInfo,
  CodexInstallProgress,
  CodexUsageSnapshot,
} from '@/types/codex-cli'

import { hasBackend } from '@/lib/environment'

const isTauri = hasBackend
const USAGE_REFRESH_MS = 1000 * 60 * 5

// Query keys for Codex CLI
export const codexCliQueryKeys = {
  all: ['codex-cli'] as const,
  status: () => [...codexCliQueryKeys.all, 'status'] as const,
  auth: () => [...codexCliQueryKeys.all, 'auth'] as const,
  usage: () => [...codexCliQueryKeys.all, 'usage'] as const,
  versions: () => [...codexCliQueryKeys.all, 'versions'] as const,
}

/**
 * Hook to detect Codex CLI in system PATH
 */
export function useCodexPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...codexCliQueryKeys.all, 'path-detection'],
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
        }>('detect_codex_in_path')
        console.debug('[ONBOARDING:SVC] codex path detection:', result)
        return result
      } catch (err) {
        console.debug('[ONBOARDING:SVC] codex path detection failed:', err)
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

function getUsageStaleTime(snapshot?: CodexUsageSnapshot): number {
  if (!snapshot?.fetchedAt) return 0
  const expiresAtMs = snapshot.fetchedAt * 1000 + USAGE_REFRESH_MS
  return Math.max(0, expiresAtMs - Date.now())
}

function getUsageRefetchInterval(snapshot?: CodexUsageSnapshot): number {
  if (!snapshot?.fetchedAt) return USAGE_REFRESH_MS
  const expiresAtMs = snapshot.fetchedAt * 1000 + USAGE_REFRESH_MS
  return Math.max(1_000, expiresAtMs - Date.now())
}

/**
 * Hook to check if Codex CLI is installed and get its status
 */
export function useCodexCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: codexCliQueryKeys.status(),
    queryFn: async (): Promise<CodexCliStatus> => {
      if (!isTauri()) {
        return { installed: false, version: null, path: null }
      }

      try {
        console.debug('[ONBOARDING:SVC] codex: checking installed status...')
        const status = await invoke<CodexCliStatus>('check_codex_cli_installed')
        console.debug('[ONBOARDING:SVC] codex: status =', status)
        return status
      } catch (error) {
        console.debug('[ONBOARDING:SVC] codex: status check FAILED:', error)
        logger.error('Failed to check Codex CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

/**
 * Hook to check if Codex CLI is authenticated
 */
export function useCodexCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: codexCliQueryKeys.auth(),
    queryFn: async (): Promise<CodexAuthStatus> => {
      if (!isTauri()) {
        return { authenticated: false, error: 'Not in Tauri context' }
      }

      try {
        console.debug('[ONBOARDING:SVC] codex: checking auth status...')
        const status = await invoke<CodexAuthStatus>('check_codex_cli_auth')
        console.debug('[ONBOARDING:SVC] codex: auth =', status)
        return status
      } catch (error) {
        console.debug('[ONBOARDING:SVC] codex: auth check FAILED:', error)
        logger.error('Failed to check Codex CLI auth', { error })
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

/**
 * Hook to fetch current Codex usage.
 */
export function useCodexUsage(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: codexCliQueryKeys.usage(),
    queryFn: async (): Promise<CodexUsageSnapshot> => {
      if (!isTauri()) {
        throw new Error('Codex usage is only available in Tauri context')
      }
      return invoke<CodexUsageSnapshot>('get_codex_usage')
    },
    enabled: options?.enabled ?? true,
    staleTime: query => getUsageStaleTime(query.state.data),
    gcTime: 1000 * 60 * 10,
    refetchInterval: query => getUsageRefetchInterval(query.state.data),
  })
}

/**
 * Hook to fetch available Codex CLI versions from GitHub releases
 */
export function useAvailableCodexVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: codexCliQueryKeys.versions(),
    queryFn: async (): Promise<CodexReleaseInfo[]> => {
      if (!isTauri()) {
        return []
      }

      try {
        const versions = await invoke<
          {
            version: string
            tag_name: string
            published_at: string
            prerelease: boolean
          }[]
        >('get_available_codex_versions')

        return versions.map(v => ({
          version: v.version,
          tagName: v.tag_name,
          publishedAt: v.published_at,
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch Codex CLI versions', { error })
        throw error
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15, // Cache for 15 minutes to avoid rate limiting
    gcTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 60, // Re-check every hour
  })
}

/**
 * Hook to install Codex CLI
 */
export function useInstallCodexCli() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (version?: string) => {
      logger.info('Installing Codex CLI', { version })
      await invoke('install_codex_cli', { version: version ?? null })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.status() })
      logger.info('Codex CLI installed successfully')
      toast.success('Codex CLI installed successfully')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to install Codex CLI', { error })
      toast.error('Failed to install Codex CLI', { description: message })
    },
  })
}

/**
 * Hook to listen for installation progress events
 */
export function useCodexInstallProgress(): [
  CodexInstallProgress | null,
  () => void,
] {
  const [progress, setProgress] = useState<CodexInstallProgress | null>(null)
  const wsConnected = useWsConnectionStatus()

  const resetProgress = useCallback(() => {
    setProgress(null)
  }, [])

  useEffect(() => {
    if (!isTauri()) return

    let unlistenFn: (() => void) | null = null
    const listenerId = Math.random().toString(36).substring(7)

    const setupListener = async () => {
      try {
        logger.info('[useCodexInstallProgress] Setting up listener', {
          listenerId,
        })
        unlistenFn = await listen<CodexInstallProgress>(
          'codex-cli:install-progress',
          event => {
            logger.info('[useCodexInstallProgress] Received progress event', {
              listenerId,
              stage: event.payload.stage,
              message: event.payload.message,
              percent: event.payload.percent,
            })
            setProgress(event.payload)
          }
        )
      } catch (error) {
        logger.error('[useCodexInstallProgress] Failed to setup listener', {
          listenerId,
          error,
        })
      }
    }

    setupListener()

    return () => {
      logger.info('[useCodexInstallProgress] Cleaning up listener', {
        listenerId,
      })
      if (unlistenFn) {
        unlistenFn()
      }
    }
  }, [wsConnected])

  return [progress, resetProgress]
}

/**
 * Combined hook for Codex CLI setup flow
 */
export function useCodexCliSetup() {
  const status = useCodexCliStatus()
  const versions = useAvailableCodexVersions()
  const installMutation = useInstallCodexCli()
  const [progress, resetProgress] = useCodexInstallProgress()

  const needsSetup = !status.isLoading && !status.data?.installed

  const install = (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => {
    logger.info('[useCodexCliSetup] install() called', {
      version,
      isPending: installMutation.isPending,
    })

    resetProgress()

    installMutation.mutate(version, {
      onSuccess: () => {
        logger.info('[useCodexCliSetup] mutate onSuccess callback')
        options?.onSuccess?.()
      },
      onError: error => {
        logger.error('[useCodexCliSetup] mutate onError callback', { error })
        options?.onError?.(error)
      },
    })
  }

  return {
    status: status.data,
    isStatusLoading: status.isLoading,
    versions: versions.data ?? [],
    isVersionsLoading: versions.isFetching,
    isVersionsError: versions.isError,
    refetchVersions: versions.refetch,
    needsSetup,
    isInstalling: installMutation.isPending,
    installError: installMutation.error,
    progress,
    install,
    refetchStatus: status.refetch,
  }
}
