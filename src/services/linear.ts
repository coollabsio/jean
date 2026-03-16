import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  LinearIssue,
  LinearIssueListResult,
  LinearTeam,
  LoadedLinearIssueContext,
} from '@/types/linear'
import { isTauri, useProjects } from './projects'
import { usePreferences } from './preferences'

function hasValue(value: string | null | undefined): boolean {
  return !!value?.trim()
}

function useHasLinearAccess(projectId: string | null): boolean {
  const { data: projects } = useProjects()
  const { data: preferences } = usePreferences()
  const project = projects?.find(p => p.id === projectId)

  return (
    hasValue(project?.linear_api_key ?? null) ||
    hasValue(preferences?.linear_api_key ?? null)
  )
}

/**
 * Check if an error is a Linear API key configuration error.
 */
export function isLinearAuthError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  return (
    lower.includes('no linear api key') ||
    lower.includes('linear api key is invalid')
  )
}

// Query keys for Linear
export const linearQueryKeys = {
  all: ['linear'] as const,
  issues: (projectId: string) =>
    [...linearQueryKeys.all, 'issues', projectId] as const,
  issueSearch: (projectId: string, query: string) =>
    [...linearQueryKeys.all, 'issue-search', projectId, query] as const,
  issueByNumber: (projectId: string, number: number) =>
    [...linearQueryKeys.all, 'issue-by-number', projectId, number] as const,
  loadedContexts: (sessionId: string) =>
    [...linearQueryKeys.all, 'loaded-contexts', sessionId] as const,
  teams: (projectId: string) =>
    [...linearQueryKeys.all, 'teams', projectId] as const,
}

/**
 * Parse a query string as a Linear issue number.
 * Accepts "#12" or "12" (pure digits only).
 * Returns the number, or null if the query is not a bare number.
 */
export function parseLinearItemNumber(query: string): number | null {
  const trimmed = query.trim().replace(/^#/, '')
  if (!trimmed || !/^\d+$/.test(trimmed)) return null
  const num = parseInt(trimmed, 10)
  return num > 0 ? num : null
}

/**
 * Hook to list Linear teams for a project
 */
export function useLinearTeams(
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  const hasLinearAccess = useHasLinearAccess(projectId)

  return useQuery({
    queryKey: linearQueryKeys.teams(projectId ?? ''),
    queryFn: async (): Promise<LinearTeam[]> => {
      if (!isTauri() || !projectId || !hasLinearAccess) {
        return []
      }

      try {
        logger.debug('Fetching Linear teams', { projectId })
        const result = await invoke<LinearTeam[]>('list_linear_teams', {
          projectId,
        })
        logger.info('Linear teams loaded', { count: result.length })
        return result
      } catch (error) {
        logger.error('Failed to load Linear teams', { error, projectId })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectId && hasLinearAccess,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    retry: 1,
  })
}

/**
 * Hook to list Linear issues for a project
 */
export function useLinearIssues(
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  const hasLinearAccess = useHasLinearAccess(projectId)

  return useQuery({
    queryKey: linearQueryKeys.issues(projectId ?? ''),
    queryFn: async (): Promise<LinearIssueListResult> => {
      if (!isTauri() || !projectId || !hasLinearAccess) {
        return { issues: [] }
      }

      try {
        logger.debug('Fetching Linear issues', { projectId })
        const result = await invoke<LinearIssueListResult>(
          'list_linear_issues',
          { projectId }
        )
        logger.info('Linear issues loaded', { count: result.issues.length })
        return result
      } catch (error) {
        logger.error('Failed to load Linear issues', { error, projectId })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectId && hasLinearAccess,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
    retry: 1,
  })
}

/**
 * Hook to search Linear issues
 */
export function useSearchLinearIssues(
  projectId: string | null,
  query: string,
  options?: { enabled?: boolean }
) {
  const hasLinearAccess = useHasLinearAccess(projectId)

  return useQuery({
    queryKey: linearQueryKeys.issueSearch(projectId ?? '', query),
    queryFn: async (): Promise<LinearIssue[]> => {
      if (!isTauri() || !projectId || !query.trim() || !hasLinearAccess) {
        return []
      }

      try {
        logger.debug('Searching Linear issues', { projectId, query })
        const result = await invoke<LinearIssue[]>('search_linear_issues', {
          projectId,
          query,
        })
        logger.info('Linear issue search returned', { count: result.length })
        return result
      } catch (error) {
        logger.error('Failed to search Linear issues', { error, projectId })
        throw error
      }
    },
    enabled:
      (options?.enabled ?? true) &&
      !!projectId &&
      !!query.trim() &&
      hasLinearAccess,
    staleTime: 1000 * 60 * 1,
    gcTime: 1000 * 60 * 5,
    retry: 1,
  })
}

/**
 * Hook to list loaded Linear issue contexts for a session
 */
export function useLoadedLinearIssueContexts(
  sessionId: string | null,
  worktreeId: string | null,
  projectId: string | null,
  options?: { enabled?: boolean }
) {
  const hasLinearAccess = useHasLinearAccess(projectId)

  return useQuery({
    queryKey: linearQueryKeys.loadedContexts(sessionId ?? ''),
    queryFn: async (): Promise<LoadedLinearIssueContext[]> => {
      if (!isTauri() || !sessionId || !projectId || !hasLinearAccess) {
        return []
      }

      try {
        return await invoke<LoadedLinearIssueContext[]>(
          'list_loaded_linear_issue_contexts',
          { sessionId, worktreeId, projectId }
        )
      } catch (error) {
        logger.error('Failed to load Linear contexts', { error, sessionId })
        return []
      }
    },
    enabled:
      (options?.enabled ?? true) &&
      !!sessionId &&
      !!projectId &&
      hasLinearAccess,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
    retry: 1,
  })
}

/**
 * Hook to fetch a single Linear issue by its number (e.g., #12).
 * Finds the issue regardless of state — useful for exact number lookup.
 */
export function useGetLinearIssueByNumber(
  projectId: string | null,
  query: string,
  options?: { enabled?: boolean }
) {
  const hasLinearAccess = useHasLinearAccess(projectId)
  const itemNumber = parseLinearItemNumber(query)
  return useQuery({
    queryKey: linearQueryKeys.issueByNumber(projectId ?? '', itemNumber ?? 0),
    queryFn: async (): Promise<LinearIssue | null> => {
      if (!isTauri() || !projectId || !itemNumber || !hasLinearAccess)
        return null
      try {
        logger.debug('Fetching Linear issue by number', { projectId, itemNumber })
        const result = await invoke<LinearIssue | null>(
          'get_linear_issue_by_number',
          { projectId, issueNumber: itemNumber }
        )
        return result ?? null
      } catch {
        return null
      }
    },
    enabled:
      (options?.enabled ?? true) &&
      !!projectId &&
      itemNumber !== null &&
      hasLinearAccess,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    retry: 0,
  })
}

/**
 * Filter Linear issues by search query (client-side)
 */
export function filterLinearIssues(
  issues: LinearIssue[],
  query: string
): LinearIssue[] {
  if (!query.trim()) return issues

  const lowerQuery = query.toLowerCase().trim()

  return issues.filter(issue => {
    // Match by identifier (e.g., "ENG-123")
    if (issue.identifier.toLowerCase().includes(lowerQuery)) return true
    // Match by title
    if (issue.title.toLowerCase().includes(lowerQuery)) return true
    // Match by description
    if (issue.description?.toLowerCase().includes(lowerQuery)) return true

    return false
  })
}
