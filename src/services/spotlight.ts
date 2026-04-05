import { useMemo } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { hasBackend } from '@/lib/environment'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { disposeAllWorktreeTerminals } from '@/lib/terminal-instances'
import type { SpotlightStatus } from '@/types/spotlight'
import { isBaseSession, type Worktree } from '@/types/projects'

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

export function shouldUseSpotlightShortcut({
  spotlightTestingEnabled,
  spotlightActive,
  targetWorktree,
}: {
  spotlightTestingEnabled: boolean
  spotlightActive: boolean
  targetWorktree?: Worktree | null
}): boolean {
  if (!spotlightTestingEnabled) return false
  if (spotlightActive) return true
  if (!targetWorktree) return true
  return !isBaseSession(targetWorktree)
}

async function invalidateSpotlightQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: spotlightQueryKeys.all })
}

export async function loadSpotlights(
  queryClient: QueryClient
): Promise<SpotlightStatus[]> {
  const cached = queryClient.getQueryData<SpotlightStatus[]>(
    spotlightQueryKeys.list()
  )
  if (cached !== undefined) return cached

  try {
    return await queryClient.fetchQuery<SpotlightStatus[]>({
      queryKey: spotlightQueryKeys.list(),
      queryFn: () => invoke<SpotlightStatus[]>('list_spotlights'),
    })
  } catch {
    return []
  }
}

export async function activateSpotlightWithEffects(
  queryClient: QueryClient,
  worktreeId: string
): Promise<SpotlightStatus> {
  const status = await invoke<SpotlightStatus>('activate_spotlight', {
    worktreeId,
  })
  disposeAllWorktreeTerminals(status.worktree_id)
  await invalidateSpotlightQueries(queryClient)
  return status
}

export async function syncSpotlightWithEffects(
  queryClient: QueryClient,
  worktreeId: string
): Promise<SpotlightStatus> {
  const status = await invoke<SpotlightStatus>('sync_spotlight', {
    worktreeId,
  })
  await invalidateSpotlightQueries(queryClient)
  return status
}

export async function deactivateSpotlightWithEffects(
  queryClient: QueryClient,
  worktreeId: string
): Promise<void> {
  await invoke('deactivate_spotlight', { worktreeId })
  disposeAllWorktreeTerminals(worktreeId)
  await invalidateSpotlightQueries(queryClient)
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
    mutationFn: (worktreeId: string) =>
      activateSpotlightWithEffects(queryClient, worktreeId),
    onSuccess: () => {
      toast.success('Spotlight enabled')
    },
    onError: error => handleSpotlightError(error, 'Failed to enable Spotlight'),
  })
}

export function useSyncSpotlight() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (worktreeId: string) =>
      syncSpotlightWithEffects(queryClient, worktreeId),
    onSuccess: () => {
      toast.success('Spotlight synced')
    },
    onError: error => handleSpotlightError(error, 'Failed to sync Spotlight'),
  })
}

export function useDeactivateSpotlight() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (worktreeId: string) =>
      deactivateSpotlightWithEffects(queryClient, worktreeId),
    onSuccess: () => {
      toast.success('Spotlight disabled')
    },
    onError: error =>
      handleSpotlightError(error, 'Failed to disable Spotlight'),
  })
}
