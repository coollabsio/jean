/**
 * Hermes Agent install, gateway lifecycle, and jobs control plane.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'
import { hasBackendTransport } from '@/lib/environment'
import type {
  HermesAuthStatus,
  HermesCliStatus,
  HermesConnectionStatus,
  HermesCreateJobRequest,
  HermesJob,
  HermesJobOutput,
  HermesModelInfo,
  HermesScheduleFromWorktreeRequest,
  HermesUpdateJobRequest,
} from '@/types/hermes-cli'

const isTauri = hasBackendTransport

export const hermesCliQueryKeys = {
  all: ['hermes-cli'] as const,
  status: () => [...hermesCliQueryKeys.all, 'status'] as const,
  auth: () => [...hermesCliQueryKeys.all, 'auth'] as const,
  pathDetection: () => [...hermesCliQueryKeys.all, 'path-detection'] as const,
  connection: () => [...hermesCliQueryKeys.all, 'connection'] as const,
  models: () => [...hermesCliQueryKeys.all, 'models'] as const,
  jobs: (
    includeDisabled = false,
    projectId?: string | null,
    worktreeId?: string | null
  ) =>
    [
      ...hermesCliQueryKeys.all,
      'jobs',
      includeDisabled,
      projectId ?? '',
      worktreeId ?? '',
    ] as const,
  job: (jobId: string) => [...hermesCliQueryKeys.all, 'job', jobId] as const,
  jobOutput: (jobId: string) =>
    [...hermesCliQueryKeys.all, 'job-output', jobId] as const,
}

export function useHermesPathDetection(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: hermesCliQueryKeys.pathDetection(),
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
        const status = await invoke<HermesCliStatus>('detect_hermes_in_path')
        return {
          found: !!status.installed,
          path: status.path,
          version: status.version,
          package_manager: null,
        }
      } catch (error) {
        logger.debug('Hermes path detection failed', { error })
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

const disconnectedStatus = (): HermesConnectionStatus => ({
  cli: { installed: false, version: null, path: null },
  apiReachable: false,
  apiAuthenticated: false,
  baseUrl: 'http://127.0.0.1:8642',
  profile: '',
  model: null,
  error: 'Not in Tauri context',
})

export function useHermesCliStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: hermesCliQueryKeys.status(),
    queryFn: async (): Promise<HermesCliStatus> => {
      if (!isTauri()) return { installed: false, version: null, path: null }
      try {
        return await invoke<HermesCliStatus>('check_hermes_cli_installed')
      } catch (error) {
        logger.error('Failed to check Hermes CLI status', { error })
        return { installed: false, version: null, path: null }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60 * 30,
  })
}

export function useHermesCliAuth(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: hermesCliQueryKeys.auth(),
    queryFn: async (): Promise<HermesAuthStatus> => {
      if (!isTauri()) {
        return {
          authenticated: false,
          error: 'Not in Tauri context',
          gatewayRunning: false,
        }
      }
      try {
        return await invoke<HermesAuthStatus>('check_hermes_cli_auth')
      } catch (error) {
        logger.error('Failed to check Hermes auth', { error })
        return {
          authenticated: false,
          error: error instanceof Error ? error.message : String(error),
          gatewayRunning: false,
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 10,
  })
}

export function useAvailableHermesModels(options?: {
  enabled?: boolean
  refresh?: boolean
}) {
  return useQuery({
    queryKey: [...hermesCliQueryKeys.models(), options?.refresh ?? false],
    queryFn: async (): Promise<HermesModelInfo[]> => {
      if (!isTauri()) {
        return [
          {
            id: 'hermes-agent',
            label: 'Hermes Agent (gateway default)',
            provider: '',
            model: 'hermes-agent',
            isDefault: true,
          },
        ]
      }
      try {
        return await invoke<HermesModelInfo[]>('list_hermes_models', {
          refresh: options?.refresh ?? false,
        })
      } catch (error) {
        logger.error('Failed to list Hermes models', { error })
        return [
          {
            id: 'hermes-agent',
            label: 'Hermes Agent (gateway default)',
            provider: '',
            model: 'hermes-agent',
            isDefault: true,
          },
        ]
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 15,
  })
}

export function useHermesStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: hermesCliQueryKeys.connection(),
    queryFn: async (): Promise<HermesConnectionStatus> => {
      if (!isTauri()) return disconnectedStatus()
      try {
        return await invoke<HermesConnectionStatus>('check_hermes_status')
      } catch (error) {
        logger.error('Failed to check Hermes status', { error })
        return {
          ...disconnectedStatus(),
          error: String(error),
        }
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 10,
    refetchInterval: 1000 * 60,
  })
}

export function useInstallHermesCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (version?: string) => {
      await invoke('install_hermes_cli', { version: version ?? null })
    },
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
      toast.success(
        'Hermes installed. Gateway service started so cron runs without Jean.'
      )
    },
    onError: error => {
      logger.error('Failed to install Hermes CLI', { error })
      toast.error('Failed to install Hermes Agent', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useUpdateHermesCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await invoke('update_hermes_cli')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
      toast.success('Hermes updated')
    },
    onError: error => {
      toast.error('Failed to update Hermes', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useUninstallHermesCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await invoke('uninstall_hermes_cli')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
      toast.success(
        'Hermes gateway service removed. Run `hermes uninstall` to remove the CLI itself.'
      )
    },
    onError: error => {
      toast.error('Failed to uninstall Hermes', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useStartHermesGateway() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      return await invoke<HermesConnectionStatus>('start_hermes_gateway')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
      toast.success('Hermes gateway started (service keeps cron running)')
    },
    onError: error => {
      toast.error('Failed to start Hermes gateway', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}

export function useHermesCliSetup() {
  const status = useHermesCliStatus()
  const installMutation = useInstallHermesCli()

  const install = (
    _version: string,
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => {
    installMutation.mutate(undefined, {
      onSuccess: () => options?.onSuccess?.(),
      onError: error => options?.onError?.(error),
    })
  }

  return {
    status: status.data,
    isStatusLoading: status.isLoading,
    versions: [{ version: 'latest', tagName: 'latest', publishedAt: '', prerelease: false }],
    isVersionsLoading: false,
    isVersionsError: false,
    refetchVersions: async () => status.refetch(),
    needsSetup: !status.isLoading && !status.data?.installed,
    isInstalling: installMutation.isPending,
    installError: installMutation.error,
    progress: null,
    install,
    checkManualVersion: async () => true,
    refetchStatus: status.refetch,
  }
}

export function useHermesJobs(options?: {
  enabled?: boolean
  includeDisabled?: boolean
  projectId?: string | null
  worktreeId?: string | null
  /** Poll while panel is open (ms). Default 15s. */
  refetchInterval?: number | false
}) {
  const includeDisabled = options?.includeDisabled ?? false
  const projectId = options?.projectId ?? null
  const worktreeId = options?.worktreeId ?? null
  return useQuery({
    queryKey: hermesCliQueryKeys.jobs(includeDisabled, projectId, worktreeId),
    queryFn: async (): Promise<HermesJob[]> => {
      if (!isTauri()) return []
      return await invoke<HermesJob[]>('list_hermes_jobs', {
        includeDisabled,
        projectId: projectId ?? undefined,
        worktreeId: worktreeId ?? undefined,
      })
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 10,
    refetchInterval: options?.refetchInterval ?? 15_000,
  })
}

export function useCreateHermesJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: HermesCreateJobRequest) => {
      return await invoke<HermesJob>(
        'create_hermes_job',
        request as unknown as Record<string, unknown>
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
      toast.success('Hermes job created')
    },
    onError: (error: unknown) => {
      toast.error(`Failed to create Hermes job: ${error}`)
    },
  })
}

