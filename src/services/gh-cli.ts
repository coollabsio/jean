/**
 * GitHub CLI management service
 *
 * Provides TanStack Query hooks for checking, installing, and managing
 * the embedded GitHub CLI (gh) binary.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke, useWsConnectionStatus } from '@/lib/transport'
import { listen } from '@/lib/transport'
import { toast } from 'sonner'
import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type {
  GhCliStatus,
  GhAuthStatus,
  GhReleaseInfo,
  GhInstallProgress,
} from '@/types/gh-cli'

import { hasBackend } from '@/lib/environment'

const isTauri = hasBackend

// Query keys for GitHub CLI
export const ghCliQueryKeys = {
  all: ['gh-cli'] as const,
  status: () => [...ghCliQueryKeys.all, 'status'] as const,
  auth: () => [...ghCliQueryKeys.all, 'auth'] as const,
  versions: () => [...ghCliQueryKeys.all, 'versions'] as const,
}

/**
 * Hook to detect GitHub CLI in system PATH
 */
export function useGhPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...ghCliQueryKeys.all, 'path-detection'],
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
        }>('detect_gh_in_path')
        console.debug('[ONBOARDING:SVC] gh path detection:', result)
        return result
      } catch (err) {
        console.debug('[ONBOARDING:SVC] gh path detection failed:', err)
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

/**
 * Hook to check if GitHub CLI is installed and get its status
 */
export function useGhCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ghCliQueryKeys.status(),
    queryFn: async (): Promise<GhCliStatus> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning mock gh CLI status')
        return { installed: false, version: null, path: null }
      }

      try {
        console.debug('[ONBOARDING:SVC] gh: checking installed status...')
        const status = await invoke<GhCliStatus>('check_gh_cli_installed')
        console.debug('[ONBOARDING:SVC] gh: status =', status)
        return status
      } catch (error) {
        logger.error('Failed to check GitHub CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    refetchInterval: 1000 * 60 * 60, // Re-check every hour
  })
}

/**
 * Hook to check if GitHub CLI is authenticated
 */
export function useGhCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ghCliQueryKeys.auth(),
    queryFn: async (): Promise<GhAuthStatus> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning mock gh auth status')
        return { authenticated: false, error: 'Not in Tauri context' }
      }

      try {
        console.debug('[ONBOARDING:SVC] gh: checking auth status...')
        const status = await invoke<GhAuthStatus>('check_gh_cli_auth')
        console.debug('[ONBOARDING:SVC] gh: auth =', status)
        return status
      } catch (error) {
        logger.error('Failed to check GitHub CLI auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

/**
 * Hook to fetch available GitHub CLI versions from GitHub releases
 */
export function useAvailableGhVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ghCliQueryKeys.versions(),
    queryFn: async (): Promise<GhReleaseInfo[]> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning empty versions list')
        return []
      }

      try {
        logger.debug('Fetching available GitHub CLI versions')
        // Transform snake_case from Rust to camelCase
        const versions = await invoke<
          {
            version: string
            tag_name: string
            published_at: string
            prerelease: boolean
          }[]
        >('get_available_gh_versions')

        return versions.map(v => ({
          version: v.version,
          tagName: v.tag_name,
          publishedAt: v.published_at,
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch gh CLI versions', { error })
        throw error
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15, // Cache for 15 minutes to avoid rate limiting
    gcTime: 1000 * 60 * 30, // 30 minutes
    refetchInterval: 1000 * 60 * 60, // Re-check every hour
  })
}

/**
 * Hook to install GitHub CLI
 */
export function useInstallGhCli() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (version?: string) => {
      logger.info('Installing GitHub CLI', { version })
      await invoke('install_gh_cli', { version: version ?? null })
    },
    // Disable retry - installation should not be retried automatically
    retry: false,
    onSuccess: () => {
      // Invalidate status to refetch
      queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.status() })
      logger.info('GitHub CLI installed successfully')
      toast.success('GitHub CLI installed successfully')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to install GitHub CLI', { error })
      toast.error('Failed to install GitHub CLI', { description: message })
    },
  })
}

/**
 * Hook to listen for installation progress events
 * Returns [progress, resetProgress] tuple to allow resetting state before new install
 */
export function useGhInstallProgress(): [GhInstallProgress | null, () => void] {
  const [progress, setProgress] = useState<GhInstallProgress | null>(null)
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
        logger.info('[useGhInstallProgress] Setting up listener', {
          listenerId,
        })
        unlistenFn = await listen<GhInstallProgress>(
          'gh-cli:install-progress',
          event => {
            logger.info('[useGhInstallProgress] Received progress event', {
              listenerId,
              stage: event.payload.stage,
              message: event.payload.message,
              percent: event.payload.percent,
            })
            setProgress(event.payload)
          }
        )
      } catch (error) {
        logger.error('[useGhInstallProgress] Failed to setup listener', {
          listenerId,
          error,
        })
      }
    }

    setupListener()

    return () => {
      logger.info('[useGhInstallProgress] Cleaning up listener', { listenerId })
      if (unlistenFn) {
        unlistenFn()
      }
    }
  }, [wsConnected])

  return [progress, resetProgress]
}

/**
 * Combined hook for gh CLI setup flow
 */
export function useGhCliSetup() {
  const status = useGhCliStatus()
  const versions = useAvailableGhVersions()
  const installMutation = useInstallGhCli()
  const [progress, resetProgress] = useGhInstallProgress()

  const needsSetup = !status.isLoading && !status.data?.installed

  // Wrapper to support install with options (e.g., onSuccess callback)
  const install = (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => {
    logger.info('[useGhCliSetup] install() called', {
      version,
      isPending: installMutation.isPending,
    })

    // Reset progress before starting new installation to prevent stale state
    resetProgress()

    logger.info('[useGhCliSetup] Calling installMutation.mutate()', { version })
    installMutation.mutate(version, {
      onSuccess: () => {
        logger.info('[useGhCliSetup] mutate onSuccess callback')
        options?.onSuccess?.()
      },
      onError: error => {
        logger.error('[useGhCliSetup] mutate onError callback', { error })
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
