import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  PlaneIssue,
  PlaneIssueListResult,
  PlaneWorkspace,
  PlaneProject,
  LoadedPlaneIssueContext,
} from '@/types/plane'
import { isTauri, useProjects } from './projects'
import { usePreferences } from './preferences'

function hasValue(value: string | null | undefined): boolean {
  return !!value?.trim()
}

function useHasPlaneAccess(projectId: string | null): boolean {
  const { data: projects } = useProjects()
  const { data: preferences } = usePreferences()
  const project = projects?.find(p => p.id === projectId)

  return (
    hasValue(project?.plane_api_key ?? null) ||
    hasValue(preferences?.plane_api_key ?? null)
  ) &&
  (
    hasValue(project?.plane_url ?? null) ||
    hasValue(preferences?.plane_url ?? null)
  )
}

/**
 * Check if an error is a Plane API key configuration error.
 */
export function isPlaneAuthError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  return (
    lower.includes('no plane api key') ||
    lower.includes('plane api key is invalid')
  )
}

// Query keys for Plane
export const planeQueryKeys = {
  all: ['plane'] as const,
  workspaces: (projectId: string) =>
    [...planeQueryKeys.all, 'workspaces', projectId] as const,
  projects: (projectId: string, workspaceSlug: string) =>
    [...planeQueryKeys.all, 'projects', projectId, workspaceSlug] as const,
  issues: (projectId: string, workspaceSlug: string) =>
    [...planeQueryKeys.all, 'issues', projectId, workspaceSlug] as const,
  issueSearch: (projectId: string, workspaceSlug: string, query: string) =>
    [...planeQueryKeys.all, 'issue-search', projectId, workspaceSlug, query] as const,
  issueByNumber: (projectId: string, identifier: string) =>
    [...planeQueryKeys.all, 'issue-by-number', projectId, identifier] as const,
  loadedContexts: (sessionId: string) =>
    [...planeQueryKeys.all, 'loaded-contexts', sessionId] as const,
}

/**
 * Parse a query string as a Plane issue identifier.
 * Accepts "PROJ-123" or just "123".
 * Returns the identifier string, or null if the query is not valid.
 */
export function parsePlaneItemNumber(query: string): string | null {
  const trimmed = query.trim().toUpperCase()
  // Check if it's in the format "XXX-123"
  if (/^[A-Z]+-\d+$/.test(trimmed)) return trimmed
  // Check if it's just digits - we need the project prefix, so return null
  // The user should provide the full identifier
  if (/^\d+$/.test(trimmed)) return null
  return null
}

/**
 * Hook to list Plane workspaces for a project
 */
