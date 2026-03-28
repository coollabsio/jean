import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useProjectsStore } from '@/store/projects-store'
import {
  useGitHubIssues,
  useGitHubPRs,
  useSearchGitHubIssues,
  useSearchGitHubPRs,
  useGetGitHubIssueByNumber,
  useGetGitHubPRByNumber,
  useDependabotAlerts,
  useRepositoryAdvisories,
  filterIssues,
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
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import {
  useProjects,
  useWorktrees,
  useCreateWorktree,
  useCreateBaseSession,
  useProjectBranches,
  useCreateWorktreeFromExistingBranch,
  useJeanConfig,
} from '@/services/projects'
import { isBaseSession } from '@/types/projects'

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
  } = useGitHubIssues(selectedProject?.path ?? null, issueState)
  const issues = issueResult?.issues

  // GitHub PRs
  const prState = includeClosed ? 'all' : 'open'
  const {
    data: prs,
    isLoading: isLoadingPRs,
    isFetching: isRefetchingPRs,
    error: prsError,
    refetch: refetchPRs,
  } = useGitHubPRs(selectedProject?.path ?? null, prState)

  // Debounced search for GitHub API
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300)

  const { data: searchedIssues, isFetching: isSearchingIssues } =
    useSearchGitHubIssues(selectedProject?.path ?? null, debouncedSearchQuery)

  const { data: searchedPRs, isFetching: isSearchingPRs } = useSearchGitHubPRs(
    selectedProject?.path ?? null,
    debouncedSearchQuery
  )

  // Exact number lookups (finds any issue/PR regardless of age or state)
  const { data: exactIssue } = useGetGitHubIssueByNumber(
    selectedProject?.path ?? null,
    debouncedSearchQuery
  )
  const { data: exactPR } = useGetGitHubPRByNumber(
    selectedProject?.path ?? null,
    debouncedSearchQuery
  )

  // Filtered issues
  const filteredIssues = useMemo(() => {
    if (parseItemNumber(searchQuery) !== null) {
      return exactIssue ? [exactIssue] : []
    }
    const stateFilteredSearch = includeClosed
      ? searchedIssues
      : searchedIssues?.filter(i => i.state === 'OPEN')
    return prependExactMatch(
      mergeWithSearchResults(
        filterIssues(issues ?? [], searchQuery),
        stateFilteredSearch
      ),
      exactIssue
    )
  }, [issues, searchQuery, searchedIssues, exactIssue, includeClosed])

  // Filtered PRs
  const filteredPRs = useMemo(() => {
    if (parseItemNumber(searchQuery) !== null) {
      return exactPR ? [exactPR] : []
    }
    const stateFilteredSearch = includeClosed
      ? searchedPRs
      : searchedPRs?.filter(p => p.state === 'OPEN')
    return prependExactMatch(
      mergeWithSearchResults(
        filterPRs(prs ?? [], searchQuery),
        stateFilteredSearch
      ),
      exactPR
    )
  }, [prs, searchQuery, searchedPRs, exactPR, includeClosed])

  // Branches
  const {
    data: branches,
    isLoading: isLoadingBranches,
    isFetching: isRefetchingBranches,
    error: branchesError,
    refetch: refetchBranches,
  } = useProjectBranches(selectedProjectId)

  const filteredBranches = useMemo(() => {
    if (!branches) return []
    const baseBranch = selectedProject?.default_branch
    const filtered = branches.filter(b => b !== baseBranch)
    if (!searchQuery) return filtered
    const q = searchQuery.toLowerCase()
    return filtered.filter(b => b.toLowerCase().includes(q))
  }, [branches, searchQuery, selectedProject?.default_branch])

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

    // Branches
    filteredBranches,
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

    // Mutations
    createWorktree,
    createBaseSession,
    createWorktreeFromBranch,
  }
}
