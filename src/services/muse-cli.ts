/** Muse Code CLI management service. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invokeForOptionalServer } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'
import { hasBackendTransport } from '@/lib/environment'
import { useOptionalSettingsTargetServerId } from '@/lib/settings-target'
import type {
  MuseAuthStatus,
  MuseCliStatus,
  MuseInstallCommand,
  MuseModelInfo,
  MusePathDetection,
} from '@/types/muse-cli'

const isTauri = hasBackendTransport

export const museCliQueryKeys = {
  all: ['muse-cli'] as const,
  status: () => [...museCliQueryKeys.all, 'status'] as const,
  auth: () => [...museCliQueryKeys.all, 'auth'] as const,
  models: () => [...museCliQueryKeys.all, 'models'] as const,
  pathDetection: () => [...museCliQueryKeys.all, 'path-detection'] as const,
}

export const MUSE_FALLBACK_MODELS: MuseModelInfo[] = [
  { id: 'muse/default', label: 'Default', isDefault: true },
  { id: 'muse/muse-spark-1.2', label: 'Muse Spark 1.2' },
]

/** The Muse installer script always installs the latest release. */
const MUSE_LATEST_VERSION = {
  version: 'latest',
  tagName: 'latest',
  publishedAt: '',
  prerelease: false,
}

const NOT_FOUND: MusePathDetection = {
  found: false,
  path: null,
  version: null,
  packageManager: null,
}

/** Normalize a backend model id to Jean's `muse/<model>` value. */
export function toMuseModelValue(id: string): string {
  return id.startsWith('muse/') ? id : `muse/${id}`
}

/** Merge backend rows into the fallback list, keyed by Jean model value. */
export function mergeMuseModels(models: MuseModelInfo[]): MuseModelInfo[] {
  const merged = new Map(MUSE_FALLBACK_MODELS.map(model => [model.id, model]))
  for (const model of models) {
    const id = toMuseModelValue(model.id)
    merged.set(id, { ...model, id })
  }
  return [...merged.values()]
}

export function useMusePathDetection(options?: { enabled?: boolean }) {
  const serverId = useOptionalSettingsTargetServerId()
  return useQuery({
    queryKey: [...museCliQueryKeys.pathDetection(), serverId ?? 'local'],
    queryFn: async (): Promise<MusePathDetection> => {
      if (!isTauri()) return NOT_FOUND
      try {
        return await invokeForOptionalServer<MusePathDetection>(
          serverId,
          'detect_muse_in_path'
        )
      } catch (error) {
        logger.debug('Muse path detection failed', { error })
        return NOT_FOUND
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useMuseCliStatus(options?: {
  enabled?: boolean
  serverId?: string
}) {
  const settingsServerId = useOptionalSettingsTargetServerId()
  const serverId = options?.serverId ?? settingsServerId
  return useQuery({
    queryKey: [...museCliQueryKeys.status(), serverId ?? 'local'],
    queryFn: async (): Promise<MuseCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invokeForOptionalServer<MuseCliStatus>(
          serverId,
          'check_muse_cli_installed'
        )
      } catch (error) {
        logger.error('Failed to check Muse CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 60,
  })
}

export function useMuseCliAuth(options?: { enabled?: boolean }) {
  const serverId = useOptionalSettingsTargetServerId()
  return useQuery({
    queryKey: [...museCliQueryKeys.auth(), serverId ?? 'local'],
    queryFn: async (): Promise<MuseAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          timedOut: false,
        }
      }
      try {
        return await invokeForOptionalServer<MuseAuthStatus>(
          serverId,
          'check_muse_cli_auth'
        )
      } catch (error) {
        logger.error('Failed to check Muse CLI auth', { error })
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

export function useAvailableMuseModels(options?: {
  enabled?: boolean
  serverId?: string
}) {
  const settingsServerId = useOptionalSettingsTargetServerId()
  const serverId = options?.serverId ?? settingsServerId
  return useQuery({
    queryKey: [...museCliQueryKeys.models(), serverId ?? 'local'],
    queryFn: async (): Promise<MuseModelInfo[]> => {
      if (!isTauri()) return MUSE_FALLBACK_MODELS
      try {
        const models = await invokeForOptionalServer<MuseModelInfo[]>(
          serverId,
          'list_muse_models'
        )
        return mergeMuseModels(models)
      } catch (error) {
        logger.error('Failed to list Muse models', { error })
        return MUSE_FALLBACK_MODELS
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
  })
}

export function useInstallMuseCli() {
  const queryClient = useQueryClient()
  const serverId = useOptionalSettingsTargetServerId()
  return useMutation({
    mutationFn: async (version?: string) => {
      await invokeForOptionalServer(serverId, 'install_muse_cli', {
        version: version && version !== 'latest' ? version : null,
      })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: museCliQueryKeys.all })
      toast.success('Muse CLI installed successfully')
    },
    onError: error => {
      logger.error('Failed to install Muse CLI', { error })
      toast.error('Failed to install Muse CLI', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useUpdateMuseCli() {
  const queryClient = useQueryClient()
  const serverId = useOptionalSettingsTargetServerId()
  return useMutation({
    mutationFn: () =>
      invokeForOptionalServer<null>(serverId, 'update_muse_cli'),
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: museCliQueryKeys.all })
      toast.success('Muse CLI updated')
    },
    onError: error => {
      logger.error('Failed to update Muse CLI', { error })
      toast.error('Failed to update Muse CLI', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useUninstallMuseCli() {
  const queryClient = useQueryClient()
  const serverId = useOptionalSettingsTargetServerId()
  return useMutation({
    mutationFn: () =>
      invokeForOptionalServer<null>(serverId, 'uninstall_muse_cli'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: museCliQueryKeys.all })
      toast.success('Jean-managed Muse CLI removed')
    },
    onError: error => {
      toast.error('Failed to remove Muse CLI', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useMuseCliSetup() {
  const status = useMuseCliStatus()
  const installMutation = useInstallMuseCli()

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
    versions: [MUSE_LATEST_VERSION],
    isVersionsLoading: false,
    isVersionsError: false,
    refetchVersions: async () => ({ data: [MUSE_LATEST_VERSION] }),
    needsSetup: !status.isLoading && !status.data?.installed,
    isInstalling: installMutation.isPending,
    installError: installMutation.error,
    progress: null,
    install,
    refetchStatus: status.refetch,
  }
}

export async function getMuseInstallCommand(
  serverId?: string
): Promise<MuseInstallCommand> {
  return invokeForOptionalServer<MuseInstallCommand>(
    serverId,
    'get_muse_install_command'
  )
}
