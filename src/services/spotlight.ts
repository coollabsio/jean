import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { hasBackend } from '@/lib/environment'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { disposeAllWorktreeTerminals } from '@/lib/terminal-instances'
import type { SpotlightStatus } from '@/types/spotlight'

const isTauri = hasBackend

export const spotlightQueryKeys = {
  all: ['spotlights'] as const,
  list: () => [...spotlightQueryKeys.all, 'list'] as const,
}

export function getSpotlightForWorktree(
  spotlights: SpotlightStatus[] | undefined,
  worktreeId: string | null | undefined
): SpotlightStatus | null {
  if (!spotlights || !worktreeId) return null
  return (
    spotlights.find(spotlight => spotlight.worktree_id === worktreeId) ?? null
  )
}

export function getEffectiveWorktreePath(
  fallbackPath: string | null | undefined,
  spotlight: SpotlightStatus | null | undefined
): string | null {
  if (spotlight?.active) return spotlight.root_path
  return fallbackPath ?? null
}

export function useSpotlights() {
  return useQuery({
    queryKey: spotlightQueryKeys.list(),
    queryFn: async (): Promise<SpotlightStatus[]> => {
      if (!isTauri()) return []
      return invoke<SpotlightStatus[]>('list_spotlights')
    },
    staleTime: 1000,
    refetchInterval: query => {
      const data = query.state.data as SpotlightStatus[] | undefined
      return data?.some(spotlight => spotlight.active) ? 1500 : false
    },
  })
}

export function useSpotlight(worktreeId: string | null | undefined) {
  const query = useSpotlights()
  const spotlight = useMemo(
    () => getSpotlightForWorktree(query.data, worktreeId),
    [query.data, worktreeId]
  )
  return { ...query, spotlight }
}

function handleSpotlightError(error: unknown, fallback: string) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : fallback
  logger.error('Spotlight operation failed', { error: message })
  toast.error(message)
}

export function useActivateSpotlight() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (worktreeId: string) => {
      const status = await invoke<SpotlightStatus>('activate_spotlight', {
        worktreeId,
      })
      return status
    },
    onSuccess: status => {
      disposeAllWorktreeTerminals(status.worktree_id)
      queryClient.invalidateQueries({ queryKey: spotlightQueryKeys.all })
      toast.success('Spotlight enabled')
    },
    onError: error => handleSpotlightError(error, 'Failed to enable Spotlight'),
  })
}

export function useSyncSpotlight() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (worktreeId: string) => {
      const status = await invoke<SpotlightStatus>('sync_spotlight', {
        worktreeId,
      })
      return status
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: spotlightQueryKeys.all })
      toast.success('Spotlight synced')
    },
    onError: error => handleSpotlightError(error, 'Failed to sync Spotlight'),
  })
}

export function useDeactivateSpotlight() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (worktreeId: string) => {
      await invoke('deactivate_spotlight', { worktreeId })
    },
    onSuccess: (_, worktreeId) => {
      disposeAllWorktreeTerminals(worktreeId)
      queryClient.invalidateQueries({ queryKey: spotlightQueryKeys.all })
      toast.success('Spotlight disabled')
    },
    onError: error =>
      handleSpotlightError(error, 'Failed to disable Spotlight'),
  })
}
