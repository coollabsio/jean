/**
 * GitLab CLI management service
 *
 * Provides TanStack Query hooks for checking, installing, and managing
 * the embedded GitLab CLI (glab) binary. Mirrors `gh-cli.ts`.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke, useWsConnectionStatus } from '@/lib/transport'
import { listen } from '@/lib/transport'
import { toast } from 'sonner'
import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import type {
  GlabCliStatus,
  GlabAuthStatus,
  GlabReleaseInfo,
  GlabInstallProgress,
} from '@/types/glab-cli'

import { hasBackendTransport } from '@/lib/environment'

const isTauri = hasBackendTransport

/**
 * Check if an error is a GitLab CLI authentication or installation error
 * (mirrors `isGhAuthError`). The Rust side maps 401/auth failures to a message
 * asking the user to run `glab auth login`.
 */
export function isGlabAuthError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  return (
    lower.includes('gitlab cli not authenticated') ||
    lower.includes('glab auth login') ||
    lower.includes('requires authentication') ||
    lower.includes('authentication required') ||
    lower.includes('invalid token') ||
    lower.includes('the system cannot find the file specified')
  )
}

// Query keys for GitLab CLI
export const glabCliQueryKeys = {
  all: ['glab-cli'] as const,
  status: () => [...glabCliQueryKeys.all, 'status'] as const,
  auth: () => [...glabCliQueryKeys.all, 'auth'] as const,
  versions: () => [...glabCliQueryKeys.all, 'versions'] as const,
}

/**
 * Hook to detect GitLab CLI in system PATH
 */
export function useGlabPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...glabCliQueryKeys.all, 'path-detection'],
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
        return await invoke<{
          found: boolean
          path: string | null
          version: string | null
          package_manager: string | null
        }>('detect_glab_in_path')
      } catch (err) {
        logger.debug('glab path detection failed', { err })
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
 * Hook to check if GitLab CLI is installed and get its status
 */
export function useGlabCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: glabCliQueryKeys.status(),
    queryFn: async (): Promise<GlabCliStatus> => {
      if (!isTauri()) {
        return { installed: false, version: null, path: null }
      }

      try {
        return await invoke<GlabCliStatus>('check_glab_cli_installed')
      } catch (error) {
        logger.error('Failed to check GitLab CLI status', { error })
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
 * Hook to check if GitLab CLI is authenticated
 */
export function useGlabCliAuth(options?: {
  enabled?: boolean
  staleTime?: number
  gcTime?: number
  refetchOnMount?: boolean | 'always'
}) {
  return useQuery({
    queryKey: glabCliQueryKeys.auth(),
    queryFn: async (): Promise<GlabAuthStatus> => {
      if (!isTauri()) {
        return { authenticated: false, error: 'Not in Tauri context' }
      }

      try {
        return await invoke<GlabAuthStatus>('check_glab_cli_auth')
      } catch (error) {
        logger.error('Failed to check GitLab CLI auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: options?.staleTime ?? 1000 * 60 * 5, // 5 minutes
    gcTime: options?.gcTime ?? 1000 * 60 * 10, // 10 minutes
    refetchOnMount: options?.refetchOnMount,
  })
}

/**
 * Hook to fetch available GitLab CLI versions from GitLab releases
 */
export function useAvailableGlabVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: glabCliQueryKeys.versions(),
    queryFn: async (): Promise<GlabReleaseInfo[]> => {
      if (!isTauri()) {
        return []
      }

      try {
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
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15, // Cache for 15 minutes
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
      logger.info('Installing GitLab CLI', { version })
      await invoke('install_glab_cli', { version: version ?? null })
    },
    // Disable retry - installation should not be retried automatically
    retry: false,
    onSuccess: () => {
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
 * Hook to listen for installation progress events.
 * Returns [progress, resetProgress] tuple to allow resetting state before new install.
 */
export function useGlabInstallProgress(): [
  GlabInstallProgress | null,
  () => void,
] {
  const [progress, setProgress] = useState<GlabInstallProgress | null>(null)
  const wsConnected = useWsConnectionStatus()

  const resetProgress = useCallback(() => {
    setProgress(null)
  }, [])

  useEffect(() => {
    if (!isTauri()) return

    let unlistenFn: (() => void) | null = null

    const setupListener = async () => {
      try {
        unlistenFn = await listen<GlabInstallProgress>(
          'glab-cli:install-progress',
          event => {
            setProgress(event.payload)
          }
        )
      } catch (error) {
        logger.error('[useGlabInstallProgress] Failed to setup listener', {
          error,
        })
      }
    }

    setupListener()

    return () => {
      if (unlistenFn) {
        unlistenFn()
      }
    }
  }, [wsConnected])

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

  const checkManualVersion = (version: string) =>
    invoke<boolean>('check_glab_cli_version_exists', { version })

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
    checkManualVersion,
    refetchStatus: status.refetch,
  }
}
