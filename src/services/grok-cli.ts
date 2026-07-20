/**
 * Grok Build CLI management service.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'
import { hasBackendTransport } from '@/lib/environment'
import type {
  GrokAuthStatus,
  GrokCliStatus,
  GrokInstallCommand,
  GrokModelInfo,
  GrokReleaseInfo,
  GrokUsageSnapshot,
} from '@/types/grok-cli'

const isTauri = hasBackendTransport
const USAGE_REFRESH_MS = 1000 * 60 * 5

export const grokCliQueryKeys = {
  all: ['grok-cli'] as const,
  status: () => [...grokCliQueryKeys.all, 'status'] as const,
  auth: () => [...grokCliQueryKeys.all, 'auth'] as const,
  usage: () => [...grokCliQueryKeys.all, 'usage'] as const,
  models: () => [...grokCliQueryKeys.all, 'models'] as const,
  versions: () => [...grokCliQueryKeys.all, 'versions'] as const,
  installCommand: () => [...grokCliQueryKeys.all, 'install-command'] as const,
}

function getUsageStaleTime(snapshot?: GrokUsageSnapshot): number {
  if (!snapshot?.fetchedAt) return 0
  const expiresAtMs = snapshot.fetchedAt * 1000 + USAGE_REFRESH_MS
  return Math.max(0, expiresAtMs - Date.now())
}

function getUsageRefetchInterval(snapshot?: GrokUsageSnapshot): number {
  if (!snapshot?.fetchedAt) return USAGE_REFRESH_MS
  const expiresAtMs = snapshot.fetchedAt * 1000 + USAGE_REFRESH_MS
  return Math.max(1_000, expiresAtMs - Date.now())
}

const fallbackGrokVersions: GrokReleaseInfo[] = [
  { version: 'latest', tagName: 'latest', publishedAt: '', prerelease: false },
]

export function useGrokPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...grokCliQueryKeys.all, 'path-detection'],
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
        return await invoke('detect_grok_in_path')
      } catch (error) {
        logger.debug('Grok path detection failed', { error })
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

export function useGrokCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: grokCliQueryKeys.status(),
    queryFn: async (): Promise<GrokCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invoke<GrokCliStatus>('check_grok_cli_installed')
      } catch (error) {
        logger.error('Failed to check Grok CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useGrokCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: grokCliQueryKeys.auth(),
    queryFn: async (): Promise<GrokAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          timedOut: false,
        }
      }
      try {
        return await invoke<GrokAuthStatus>('check_grok_cli_auth')
      } catch (error) {
        logger.error('Failed to check Grok CLI auth', { error })
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

/**
 * Hook to fetch current Grok subscription / Build usage (OAuth accounts).
 */
export function useGrokUsage(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: grokCliQueryKeys.usage(),
    queryFn: async (): Promise<GrokUsageSnapshot> => {
      if (!isTauri()) {
        throw new Error('Grok usage is only available when connected to Jean')
      }
      return invoke<GrokUsageSnapshot>('get_grok_usage')
    },
    enabled: options?.enabled ?? true,
    staleTime: query => getUsageStaleTime(query.state.data),
    gcTime: 1000 * 60 * 10,
    refetchInterval: query => getUsageRefetchInterval(query.state.data),
  })
}

export function useAvailableGrokModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: grokCliQueryKeys.models(),
    queryFn: async (): Promise<GrokModelInfo[]> => {
      if (!isTauri()) {
        return [
          {
            id: 'grok-4.5',
            label: 'Grok 4.5',
            isDefault: true,
          },
        ]
      }
      try {
        return await invoke<GrokModelInfo[]>('list_grok_models')
      } catch (error) {
        logger.error('Failed to list Grok models', { error })
        return [
          {
            id: 'grok-4.5',
            label: 'Grok 4.5',
            isDefault: true,
          },
        ]
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useAvailableGrokVersions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: grokCliQueryKeys.versions(),
    queryFn: async (): Promise<GrokReleaseInfo[]> => {
      if (!isTauri()) return fallbackGrokVersions
      try {
        const versions = await invoke<
          {
            version: string
            tag_name: string
            published_at: string
            prerelease: boolean
          }[]
        >('get_available_grok_versions')
        return versions.map(v => ({
          version: v.version,
          tagName: v.tag_name,
          publishedAt: v.published_at,
          prerelease: v.prerelease,
        }))
      } catch (error) {
        logger.error('Failed to fetch Grok CLI versions', { error })
        return fallbackGrokVersions
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useInstallGrokCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version?: string) => {
      await invoke('install_grok_cli', { version: version ?? null })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: grokCliQueryKeys.all })
      toast.success('Grok CLI installed successfully')
    },
    onError: error => {
      logger.error('Failed to install Grok CLI', { error })
      toast.error('Failed to install Grok CLI', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useGrokCliSetup() {
  const status = useGrokCliStatus()
  const versions = useAvailableGrokVersions()
  const installMutation = useInstallGrokCli()

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
    invoke<boolean>('check_grok_cli_version_exists', { version })

  return {
    status: status.data,
    isStatusLoading: status.isLoading,
    versions: versions.data?.length ? versions.data : fallbackGrokVersions,
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

export async function getGrokInstallCommand(): Promise<GrokInstallCommand> {
  return invoke<GrokInstallCommand>('get_grok_install_command')
}
