/**
 * GitLab CLI (`glab`) management service
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
  ForgeKind,
} from '@/types/glab-cli'
import { hasBackendTransport } from '@/lib/environment'

const isTauri = hasBackendTransport

export const glabCliQueryKeys = {
  all: ['glab-cli'] as const,
  status: () => [...glabCliQueryKeys.all, 'status'] as const,
  auth: () => [...glabCliQueryKeys.all, 'auth'] as const,
  versions: () => [...glabCliQueryKeys.all, 'versions'] as const,
  forge: (path: string) => [...glabCliQueryKeys.all, 'forge', path] as const,
}

export function useGlabPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...glabCliQueryKeys.all, 'path-detection'],
    queryFn: async () => {
      if (!isTauri()) {
        return { found: false, path: null, version: null, package_manager: null }
      }
      try {
        return await invoke<{
          found: boolean
          path: string | null
          version: string | null
          package_manager: string | null
        }>('detect_glab_in_path')
      } catch {
        return { found: false, path: null, version: null, package_manager: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
  })
}

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
    staleTime: 1000 * 60 * 5,
  })
}

export function useGlabCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: glabCliQueryKeys.auth(),
    queryFn: async (): Promise<GlabAuthStatus> => {
      if (!isTauri()) {
        return { authenticated: false, error: 'Not in Tauri context' }
      }
      try {
        return await invoke<GlabAuthStatus>('check_glab_cli_auth')
      } catch (error) {
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
  })
}

export function useAvailableGlabVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: glabCliQueryKeys.versions(),
    queryFn: async (): Promise<GlabReleaseInfo[]> => {
      if (!isTauri()) return []
      return invoke<GlabReleaseInfo[]>('get_available_glab_versions')
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
  })
}

export function useProjectForge(
  projectPath: string | null | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: glabCliQueryKeys.forge(projectPath ?? ''),
    queryFn: async (): Promise<ForgeKind> => {
      if (!isTauri() || !projectPath) return 'unknown'
      try {
        return await invoke<ForgeKind>('detect_project_forge', {
          projectPath,
        })
      } catch {
        return 'unknown'
      }
    },
    enabled: (options?.enabled ?? true) && !!projectPath,
    staleTime: 1000 * 60 * 10,
  })
}

export function useGlabCliSetup() {
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<GlabInstallProgress | null>(null)
  const { data: status, isLoading: isStatusLoading, refetch: refetchStatus } =
    useGlabCliStatus()
  const {
    data: versions = [],
    isLoading: isVersionsLoading,
    isError: isVersionsError,
    refetch: refetchVersions,
  } = useAvailableGlabVersions()

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    listen<GlabInstallProgress>('glab-cli:install-progress', event => {
      setProgress(event.payload)
    }).then(fn => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [])

  const installMutation = useMutation({
    mutationFn: async (version?: string) => {
      setProgress({ stage: 'starting', message: 'Starting…', percent: 0 })
      await invoke('install_glab_cli', { version: version ?? null })
    },
    onSuccess: async () => {
      toast.success('GitLab CLI installed')
      await queryClient.invalidateQueries({ queryKey: glabCliQueryKeys.all })
      setProgress(null)
    },
    onError: (error: unknown) => {
      toast.error(
        `GitLab CLI install failed: ${error instanceof Error ? error.message : String(error)}`
      )
      setProgress(null)
    },
  })

  const install = useCallback(
    (
      version?: string,
      options?: { onSuccess?: () => void; onError?: (e: unknown) => void }
    ) => {
      installMutation.mutate(version, {
        onSuccess: () => options?.onSuccess?.(),
        onError: e => options?.onError?.(e),
      })
    },
    [installMutation]
  )

  return {
    status,
    isStatusLoading,
    versions,
    isVersionsLoading,
    isVersionsError,
    refetchVersions,
    isInstalling: installMutation.isPending,
    installError: installMutation.error,
    progress,
    install,
    refetchStatus,
  }
}

// Keep connection type imported for parity with other CLI services
void useWsConnectionStatus
