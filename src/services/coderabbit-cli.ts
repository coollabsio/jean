/** CodeRabbit CLI management service. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { hasBackendTransport } from '@/lib/environment'
import { invoke, listen, useWsConnectionStatus } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  CodeRabbitAuthStatus,
  CodeRabbitCliStatus,
  CodeRabbitInstallProgress,
  CodeRabbitPathDetection,
  CodeRabbitReleaseInfo,
} from '@/types/coderabbit-cli'

const isTauri = hasBackendTransport

export const coderabbitCliQueryKeys = {
  all: ['coderabbit-cli'] as const,
  status: () => [...coderabbitCliQueryKeys.all, 'status'] as const,
  auth: () => [...coderabbitCliQueryKeys.all, 'auth'] as const,
  versions: () => [...coderabbitCliQueryKeys.all, 'versions'] as const,
  pathDetection: () =>
    [...coderabbitCliQueryKeys.all, 'path-detection'] as const,
}

export function useCodeRabbitPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: coderabbitCliQueryKeys.pathDetection(),
    queryFn: async (): Promise<CodeRabbitPathDetection> => {
      if (!isTauri()) {
        return {
          found: false,
          path: null,
          version: null,
          package_manager: null,
        }
      }
      try {
        return invoke<CodeRabbitPathDetection>('detect_coderabbit_in_path')
      } catch (error) {
        logger.debug('CodeRabbit PATH detection failed', { error })
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

export function useCodeRabbitCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: coderabbitCliQueryKeys.status(),
    queryFn: async (): Promise<CodeRabbitCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return invoke<CodeRabbitCliStatus>('check_coderabbit_cli_installed')
      } catch (error) {
        logger.error('Failed to check CodeRabbit CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useCodeRabbitCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: coderabbitCliQueryKeys.auth(),
    queryFn: async (): Promise<CodeRabbitAuthStatus> => {
      if (!isTauri())
        return { authenticated: false, error: 'Not in Tauri context' }
      try {
        return invoke<CodeRabbitAuthStatus>('check_coderabbit_cli_auth')
      } catch (error) {
        logger.error('Failed to check CodeRabbit CLI auth', { error })
        return { authenticated: false, error: String(error) }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useAvailableCodeRabbitVersions(options?: {
  enabled?: boolean
}) {
  return useQuery({
    queryKey: coderabbitCliQueryKeys.versions(),
    queryFn: async (): Promise<CodeRabbitReleaseInfo[]> => {
      if (!isTauri()) return []
      try {
        const versions = await invoke<
          {
            version: string
            tag_name: string
            published_at: string
            prerelease: boolean
          }[]
        >('get_available_coderabbit_versions')
        return versions.map(v => ({
          version: v.version,
          tagName: v.tag_name,
          publishedAt: v.published_at,
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch CodeRabbit CLI versions', { error })
        return []
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useInstallCodeRabbitCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version?: string) => {
      await invoke('install_coderabbit_cli', { version: version ?? null })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: coderabbitCliQueryKeys.all })
      toast.success('CodeRabbit CLI installed successfully')
    },
    onError: error => {
      logger.error('Failed to install CodeRabbit CLI', { error })
      toast.error('Failed to install CodeRabbit CLI', {
        description: String(error),
      })
    },
  })
}

export function useUpdateCodeRabbitCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await invoke('update_coderabbit_cli')
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: coderabbitCliQueryKeys.all })
      toast.success('CodeRabbit CLI updated')
    },
    onError: error => {
      logger.error('Failed to update CodeRabbit CLI', { error })
      toast.error('Failed to update CodeRabbit CLI', {
        description: String(error),
      })
    },
  })
}

export function useCodeRabbitInstallProgress(): [
  CodeRabbitInstallProgress | null,
  () => void,
] {
  const [progress, setProgress] = useState<CodeRabbitInstallProgress | null>(
    null
  )
  const wsConnected = useWsConnectionStatus()
  const resetProgress = useCallback(() => setProgress(null), [])

  useEffect(() => {
    if (!isTauri()) return
    let unlistenFn: (() => void) | null = null
    const setup = async () => {
      unlistenFn = await listen<CodeRabbitInstallProgress>(
        'coderabbit-cli:install-progress',
        event => setProgress(event.payload)
      )
    }
    setup().catch(error =>
      logger.error('Failed to listen for CodeRabbit install progress', {
        error,
      })
    )
    return () => unlistenFn?.()
  }, [wsConnected])

  return [progress, resetProgress]
}

export function useCodeRabbitCliSetup() {
  const status = useCodeRabbitCliStatus()
  const versions = useAvailableCodeRabbitVersions()
  const installMutation = useInstallCodeRabbitCli()
  const [progress, resetProgress] = useCodeRabbitInstallProgress()

  const needsSetup = !status.isLoading && !status.data?.installed

  const install = (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => {
    logger.info('[useCodeRabbitCliSetup] install() called', {
      version,
      isPending: installMutation.isPending,
    })

    resetProgress()

    installMutation.mutate(version, {
      onSuccess: () => {
        logger.info('[useCodeRabbitCliSetup] mutate onSuccess callback')
        options?.onSuccess?.()
      },
      onError: error => {
        logger.error('[useCodeRabbitCliSetup] mutate onError callback', {
          error,
        })
        options?.onError?.(error)
      },
    })
  }

  const checkManualVersion = (version: string) =>
    invoke<boolean>('check_coderabbit_cli_version_exists', { version })

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
