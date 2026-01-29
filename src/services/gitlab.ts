/**
 * GitLab service for issues and merge requests
 *
 * Provides TanStack Query hooks for interacting with GitLab via the glab CLI.
 */

import { useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@/lib/logger'
import type {
  GitLabIssue,
  GitLabIssueDetail,
  GitLabMergeRequest,
  GitLabMergeRequestDetail,
  LoadedGitLabIssueContext,
  LoadedGitLabMergeRequestContext,
} from '@/types/gitlab'
import { isTauri } from './projects'

// Query keys for GitLab
export const gitlabQueryKeys = {
  all: ['gitlab'] as const,
  issues: (projectPath: string, state: string) =>
    [...gitlabQueryKeys.all, 'issues', projectPath, state] as const,
  issue: (projectPath: string, issueIid: number) =>
    [...gitlabQueryKeys.all, 'issue', projectPath, issueIid] as const,
  loadedIssueContexts: (worktreeId: string) =>
    [...gitlabQueryKeys.all, 'loaded-issue-contexts', worktreeId] as const,
  mrs: (projectPath: string, state: string) =>
    [...gitlabQueryKeys.all, 'mrs', projectPath, state] as const,
  mr: (projectPath: string, mrIid: number) =>
    [...gitlabQueryKeys.all, 'mr', projectPath, mrIid] as const,
  loadedMrContexts: (worktreeId: string) =>
    [...gitlabQueryKeys.all, 'loaded-mr-contexts', worktreeId] as const,
}

/**
 * Hook to list GitLab issues for a project
 *
 * @param projectPath - Path to the git repository
 * @param state - Issue state: "opened", "closed", or "all" (note: GitLab uses "opened" not "open")
 */
export function useGitLabIssues(
  projectPath: string | null,
  state: 'opened' | 'closed' | 'all' = 'opened'
) {
  return useQuery({
    queryKey: gitlabQueryKeys.issues(projectPath ?? '', state),
    queryFn: async (): Promise<GitLabIssue[]> => {
      if (!isTauri() || !projectPath) {
        return []
      }

      try {
        logger.debug('Fetching GitLab issues', { projectPath, state })
        const issues = await invoke<GitLabIssue[]>('list_gitlab_issues', {
          projectPath,
          state,
        })
        logger.info('GitLab issues loaded', { count: issues.length })
        return issues
      } catch (error) {
        logger.error('Failed to load GitLab issues', { error, projectPath })
        throw error
      }
    },
    enabled: !!projectPath,
    staleTime: 1000 * 60 * 2, // 2 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    retry: 1,
  })
}

/**
 * Hook to get detailed information about a specific GitLab issue
 *
 * @param projectPath - Path to the git repository
 * @param issueIid - Issue IID (internal ID) to fetch
 */
export function useGitLabIssue(projectPath: string | null, issueIid: number | null) {
  return useQuery({
    queryKey: gitlabQueryKeys.issue(projectPath ?? '', issueIid ?? 0),
    queryFn: async (): Promise<GitLabIssueDetail> => {
      if (!isTauri() || !projectPath || !issueIid) {
        throw new Error('Missing required parameters')
      }

      try {
        logger.debug('Fetching GitLab issue details', { projectPath, issueIid })
        const issue = await invoke<GitLabIssueDetail>('get_gitlab_issue', {
          projectPath,
          issueIid,
        })
        logger.info('GitLab issue loaded', { iid: issue.iid, title: issue.title })
        return issue
      } catch (error) {
        logger.error('Failed to load GitLab issue', { error, projectPath, issueIid })
        throw error
      }
    },
    enabled: !!projectPath && !!issueIid,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 15, // 15 minutes
  })
}

/**
 * Filter issues by search query (iid, title, or description)
 */
export function filterGitLabIssues(issues: GitLabIssue[], query: string): GitLabIssue[] {
  if (!query.trim()) {
    return issues
  }

  const lowerQuery = query.toLowerCase().trim()

  return issues.filter(issue => {
    // Match by issue IID (e.g., "123" or "!123")
    const iidQuery = lowerQuery.replace(/^[!#]/, '')
    if (issue.iid.toString().includes(iidQuery)) {
      return true
    }

    // Match by title
    if (issue.title.toLowerCase().includes(lowerQuery)) {
      return true
    }

    // Match by description
    if (issue.description?.toLowerCase().includes(lowerQuery)) {
      return true
    }

    return false
  })
}

/**
 * Load issue context for a worktree (fetch from GitLab and save)
 */
export async function loadGitLabIssueContext(
  worktreeId: string,
  issueIid: number,
  projectPath: string
): Promise<LoadedGitLabIssueContext> {
  return invoke<LoadedGitLabIssueContext>('load_gitlab_issue_context', {
    worktreeId,
    issueIid,
    projectPath,
  })
}

/**
 * Remove a loaded issue context from a worktree
 */
export async function removeGitLabIssueContext(
  worktreeId: string,
  issueIid: number,
  projectPath: string
): Promise<void> {
  await invoke('remove_gitlab_issue_context', {
    worktreeId,
    issueIid,
    projectPath,
  })
}

// =============================================================================
// GitLab Merge Request Hooks and Functions
// =============================================================================

/**
 * Hook to list GitLab merge requests for a project
 *
 * @param projectPath - Path to the git repository
 * @param state - MR state: "opened", "closed", "merged", or "all"
 */
export function useGitLabMRs(
  projectPath: string | null,
  state: 'opened' | 'closed' | 'merged' | 'all' = 'opened'
) {
  return useQuery({
    queryKey: gitlabQueryKeys.mrs(projectPath ?? '', state),
    queryFn: async (): Promise<GitLabMergeRequest[]> => {
      if (!isTauri() || !projectPath) {
        return []
      }

      try {
        logger.debug('Fetching GitLab MRs', { projectPath, state })
        const mrs = await invoke<GitLabMergeRequest[]>('list_gitlab_mrs', {
          projectPath,
          state,
        })
        logger.info('GitLab MRs loaded', { count: mrs.length })
        return mrs
      } catch (error) {
        logger.error('Failed to load GitLab MRs', { error, projectPath })
        throw error
      }
    },
    enabled: !!projectPath,
    staleTime: 1000 * 60 * 2, // 2 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
    retry: 1,
  })
}

/**
 * Hook to get detailed information about a specific GitLab MR
 *
 * @param projectPath - Path to the git repository
 * @param mrIid - MR IID (internal ID) to fetch
 */
export function useGitLabMR(projectPath: string | null, mrIid: number | null) {
  return useQuery({
    queryKey: gitlabQueryKeys.mr(projectPath ?? '', mrIid ?? 0),
    queryFn: async (): Promise<GitLabMergeRequestDetail> => {
      if (!isTauri() || !projectPath || !mrIid) {
        throw new Error('Missing required parameters')
      }

      try {
        logger.debug('Fetching GitLab MR details', { projectPath, mrIid })
        const mr = await invoke<GitLabMergeRequestDetail>('get_gitlab_mr', {
          projectPath,
          mrIid,
        })
        logger.info('GitLab MR loaded', { iid: mr.iid, title: mr.title })
        return mr
      } catch (error) {
        logger.error('Failed to load GitLab MR', { error, projectPath, mrIid })
        throw error
      }
    },
    enabled: !!projectPath && !!mrIid,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 15, // 15 minutes
  })
}

/**
 * Filter MRs by search query (iid, title, or description)
 */
export function filterGitLabMRs(mrs: GitLabMergeRequest[], query: string): GitLabMergeRequest[] {
  if (!query.trim()) {
    return mrs
  }

  const lowerQuery = query.toLowerCase().trim()

  return mrs.filter(mr => {
    // Match by MR IID (e.g., "123" or "!123")
    const iidQuery = lowerQuery.replace(/^[!#]/, '')
    if (mr.iid.toString().includes(iidQuery)) {
      return true
    }

    // Match by title
    if (mr.title.toLowerCase().includes(lowerQuery)) {
      return true
    }

    // Match by description
    if (mr.description?.toLowerCase().includes(lowerQuery)) {
      return true
    }

    // Match by branch name
    if (mr.sourceBranch.toLowerCase().includes(lowerQuery)) {
      return true
    }

    return false
  })
}

/**
 * Load MR context for a worktree (fetch from GitLab and save)
 */
export async function loadGitLabMRContext(
  worktreeId: string,
  mrIid: number,
  projectPath: string
): Promise<LoadedGitLabMergeRequestContext> {
  return invoke<LoadedGitLabMergeRequestContext>('load_gitlab_mr_context', {
    worktreeId,
    mrIid,
    projectPath,
  })
}

/**
 * Remove a loaded MR context from a worktree
 */
export async function removeGitLabMRContext(
  worktreeId: string,
  mrIid: number,
  projectPath: string
): Promise<void> {
  await invoke('remove_gitlab_mr_context', {
    worktreeId,
    mrIid,
    projectPath,
  })
}

// =============================================================================
// GitLab Context Listing and Content Functions
// =============================================================================

/**
 * Hook to list loaded GitLab issue contexts for a worktree
 */
export function useLoadedGitLabIssueContexts(worktreeId: string | null) {
  return useQuery({
    queryKey: gitlabQueryKeys.loadedIssueContexts(worktreeId ?? ''),
    queryFn: async (): Promise<LoadedGitLabIssueContext[]> => {
      if (!isTauri() || !worktreeId) {
        return []
      }

      try {
        logger.debug('Listing loaded GitLab issue contexts', { worktreeId })
        const contexts = await invoke<LoadedGitLabIssueContext[]>(
          'list_loaded_gitlab_issue_contexts',
          { worktreeId }
        )
        logger.info('Loaded GitLab issue contexts listed', { count: contexts.length })
        return contexts
      } catch (error) {
        logger.error('Failed to list loaded GitLab issue contexts', { error, worktreeId })
        throw error
      }
    },
    enabled: !!worktreeId,
    staleTime: 1000 * 60 * 2, // 2 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

/**
 * Hook to list loaded GitLab MR contexts for a worktree
 */
export function useLoadedGitLabMRContexts(worktreeId: string | null) {
  return useQuery({
    queryKey: gitlabQueryKeys.loadedMrContexts(worktreeId ?? ''),
    queryFn: async (): Promise<LoadedGitLabMergeRequestContext[]> => {
      if (!isTauri() || !worktreeId) {
        return []
      }

      try {
        logger.debug('Listing loaded GitLab MR contexts', { worktreeId })
        const contexts = await invoke<LoadedGitLabMergeRequestContext[]>(
          'list_loaded_gitlab_mr_contexts',
          { worktreeId }
        )
        logger.info('Loaded GitLab MR contexts listed', { count: contexts.length })
        return contexts
      } catch (error) {
        logger.error('Failed to list loaded GitLab MR contexts', { error, worktreeId })
        throw error
      }
    },
    enabled: !!worktreeId,
    staleTime: 1000 * 60 * 2, // 2 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

/**
 * Get the content of a loaded GitLab issue context file
 */
export async function getGitLabIssueContextContent(
  worktreeId: string,
  issueIid: number,
  projectPath: string
): Promise<string> {
  return invoke<string>('get_gitlab_issue_context_content', {
    worktreeId,
    issueIid,
    projectPath,
  })
}

/**
 * Get the content of a loaded GitLab MR context file
 */
export async function getGitLabMRContextContent(
  worktreeId: string,
  mrIid: number,
  projectPath: string
): Promise<string> {
  return invoke<string>('get_gitlab_mr_context_content', {
    worktreeId,
    mrIid,
    projectPath,
  })
}

// =============================================================================
// GitLab MR Operations
// =============================================================================

/**
 * Open/create a merge request for a worktree
 */
export async function openMergeRequest(
  worktreeId: string,
  options?: {
    title?: string
    body?: string
    draft?: boolean
  }
): Promise<string> {
  return invoke<string>('open_merge_request', {
    worktreeId,
    title: options?.title ?? null,
    body: options?.body ?? null,
    draft: options?.draft ?? null,
  })
}

/**
 * Checkout a GitLab MR into a new worktree
 */
export async function checkoutGitLabMR(
  projectId: string,
  mrIid: number
): Promise<import('@/types/projects').Worktree> {
  return invoke<import('@/types/projects').Worktree>('checkout_gitlab_mr', {
    projectId,
    mrIid,
  })
}
