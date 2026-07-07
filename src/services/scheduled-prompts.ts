/**
 * Scheduled prompts service — TanStack Query hooks over the Tauri
 * `scheduled_prompts` commands.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { hasBackend } from '@/lib/environment'
import type {
  ScheduledPrompt,
  CreateScheduledPromptArgs,
} from '@/types/scheduled-prompts'

const isTauri = hasBackend

export const scheduledPromptsQueryKeys = {
  all: ['scheduled-prompts'] as const,
  list: () => [...scheduledPromptsQueryKeys.all, 'list'] as const,
}

/** List every pending scheduled prompt. */
export function useScheduledPrompts() {
  return useQuery({
    queryKey: scheduledPromptsQueryKeys.list(),
    queryFn: async (): Promise<ScheduledPrompt[]> => {
      if (!isTauri()) return []
      return invoke<ScheduledPrompt[]>('list_scheduled_prompts')
    },
    // The scheduler fires + removes entries in the background, so poll to keep
    // the panel roughly in sync (no backend event is emitted on fire).
    refetchInterval: 20_000,
  })
}

/** Create a scheduled prompt; invalidates the list on success. */
export function useCreateScheduledPrompt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (
      args: CreateScheduledPromptArgs,
    ): Promise<ScheduledPrompt> => {
      return invoke<ScheduledPrompt>('create_scheduled_prompt', {
        sessionId: args.sessionId,
        worktreeId: args.worktreeId,
        worktreePath: args.worktreePath,
        prompt: args.prompt,
        backend: args.backend,
        model: args.model ?? null,
        trigger: args.trigger,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: scheduledPromptsQueryKeys.list(),
      })
    },
  })
}

/** Cancel a scheduled prompt by id; invalidates the list on success. */
export function useCancelScheduledPrompt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<boolean> => {
      return invoke<boolean>('cancel_scheduled_prompt', { id })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: scheduledPromptsQueryKeys.list(),
      })
    },
  })
}
