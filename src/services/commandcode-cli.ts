/** Command Code CLI management service. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  CommandCodeAuthStatus,
  CommandCodeCliStatus,
  CommandCodeInstallCommand,
  CommandCodeInstallProgress,
  CommandCodePathDetection,
  CommandCodeModelInfo,
  CommandCodeReleaseInfo,
} from '@/types/commandcode-cli'
import { hasBackendTransport } from '@/lib/environment'

const isTauri = hasBackendTransport

export const commandcodeCliQueryKeys = {
  all: ['commandcode-cli'] as const,
  status: () => [...commandcodeCliQueryKeys.all, 'status'] as const,
  auth: () => [...commandcodeCliQueryKeys.all, 'auth'] as const,
  models: () => [...commandcodeCliQueryKeys.all, 'models'] as const,
  versions: () => [...commandcodeCliQueryKeys.all, 'versions'] as const,
  installCommand: () =>
    [...commandcodeCliQueryKeys.all, 'install-command'] as const,
}

export function useCommandCodePathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...commandcodeCliQueryKeys.all, 'path-detection'],
    queryFn: async (): Promise<CommandCodePathDetection> => {
      if (!isTauri()) {
        return {
          found: false,
          path: null,
          version: null,
          packageManager: null,
        }
      }
      try {
        return await invoke<CommandCodePathDetection>(
          'detect_commandcode_in_path'
        )
      } catch (error) {
        logger.debug('Command Code path detection failed', { error })
        return {
          found: false,
          path: null,
          version: null,
          packageManager: null,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useCommandCodeCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: commandcodeCliQueryKeys.status(),
    queryFn: async (): Promise<CommandCodeCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invoke<CommandCodeCliStatus>(
          'check_commandcode_cli_installed'
        )
      } catch (error) {
        logger.error('Failed to check Command Code CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useCommandCodeCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: commandcodeCliQueryKeys.auth(),
    queryFn: async (): Promise<CommandCodeAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          timedOut: false,
        }
      }
      try {
        return await invoke<CommandCodeAuthStatus>('check_commandcode_cli_auth')
      } catch (error) {
        logger.error('Failed to check Command Code CLI auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
          timedOut: false,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useAvailableCommandCodeModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: commandcodeCliQueryKeys.models(),
    queryFn: async (): Promise<CommandCodeModelInfo[]> => {
      if (!isTauri()) return []
      try {
        return await invoke<CommandCodeModelInfo[]>('list_commandcode_models')
      } catch (error) {
        logger.error('Failed to list Command Code models', { error })
        return []
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

export function useAvailableCommandCodeVersions(options?: {
  enabled?: boolean
}) {
  return useQuery({
    queryKey: commandcodeCliQueryKeys.versions(),
    queryFn: async (): Promise<CommandCodeReleaseInfo[]> => {
      if (!isTauri()) return []
      try {
        const versions = await invoke<
          {
            version: string
            tag_name: string
            published_at: string
            prerelease: boolean
          }[]
        >('get_available_commandcode_versions')
        return versions.map(v => ({
          version: v.version,
          tagName: v.tag_name,
          publishedAt: v.published_at,
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch Command Code CLI versions', { error })
        return []
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useInstallCommandCodeCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version?: string) => {
      await invoke('install_commandcode_cli', { version: version ?? null })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: commandcodeCliQueryKeys.all })
      toast.success('Command Code CLI installed successfully')
    },
    onError: error => {
      logger.error('Failed to install Command Code CLI', { error })
      toast.error('Failed to install Command Code CLI', {
        description: String(error),
      })
    },
  })
}

export function useCommandCodeInstallProgress(): [
  CommandCodeInstallProgress | null,
  () => void,
] {
  const [progress, setProgress] = useState<CommandCodeInstallProgress | null>(
    null
  )
  const resetProgress = useCallback(() => setProgress(null), [])
  return [progress, resetProgress]
}

export function useCommandCodeCliSetup() {
  const status = useCommandCodeCliStatus()
  const versions = useAvailableCommandCodeVersions()
  const installMutation = useInstallCommandCodeCli()
  const [progress, resetProgress] = useCommandCodeInstallProgress()

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
    invoke<boolean>('check_commandcode_cli_version_exists', { version })

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
    checkManualVersion,
    refetchStatus: status.refetch,
  }
}

export async function getCommandCodeInstallCommand(): Promise<CommandCodeInstallCommand> {
  return invoke<CommandCodeInstallCommand>('get_commandcode_install_command')
}
