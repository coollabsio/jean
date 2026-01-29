/**
 * GitLab CLI management service
 *
 * Provides TanStack Query hooks for checking, installing, and managing
 * the embedded GitLab CLI (glab) binary.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type {
  GlabCliStatus,
  GlabAuthStatus,
  GlabReleaseInfo,
  GlabInstallProgress,
} from '@/types/glab-cli'

// Check if running in Tauri context (vs plain browser)
const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Query keys for GitLab CLI
export const glabCliQueryKeys = {
  all: ['glab-cli'] as const,
  status: () => [...glabCliQueryKeys.all, 'status'] as const,
  auth: () => [...glabCliQueryKeys.all, 'auth'] as const,
  versions: () => [...glabCliQueryKeys.all, 'versions'] as const,
}

/**
 * Hook to check if GitLab CLI is installed and get its status
 */
export function useGlabCliStatus() {
  return useQuery({
    queryKey: glabCliQueryKeys.status(),
    queryFn: async (): Promise<GlabCliStatus> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning mock glab CLI status')
        return { installed: false, version: null, path: null }
      }

      try {
        logger.debug('Checking GitLab CLI installation status')
        const status = await invoke<GlabCliStatus>('check_glab_cli_installed')
        logger.info('GitLab CLI status', { status })
        return status
      } catch (error) {
        logger.error('Failed to check GitLab CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    refetchInterval: 1000 * 60 * 60, // Re-check every hour
  })
}

/**
 * Hook to check if GitLab CLI is authenticated
 */
export function useGlabCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: glabCliQueryKeys.auth(),
    queryFn: async (): Promise<GlabAuthStatus> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning mock glab auth status')
        return { authenticated: false, error: 'Not in Tauri context', host: null }
      }

      try {
        logger.debug('Checking GitLab CLI authentication status')
        const status = await invoke<GlabAuthStatus>('check_glab_cli_auth')
        logger.info('GitLab CLI auth status', { status })
        return status
      } catch (error) {
        logger.error('Failed to check GitLab CLI auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
          host: null,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

/**
 * Hook to fetch available GitLab CLI versions from GitHub releases
 */
export function useAvailableGlabVersions() {
  return useQuery({
    queryKey: glabCliQueryKeys.versions(),
    queryFn: async (): Promise<GlabReleaseInfo[]> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning empty versions list')
        return []
      }

      try {
        logger.debug('Fetching available GitLab CLI versions')
        // Transform snake_case from Rust to camelCase
        const versions = await invoke<
          {
            version: string
            tag_name: string
            published_at: string
            prerelease: boolean
          }[]
        >('get_available_glab_versions')

        return versions.map(v => ({
          version: v.version,
          tagName: v.tag_name,
          publishedAt: v.published_at,
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch glab CLI versions', { error })
        throw error
      }
    },
    staleTime: 1000 * 60 * 15, // 15 minutes
    gcTime: 1000 * 60 * 30, // 30 minutes
    refetchInterval: 1000 * 60 * 60, // Re-check every hour
  })
}

/**
 * Hook to install GitLab CLI
 */
export function useInstallGlabCli() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (version?: string) => {
      if (!isTauri()) {
        throw new Error('Cannot install glab CLI outside Tauri context')
      }

      logger.info('Installing GitLab CLI', { version })
      await invoke('install_glab_cli', { version: version ?? null })
    },
    // Disable retry - installation should not be retried automatically
    retry: false,
    onSuccess: () => {
      // Invalidate status to refetch
      queryClient.invalidateQueries({ queryKey: glabCliQueryKeys.status() })
      logger.info('GitLab CLI installed successfully')
      toast.success('GitLab CLI installed successfully')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to install GitLab CLI', { error })
      toast.error('Failed to install GitLab CLI', { description: message })
    },
  })
}

/**
 * Hook to listen for installation progress events
 * Returns [progress, resetProgress] tuple to allow resetting state before new install
 */
export function useGlabInstallProgress(): [GlabInstallProgress | null, () => void] {
  const [progress, setProgress] = useState<GlabInstallProgress | null>(null)

  const resetProgress = useCallback(() => {
    setProgress(null)
  }, [])

  useEffect(() => {
    if (!isTauri()) return

    let unlistenFn: (() => void) | null = null
    const listenerId = Math.random().toString(36).substring(7)

    const setupListener = async () => {
      try {
        logger.info('[useGlabInstallProgress] Setting up listener', { listenerId })
        unlistenFn = await listen<GlabInstallProgress>(
          'glab-cli:install-progress',
          event => {
            logger.info('[useGlabInstallProgress] Received progress event', {
              listenerId,
              stage: event.payload.stage,
              message: event.payload.message,
              percent: event.payload.percent,
            })
            setProgress(event.payload)
          }
        )
      } catch (error) {
        logger.error('[useGlabInstallProgress] Failed to setup listener', { listenerId, error })
      }
    }

    setupListener()

    return () => {
      logger.info('[useGlabInstallProgress] Cleaning up listener', { listenerId })
      if (unlistenFn) {
        unlistenFn()
      }
    }
  }, [])

  return [progress, resetProgress]
}

/**
 * Combined hook for glab CLI setup flow
 */
export function useGlabCliSetup() {
  const status = useGlabCliStatus()
  const versions = useAvailableGlabVersions()
  const installMutation = useInstallGlabCli()
  const [progress, resetProgress] = useGlabInstallProgress()

  const needsSetup = !status.isLoading && !status.data?.installed

  // Wrapper to support install with options (e.g., onSuccess callback)
  const install = (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => {
    logger.info('[useGlabCliSetup] install() called', {
      version,
      isPending: installMutation.isPending,
    })

    // Reset progress before starting new installation to prevent stale state
    resetProgress()

    logger.info('[useGlabCliSetup] Calling installMutation.mutate()', { version })
    installMutation.mutate(version, {
      onSuccess: () => {
        logger.info('[useGlabCliSetup] mutate onSuccess callback')
        options?.onSuccess?.()
      },
      onError: error => {
        logger.error('[useGlabCliSetup] mutate onError callback', { error })
        options?.onError?.(error)
      },
    })
  }

  return {
    status: status.data,
    isStatusLoading: status.isLoading,
    versions: versions.data ?? [],
    isVersionsLoading: versions.isLoading,
    needsSetup,
    isInstalling: installMutation.isPending,
    installError: installMutation.error,
    progress,
    install,
    refetchStatus: status.refetch,
  }
}