export function usePlaneWorkspaces(
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  const hasPlaneAccess = useHasPlaneAccess(projectId)

  return useQuery({
    queryKey: planeQueryKeys.workspaces(projectId ?? ''),
    queryFn: async (): Promise<PlaneWorkspace[]> => {
      if (!isTauri() || !projectId || !hasPlaneAccess) {
        return []
      }

      try {
        logger.debug('Fetching Plane workspaces', { projectId })
        const result = await invoke<PlaneWorkspace[]>('list_plane_workspaces', {
          projectId,
        })
        logger.info('Plane workspaces loaded', { count: result.length })
        return result
      } catch (error) {
        logger.error('Failed to load Plane workspaces', { error, projectId })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectId && hasPlaneAccess,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    retry: 1,
  })
}

/**
 * Hook to list Plane projects for a workspace
 */
export function usePlaneProjects(
  projectId: string | null,
  workspaceSlug: string | null,
  options?: { enabled?: boolean }
) {
  const hasPlaneAccess = useHasPlaneAccess(projectId)

  return useQuery({
    queryKey: planeQueryKeys.projects(projectId ?? '', workspaceSlug ?? ''),
    queryFn: async (): Promise<PlaneProject[]> => {
      if (!isTauri() || !projectId || !workspaceSlug || !hasPlaneAccess) {
        return []
      }

      try {
        logger.debug('Fetching Plane projects', { projectId, workspaceSlug })
        const result = await invoke<PlaneProject[]>('list_plane_projects', {
          projectId,
          workspaceSlug,
        })
        logger.info('Plane projects loaded', { count: result.length })
        return result
      } catch (error) {
        logger.error('Failed to load Plane projects', { error, projectId, workspaceSlug })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectId && !!workspaceSlug && hasPlaneAccess,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    retry: 1,
  })
}

/**
 * Hook to list Plane issues for a project
 */
export function usePlaneIssues(
  projectId: string | null,
  workspaceSlug: string | null,
  projectIdFilter: string | null = null,
  options?: { enabled?: boolean }
) {
  const hasPlaneAccess = useHasPlaneAccess(projectId)

  return useQuery({
    queryKey: planeQueryKeys.issues(projectId ?? '', workspaceSlug ?? ''),
    queryFn: async (): Promise<PlaneIssueListResult> => {
      if (!isTauri() || !projectId || !workspaceSlug || !hasPlaneAccess) {
        return { issues: [] }
      }

      try {
        logger.debug('Fetching Plane issues', { projectId, workspaceSlug, projectIdFilter })
        const result = await invoke<PlaneIssueListResult>(
          'list_plane_issues',
          {
            projectId,
            workspaceSlug,
            projectIdFilter,
          }
        )
        logger.info('Plane issues loaded', { count: result.issues.length })
        return result
      } catch (error) {
        logger.error('Failed to load Plane issues', { error, projectId, workspaceSlug })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectId && !!workspaceSlug && hasPlaneAccess,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
    retry: 1,
  })
}

/**
 * Hook to search Plane issues
 */
export function useSearchPlaneIssues(
  projectId: string | null,
  workspaceSlug: string | null,
  projectIdFilter: string | null,
  search: string,
  options?: { enabled?: boolean }
) {
  const hasPlaneAccess = useHasPlaneAccess(projectId)

  return useQuery({
    queryKey: planeQueryKeys.issueSearch(projectId ?? '', workspaceSlug ?? '', search),
    queryFn: async (): Promise<PlaneIssue[]> => {
      if (!isTauri() || !projectId || !workspaceSlug || !search.trim() || !hasPlaneAccess) {
        return []
      }

      try {
        logger.debug('Searching Plane issues', { projectId, workspaceSlug, search })
        const result = await invoke<PlaneIssue[]>('search_plane_issues', {
          projectId,
          workspaceSlug,
          projectIdFilter,
          search,
        })
        logger.info('Plane issue search returned', { count: result.length })
        return result
      } catch (error) {
        logger.error('Failed to search Plane issues', { error, projectId })
        throw error
      }
    },
    enabled:
      (options?.enabled ?? true) &&
      !!projectId &&
      !!workspaceSlug &&
      !!search.trim() &&
      hasPlaneAccess,
    staleTime: 1000 * 60 * 1,
    gcTime: 1000 * 60 * 5,
    retry: 1,
  })
}

/**
 * Hook to list loaded Plane issue contexts for a session
 */
export function useLoadedPlaneIssueContexts(
  sessionId: string | null,
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  const hasPlaneAccess = useHasPlaneAccess(projectId)

  return useQuery({
    queryKey: planeQueryKeys.loadedContexts(sessionId ?? ''),
    queryFn: async (): Promise<LoadedPlaneIssueContext[]> => {
      if (!isTauri() || !sessionId || !projectId || !hasPlaneAccess) {
        return []
      }

      try {
        return await invoke<LoadedPlaneIssueContext[]>(
          'list_loaded_plane_issue_contexts',
          { sessionId, projectId }
        )
      } catch (error) {
        logger.error('Failed to load Plane contexts', { error, sessionId })
        return []
      }
    },
    enabled:
      (options?.enabled ?? true) &&
      !!sessionId &&
      !!projectId &&
      hasPlaneAccess,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
    retry: 1,
  })
}

/**
 * Hook to fetch a single Plane issue by its identifier (e.g., "PROJ-123").
 * Finds the issue regardless of state — useful for exact identifier lookup.
 */
export function useGetPlaneIssueByNumber(
  projectId: string | null,
  workspaceSlug: string | null,
  projectIdFilter: string | null,
  identifier: string | null,
  options?: { enabled?: boolean }
) {
  const hasPlaneAccess = useHasPlaneAccess(projectId)

  return useQuery({
    queryKey: planeQueryKeys.issueByNumber(projectId ?? '', identifier ?? ''),
    queryFn: async (): Promise<PlaneIssue | null> => {
      if (!isTauri() || !projectId || !workspaceSlug || !identifier || !hasPlaneAccess)
        return null
      try {
        logger.debug('Fetching Plane issue by identifier', { projectId, identifier })
        const result = await invoke<PlaneIssue | null>(
          'get_plane_issue_by_number',
          {
            projectId,
            workspaceSlug,
            projectIdFilter,
            identifier,
          }
        )
        return result ?? null
      } catch {
        return null
      }
    },
    enabled:
      (options?.enabled ?? true) &&
      !!projectId &&
      !!workspaceSlug &&
      !!identifier &&
      hasPlaneAccess,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    retry: 0,
  })
}

/**
 * Filter Plane issues by search query (client-side)
 */
export function filterPlaneIssues(
  issues: PlaneIssue[],
  query: string
): PlaneIssue[] {
  if (!query.trim()) return issues

  const lowerQuery = query.toLowerCase().trim()

  return issues.filter(issue => {
    // Match by identifier (e.g., "PROJ-123")
    if (issue.sequenceId.toLowerCase().includes(lowerQuery)) return true
    // Match by title
    if (issue.name.toLowerCase().includes(lowerQuery)) return true
    // Match by description
    if (issue.description?.toLowerCase().includes(lowerQuery)) return true

    return false
  })
}
