import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  LoadedPlaneWorkItemContext,
  PlaneProject,
  PlaneWorkItem,
  PlaneWorkItemDetail,
} from '@/types/plane'
import type { AppPreferences } from '@/types/preferences'
import type { PlaneProjectSettings, Project } from '@/types/projects'
import { invalidateProjectLists, isTauri } from './projects'

/** Filter work items by identifier, title, or description (client-side) */
export function filterPlaneWorkItems(
  items: PlaneWorkItem[],
  query: string
): PlaneWorkItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    item =>
      item.identifier.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      !!item.description?.toLowerCase().includes(q)
  )
}

/**
 * Check if an error is a Plane configuration error (missing or invalid key/workspace).
 */
function hasValue(value: string | null | undefined): boolean {
  return !!value?.trim()
}

/**
 * True when Plane is set up for a project: an API key and a workspace slug,
 * each from the project or the global settings (matches the backend config).
 * Remote server preferences redact the key and send
 * `plane_api_key_configured` instead.
 */
export function hasPlaneAccess(
  project: Pick<Project, 'plane'> | null | undefined,
  preferences:
    | (Pick<AppPreferences, 'plane_api_key' | 'plane_workspace_slug'> & {
        plane_api_key_configured?: boolean
      })
    | null
    | undefined
): boolean {
  if (!project) return false
  const hasKey =
    hasValue(project.plane?.api_key) ||
    hasValue(preferences?.plane_api_key) ||
    preferences?.plane_api_key_configured === true
  const hasWorkspace =
    hasValue(project.plane?.workspace_slug) ||
    hasValue(preferences?.plane_workspace_slug)
  return hasKey && hasWorkspace
}

export function isPlaneAuthError(error: unknown): boolean {
  if (!error) return false
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase()
  return (
    message.includes('no plane api key') ||
    message.includes('no plane workspace') ||
    message.includes('plane api key is invalid') ||
    message.includes('plane api key has no access')
  )
}

export const planeQueryKeys = {
  all: ['plane'] as const,
  workItems: (projectId: string) =>
    [...planeQueryKeys.all, 'work-items', projectId] as const,
  search: (projectId: string, query: string) =>
    [...planeQueryKeys.all, 'search', projectId, query] as const,
  loadedContexts: (sessionId: string) =>
    [...planeQueryKeys.all, 'loaded-contexts', sessionId] as const,
  projects: (projectId: string) =>
    [...planeQueryKeys.all, 'projects', projectId] as const,
}

/**
 * Active Plane work items for a Jean project. Missing or invalid settings
 * surface as errors so the UI can show PlaneAuthError.
 */
export function usePlaneWorkItems(
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: planeQueryKeys.workItems(projectId ?? ''),
    queryFn: async (): Promise<PlaneWorkItem[]> => {
      if (!projectId) return []
      try {
        return await invoke<PlaneWorkItem[]>('list_plane_work_items', {
          projectId,
        })
      } catch (error) {
        logger.error('Failed to load Plane work items', { error, projectId })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectId,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
    retry: 1,
  })
}

/** Server-side Plane search (title and identifier) */
export function useSearchPlaneWorkItems(
  projectId: string | null,
  query: string,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: planeQueryKeys.search(projectId ?? '', query),
    queryFn: async (): Promise<PlaneWorkItem[]> => {
      if (!projectId || !query.trim()) return []
      try {
        return await invoke<PlaneWorkItem[]>('search_plane_work_items', {
          projectId,
          query,
        })
      } catch (error) {
        logger.error('Failed to search Plane work items', { error, projectId })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectId && !!query.trim(),
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    retry: 1,
  })
}

/** Plane work items loaded as context into a session (and its worktree) */
export function useLoadedPlaneWorkItemContexts(
  sessionId: string | null,
  worktreeId: string | null,
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: planeQueryKeys.loadedContexts(sessionId ?? ''),
    queryFn: async (): Promise<LoadedPlaneWorkItemContext[]> => {
      if (!isTauri() || !sessionId || !projectId) return []
      try {
        return await invoke<LoadedPlaneWorkItemContext[]>(
          'list_loaded_plane_work_item_contexts',
          { sessionId, worktreeId, projectId }
        )
      } catch (error) {
        logger.error('Failed to load Plane contexts', { error, sessionId })
        return []
      }
    },
    enabled: (options?.enabled ?? true) && !!sessionId && !!projectId,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
    retry: 1,
  })
}

/** Plane projects of the configured workspace (for the project filter) */
export function usePlaneProjects(
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: planeQueryKeys.projects(projectId ?? ''),
    queryFn: async (): Promise<PlaneProject[]> => {
      if (!projectId) return []
      return invoke<PlaneProject[]>('list_plane_projects', { projectId })
    },
    enabled: (options?.enabled ?? true) && !!projectId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    retry: 0,
  })
}

/** Fetch a work item with comments by identifier (e.g. "PROJ-12") */
export function getPlaneWorkItem(
  projectId: string,
  identifier: string
): Promise<PlaneWorkItemDetail> {
  return invoke<PlaneWorkItemDetail>('get_plane_work_item', {
    projectId,
    identifier,
  })
}

/** Replace the per-project Plane settings */
export function useUpdateProjectPlaneSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      projectId,
      settings,
    }: {
      projectId: string
      settings: PlaneProjectSettings
    }) =>
      invoke<Project>('update_project_plane_settings', {
        projectId,
        settings,
      }),
    onSuccess: () => {
      invalidateProjectLists(queryClient)
      queryClient.invalidateQueries({ queryKey: planeQueryKeys.all })
    },
    onError: error => {
      toast.error('Failed to save Plane settings', {
        description: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
