/**
 * Kimi Code CLI management service.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'
import { hasBackendTransport } from '@/lib/environment'
import type {
  KimiAuthStatus,
  KimiCliStatus,
  KimiInstallCommand,
  KimiModelInfo,
  KimiReleaseInfo,
} from '@/types/kimi-cli'

const isTauri = hasBackendTransport

export const kimiCliQueryKeys = {
  all: ['kimi-cli'] as const,
  status: () => [...kimiCliQueryKeys.all, 'status'] as const,
  auth: () => [...kimiCliQueryKeys.all, 'auth'] as const,
  models: () => [...kimiCliQueryKeys.all, 'models'] as const,
  versions: () => [...kimiCliQueryKeys.all, 'versions'] as const,
  installCommand: () => [...kimiCliQueryKeys.all, 'install-command'] as const,
}

const fallbackKimiVersions: KimiReleaseInfo[] = [
  { version: 'latest', tagName: 'latest', publishedAt: '', prerelease: false },
]

export function useKimiPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...kimiCliQueryKeys.all, 'path-detection'],
    queryFn: async (): Promise<{
      found: boolean
      path: string | null
      version: string | null
      packageManager: string | null
    }> => {
      if (!isTauri()) {
        return {
          found: false,
          path: null,
          version: null,
          packageManager: null,
        }
      }
      try {
        return await invoke('detect_kimi_in_path')
      } catch (error) {
        logger.debug('Kimi path detection failed', { error })
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

export function useKimiCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: kimiCliQueryKeys.status(),
    queryFn: async (): Promise<KimiCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invoke<KimiCliStatus>('check_kimi_cli_installed')
      } catch (error) {
        logger.error('Failed to check Kimi CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useKimiCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: kimiCliQueryKeys.auth(),
    queryFn: async (): Promise<KimiAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          timedOut: false,
        }
      }
      try {
        return await invoke<KimiAuthStatus>('check_kimi_cli_auth')
      } catch (error) {
        logger.error('Failed to check Kimi CLI auth', { error })
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

export function useAvailableKimiModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: kimiCliQueryKeys.models(),
    queryFn: async (): Promise<KimiModelInfo[]> => {
      if (!isTauri()) {
        return [{ id: 'default', label: 'Configured default', isDefault: true }]
      }
      try {
        const models = await invoke<KimiModelInfo[]>('list_kimi_models')
        return models.length
          ? models
          : [{ id: 'default', label: 'Configured default', isDefault: true }]
      } catch (error) {
        logger.error('Failed to list Kimi models', { error })
        return [{ id: 'default', label: 'Configured default', isDefault: true }]
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useAvailableKimiVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: kimiCliQueryKeys.versions(),
    queryFn: async (): Promise<KimiReleaseInfo[]> => {
      if (!isTauri()) return fallbackKimiVersions
      try {
        const versions = await invoke<
          {
            version: string
            tag_name: string
            published_at: string
            prerelease: boolean
          }[]
        >('get_available_kimi_versions')
        return versions.map(v => ({
          version: v.version,
          tagName: v.tag_name,
          publishedAt: v.published_at,
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch Kimi CLI versions', { error })
        return fallbackKimiVersions
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useInstallKimiCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version?: string) => {
      await invoke('install_kimi_cli', { version: version ?? null })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: kimiCliQueryKeys.all })
      toast.success('Kimi CLI installed successfully')
    },
    onError: error => {
      logger.error('Failed to install Kimi CLI', { error })
      toast.error('Failed to install Kimi CLI', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useKimiCliSetup() {
  const status = useKimiCliStatus()
  const versions = useAvailableKimiVersions()
  const installMutation = useInstallKimiCli()

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
    invoke<boolean>('check_kimi_cli_version_exists', { version })

  return {
    status: status.data,
    isStatusLoading: status.isLoading,
    versions: versions.data?.length ? versions.data : fallbackKimiVersions,
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

export async function getKimiInstallCommand(): Promise<KimiInstallCommand> {
  return invoke<KimiInstallCommand>('get_kimi_install_command')
}
