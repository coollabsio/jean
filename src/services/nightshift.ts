import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import type {
  NightshiftCheck,
  NightshiftConfig,
  NightshiftRun,
} from '@/types/nightshift'

export const nightshiftQueryKeys = {
  all: ['nightshift'] as const,
  checks: () => [...nightshiftQueryKeys.all, 'checks'] as const,
  config: (projectId: string) =>
    [...nightshiftQueryKeys.all, 'config', projectId] as const,
  runs: (projectId: string) =>
    [...nightshiftQueryKeys.all, 'runs', projectId] as const,
  run: (runId: string) =>
    [...nightshiftQueryKeys.all, 'run', runId] as const,
}

/** Get all available built-in checks */
export function useNightshiftChecks() {
  return useQuery({
    queryKey: nightshiftQueryKeys.checks(),
    queryFn: () => invoke<NightshiftCheck[]>('nightshift_list_checks'),
    staleTime: Infinity, // Built-in checks never change during runtime
  })
}

/** Get Nightshift config for a project */
export function useNightshiftConfig(projectId: string | null) {
  return useQuery({
    queryKey: nightshiftQueryKeys.config(projectId ?? ''),
    queryFn: () =>
      invoke<NightshiftConfig>('nightshift_get_config', { projectId }),
    enabled: !!projectId,
  })
}

/** Save Nightshift config for a project */
export function useSaveNightshiftConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      projectId,
      config,
    }: {
      projectId: string
      config: NightshiftConfig
    }) => invoke<null>('nightshift_save_config', { projectId, config }),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({
        queryKey: nightshiftQueryKeys.config(projectId),
      })
    },
  })
}

/** Manually trigger a Nightshift run */
export function useStartNightshiftRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) =>
      invoke<string>('nightshift_start_run', { projectId }),
    onSuccess: (_, projectId) => {
      queryClient.invalidateQueries({
        queryKey: nightshiftQueryKeys.runs(projectId),
      })
    },
  })
}

/** Cancel an in-progress run */
export function useCancelNightshiftRun() {
  return useMutation({
    mutationFn: (runId: string) =>
      invoke<boolean>('nightshift_cancel_run', { runId }),
  })
}

/** Get run history for a project */
export function useNightshiftRuns(projectId: string | null) {
  return useQuery({
    queryKey: nightshiftQueryKeys.runs(projectId ?? ''),
    queryFn: () =>
      invoke<NightshiftRun[]>('nightshift_get_runs', {
        projectId,
        limit: 20,
      }),
    enabled: !!projectId,
    staleTime: 1000 * 60, // 1 minute
  })
}

/** Get a single run's details */
export function useNightshiftRun(runId: string | null) {
  return useQuery({
    queryKey: nightshiftQueryKeys.run(runId ?? ''),
    queryFn: () => invoke<NightshiftRun>('nightshift_get_run', { runId }),
    enabled: !!runId,
  })
}
