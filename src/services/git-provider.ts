/**
 * Git host provider resolution for the frontend.
 *
 * Wraps the `get_git_provider` Tauri command (which resolves a project's
 * provider from its `jean.json` + origin remote) and exposes provider-aware
 * labels so the UI can say "Merge Request" vs "Pull Request", pick the right
 * CLI-auth state, etc.
 */

import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { hasBackend } from '@/lib/environment'
import type { GitProvider } from '@/types/provider'

const isTauri = hasBackend

export interface GitProviderInfo {
  provider: GitProvider
  host: string
}

export const gitProviderQueryKeys = {
  all: ['git-provider'] as const,
  forPath: (projectPath: string | null | undefined) =>
    [...gitProviderQueryKeys.all, projectPath] as const,
}

/**
 * Resolve a project's git host provider. Defaults to GitHub when unknown or
 * outside a Tauri context, matching the backend's fallback.
 */
export function useProjectGitProvider(projectPath: string | null | undefined) {
  return useQuery<GitProviderInfo>({
    queryKey: gitProviderQueryKeys.forPath(projectPath),
    queryFn: async () => {
      if (!isTauri() || !projectPath) {
        return { provider: 'github', host: 'github.com' }
      }
      try {
        return await invoke<GitProviderInfo>('get_git_provider', { projectPath })
      } catch {
        return { provider: 'github', host: 'github.com' }
      }
    },
    enabled: !!projectPath,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
  })
}

/** Provider-specific wording used across issue/PR UI. */
export interface ProviderLabels {
  /** "GitHub" | "GitLab" */
  name: string
  /** "Pull Request" | "Merge Request" */
  pullRequest: string
  /** "PR" | "MR" */
  pullRequestShort: string
  /** "PRs" | "MRs" */
  pullRequestsShort: string
  /** "Sign in to GitHub" | "Sign in to GitLab" */
  signIn: string
}

export function providerLabels(provider: GitProvider): ProviderLabels {
  if (provider === 'gitlab') {
    return {
      name: 'GitLab',
      pullRequest: 'Merge Request',
      pullRequestShort: 'MR',
      pullRequestsShort: 'MRs',
      signIn: 'Sign in to GitLab',
    }
  }
  return {
    name: 'GitHub',
    pullRequest: 'Pull Request',
    pullRequestShort: 'PR',
    pullRequestsShort: 'PRs',
    signIn: 'Sign in to GitHub',
  }
}
