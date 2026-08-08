/**
 * Devin CLI management service.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'
import { hasBackendTransport } from '@/lib/environment'
import type {
  DevinAuthStatus,
  DevinCliStatus,
  DevinInstallCommand,
  DevinModelInfo,
  DevinReleaseInfo,
} from '@/types/devin-cli'

const isTauri = hasBackendTransport

export const devinCliQueryKeys = {
  all: ['devin-cli'] as const,
  status: () => [...devinCliQueryKeys.all, 'status'] as const,
  auth: () => [...devinCliQueryKeys.all, 'auth'] as const,
  models: () => [...devinCliQueryKeys.all, 'models'] as const,
  versions: () => [...devinCliQueryKeys.all, 'versions'] as const,
  installCommand: () => [...devinCliQueryKeys.all, 'install-command'] as const,
}

const fallbackDevinVersions: DevinReleaseInfo[] = [
  { version: 'latest', tagName: 'latest', publishedAt: '', prerelease: false },
]

export function useDevinPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...devinCliQueryKeys.all, 'path-detection'],
    queryFn: async (): Promise<{
      found: boolean
      path: string | null
      version: string | null
      packageManager: string | null
    }> => {
      if (!isTauri()) {
        return { found: false, path: null, version: null, packageManager: null }
      }
      try {
        return await invoke('detect_devin_in_path')
      } catch (error) {
        logger.debug('Devin path detection failed', { error })
        return { found: false, path: null, version: null, packageManager: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useDevinCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: devinCliQueryKeys.status(),
    queryFn: async (): Promise<DevinCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invoke<DevinCliStatus>('check_devin_cli_installed')
      } catch (error) {
        logger.error('Failed to check Devin CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useDevinCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: devinCliQueryKeys.auth(),
    queryFn: async (): Promise<DevinAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          timedOut: false,
        }
      }
      try {
        return await invoke<DevinAuthStatus>('check_devin_cli_auth')
      } catch (error) {
        logger.error('Failed to check Devin CLI auth', { error })
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

export function useAvailableDevinModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: devinCliQueryKeys.models(),
    queryFn: async (): Promise<DevinModelInfo[]> => {
      if (!isTauri()) {
        return [{ id: 'default', label: 'Configured default', isDefault: true }]
      }
      try {
        const models = await invoke<DevinModelInfo[]>('list_devin_models')
        return models.length
          ? models
          : [{ id: 'default', label: 'Configured default', isDefault: true }]
      } catch (error) {
        logger.error('Failed to list Devin models', { error })
        return [{ id: 'default', label: 'Configured default', isDefault: true }]
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useAvailableDevinVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: devinCliQueryKeys.versions(),
    queryFn: async (): Promise<DevinReleaseInfo[]> => {
      if (!isTauri()) return fallbackDevinVersions
      try {
        const versions = await invoke<
          (DevinReleaseInfo & {
            tag_name?: string
            published_at?: string
          })[]
        >('get_available_devin_versions')
        return versions.map(v => ({
          version: v.version,
          tagName: v.tagName ?? v.tag_name ?? v.version,
          publishedAt: v.publishedAt ?? v.published_at ?? '',
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch Devin CLI versions', { error })
        return fallbackDevinVersions
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useInstallDevinCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version?: string) => {
      await invoke('install_devin_cli', { version: version ?? null })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: devinCliQueryKeys.all })
      toast.success('Devin CLI installed successfully')
    },
    onError: error => {
      logger.error('Failed to install Devin CLI', { error })
      toast.error('Failed to install Devin CLI', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useDevinCliSetup() {
  const status = useDevinCliStatus()
  const versions = useAvailableDevinVersions()
  const installMutation = useInstallDevinCli()

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
    invoke<boolean>('check_devin_cli_version_exists', { version })

  return {
    status: status.data,
    isStatusLoading: status.isLoading,
    versions: versions.data?.length ? versions.data : fallbackDevinVersions,
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

export async function getDevinInstallCommand(): Promise<DevinInstallCommand> {
  return invoke<DevinInstallCommand>('get_devin_install_command')
}
