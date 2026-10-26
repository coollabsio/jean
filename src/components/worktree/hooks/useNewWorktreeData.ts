import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useProjectsStore } from '@/store/projects-store'
import {
  useGitHubIssues,
  useGitHubPRs,
  useSearchGitHubIssues,
  useSearchGitHubPRs,
  useListGitHubIssuesByNumber,
  useListGitHubPRsByNumber,
  prependExactMatches,
  useDependabotAlerts,
  useRepositoryAdvisories,
  useGitHubDiscussions,
  useSearchGitHubDiscussions,
  useGetGitHubDiscussionByNumber,
  filterIssues,
  filterDiscussions,
  filterPRs,
  filterSecurityAlerts,
  filterAdvisories,
  mergeWithSearchResults,
  prependExactMatch,
  parseItemNumber,
} from '@/services/github'
import {
  useLinearIssues,
  useSearchLinearIssues,
  filterLinearIssues,
} from '@/services/linear'
import { filterSentryIssues, useSentryIssues } from '@/services/sentry'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import {
  useProjects,
  useWorktrees,
  useCreateWorktree,
  useCreateBaseSession,
  useWorktreeBranches,
  useCreateWorktreeFromExistingBranch,
  useJeanConfig,
  useProjectRemotes,
} from '@/services/projects'
import { isBaseSession } from '@/types/projects'
import {
  distinctGitHubRepos,
  filterWorktreeBranches,
  primaryGitHubRemote,
  worktreeBaseBranchOption,
  worktreeBranchRemoteCount,
} from '@/lib/remote-worktree-sources'

