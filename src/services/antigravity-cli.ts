/** Antigravity CLI management service. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'
import { hasBackendTransport } from '@/lib/environment'
import type {
  AntigravityAuthStatus,
  AntigravityCliStatus,
  AntigravityInstallCommand,
  AntigravityModelInfo,
  AntigravityReleaseInfo,
} from '@/types/antigravity-cli'

const isTauri = hasBackendTransport

export const antigravityCliQueryKeys = {
  all: ['antigravity-cli'] as const,
  status: () => [...antigravityCliQueryKeys.all, 'status'] as const,
  auth: () => [...antigravityCliQueryKeys.all, 'auth'] as const,
  models: () => [...antigravityCliQueryKeys.all, 'models'] as const,
  versions: () => [...antigravityCliQueryKeys.all, 'versions'] as const,
  installCommand: () => [...antigravityCliQueryKeys.all, 'install-command'] as const,
}

const fallbackAntigravityVersions: AntigravityReleaseInfo[] = [
  { version: 'latest', tagName: 'latest', publishedAt: '', prerelease: false },
]

export function useAntigravityPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...antigravityCliQueryKeys.all, 'path-detection'],
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
        return await invoke('detect_antigravity_in_path')
      } catch (error) {
        logger.debug('Antigravity path detection failed', { error })
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

export function useAntigravityCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: antigravityCliQueryKeys.status(),
    queryFn: async (): Promise<AntigravityCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invoke<AntigravityCliStatus>('check_antigravity_cli_installed')
      } catch (error) {
        logger.error('Failed to check Antigravity CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useAntigravityCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: antigravityCliQueryKeys.auth(),
    queryFn: async (): Promise<AntigravityAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          timedOut: false,
        }
      }
      try {
        return await invoke<AntigravityAuthStatus>('check_antigravity_cli_auth')
      } catch (error) {
        logger.error('Failed to check Antigravity CLI auth', { error })
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

export function useAvailableAntigravityModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: antigravityCliQueryKeys.models(),
    queryFn: async (): Promise<AntigravityModelInfo[]> => {
      if (!isTauri()) {
        return [{ id: 'default', label: 'Configured default', isDefault: true }]
      }
      try {
        const models = await invoke<AntigravityModelInfo[]>('list_antigravity_models')
        return models.length
          ? models
          : [{ id: 'default', label: 'Configured default', isDefault: true }]
      } catch (error) {
        logger.error('Failed to list Antigravity models', { error })
        return [{ id: 'default', label: 'Configured default', isDefault: true }]
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useAvailableAntigravityVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: antigravityCliQueryKeys.versions(),
    queryFn: async (): Promise<AntigravityReleaseInfo[]> => {
      if (!isTauri()) return fallbackAntigravityVersions
      try {
        const versions = await invoke<
          {
            version: string
            tag_name: string
            published_at: string
            prerelease: boolean
          }[]
        >('get_available_antigravity_versions')
        return versions.map(v => ({
          version: v.version,
          tagName: v.tag_name,
          publishedAt: v.published_at,
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch Antigravity CLI versions', { error })
        return fallbackAntigravityVersions
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useInstallAntigravityCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version?: string) => {
      await invoke('install_antigravity_cli', { version: version ?? null })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: antigravityCliQueryKeys.all })
      toast.success('Antigravity CLI installed successfully')
    },
    onError: error => {
      logger.error('Failed to install Antigravity CLI', { error })
      toast.error('Failed to install Antigravity CLI', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useUninstallAntigravityCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => invoke<null>('uninstall_antigravity_cli'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: antigravityCliQueryKeys.all })
      toast.success('Jean-managed Antigravity CLI removed')
    },
    onError: error => {
      toast.error('Failed to remove Antigravity CLI', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

function checkManualVersion(version: string) {
  return invoke<boolean>('check_antigravity_cli_version_exists', { version })
}

export function useAntigravityCliSetup() {
  const status = useAntigravityCliStatus()
  const versions = useAvailableAntigravityVersions()
  const installMutation = useInstallAntigravityCli()

  const install = (
    version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => {
    installMutation.mutate(version, {
      onSuccess: () => options?.onSuccess?.(),
      onError: error => options?.onError?.(error),
    })
  }
  return {
    status: status.data,
    isStatusLoading: status.isLoading,
    versions: versions.data?.length ? versions.data : fallbackAntigravityVersions,
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

export async function getAntigravityInstallCommand(): Promise<AntigravityInstallCommand> {
  return invoke<AntigravityInstallCommand>('get_antigravity_install_command')
}
