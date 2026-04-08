import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type {
  GitHubIssue,
  GitHubIssueDetail,
  GitHubIssueListResult,
  GitHubPullRequest,
  GitHubPullRequestDetail,
  LoadedIssueContext,
  LoadedPullRequestContext,
  DependabotAlert,
  LoadedSecurityAlertContext,
  RepositoryAdvisory,
  LoadedAdvisoryContext,
  AttachedSavedContext,
  WorkflowRunsResult,
} from '@/types/github'
import { isTauri } from './projects'

/**
 * Check if an error is a GitHub CLI authentication or installation error.
 *
 * Matches:
 * - Auth errors: "GitHub CLI not authenticated. Run 'gh auth login' first."
 * - Auth prompt: stderr containing "gh auth login"
 * - Binary not found: "The system cannot find the file specified."
 *
 * Does NOT match generic gh failures (no remotes, repo not found, etc.)
 */
export function isGhAuthError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  return (
    lower.includes('not authenticated') ||
    lower.includes('gh auth login') ||
    lower.includes('the system cannot find the file specified')
  )
}

// Query keys for GitHub
export const githubQueryKeys = {
  all: ['github'] as const,
  issues: (projectPath: string, state: string) =>
    [...githubQueryKeys.all, 'issues', projectPath, state] as const,
  issue: (projectPath: string, issueNumber: number) =>
    [...githubQueryKeys.all, 'issue', projectPath, issueNumber] as const,
  loadedContexts: (sessionId: string, worktreeId?: string | null) =>
    worktreeId
      ? ([
          ...githubQueryKeys.all,
          'loaded-contexts',
          sessionId,
          worktreeId,
        ] as const)
      : ([...githubQueryKeys.all, 'loaded-contexts', sessionId] as const),
  prs: (projectPath: string, state: string) =>
    [...githubQueryKeys.all, 'prs', projectPath, state] as const,
  pr: (projectPath: string, prNumber: number) =>
    [...githubQueryKeys.all, 'pr', projectPath, prNumber] as const,
  loadedPrContexts: (sessionId: string, worktreeId?: string | null) =>
    worktreeId
      ? ([
          ...githubQueryKeys.all,
          'loaded-pr-contexts',
          sessionId,
          worktreeId,
        ] as const)
      : ([...githubQueryKeys.all, 'loaded-pr-contexts', sessionId] as const),
  attachedContexts: (sessionId: string) =>
    [...githubQueryKeys.all, 'attached-contexts', sessionId] as const,
  issueSearch: (projectPath: string, query: string) =>
    [...githubQueryKeys.all, 'issue-search', projectPath, query] as const,
  prSearch: (projectPath: string, query: string) =>
    [...githubQueryKeys.all, 'pr-search', projectPath, query] as const,
  issueByNumber: (projectPath: string, number: number) =>
    [...githubQueryKeys.all, 'issue-by-number', projectPath, number] as const,
  prByNumber: (projectPath: string, number: number) =>
    [...githubQueryKeys.all, 'pr-by-number', projectPath, number] as const,
  workflowRuns: (projectPath: string, branch?: string) =>
    [
      ...githubQueryKeys.all,
      'workflow-runs',
      projectPath,
      branch ?? '',
    ] as const,
  securityAlerts: (projectPath: string, state: string) =>
    [...githubQueryKeys.all, 'security-alerts', projectPath, state] as const,
  securityAlert: (projectPath: string, alertNumber: number) =>
    [
      ...githubQueryKeys.all,
      'security-alert',
      projectPath,
      alertNumber,
    ] as const,
  loadedSecurityContexts: (sessionId: string, worktreeId?: string | null) =>
    worktreeId
      ? ([
          ...githubQueryKeys.all,
          'loaded-security-contexts',
          sessionId,
          worktreeId,
        ] as const)
      : ([
          ...githubQueryKeys.all,
          'loaded-security-contexts',
          sessionId,
        ] as const),
  advisories: (projectPath: string, state: string) =>
    [...githubQueryKeys.all, 'advisories', projectPath, state] as const,
  advisory: (projectPath: string, ghsaId: string) =>
    [...githubQueryKeys.all, 'advisory', projectPath, ghsaId] as const,
  loadedAdvisoryContexts: (sessionId: string, worktreeId?: string | null) =>
    worktreeId
      ? ([
          ...githubQueryKeys.all,
          'loaded-advisory-contexts',
          sessionId,
          worktreeId,
        ] as const)
      : ([
          ...githubQueryKeys.all,
          'loaded-advisory-contexts',
          sessionId,
        ] as const),
}