export function useNewWorktreeData(
  searchQuery: string,
  includeClosed: boolean
) {
  const queryClient = useQueryClient()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)

  // Project data
  const { data: projects } = useProjects()
  const selectedProject = useMemo(
    () => projects?.find(p => p.id === selectedProjectId),
    [projects, selectedProjectId]
  )

  // Worktrees & base session
  const { data: worktrees } = useWorktrees(selectedProjectId)
  const hasBaseSession = useMemo(
    () => worktrees?.some(w => isBaseSession(w)) ?? false,
    [worktrees]
  )
  const baseSession = useMemo(
    () => worktrees?.find(w => isBaseSession(w)),
    [worktrees]
  )

  // GitHub issues
  const issueState = includeClosed ? 'all' : 'open'
  const {
    data: issueResult,
    isLoading: isLoadingIssues,
    isFetching: isRefetchingIssues,
    error: issuesError,
    refetch: refetchIssues,
  } = useGitHubIssues(selectedProject?.path ?? null, issueState, {
    ownerId: selectedProjectId ?? undefined,
  })
  const issues = issueResult?.issues

  // GitHub PRs
  const prState = includeClosed ? 'all' : 'open'
  const {
    data: prs,
    isLoading: isLoadingPRs,
    isFetching: isRefetchingPRs,
    error: prsError,
    refetch: refetchPRs,
  } = useGitHubPRs(selectedProject?.path ?? null, prState, {
    ownerId: selectedProjectId ?? undefined,
  })

  // Debounced search for GitHub API
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300)

  const { data: searchedIssues, isFetching: isSearchingIssues } =
    useSearchGitHubIssues(selectedProject?.path ?? null, debouncedSearchQuery)

  const { data: searchedPRs, isFetching: isSearchingPRs } = useSearchGitHubPRs(
    selectedProject?.path ?? null,
    debouncedSearchQuery
  )

  // Exact number lookups across every linked GitHub repository.
  const { data: exactIssues } = useListGitHubIssuesByNumber(
    selectedProject?.path ?? null,
    debouncedSearchQuery
  )
  const { data: exactPRs } = useListGitHubPRsByNumber(
    selectedProject?.path ?? null,
    debouncedSearchQuery
  )

  // Filtered issues. A numeric query returns every repository's match.
  const filteredIssues = useMemo(() => {
    if (parseItemNumber(searchQuery) !== null) {
      return exactIssues ?? []
    }
    const stateFilteredSearch = includeClosed
      ? searchedIssues
      : searchedIssues?.filter(i => i.state === 'OPEN')
    return prependExactMatches(
      mergeWithSearchResults(
        filterIssues(issues ?? [], searchQuery),
        stateFilteredSearch
      ),
      exactIssues
    )
  }, [issues, searchQuery, searchedIssues, exactIssues, includeClosed])

  // Filtered PRs
  const filteredPRs = useMemo(() => {
    if (parseItemNumber(searchQuery) !== null) {
      return exactPRs ?? []
    }
    const stateFilteredSearch = includeClosed
      ? searchedPRs
      : searchedPRs?.filter(p => p.state === 'OPEN')
    return prependExactMatches(
      mergeWithSearchResults(
        filterPRs(prs ?? [], searchQuery),
        stateFilteredSearch
      ),
      exactPRs
    )
  }, [prs, searchQuery, searchedPRs, exactPRs, includeClosed])

  const githubSourceItems = useMemo(
    () => [...(issues ?? []), ...(prs ?? [])],
    [issues, prs]
  )
  const primaryGitHubRemoteName = useMemo(
    () => primaryGitHubRemote(githubSourceItems),
    [githubSourceItems]
  )
  const hasMultipleGitHubRemotes = useMemo(() => {
    const remotes = new Set(
      githubSourceItems
        .map(item => item.remote?.trim())
        .filter((remote): remote is string => Boolean(remote))
    )
    return remotes.size > 1
  }, [githubSourceItems])
  const showGitHubSource = useMemo(
    () => distinctGitHubRepos(githubSourceItems).length > 1,
    [githubSourceItems]
  )

  // GitHub discussions
  const discussionState = includeClosed ? 'all' : 'open'
  const {
    data: discussions,
    isLoading: isLoadingDiscussions,
    isFetching: isRefetchingDiscussions,
    error: discussionsError,
    refetch: refetchDiscussions,
    hasNextPage: hasMoreDiscussions,
    fetchNextPage: fetchMoreDiscussions,
    isFetchingNextPage: isLoadingMoreDiscussions,
  } = useGitHubDiscussions(selectedProject?.path ?? null, discussionState)

  const { data: searchedDiscussions, isFetching: isSearchingDiscussions } =
    useSearchGitHubDiscussions(
      selectedProject?.path ?? null,
      debouncedSearchQuery
    )
  const { data: exactDiscussion } = useGetGitHubDiscussionByNumber(
    selectedProject?.path ?? null,
    debouncedSearchQuery
  )

  const filteredDiscussions = useMemo(() => {
    if (parseItemNumber(searchQuery) !== null) {
      return exactDiscussion ? [exactDiscussion] : []
    }
    const stateFilteredSearch = includeClosed
      ? searchedDiscussions
      : searchedDiscussions?.filter(d => !d.closed)
    return prependExactMatch(
      mergeWithSearchResults(
        filterDiscussions(discussions ?? [], searchQuery),
        stateFilteredSearch
      ),
      exactDiscussion
    )
  }, [
    discussions,
    searchQuery,
    searchedDiscussions,
    exactDiscussion,
    includeClosed,
  ])

  // Branches from every configured remote. The dialog keeps same-named
  // branches distinct; the quick-action picker still uses short origin names.
  const {
    data: remoteBranches,
    isLoading: isLoadingBranches,
    isFetching: isRefetchingBranches,
    error: branchesError,
    refetch: refetchBranches,
  } = useWorktreeBranches(selectedProjectId)

  const branches = useMemo(() => {
    const seen = new Set<string>()
    const names: string[] = []
    for (const branch of remoteBranches ?? []) {
      const option = worktreeBaseBranchOption(branch)
      if (!option || seen.has(option)) continue
      seen.add(option)
      names.push(option)
    }
    return names
  }, [remoteBranches])

  const branchRemoteCount = useMemo(
    () => worktreeBranchRemoteCount(remoteBranches ?? []),
    [remoteBranches]
  )

  const filteredBranches = useMemo(
    () =>
      filterWorktreeBranches(
        remoteBranches ?? [],
        selectedProject?.default_branch,
        searchQuery
      ),
    [remoteBranches, searchQuery, selectedProject?.default_branch]
  )

  // Git remotes that have the default branch (drives the per-remote quick
  // actions when a project tracks more than one, e.g. upstream plus a fork)
  const { data: remotes } = useProjectRemotes(
    selectedProject?.path,
    selectedProject?.default_branch
  )

  // Security alerts (Dependabot)
  const securityState = includeClosed ? 'all' : ('open' as const)
  const {
    data: securityAlerts,
    isLoading: isLoadingSecurityAlerts,
    isFetching: isRefetchingSecurityAlerts,
    error: securityError,
    refetch: refetchSecurityAlerts,
  } = useDependabotAlerts(selectedProject?.path ?? null, securityState)

  const filteredSecurityAlerts = useMemo(() => {
    const ALERT_STATE_ORDER = ['open', 'dismissed', 'fixed', 'auto_dismissed']
    return filterSecurityAlerts(securityAlerts ?? [], searchQuery).sort(
      (a, b) =>
        (ALERT_STATE_ORDER.indexOf(a.state) ?? 99) -
        (ALERT_STATE_ORDER.indexOf(b.state) ?? 99)
    )
  }, [securityAlerts, searchQuery])

  // Repository advisories — fetch all states, filter closed on frontend
  const {
    data: advisories,
    isLoading: isLoadingAdvisories,
    isFetching: isRefetchingAdvisories,
    refetch: refetchAdvisories,
  } = useRepositoryAdvisories(selectedProject?.path ?? null)

  const filteredAdvisories = useMemo(() => {
    const ADVISORY_STATE_ORDER = ['triage', 'draft', 'published', 'closed']
    return filterAdvisories(advisories ?? [], searchQuery)
      .filter(
        advisory =>
          includeClosed ||
          (advisory.state !== 'closed' && advisory.state !== 'published')
      )
      .sort(
        (a, b) =>
          (ADVISORY_STATE_ORDER.indexOf(a.state) ?? 99) -
          (ADVISORY_STATE_ORDER.indexOf(b.state) ?? 99)
      )
  }, [advisories, searchQuery, includeClosed])

  // Linear issues
  const {
    data: linearIssueResult,
    isLoading: isLoadingLinearIssues,
    isFetching: isRefetchingLinearIssues,
    error: linearIssuesError,
    refetch: refetchLinearIssues,
  } = useLinearIssues(selectedProjectId)
  const linearIssues = linearIssueResult?.issues

  const { data: searchedLinearIssues, isFetching: isSearchingLinearIssues } =
    useSearchLinearIssues(selectedProjectId, debouncedSearchQuery)

  const filteredLinearIssues = useMemo(() => {
    const local = filterLinearIssues(linearIssues ?? [], searchQuery)
    if (!searchedLinearIssues?.length) return local
    // Merge search results, dedup by id
    const ids = new Set(local.map(i => i.id))
    const extra = searchedLinearIssues.filter(i => !ids.has(i.id))
    return [...local, ...extra]
  }, [linearIssues, searchQuery, searchedLinearIssues])

  // Sentry issues. The debounced query is also sent to Sentry so structured
  // searches can find issues outside the initial unresolved result page.
  const {
    data: sentryIssues = [],
    isLoading: isLoadingSentryIssues,
    isFetching: isRefetchingSentryIssues,
    error: sentryIssuesError,
    refetch: refetchSentryIssues,
  } = useSentryIssues(selectedProjectId, debouncedSearchQuery)
  const filteredSentryIssues = useMemo(
    () => filterSentryIssues(sentryIssues, searchQuery),
    [sentryIssues, searchQuery]
  )

  // Jean config
  const { data: jeanConfig } = useJeanConfig(selectedProject?.path ?? null)

  // Mutations
  const createWorktree = useCreateWorktree()
  const createBaseSession = useCreateBaseSession()
  const createWorktreeFromBranch = useCreateWorktreeFromExistingBranch()

  return {
    queryClient,
    selectedProjectId,
    selectedProject,
    hasBaseSession,
    baseSession,
    jeanConfig,

    // Issues
    filteredIssues,
    hasMultipleGitHubRemotes,
    primaryGitHubRemote: primaryGitHubRemoteName,
    showGitHubSource,
    isLoadingIssues,
    isRefetchingIssues,
    isSearchingIssues,
    issuesError,
    refetchIssues,

    // PRs
    filteredPRs,
    isLoadingPRs,
    isRefetchingPRs,
    isSearchingPRs,
    prsError,
    refetchPRs,

    // Discussions
    filteredDiscussions,
    isLoadingDiscussions,
    isRefetchingDiscussions,
    isSearchingDiscussions,
    discussionsError,
    refetchDiscussions,
    hasMoreDiscussions,
    fetchMoreDiscussions,
    isLoadingMoreDiscussions,

    // Remotes
    remotes,

    // Branches
    branches,
    filteredBranches,
    branchRemoteCount,
    isLoadingBranches,
    isRefetchingBranches,
    branchesError,
    refetchBranches,

    // Security alerts
    filteredSecurityAlerts,
    isLoadingSecurityAlerts,
    isRefetchingSecurityAlerts,
    securityError,
    refetchSecurityAlerts,

    // Repository advisories
    filteredAdvisories,
    isLoadingAdvisories,
    isRefetchingAdvisories,
    refetchAdvisories,

    // Linear issues
    filteredLinearIssues,
    isLoadingLinearIssues,
    isRefetchingLinearIssues,
    isSearchingLinearIssues,
    linearIssuesError,
    refetchLinearIssues,

    // Sentry issues
    filteredSentryIssues,
    isLoadingSentryIssues,
    isRefetchingSentryIssues,
    sentryIssuesError,
    refetchSentryIssues,

    // Mutations
    createWorktree,
    createBaseSession,
    createWorktreeFromBranch,
  }
}
