import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  SentryIssue,
  SentryIssueContext,
  SentryProjectMapping,
} from '@/types/sentry'
import type { AppPreferences } from '@/types/preferences'
import type { Project } from '@/types/projects'

export const sentryQueryKeys = {
  all: ['sentry'] as const,
  projects: (projectId: string) =>
    [...sentryQueryKeys.all, 'projects', projectId] as const,
  issues: (projectId: string, query: string) =>
    [...sentryQueryKeys.all, 'issues', projectId, query] as const,
  loadedContexts: (sessionId: string) =>
    [...sentryQueryKeys.all, 'loaded-contexts', sessionId] as const,
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

function hasValue(value: string | null | undefined): boolean {
  return !!value?.trim()
}

/**
 * True when Sentry is set up for a project: a project or global auth token,
 * and at least one linked Sentry project (matches `get_sentry_config`).
 * Remote server preferences redact the token and send
 * `sentry_auth_token_configured` instead.
 */
export function hasSentryAccess(
  project:
    | Pick<
        Project,
        | 'sentry_auth_token'
        | 'sentry_projects'
        | 'sentry_organization_slug'
        | 'sentry_project_slug'
      >
    | null
    | undefined,
  preferences:
    | (Pick<AppPreferences, 'sentry_auth_token'> & {
        sentry_auth_token_configured?: boolean
      })
    | null
    | undefined
): boolean {
  if (!project) return false
  const hasToken =
    hasValue(project.sentry_auth_token) ||
    hasValue(preferences?.sentry_auth_token) ||
    preferences?.sentry_auth_token_configured === true
  const hasLinkedProject =
    (project.sentry_projects ?? []).some(
      link => hasValue(link.organization_slug) && hasValue(link.project_slug)
    ) ||
    (hasValue(project.sentry_organization_slug) &&
      hasValue(project.sentry_project_slug))
  return hasToken && hasLinkedProject
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

export function useLoadedSentryContexts(
  sessionId: string | null,
  worktreeId: string | null,
  projectId: string | null
) {
  return useQuery({
    queryKey: sentryQueryKeys.loadedContexts(sessionId ?? ''),
    queryFn: async () =>
      (await invoke<SentryIssueContext[]>('get_sentry_issue_context_contents', {
        sessionId,
        worktreeId,
        projectId,
      })) ?? [],
    enabled: !!sessionId && !!projectId,
  })
}
