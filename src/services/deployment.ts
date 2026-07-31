import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { isTauri, projectsQueryKeys } from '@/services/projects'
import type {
  CloseDeploymentResult,
  DeploymentOverview,
} from '@/types/deployment'

export const deploymentQueryKeys = {
  all: ['deployment'] as const,
  overview: (projectId: string) =>
    [...deploymentQueryKeys.all, 'overview', projectId] as const,
}

export function useDeploymentOverview(projectId: string | null) {
  return useQuery({
    queryKey: deploymentQueryKeys.overview(projectId ?? ''),
    queryFn: async (): Promise<DeploymentOverview> => {
      if (!isTauri() || !projectId) {
        throw new Error('Aucun projet de déploiement sélectionné')
      }
      return invoke<DeploymentOverview>('get_deployment_overview', {
        projectId,
      })
    },
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  })
}

function useRefreshAfterClose(projectId: string | null) {
  const queryClient = useQueryClient()
  return async () => {
    if (projectId) {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: deploymentQueryKeys.overview(projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        }),
      ])
    }
    await queryClient.invalidateQueries({ queryKey: ['clickup'] })
  }
}

export function useCloseDeployedTask(projectId: string | null) {
  const refresh = useRefreshAfterClose(projectId)
  return useMutation({
    mutationFn: async (taskId: string): Promise<CloseDeploymentResult> => {
      if (!projectId) throw new Error('Aucun projet sélectionné')
      return invoke<CloseDeploymentResult>('close_deployed_task', {
        projectId,
        taskId,
      })
    },
    onSuccess: refresh,
  })
}

export function useCloseAllDeployedTasks(projectId: string | null) {
  const refresh = useRefreshAfterClose(projectId)
  return useMutation({
    mutationFn: async (): Promise<CloseDeploymentResult[]> => {
      if (!projectId) throw new Error('Aucun projet sélectionné')
      return invoke<CloseDeploymentResult[]>('close_all_deployed_tasks', {
        projectId,
      })
    },
    onSuccess: refresh,
  })
}