export function useCreateHermesJobFromWorktree() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (request: HermesScheduleFromWorktreeRequest) => {
      return await invoke<HermesJob>('create_hermes_job_from_worktree', {
        worktreeId: request.worktreeId,
        name: request.name ?? '',
        schedule: request.schedule,
        prompt: request.prompt,
        deliver: request.deliver ?? 'local',
        skills: request.skills ?? null,
        model: request.model ?? null,
        provider: request.provider ?? null,
      })
    },
    onSuccess: job => {
      queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
      toast.success(
        `Scheduled “${job.name}”${job.nextRunAt ? ` · next ${job.nextRunAt}` : ''}`
      )
    },
    onError: (error: unknown) => {
      toast.error(`Failed to schedule Hermes job: ${error}`)
    },
  })
}

export function useHermesJobOutput(
  jobId: string | null | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: hermesCliQueryKeys.jobOutput(jobId ?? ''),
    queryFn: async (): Promise<HermesJobOutput | null> => {
      if (!isTauri() || !jobId) return null
      return await invoke<HermesJobOutput>('get_hermes_job_output', { jobId })
    },
    enabled: (options?.enabled ?? true) && !!jobId,
    staleTime: 1000 * 10,
  })
}

export function useUpdateHermesJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (args: {
      jobId: string
      request: HermesUpdateJobRequest
    }) => {
      return await invoke<HermesJob>('update_hermes_job', {
        jobId: args.jobId,
        request: args.request,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
      toast.success('Hermes job updated')
    },
    onError: (error: unknown) => {
      toast.error(`Failed to update Hermes job: ${error}`)
    },
  })
}

export function useHermesJobAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (args: {
      jobId: string
      action: 'pause' | 'resume' | 'run' | 'delete'
    }) => {
      switch (args.action) {
        case 'pause':
          return await invoke<HermesJob>('pause_hermes_job', {
            jobId: args.jobId,
          })
        case 'resume':
          return await invoke<HermesJob>('resume_hermes_job', {
            jobId: args.jobId,
          })
        case 'run':
          return await invoke('run_hermes_job', { jobId: args.jobId })
        case 'delete':
          await invoke('delete_hermes_job', { jobId: args.jobId })
          return null
      }
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
      const labels = {
        pause: 'paused',
        resume: 'resumed',
        run: 'triggered',
        delete: 'deleted',
      } as const
      toast.success(`Hermes job ${labels[vars.action]}`)
    },
    onError: (error: unknown) => {
      toast.error(`Hermes job action failed: ${error}`)
    },
  })
}