/**
 * Hook to list GitHub issues for a project
 *
 * @param projectPath - Path to the git repository
 * @param state - Issue state: "open", "closed", or "all"
 */
export function useGitHubIssues(
  projectPath: string | null,
  state: 'open' | 'closed' | 'all' = 'open',
  options?: { enabled?: boolean; staleTime?: number }
) {
  return useQuery({
    queryKey: githubQueryKeys.issues(projectPath ?? '', state),
    queryFn: async (): Promise<GitHubIssueListResult> => {
      if (!isTauri() || !projectPath) {
        return { issues: [], totalCount: 0 }
      }

      try {
        logger.debug('Fetching GitHub issues', { projectPath, state })
        const result = await invoke<GitHubIssueListResult>(
          'list_github_issues',
          {
            projectPath,
            state,
          }
        )
        logger.info('GitHub issues loaded', {
          count: result.issues.length,
          totalCount: result.totalCount,
        })
        return result
      } catch (error) {
        logger.error('Failed to load GitHub issues', { error, projectPath })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectPath,
    staleTime: options?.staleTime ?? 1000 * 60 * 2, // default 2 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    retry: 1, // Only retry once for API errors
  })
}

/**
 * Hook to get detailed information about a specific GitHub issue
 *
 * @param projectPath - Path to the git repository
 * @param issueNumber - Issue number to fetch
 */
export function useGitHubIssue(
  projectPath: string | null,
  issueNumber: number | null
) {
  return useQuery({
    queryKey: githubQueryKeys.issue(projectPath ?? '', issueNumber ?? 0),
    queryFn: async (): Promise<GitHubIssueDetail> => {
      if (!isTauri() || !projectPath || !issueNumber) {
        throw new Error('Missing required parameters')
      }

      try {
        logger.debug('Fetching GitHub issue details', {
          projectPath,
          issueNumber,
        })
        const issue = await invoke<GitHubIssueDetail>('get_github_issue', {
          projectPath,
          issueNumber,
        })
        logger.info('GitHub issue loaded', {
          number: issue.number,
          title: issue.title,
        })
        return issue
      } catch (error) {
        logger.error('Failed to load GitHub issue', {
          error,
          projectPath,
          issueNumber,
        })
        throw error
      }
    },
    enabled: !!projectPath && !!issueNumber,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 15, // 15 minutes
  })
}

const NEW_ISSUE_CUTOFF_MS = 24 * 60 * 60 * 1000

/** Check if an issue was created within the last 24 hours */
export function isNewIssue(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() < NEW_ISSUE_CUTOFF_MS
}

/** Count issues created within the last 24 hours */
export function countNewIssues(issues: GitHubIssue[]): number {
  const cutoff = Date.now() - NEW_ISSUE_CUTOFF_MS
  return issues.filter(i => new Date(i.created_at).getTime() > cutoff).length
}

/**
 * Filter issues by search query (number, title, or body)
 *
 * Used for local filtering in the modal component
 */

/**
 * Parse a search query for `label:"name"` directives.
 * Returns required labels (all must match) and the remaining free-text query.
 *
 * Examples:
 *   'label:"bug" crash'  → { labels: ['bug'], textQuery: 'crash' }
 *   'label:"bug" label:"high priority"' → { labels: ['bug', 'high priority'], textQuery: '' }
 */
export function parseLabelQuery(query: string): {
  labels: string[]
  textQuery: string
} {
  const labels: string[] = []
  const textQuery = query
    .replace(/label:"([^"]+)"/gi, (_, name) => {
      labels.push(name.toLowerCase())
      return ''
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { labels, textQuery }
}

export function filterIssues(
  issues: GitHubIssue[],
  query: string
): GitHubIssue[] {
  if (!query.trim()) {
    return issues
  }

  const { labels, textQuery } = parseLabelQuery(query)
  const lowerQuery = textQuery.toLowerCase()

  return issues.filter(issue => {
    // All specified labels must be present
    if (labels.length > 0) {
      const issueLabels = issue.labels.map(l => l.name.toLowerCase())
      if (!labels.every(l => issueLabels.some(il => il.includes(l)))) {
        return false
      }
    }

    // If no text query remains, label match is enough
    if (!lowerQuery) return true

    // Match by issue number (e.g., "123" or "#123")
    const numberQuery = lowerQuery.replace(/^#/, '')
    if (issue.number.toString().includes(numberQuery)) {
      return true
    }

    // Match by title
    if (issue.title.toLowerCase().includes(lowerQuery)) {
      return true
    }

    // Match by body
    if (issue.body?.toLowerCase().includes(lowerQuery)) {
      return true
    }

    // Match by label name
    if (issue.labels.some(l => l.name.toLowerCase().includes(lowerQuery))) {
      return true
    }

    return false
  })
}

/**
 * Hook to search GitHub issues using GitHub's search API
 *
 * Queries GitHub directly via `gh issue list --search`, which finds
 * issues beyond the default list limit of 100.
 *
 * @param projectPath - Path to the git repository
 * @param query - Search query (should be debounced by caller)
 */
export function useSearchGitHubIssues(
  projectPath: string | null,
  query: string
) {
  return useQuery({
    queryKey: githubQueryKeys.issueSearch(projectPath ?? '', query),
    queryFn: async (): Promise<GitHubIssue[]> => {
      if (!isTauri() || !projectPath || !query) {
        return []
      }

      try {
        logger.debug('Searching GitHub issues', { projectPath, query })
        const issues = await invoke<GitHubIssue[]>('search_github_issues', {
          projectPath,
          query,
        })
        logger.info('GitHub issue search results', {
          count: issues.length,
          query,
        })
        return issues
      } catch (error) {
        logger.error('Failed to search GitHub issues', {
          error,
          projectPath,
          query,
        })
        throw error
      }
    },
    enabled: !!projectPath && query.length >= 2,
    staleTime: 1000 * 30, // 30 seconds
    gcTime: 1000 * 60 * 5, // 5 minutes
    retry: 0,
  })
}

/**
 * Hook to list loaded issue contexts for a session
 *
 * @param sessionId - The session ID
 */
export function useLoadedIssueContexts(
  sessionId: string | null,
  worktreeId?: string | null
) {
  return useQuery({
    queryKey: githubQueryKeys.loadedContexts(sessionId ?? '', worktreeId),
    queryFn: async (): Promise<LoadedIssueContext[]> => {
      if (!isTauri() || !sessionId) {
        return []
      }

      try {
        logger.debug('Fetching loaded issue contexts', { sessionId })
        const contexts = await invoke<LoadedIssueContext[]>(
          'list_loaded_issue_contexts',
          {
            sessionId,
            worktreeId: worktreeId ?? undefined,
          }
        )
        logger.info('Loaded issue contexts fetched', { count: contexts.length })
        return contexts
      } catch (error) {
        logger.error('Failed to load issue contexts', { error, sessionId })
        throw error
      }
    },
    enabled: !!sessionId,
    staleTime: 1000 * 60, // 1 minute
    gcTime: 1000 * 60 * 5, // 5 minutes
  })
}

/**
 * Load issue context for a session (fetch from GitHub and save)
 */
export async function loadIssueContext(
  sessionId: string,
  issueNumber: number,
  projectPath: string
): Promise<LoadedIssueContext> {
  return invoke<LoadedIssueContext>('load_issue_context', {
    sessionId,
    issueNumber,
    projectPath,
  })
}

/**
 * Remove a loaded issue context from a session
 */
export async function removeIssueContext(
  sessionId: string,
  issueNumber: number,
  projectPath: string
): Promise<void> {
  return invoke('remove_issue_context', {
    sessionId,
    issueNumber,
    projectPath,
  })
}

// =============================================================================
// GitHub Pull Request Hooks and Functions
// =============================================================================

/**
 * Hook to list GitHub pull requests for a project
 *
 * @param projectPath - Path to the git repository
 * @param state - PR state: "open", "closed", "merged", or "all"
 */
export function useGitHubPRs(
  projectPath: string | null,
  state: 'open' | 'closed' | 'merged' | 'all' = 'open',
  options?: { enabled?: boolean; staleTime?: number }
) {
  return useQuery({
    queryKey: githubQueryKeys.prs(projectPath ?? '', state),
    queryFn: async (): Promise<GitHubPullRequest[]> => {
      if (!isTauri() || !projectPath) {
        return []
      }

      try {
        logger.debug('Fetching GitHub PRs', { projectPath, state })
        const prs = await invoke<GitHubPullRequest[]>('list_github_prs', {
          projectPath,
          state,
        })
        logger.info('GitHub PRs loaded', { count: prs.length })
        return prs
      } catch (error) {
        logger.error('Failed to load GitHub PRs', { error, projectPath })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectPath,
    staleTime: options?.staleTime ?? 1000 * 60 * 2, // default 2 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    retry: 1, // Only retry once for API errors
  })
}

/**
 * Hook to get detailed information about a specific GitHub PR
 *
 * @param projectPath - Path to the git repository
 * @param prNumber - PR number to fetch
 */
export function useGitHubPR(
  projectPath: string | null,
  prNumber: number | null
) {
  return useQuery({
    queryKey: githubQueryKeys.pr(projectPath ?? '', prNumber ?? 0),
    queryFn: async (): Promise<GitHubPullRequestDetail> => {
      if (!isTauri() || !projectPath || !prNumber) {
        throw new Error('Missing required parameters')
      }

      try {
        logger.debug('Fetching GitHub PR details', { projectPath, prNumber })
        const pr = await invoke<GitHubPullRequestDetail>('get_github_pr', {
          projectPath,
          prNumber,
        })
        logger.info('GitHub PR loaded', { number: pr.number, title: pr.title })
        return pr
      } catch (error) {
        logger.error('Failed to load GitHub PR', {
          error,
          projectPath,
          prNumber,
        })
        throw error
      }
    },
    enabled: !!projectPath && !!prNumber,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 15, // 15 minutes
  })
}

/**
 * Hook to list loaded PR contexts for a session
 *
 * @param sessionId - The session ID
 */
export function useLoadedPRContexts(
  sessionId: string | null,
  worktreeId?: string | null
) {
  return useQuery({
    queryKey: githubQueryKeys.loadedPrContexts(sessionId ?? '', worktreeId),
    queryFn: async (): Promise<LoadedPullRequestContext[]> => {
      if (!isTauri() || !sessionId) {
        return []
      }

      try {
        logger.debug('Fetching loaded PR contexts', { sessionId })
        const contexts = await invoke<LoadedPullRequestContext[]>(
          'list_loaded_pr_contexts',
          {
            sessionId,
            worktreeId: worktreeId ?? undefined,
          }
        )
        logger.info('Loaded PR contexts fetched', { count: contexts.length })
        return contexts
      } catch (error) {
        logger.error('Failed to load PR contexts', { error, sessionId })
        throw error
      }
    },
    enabled: !!sessionId,
    staleTime: 1000 * 60, // 1 minute
    gcTime: 1000 * 60 * 5, // 5 minutes
  })
}

/**
 * Load PR context for a session (fetch from GitHub and save)
 */
export async function loadPRContext(
  sessionId: string,
  prNumber: number,
  projectPath: string
): Promise<LoadedPullRequestContext> {
  return invoke<LoadedPullRequestContext>('load_pr_context', {
    sessionId,
    prNumber,
    projectPath,
  })
}

/**
 * Remove a loaded PR context from a session
 */
export async function removePRContext(
  sessionId: string,
  prNumber: number,
  projectPath: string
): Promise<void> {
  return invoke('remove_pr_context', {
    sessionId,
    prNumber,
    projectPath,
  })
}

/**
 * Get the content of a loaded issue context file
 */
export async function getIssueContextContent(
  sessionId: string,
  issueNumber: number,
  projectPath: string
): Promise<string> {
  return invoke<string>('get_issue_context_content', {
    sessionId,
    issueNumber,
    projectPath,
  })
}

/**
 * Get the content of a loaded PR context file
 */
export async function getPRContextContent(
  sessionId: string,
  prNumber: number,
  projectPath: string
): Promise<string> {
  return invoke<string>('get_pr_context_content', {
    sessionId,
    prNumber,
    projectPath,
  })
}

/**
 * Filter PRs by search query (number, title, or body)
 *
 * Used for local filtering in the modal component
 */
export function filterPRs(
  prs: GitHubPullRequest[],
  query: string
): GitHubPullRequest[] {
  if (!query.trim()) {
    return prs
  }

  const { labels, textQuery } = parseLabelQuery(query)
  const lowerQuery = textQuery.toLowerCase()

  return prs.filter(pr => {
    // All specified labels must be present
    if (labels.length > 0) {
      const prLabels = pr.labels.map(l => l.name.toLowerCase())
      if (!labels.every(l => prLabels.some(pl => pl.includes(l)))) {
        return false
      }
    }

    // If no text query remains, label match is enough
    if (!lowerQuery) return true

    // Match by PR number (e.g., "123" or "#123")
    const numberQuery = lowerQuery.replace(/^#/, '')
    if (pr.number.toString().includes(numberQuery)) {
      return true
    }

    // Match by title
    if (pr.title.toLowerCase().includes(lowerQuery)) {
      return true
    }

    // Match by body
    if (pr.body?.toLowerCase().includes(lowerQuery)) {
      return true
    }

    // Match by branch name
    if (pr.headRefName.toLowerCase().includes(lowerQuery)) {
      return true
    }

    // Match by label name
    if (pr.labels.some(l => l.name.toLowerCase().includes(lowerQuery))) {
      return true
    }

    return false
  })
}

/**
 * Hook to search GitHub PRs using GitHub's search API
 *
 * Queries GitHub directly via `gh pr list --search`, which finds
 * PRs beyond the default list limit of 100.
 *
 * @param projectPath - Path to the git repository
 * @param query - Search query (should be debounced by caller)
 */
export function useSearchGitHubPRs(projectPath: string | null, query: string) {
  return useQuery({
    queryKey: githubQueryKeys.prSearch(projectPath ?? '', query),
    queryFn: async (): Promise<GitHubPullRequest[]> => {
      if (!isTauri() || !projectPath || !query) {
        return []
      }

      try {
        logger.debug('Searching GitHub PRs', { projectPath, query })
        const prs = await invoke<GitHubPullRequest[]>('search_github_prs', {
          projectPath,
          query,
        })
        logger.info('GitHub PR search results', { count: prs.length, query })
        return prs
      } catch (error) {
        logger.error('Failed to search GitHub PRs', {
          error,
          projectPath,
          query,
        })
        throw error
      }
    },
    enabled: !!projectPath && query.length >= 2,
    staleTime: 1000 * 30, // 30 seconds
    gcTime: 1000 * 60 * 5, // 5 minutes
    retry: 0,
  })
}

/**
 * Merge local-filtered results with remote search results, deduplicating by number.
 * Local results appear first, remote-only results are appended.
 */
export function mergeWithSearchResults<T extends { number: number }>(
  localResults: T[],
  searchResults: T[] | undefined
): T[] {
  if (!searchResults?.length) return localResults

  const localNumbers = new Set(localResults.map(item => item.number))
  const remoteOnly = searchResults.filter(
    item => !localNumbers.has(item.number)
  )

  if (remoteOnly.length === 0) return localResults
  return [...localResults, ...remoteOnly]
}

/**
 * Parse a search query as a GitHub item number.
 * Accepts "123" or "#123", returns the number or null.
 */
export function parseItemNumber(query: string): number | null {
  const trimmed = query.trim().replace(/^#/, '')
  if (!trimmed || !/^\d+$/.test(trimmed)) return null
  const num = parseInt(trimmed, 10)
  return num > 0 ? num : null
}

/**
 * Prepend an exact-match item to an array, deduplicating by number.
 */
export function prependExactMatch<T extends { number: number }>(
  items: T[],
  exactMatch: T | undefined | null
): T[] {
  if (!exactMatch) return items
  const filtered = items.filter(item => item.number !== exactMatch.number)
  return [exactMatch, ...filtered]
}

/**
 * Hook to fetch a single GitHub issue by exact number.
 * Returns the same GitHubIssue type as list_github_issues.
 */
export function useGetGitHubIssueByNumber(
  projectPath: string | null,
  query: string
) {
  const itemNumber = parseItemNumber(query)
  return useQuery({
    queryKey: githubQueryKeys.issueByNumber(projectPath ?? '', itemNumber ?? 0),
    queryFn: async (): Promise<GitHubIssue | null> => {
      if (!isTauri() || !projectPath || !itemNumber) return null
      try {
        return await invoke<GitHubIssue>('get_github_issue_by_number', {
          projectPath,
          issueNumber: itemNumber,
        })
      } catch {
        return null
      }
    },
    enabled: !!projectPath && itemNumber !== null,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    retry: 0,
  })
}

/**
 * Hook to fetch a single GitHub PR by exact number.
 * Returns the same GitHubPullRequest type as list_github_prs.
 */
export function useGetGitHubPRByNumber(
  projectPath: string | null,
  query: string
) {
  const itemNumber = parseItemNumber(query)
  return useQuery({
    queryKey: githubQueryKeys.prByNumber(projectPath ?? '', itemNumber ?? 0),
    queryFn: async (): Promise<GitHubPullRequest | null> => {
      if (!isTauri() || !projectPath || !itemNumber) return null
      try {
        return await invoke<GitHubPullRequest>('get_github_pr_by_number', {
          projectPath,
          prNumber: itemNumber,
        })
      } catch {
        return null
      }
    },
    enabled: !!projectPath && itemNumber !== null,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    retry: 0,
  })
}

// =============================================================================
// Dependabot Alert / Security Hooks and Functions
// =============================================================================

/**
 * Hook to list Dependabot alerts for a project
 *
 * @param projectPath - Path to the git repository
 * @param state - Alert state filter: "open" or "all"
 */
export function useDependabotAlerts(
  projectPath: string | null,
  state: 'open' | 'all' = 'open',
  options?: { enabled?: boolean; staleTime?: number }
) {
  return useQuery({
    queryKey: githubQueryKeys.securityAlerts(projectPath ?? '', state),
    queryFn: async (): Promise<DependabotAlert[]> => {
      if (!isTauri() || !projectPath) {
        return []
      }

      try {
        logger.debug('Fetching Dependabot alerts', { projectPath, state })
        const stateParam =
          state === 'all' ? 'open,dismissed,fixed,auto_dismissed' : state
        const alerts = await invoke<DependabotAlert[]>(
          'list_dependabot_alerts',
          {
            projectPath,
            state: stateParam,
          }
        )
        logger.info('Dependabot alerts loaded', { count: alerts.length })
        return alerts
      } catch (error) {
        // Auth errors should propagate so GhAuthError UI is shown
        if (isGhAuthError(error)) throw error
        // Other errors (permissions, feature not available) — treat as empty
        logger.debug('Dependabot alerts not available', {
          error,
          projectPath,
        })
        return []
      }
    },
    enabled: (options?.enabled ?? true) && !!projectPath,
    staleTime: options?.staleTime ?? 1000 * 60 * 2, // 2 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    retry: 1,
  })
}

/**
 * Hook to fetch a single Dependabot alert by number
 *
 * @param projectPath - The project path
 * @param alertNumber - The alert number, or null to skip
 */
export function useDependabotAlert(
  projectPath: string | null,
  alertNumber: number | null
) {
  return useQuery({
    queryKey: githubQueryKeys.securityAlert(
      projectPath ?? '',
      alertNumber ?? 0
    ),
    queryFn: async (): Promise<DependabotAlert> => {
      if (!isTauri() || !projectPath || !alertNumber) {
        throw new Error('Missing required parameters')
      }

      try {
        logger.debug('Fetching Dependabot alert', {
          projectPath,
          alertNumber,
        })
        const alert = await invoke<DependabotAlert>('get_dependabot_alert', {
          projectPath,
          alertNumber,
        })
        logger.info('Dependabot alert loaded', {
          number: alert.number,
          severity: alert.severity,
        })
        return alert
      } catch (error) {
        logger.error('Failed to load Dependabot alert', {
          error,
          projectPath,
          alertNumber,
        })
        throw error
      }
    },
    enabled: !!projectPath && !!alertNumber,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 15, // 15 minutes
  })
}

/**
 * Hook to list loaded security alert contexts for a session
 */
export function useLoadedSecurityContexts(
  sessionId: string | null,
  worktreeId?: string | null
) {
  return useQuery({
    queryKey: githubQueryKeys.loadedSecurityContexts(
      sessionId ?? '',
      worktreeId
    ),
    queryFn: async (): Promise<LoadedSecurityAlertContext[]> => {
      if (!isTauri() || !sessionId) {
        return []
      }

      try {
        logger.debug('Fetching loaded security contexts', { sessionId })
        const contexts = await invoke<LoadedSecurityAlertContext[]>(
          'list_loaded_security_contexts',
          {
            sessionId,
            worktreeId: worktreeId ?? undefined,
          }
        )
        logger.info('Loaded security contexts fetched', {
          count: contexts.length,
        })
        return contexts
      } catch (error) {
        logger.debug('Failed to load security contexts', {
          error,
          sessionId,
        })
        return []
      }
    },
    enabled: !!sessionId,
    staleTime: 1000 * 60, // 1 minute
    gcTime: 1000 * 60 * 5, // 5 minutes
  })
}

/**
 * Load security alert context for a session (fetch from GitHub and save)
 */
export async function loadSecurityContext(
  sessionId: string,
  alertNumber: number,
  projectPath: string
): Promise<LoadedSecurityAlertContext> {
  return invoke<LoadedSecurityAlertContext>('load_security_alert_context', {
    sessionId,
    alertNumber,
    projectPath,
  })
}

/**
 * Remove a loaded security alert context from a session
 */
export async function removeSecurityContext(
  sessionId: string,
  alertNumber: number,
  projectPath: string
): Promise<void> {
  return invoke('remove_security_context', {
    sessionId,
    alertNumber,
    projectPath,
  })
}

/**
 * Get the content of a loaded security context file
 */
export async function getSecurityContextContent(
  sessionId: string,
  alertNumber: number,
  projectPath: string
): Promise<string> {
  return invoke<string>('get_security_context_content', {
    sessionId,
    alertNumber,
    projectPath,
  })
}

/**
 * Filter Dependabot alerts by search query
 */
export function filterSecurityAlerts(
  alerts: DependabotAlert[],
  query: string
): DependabotAlert[] {
  if (!query.trim()) return alerts

  const lowerQuery = query.toLowerCase().trim()

  return alerts.filter(alert => {
    const numberQuery = lowerQuery.replace(/^#/, '')
    if (alert.number.toString().includes(numberQuery)) return true
    if (alert.packageName.toLowerCase().includes(lowerQuery)) return true
    if (alert.summary.toLowerCase().includes(lowerQuery)) return true
    if (alert.ghsaId.toLowerCase().includes(lowerQuery)) return true
    if (alert.cveId?.toLowerCase().includes(lowerQuery)) return true
    if (alert.severity.toLowerCase().includes(lowerQuery)) return true
    return false
  })
}

// =============================================================================
// Repository Security Advisory Hooks and Functions
// =============================================================================

/**
 * Hook to list repository security advisories for a project
 *
 * @param projectPath - Path to the git repository
 * @param state - Advisory state filter: "published" or "all"
 */
export function useRepositoryAdvisories(
  projectPath: string | null,
  state?: string,
  options?: { enabled?: boolean; staleTime?: number }
) {
  return useQuery({
    queryKey: githubQueryKeys.advisories(projectPath ?? '', state ?? 'all'),
    queryFn: async (): Promise<RepositoryAdvisory[]> => {
      if (!isTauri() || !projectPath) {
        return []
      }

      try {
        logger.debug('Fetching repository advisories', { projectPath, state })
        const advisories = await invoke<RepositoryAdvisory[]>(
          'list_repository_advisories',
          {
            projectPath,
            state: state ?? null,
          }
        )
        logger.info('Repository advisories loaded', {
          count: advisories.length,
        })
        return advisories
      } catch (error) {
        // Auth errors should propagate so GhAuthError UI is shown
        if (isGhAuthError(error)) throw error
        // Other errors (permissions, feature not available) — treat as empty
        logger.debug('Repository advisories not available', {
          error,
          projectPath,
        })
        return []
      }
    },
    enabled: (options?.enabled ?? true) && !!projectPath,
    staleTime: options?.staleTime ?? 1000 * 60 * 2, // 2 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    retry: 1,
  })
}

/**
 * Hook to fetch a single repository advisory by GHSA ID
 *
 * @param projectPath - The project path
 * @param ghsaId - The GHSA ID, or null to skip
 */
export function useRepositoryAdvisory(
  projectPath: string | null,
  ghsaId: string | null
) {
  return useQuery({
    queryKey: githubQueryKeys.advisory(projectPath ?? '', ghsaId ?? ''),
    queryFn: async (): Promise<RepositoryAdvisory> => {
      if (!isTauri() || !projectPath || !ghsaId) {
        throw new Error('Missing required parameters')
      }

      try {
        logger.debug('Fetching repository advisory', { projectPath, ghsaId })
        const advisory = await invoke<RepositoryAdvisory>(
          'get_repository_advisory',
          {
            projectPath,
            ghsaId,
          }
        )
        logger.info('Repository advisory loaded', {
          ghsaId: advisory.ghsaId,
          severity: advisory.severity,
        })
        return advisory
      } catch (error) {
        logger.error('Failed to load repository advisory', {
          error,
          projectPath,
          ghsaId,
        })
        throw error
      }
    },
    enabled: !!projectPath && !!ghsaId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}

/**
 * Hook to list loaded advisory contexts for a session
 */
export function useLoadedAdvisoryContexts(
  sessionId: string | null,
  worktreeId?: string | null
) {
  return useQuery({
    queryKey: githubQueryKeys.loadedAdvisoryContexts(
      sessionId ?? '',
      worktreeId
    ),
    queryFn: async (): Promise<LoadedAdvisoryContext[]> => {
      if (!isTauri() || !sessionId) {
        return []
      }

      try {
        logger.debug('Fetching loaded advisory contexts', { sessionId })
        const contexts = await invoke<LoadedAdvisoryContext[]>(
          'list_loaded_advisory_contexts',
          {
            sessionId,
            worktreeId: worktreeId ?? undefined,
          }
        )
        logger.info('Loaded advisory contexts fetched', {
          count: contexts.length,
        })
        return contexts
      } catch (error) {
        logger.debug('Failed to load advisory contexts', {
          error,
          sessionId,
        })
        return []
      }
    },
    enabled: !!sessionId,
    staleTime: 1000 * 60, // 1 minute
    gcTime: 1000 * 60 * 5, // 5 minutes
  })
}

/**
 * Load advisory context for a session (fetch from GitHub and save)
 */
export async function loadAdvisoryContext(
  sessionId: string,
  ghsaId: string,
  projectPath: string
): Promise<LoadedAdvisoryContext> {
  return invoke<LoadedAdvisoryContext>('load_advisory_context', {
    sessionId,
    ghsaId,
    projectPath,
  })
}

/**
 * Remove a loaded advisory context from a session
 */
export async function removeAdvisoryContext(
  sessionId: string,
  ghsaId: string,
  projectPath: string
): Promise<void> {
  return invoke('remove_advisory_context', {
    sessionId,
    ghsaId,
    projectPath,
  })
}

/**
 * Get the content of a loaded advisory context file
 */
export async function getAdvisoryContextContent(
  sessionId: string,
  ghsaId: string,
  projectPath: string
): Promise<string> {
  return invoke<string>('get_advisory_context_content', {
    sessionId,
    ghsaId,
    projectPath,
  })
}

/**
 * Filter repository advisories by search query
 */
export function filterAdvisories(
  advisories: RepositoryAdvisory[],
  query: string
): RepositoryAdvisory[] {
  if (!query.trim()) return advisories
  const lower = query.toLowerCase()
  return advisories.filter(
    a =>
      a.ghsaId.toLowerCase().includes(lower) ||
      (a.cveId && a.cveId.toLowerCase().includes(lower)) ||
      a.summary.toLowerCase().includes(lower) ||
      a.severity.toLowerCase().includes(lower) ||
      a.vulnerabilities.some(
        v =>
          v.packageName.toLowerCase().includes(lower) ||
          v.packageEcosystem.toLowerCase().includes(lower)
      )
  )
}

// =============================================================================
// GitHub Actions Workflow Runs
// =============================================================================

/**
 * Hook to list GitHub Actions workflow runs for a project
 *
 * @param projectPath - Path to the git repository
 * @param branch - Optional branch name to filter runs (for PR/worktree-specific views)
 */
export function useWorkflowRuns(
  projectPath: string | null,
  branch?: string,
  options?: { enabled?: boolean; staleTime?: number }
) {
  return useQuery({
    queryKey: githubQueryKeys.workflowRuns(projectPath ?? '', branch),
    queryFn: async (): Promise<WorkflowRunsResult> => {
      if (!isTauri() || !projectPath) {
        return { runs: [], failedCount: 0 }
      }

      try {
        logger.debug('Fetching workflow runs', { projectPath, branch })
        const result = await invoke<WorkflowRunsResult>('list_workflow_runs', {
          projectPath,
          branch: branch ?? null,
        })
        logger.info('Workflow runs loaded', {
          count: result.runs.length,
          failedCount: result.failedCount,
        })
        return result
      } catch (error) {
        logger.error('Failed to load workflow runs', { error, projectPath })
        throw error
      }
    },
    enabled: (options?.enabled ?? true) && !!projectPath,
    staleTime: options?.staleTime ?? 1000 * 60 * 3, // 3 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    retry: 1,
  })
}

// =============================================================================
// Attached Saved Context Hooks and Functions
// =============================================================================

/**
 * Hook to list attached saved contexts for a session
 *
 * @param sessionId - The session ID
 */
export function useAttachedSavedContexts(sessionId: string | null) {
  return useQuery({
    queryKey: githubQueryKeys.attachedContexts(sessionId ?? ''),
    queryFn: async (): Promise<AttachedSavedContext[]> => {
      if (!isTauri() || !sessionId) {
        return []
      }

      try {
        logger.debug('Fetching attached saved contexts', { sessionId })
        const contexts = await invoke<AttachedSavedContext[]>(
          'list_attached_saved_contexts',
          {
            sessionId,
          }
        )
        logger.info('Attached saved contexts fetched', {
          count: contexts.length,
        })
        return contexts
      } catch (error) {
        logger.error('Failed to load attached saved contexts', {
          error,
          sessionId,
        })
        throw error
      }
    },
    enabled: !!sessionId,
    staleTime: 1000 * 60, // 1 minute
    gcTime: 1000 * 60 * 5, // 5 minutes
  })
}

/**
 * Attach a saved context to a session (copy file to session-specific location)
 */
export async function attachSavedContext(
  sessionId: string,
  sourcePath: string,
  slug: string
): Promise<AttachedSavedContext> {
  return invoke<AttachedSavedContext>('attach_saved_context', {
    sessionId,
    sourcePath,
    slug,
  })
}

/**
 * Remove an attached saved context from a session
 */
export async function removeSavedContext(
  sessionId: string,
  slug: string
): Promise<void> {
  return invoke('remove_saved_context', {
    sessionId,
    slug,
  })
}

/**
 * Get the content of an attached saved context file
 */
export async function getSavedContextContent(
  sessionId: string,
  slug: string
): Promise<string> {
  return invoke<string>('get_saved_context_content', {
    sessionId,
    slug,
  })
}
