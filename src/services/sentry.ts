import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type { SentryIssue, SentryProjectMapping } from '@/types/sentry'

export const sentryQueryKeys = {
  all: ['sentry'] as const,
  projects: (projectId: string) =>
    [...sentryQueryKeys.all, 'projects', projectId] as const,
  issues: (projectId: string, query: string) =>
    [...sentryQueryKeys.all, 'issues', projectId, query] as const,
}

export async function testSentryAuthToken(
  authToken: string
): Promise<SentryProjectMapping[]> {
  return invoke<SentryProjectMapping[]>('test_sentry_auth_token', { authToken })
}

export function useSentryProjects(
  projectId: string,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: sentryQueryKeys.projects(projectId),
    queryFn: () =>
      invoke<SentryProjectMapping[]>('list_sentry_projects', { projectId }),
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    retry: false,
  })
}

export function isSentryAuthError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  return (
    lower.includes('no sentry auth token') ||
    lower.includes('no sentry organization') ||
    lower.includes('no sentry project') ||
    lower.includes('sentry organization or project was not found') ||
    lower.includes('sentry auth token is invalid') ||
    lower.includes('missing the event:read scope') ||
    lower.includes('missing the org:read scope')
  )
}

export function filterSentryIssues(
  issues: SentryIssue[],
  query: string
): SentryIssue[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return issues
  return issues.filter(issue =>
    [issue.id, issue.shortId, issue.title, issue.culprit].some(value =>
      value.toLowerCase().includes(normalized)
    )
  )
}

export function useSentryIssues(projectId: string | null, query = '') {
  return useQuery({
    queryKey: sentryQueryKeys.issues(projectId ?? '', query),
    queryFn: async (): Promise<SentryIssue[]> => {
      if (!projectId) return []
      try {
        const issues = await invoke<SentryIssue[]>('list_sentry_issues', {
          projectId,
          query: query.trim() || null,
        })
        logger.info('Sentry issues loaded', { count: issues.length })
        return issues
      } catch (error) {
        logger.error('Failed to load Sentry issues', { error, projectId })
        throw error
      }
    },
    enabled: !!projectId,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 10,
    retry: 1,
  })
}
