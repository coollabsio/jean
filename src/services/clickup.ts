import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  ClickUpConfig,
  ClickUpMe,
  ClickUpStatusOption,
  ClickUpTask,
} from '@/types/clickup'
import { isTauri } from './projects'

function hasValue(value: string | null | undefined): boolean {
  return !!value?.trim()
}

/**
 * Check if an error is a ClickUp token configuration error.
 */
export function isClickUpAuthError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  return (
    lower.includes('no clickup api token') ||
    lower.includes('clickup api token is invalid')
  )
}

// Query keys for ClickUp
export const clickupQueryKeys = {
  all: ['clickup'] as const,
  config: () => [...clickupQueryKeys.all, 'config'] as const,
  statusOptions: () => [...clickupQueryKeys.all, 'status-options'] as const,
  me: (projectId: string) =>
    [...clickupQueryKeys.all, 'me', projectId] as const,
  task: (taskId: string) => [...clickupQueryKeys.all, 'task', taskId] as const,
  resolvedTask: (worktreeId: string) =>
    [...clickupQueryKeys.all, 'resolved-task', worktreeId] as const,
}

/**
 * Hook to read the persisted ClickUp config (token + list ids).
 */
export function useClickUpConfig() {
  return useQuery({
    queryKey: clickupQueryKeys.config(),
    queryFn: async (): Promise<ClickUpConfig> => {
      if (!isTauri()) {
        return { projectTokens: {} }
      }
      return invoke<ClickUpConfig>('get_clickup_config')
    },
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    retry: 1,
  })
}

/**
 * Whether a ClickUp token is configured (global or for this project).
 */
export function useHasClickUpAccess(projectId: string | null): boolean {
  const { data: config } = useClickUpConfig()
  if (!config) return false
  const projectToken = projectId ? config.projectTokens?.[projectId] : undefined
  return hasValue(config.token) || hasValue(projectToken)
}

/**
 * Hook for the hard-coded Planexpo status transitions.
 */
export function useClickUpStatusOptions() {
  return useQuery({
    queryKey: clickupQueryKeys.statusOptions(),
    queryFn: async (): Promise<ClickUpStatusOption[]> => {
      if (!isTauri()) return []
      return invoke<ClickUpStatusOption[]>('get_clickup_status_options')
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 0,
  })
}

/**
 * Resolve the ClickUp task id linked to a worktree (manual override or the
 * `CU-<id>` branch convention). Returns null when nothing is linked.
 */
export function useResolvedClickUpTaskId(worktreeId: string | null) {
  return useQuery({
    queryKey: clickupQueryKeys.resolvedTask(worktreeId ?? ''),
    queryFn: async (): Promise<string | null> => {
      if (!isTauri() || !worktreeId) return null
      const result = await invoke<string | null>(
        'resolve_clickup_task_for_worktree',
        { worktreeId }
      )
      return result ?? null
    },
    enabled: !!worktreeId,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    retry: 0,
  })
}

/**
 * Fetch a ClickUp task by id.
 */
export function useClickUpTask(
  taskId: string | null,
  projectId: string | null
) {
  const hasAccess = useHasClickUpAccess(projectId)

  return useQuery({
    queryKey: clickupQueryKeys.task(taskId ?? ''),
    queryFn: async (): Promise<ClickUpTask | null> => {
      if (!isTauri() || !taskId || !hasAccess) return null
      try {
        logger.debug('Fetching ClickUp task', { taskId })
        return await invoke<ClickUpTask>('get_clickup_task', {
          taskId,
          projectId: projectId ?? undefined,
        })
      } catch (error) {
        logger.error('Failed to load ClickUp task', { error, taskId })
        throw error
      }
    },
    enabled: !!taskId && hasAccess,
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    retry: 1,
  })
}

/**
 * Fetch the authenticated ClickUp user.
 */
export function useClickUpMe(projectId: string | null) {
  const hasAccess = useHasClickUpAccess(projectId)

  return useQuery({
    queryKey: clickupQueryKeys.me(projectId ?? ''),
    queryFn: async (): Promise<ClickUpMe | null> => {
      if (!isTauri() || !hasAccess) return null
      return invoke<ClickUpMe>('get_clickup_me', {
        projectId: projectId ?? undefined,
      })
    },
    enabled: hasAccess,
    staleTime: 1000 * 60 * 30,
    gcTime: 1000 * 60 * 60,
    retry: 1,
  })
}

/**
 * Mutation: change a task's status.
 */
export function useUpdateClickUpStatus(projectId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { taskId: string; status: string }) => {
      return invoke<ClickUpTask>('update_clickup_task_status', {
        taskId: vars.taskId,
        status: vars.status,
        projectId: projectId ?? undefined,
      })
    },
    onSuccess: task => {
      queryClient.setQueryData(clickupQueryKeys.task(task.id), task)
    },
  })
}

/**
 * Mutation: self-assign the authenticated user to a task.
 */
export function useAssignClickUpToMe(projectId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { taskId: string }) => {
      return invoke<ClickUpTask>('assign_clickup_task_to_me', {
        taskId: vars.taskId,
        projectId: projectId ?? undefined,
      })
    },
    onSuccess: task => {
      queryClient.setQueryData(clickupQueryKeys.task(task.id), task)
    },
  })
}

/**
 * Mutation: manually link a worktree to a task id.
 */
export function useSetClickUpLink() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { worktreeId: string; taskId: string }) => {
      await invoke('set_clickup_link', {
        worktreeId: vars.worktreeId,
        taskId: vars.taskId,
      })
      return vars
    },
    onSuccess: vars => {
      queryClient.invalidateQueries({
        queryKey: clickupQueryKeys.resolvedTask(vars.worktreeId),
      })
    },
  })
}

/**
 * Mutation: remove a manual worktree link.
 */
export function useClearClickUpLink() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { worktreeId: string }) => {
      await invoke('clear_clickup_link', { worktreeId: vars.worktreeId })
      return vars
    },
    onSuccess: vars => {
      queryClient.invalidateQueries({
        queryKey: clickupQueryKeys.resolvedTask(vars.worktreeId),
      })
    },
  })
}

/**
 * Mutation: save the ClickUp config (global token + list ids).
 */
export function useSaveClickUpConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: {
      token?: string
      planexpoListId?: string
      sprintListId?: string
      productionVersionUrl?: string
    }) => {
      await invoke('set_clickup_config', {
        token: vars.token,
        planexpoListId: vars.planexpoListId,
        sprintListId: vars.sprintListId,
        productionVersionUrl: vars.productionVersionUrl,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clickupQueryKeys.all })
    },
  })
}

/**
 * Browse tasks in a list (defaults to the configured Planexpo list).
 */
export async function listClickUpTasks(
  listId?: string,
  projectId?: string
): Promise<ClickUpTask[]> {
  return invoke<ClickUpTask[]>('list_clickup_tasks', {
    listId,
    projectId,
  })
}
