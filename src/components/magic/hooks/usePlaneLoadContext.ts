import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import {
  filterPlaneWorkItems,
  useLoadedPlaneWorkItemContexts,
  usePlaneWorkItems,
  useSearchPlaneWorkItems,
} from '@/services/plane'
import type { LoadedPlaneWorkItemContext, PlaneWorkItem } from '@/types/plane'
import type { ViewingContext } from './useLoadContextHandlers'

interface PlaneWorkItemContextContent {
  identifier: string
  title: string
  content: string
}

interface UsePlaneLoadContextOptions {
  open: boolean
  activeSessionId: string | null
  worktreeId: string | null
  projectId: string | null
  searchQuery: string
  onClearSearch: () => void
  setViewingContext: (ctx: ViewingContext | null) => void
}

function withoutKey(set: Set<string>, key: string): Set<string> {
  const next = new Set(set)
  next.delete(key)
  return next
}

/** Data and actions of the Plane tab in the Load Context modal. */
export function usePlaneLoadContext({
  open,
  activeSessionId,
  worktreeId,
  projectId,
  searchQuery,
  onClearSearch,
  setViewingContext,
}: UsePlaneLoadContextOptions) {
  const loaded = useLoadedPlaneWorkItemContexts(
    activeSessionId,
    worktreeId,
    projectId
  )
  const workItems = usePlaneWorkItems(projectId, { enabled: open })
  const debouncedQuery = useDebouncedValue(searchQuery, 300)
  const search = useSearchPlaneWorkItems(projectId, debouncedQuery, {
    enabled: open,
  })
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())

  const loadedContexts = loaded.data ?? []
  const { refetch: refetchLoaded } = loaded

  const filteredWorkItems = useMemo(() => {
    const loadedIds = new Set(loaded.data?.map(c => c.identifier) ?? [])
    const local = filterPlaneWorkItems(workItems.data ?? [], searchQuery)
    const seen = new Set(local.map(i => i.id))
    const extra = (search.data ?? []).filter(i => !seen.has(i.id))
    return [...local, ...extra].filter(i => !loadedIds.has(i.identifier))
  }, [loaded.data, workItems.data, search.data, searchQuery])

  const loadWorkItem = useCallback(
    async (identifier: string, isRefresh = false) => {
      if (!activeSessionId || !projectId) {
        toast.error('No active session')
        return
      }
      setLoadingIds(prev => new Set(prev).add(identifier))
      const toastId = toast.loading(
        isRefresh ? `Refreshing ${identifier}...` : `Loading ${identifier}...`
      )
      try {
        const result = await invoke<LoadedPlaneWorkItemContext>(
          'load_plane_work_item_context',
          { sessionId: activeSessionId, projectId, identifier }
        )
        await refetchLoaded()
        toast.success(
          `${result.identifier}: ${result.title}${result.commentCount > 0 ? ` (${result.commentCount} comments)` : ''}`,
          { id: toastId }
        )
      } catch (error) {
        toast.error(`${error}`, { id: toastId })
      } finally {
        setLoadingIds(prev => withoutKey(prev, identifier))
      }
    },
    [activeSessionId, projectId, refetchLoaded]
  )

  const removeWorkItem = useCallback(
    async (identifier: string) => {
      if (!activeSessionId || !projectId) return
      setRemovingIds(prev => new Set(prev).add(identifier))
      try {
        await invoke('remove_plane_work_item_context', {
          sessionId: activeSessionId,
          projectId,
          identifier,
        })
        await refetchLoaded()
        toast.success(`Removed ${identifier} from context`)
      } catch (error) {
        toast.error(`Failed to remove Plane work item: ${error}`)
      } finally {
        setRemovingIds(prev => withoutKey(prev, identifier))
      }
    },
    [activeSessionId, projectId, refetchLoaded]
  )

  const viewWorkItem = useCallback(
    async (ctx: LoadedPlaneWorkItemContext) => {
      if (!activeSessionId || !projectId) return
      try {
        const contents = await invoke<PlaneWorkItemContextContent[]>(
          'get_plane_work_item_context_contents',
          { sessionId: activeSessionId, worktreeId, projectId }
        )
        const match = contents.find(c => c.identifier === ctx.identifier)
        if (!match) {
          toast.error(`Failed to load context: ${ctx.identifier} not found`)
          return
        }
        setViewingContext({
          type: 'plane',
          identifier: ctx.identifier,
          title: `${ctx.identifier}: ${ctx.title}`,
          content: match.content,
        })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [activeSessionId, worktreeId, projectId, setViewingContext]
  )

  const selectWorkItem = useCallback(
    (item: PlaneWorkItem) => {
      void loadWorkItem(item.identifier)
      onClearSearch()
    },
    [loadWorkItem, onClearSearch]
  )

  const resetState = useCallback(() => {
    setLoadingIds(new Set())
    setRemovingIds(new Set())
  }, [])

  return {
    loadedContexts,
    isLoadingContexts: loaded.isLoading,
    hasLoadedContexts: loadedContexts.length > 0,
    refetchLoaded,
    filteredWorkItems,
    isLoading: workItems.isLoading,
    isRefetching: workItems.isFetching,
    isSearching: search.isFetching,
    error: workItems.error,
    refetch: workItems.refetch,
    loadingIds,
    removingIds,
    loadWorkItem,
    removeWorkItem,
    viewWorkItem,
    selectWorkItem,
    resetState,
  }
}
