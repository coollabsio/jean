/**
 * Antigravity CLI management service.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'
import { hasBackend } from '@/lib/environment'
import type {
  AntigravityAuthStatus,
  AntigravityCliStatus,
  AntigravityModelInfo,
  AntigravityReleaseInfo,
} from '@/types/antigravity-cli'

const isTauri = hasBackend

export const antigravityCliQueryKeys = {
  all: ['antigravity-cli'] as const,
  status: () => [...antigravityCliQueryKeys.all, 'status'] as const,
  auth: () => [...antigravityCliQueryKeys.all, 'auth'] as const,
  models: () => [...antigravityCliQueryKeys.all, 'models'] as const,
  versions: () => [...antigravityCliQueryKeys.all, 'versions'] as const,
  installCommand: () => [...antigravityCliQueryKeys.all, 'install-command'] as const,
}

const fallbackAntigravityVersions: AntigravityReleaseInfo[] = [
  { version: '1.0.16', publishedAt: '2026-07-03T00:00:00Z', prerelease: false },
]

export function useAntigravityPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...antigravityCliQueryKeys.all, 'path-detection'],
    queryFn: async (): Promise<{
      found: boolean
      path: string | null
      version: string | null
    }> => {
      if (!isTauri()) return { found: false, path: null, version: null }
      try {
        const path = await invoke<string | null>('detect_antigravity_in_path')
        return { found: path !== null, path, version: null }
      } catch (error) {
        logger.debug('Antigravity path detection failed', { error })
        return { found: false, path: null, version: null }
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
        return [
          {
            id: 'Gemini 3.5 Flash (Low)',
            label: 'Gemini 3.5 Flash (Low)',
            isDefault: true,
          },
          {
            id: 'Claude Sonnet 4.6 (Thinking)',
            label: 'Claude Sonnet 4.6 (Thinking)',
            isDefault: false,
          },
        ]
      }
      try {
        return await invoke<AntigravityModelInfo[]>('list_antigravity_models')
      } catch (error) {
        logger.error('Failed to list Antigravity models', { error })
        return [
          {
            id: 'Gemini 3.5 Flash (Low)',
            label: 'Gemini 3.5 Flash (Low)',
            isDefault: true,
          },
          {
            id: 'Claude Sonnet 4.6 (Thinking)',
            label: 'Claude Sonnet 4.6 (Thinking)',
            isDefault: false,
          },
        ]
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
            published_at: string
          }[]
        >('get_available_antigravity_versions')
        return versions.map(v => ({
          version: v.version,
          publishedAt: v.published_at,
          prerelease: false,
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

  const checkManualVersion = (version: string) =>
    invoke<boolean>('check_antigravity_cli_version_exists', { version })

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
