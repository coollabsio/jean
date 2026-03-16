import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useAllSessions } from '@/services/chat'
import {
  useGitHubIssues,
  useGitHubPRs,
  useSearchGitHubIssues,
  useSearchGitHubPRs,
  useGetGitHubIssueByNumber,
  useGetGitHubPRByNumber,
  useLoadedIssueContexts,
  useLoadedPRContexts,
  useDependabotAlerts,
  useLoadedSecurityContexts,
  useRepositoryAdvisories,
  useLoadedAdvisoryContexts,
  useAttachedSavedContexts,
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
  useGetLinearIssueByNumber,
  useLoadedLinearIssueContexts,
  filterLinearIssues,
  parseLinearItemNumber,
} from '@/services/linear'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import type { SavedContextsResponse } from '@/types/chat'

interface UseLoadContextDataOptions {
  open: boolean
  worktreePath: string | null
  worktreeId: string | null
  projectId: string | null
  activeSessionId: string | null
  searchQuery: string
  includeClosed: boolean
}

export function useLoadContextData({
  open,
  worktreePath,
  worktreeId,
  projectId,
  activeSessionId,
  searchQuery,
  includeClosed,
}: UseLoadContextDataOptions) {
  const queryClient = useQueryClient()

  // Issue contexts for this session
  const {
    data: loadedIssueContexts,
    isLoading: isLoadingIssueContexts,
    refetch: refetchIssueContexts,
  } = useLoadedIssueContexts(activeSessionId)

  // PR contexts for this session
  const {
    data: loadedPRContexts,
    isLoading: isLoadingPRContexts,
    refetch: refetchPRContexts,
  } = useLoadedPRContexts(activeSessionId)

  // Security alert contexts for this session
  const {
    data: loadedSecurityContexts,
    isLoading: isLoadingSecurityContexts,
    refetch: refetchSecurityContexts,
  } = useLoadedSecurityContexts(activeSessionId)

  // Advisory contexts for this session
  const {
    data: loadedAdvisoryContexts,
    isLoading: isLoadingAdvisoryContexts,
    refetch: refetchAdvisoryContexts,
  } = useLoadedAdvisoryContexts(activeSessionId)

  // Attached saved contexts for this session
  const {
    data: attachedSavedContexts,
    isLoading: isLoadingAttachedContexts,
    refetch: refetchAttachedContexts,
  } = useAttachedSavedContexts(activeSessionId)

  // Linear issue contexts for this session
  const {
    data: loadedLinearContexts,
    isLoading: isLoadingLinearContexts,
    refetch: refetchLinearContexts,
  } = useLoadedLinearIssueContexts(activeSessionId, worktreeId, projectId)

  // Linear issues query
  const {
    data: linearIssueResult,
    isLoading: isLoadingLinearIssues,
    isFetching: isRefetchingLinearIssues,
    error: linearIssuesError,
    refetch: refetchLinearIssues,
  } = useLinearIssues(projectId, { enabled: open })

  // GitHub issues query
  const issueState = includeClosed ? 'all' : 'open'
  const {
    data: issueResult,
    isLoading: isLoadingIssues,
    isFetching: isRefetchingIssues,
    error: issuesError,
    refetch: refetchIssues,
  } = useGitHubIssues(worktreePath, issueState)
  const issues = issueResult?.issues

  // GitHub security alerts query
  const securityState = includeClosed ? 'all' : 'open'
  const {
    data: securityAlerts,
    isLoading: isLoadingSecurityAlerts,
    isFetching: isRefetchingSecurityAlerts,
    error: securityError,
    refetch: refetchSecurityAlerts,
  } = useDependabotAlerts(worktreePath, securityState)

  // Repository advisories query — fetch all states, filter closed on frontend
  const {
    data: advisories,
    isLoading: isLoadingAdvisories,
    isFetching: isRefetchingAdvisories,
    refetch: refetchAdvisories,
  } = useRepositoryAdvisories(worktreePath)

  // GitHub PRs query
  const prState = includeClosed ? 'all' : 'open'
  const {
    data: prs,
    isLoading: isLoadingPRs,
    isFetching: isRefetchingPRs,
    error: prsError,
    refetch: refetchPRs,
  } = useGitHubPRs(worktreePath, prState)

  // Fetch saved contexts
  const {
    data: contextsData,
    isLoading: isLoadingContexts,
    error: contextsError,
    refetch: refetchContexts,
  } = useQuery({
    queryKey: ['session-context'],
    queryFn: () => invoke<SavedContextsResponse>('list_saved_contexts'),
    enabled: open,
    staleTime: 1000 * 60 * 5,
  })

  // Fetch all sessions across all worktrees
  const { data: allSessionsData, isLoading: isLoadingSessions } =
    useAllSessions(open)

  // Debounced search query for GitHub API search
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300)

  // GitHub search queries (triggered when local filter may miss results)
  const { data: searchedIssues, isFetching: isSearchingIssues } =
    useSearchGitHubIssues(worktreePath, debouncedSearchQuery)

  const { data: searchedPRs, isFetching: isSearchingPRs } =
    useSearchGitHubPRs(worktreePath, debouncedSearchQuery)

  const { data: searchedLinearIssues, isFetching: isSearchingLinearIssues } =
    useSearchLinearIssues(projectId, debouncedSearchQuery)

  // Exact number lookups (finds any issue/PR regardless of age or state)
  const { data: exactIssue } = useGetGitHubIssueByNumber(
    worktreePath,
    debouncedSearchQuery
  )
  const { data: exactPR } = useGetGitHubPRByNumber(
    worktreePath,
    debouncedSearchQuery
  )
  const { data: exactLinearIssue } = useGetLinearIssueByNumber(
    projectId,
    debouncedSearchQuery,
    { enabled: open }
  )

  // Filter issues locally, merge with search results, exclude already loaded ones
  const filteredIssues = useMemo(() => {
    const loadedNumbers = new Set(loadedIssueContexts?.map(c => c.number) ?? [])
    if (parseItemNumber(searchQuery) !== null) {
      return exactIssue && !loadedNumbers.has(exactIssue.number) ? [exactIssue] : []
    }
    const localFiltered = filterIssues(issues ?? [], searchQuery)
    const merged = mergeWithSearchResults(localFiltered, searchedIssues)
    const withExact = prependExactMatch(merged, exactIssue)
    return withExact.filter(issue => !loadedNumbers.has(issue.number))
  }, [issues, searchQuery, searchedIssues, loadedIssueContexts, exactIssue])

  // Filter PRs locally, merge with search results, exclude already loaded ones
  const filteredPRs = useMemo(() => {
    const loadedNumbers = new Set(loadedPRContexts?.map(c => c.number) ?? [])
    if (parseItemNumber(searchQuery) !== null) {
      return exactPR && !loadedNumbers.has(exactPR.number) ? [exactPR] : []
    }
    const localFiltered = filterPRs(prs ?? [], searchQuery)
    const merged = mergeWithSearchResults(localFiltered, searchedPRs)
    const withExact = prependExactMatch(merged, exactPR)
    return withExact.filter(pr => !loadedNumbers.has(pr.number))
  }, [prs, searchQuery, searchedPRs, loadedPRContexts, exactPR])

  // Filter security alerts locally, exclude already loaded ones, sort by state
  const filteredSecurityAlerts = useMemo(() => {
    const ALERT_STATE_ORDER = ['open', 'dismissed', 'fixed', 'auto_dismissed']
    const loadedNumbers = new Set(
      loadedSecurityContexts?.map(c => c.number) ?? []
    )
    const localFiltered = filterSecurityAlerts(securityAlerts ?? [], searchQuery)
    return localFiltered
      .filter(alert => !loadedNumbers.has(alert.number))
      .sort(
        (a, b) =>
          (ALERT_STATE_ORDER.indexOf(a.state) ?? 99) -
          (ALERT_STATE_ORDER.indexOf(b.state) ?? 99)
      )
  }, [securityAlerts, searchQuery, loadedSecurityContexts])

  // Filter advisories locally, exclude already loaded ones, hide closed unless includeClosed, sort by state
  const filteredAdvisories = useMemo(() => {
    const ADVISORY_STATE_ORDER = ['triage', 'draft', 'published', 'closed']
    const loadedGhsaIds = new Set(
      loadedAdvisoryContexts?.map(c => c.ghsaId) ?? []
    )
    const localFiltered = filterAdvisories(advisories ?? [], searchQuery)
    return localFiltered
      .filter(advisory => !loadedGhsaIds.has(advisory.ghsaId))
      .filter(advisory => includeClosed || (advisory.state !== 'closed' && advisory.state !== 'published'))
      .sort(
        (a, b) =>
          (ADVISORY_STATE_ORDER.indexOf(a.state) ?? 99) -
          (ADVISORY_STATE_ORDER.indexOf(b.state) ?? 99)
      )
  }, [advisories, searchQuery, loadedAdvisoryContexts, includeClosed])

  // Filter contexts by search query, excluding already attached ones
  const filteredContexts = useMemo(() => {
    if (!contextsData?.contexts) return []

    const attachedSlugs = new Set(attachedSavedContexts?.map(c => c.slug) ?? [])
    const filtered = contextsData.contexts.filter(
      ctx => !attachedSlugs.has(ctx.slug)
    )

    if (!searchQuery) return filtered

    const query = searchQuery.toLowerCase()
    return filtered.filter(
      ctx =>
        ctx.slug.toLowerCase().includes(query) ||
        ctx.project_name.toLowerCase().includes(query) ||
        (ctx.name && ctx.name.toLowerCase().includes(query))
    )
  }, [contextsData, searchQuery, attachedSavedContexts])

  // Filter sessions (exclude current session, apply search, group by project/worktree)
  const filteredEntries = useMemo(() => {
    if (!allSessionsData?.entries) return []

    return allSessionsData.entries
      .map(entry => {
        const filteredSessions = entry.sessions
          .filter(s => s.messages.length > 0)
          .filter(s => s.id !== activeSessionId)
          .filter(s => {
            if (!searchQuery) return true
            const query = searchQuery.toLowerCase()
            return (
              s.name.toLowerCase().includes(query) ||
              entry.project_name.toLowerCase().includes(query) ||
              entry.worktree_name.toLowerCase().includes(query) ||
              s.messages.some(m => m.content.toLowerCase().includes(query))
            )
          })

        return { ...entry, sessions: filteredSessions }
      })
      .filter(entry => entry.sessions.length > 0)
  }, [allSessionsData, searchQuery, activeSessionId])

  // Filter Linear issues locally, merge with search results, exclude already loaded ones
  const filteredLinearIssues = useMemo(() => {
    const loadedIdentifiers = new Set(
      loadedLinearContexts?.map(c => c.identifier) ?? []
    )
    if (parseLinearItemNumber(searchQuery) !== null) {
      return exactLinearIssue && !loadedIdentifiers.has(exactLinearIssue.identifier)
        ? [exactLinearIssue]
        : []
    }
    const localFiltered = filterLinearIssues(
      linearIssueResult?.issues ?? [],
      searchQuery
    )
    // Merge search results
    if (searchedLinearIssues && searchedLinearIssues.length > 0) {
      const existingIds = new Set(localFiltered.map(i => i.id))
      for (const issue of searchedLinearIssues) {
        if (!existingIds.has(issue.id)) {
          localFiltered.push(issue)
        }
      }
    }
    return localFiltered.filter(
      issue => !loadedIdentifiers.has(issue.identifier)
    )
  }, [
    linearIssueResult,
    searchQuery,
    searchedLinearIssues,
    loadedLinearContexts,
    exactLinearIssue,
  ])

  // Mutation for renaming contexts
  const renameMutation = useMutation({
    mutationFn: async ({
      filename,
      newName,
    }: {
      filename: string
      newName: string
    }) => {
      await invoke('rename_saved_context', { filename, newName })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session-context'] })
    },
    onError: error => {
      toast.error(`Failed to rename context: ${error}`)
    },
  })

  return {
    // Loaded/attached data
    loadedIssueContexts,
    isLoadingIssueContexts,
    refetchIssueContexts,
    loadedPRContexts,
    isLoadingPRContexts,
    refetchPRContexts,
    loadedSecurityContexts,
    isLoadingSecurityContexts,
    refetchSecurityContexts,
    loadedAdvisoryContexts,
    isLoadingAdvisoryContexts,
    refetchAdvisoryContexts,
    attachedSavedContexts,
    isLoadingAttachedContexts,
    refetchAttachedContexts,

    // GitHub data states
    isLoadingIssues,
    isRefetchingIssues,
    isSearchingIssues,
    issuesError,
    refetchIssues,
    isLoadingPRs,
    isRefetchingPRs,
    isSearchingPRs,
    prsError,
    refetchPRs,

    // Security alerts states
    isLoadingSecurityAlerts,
    isRefetchingSecurityAlerts,
    securityError,
    refetchSecurityAlerts,

    // Advisory states
    isLoadingAdvisories,
    isRefetchingAdvisories,
    refetchAdvisories,

    // Contexts/sessions states
    isLoadingContexts,
    isLoadingSessions,
    contextsError,
    refetchContexts,

    // Linear data states
    loadedLinearContexts,
    isLoadingLinearContexts,
    refetchLinearContexts,
    isLoadingLinearIssues,
    isRefetchingLinearIssues,
    isSearchingLinearIssues,
    linearIssuesError,
    refetchLinearIssues,

    // Filtered data
    filteredIssues,
    filteredPRs,
    filteredSecurityAlerts,
    filteredAdvisories,
    filteredLinearIssues,
    filteredContexts,
    filteredEntries,

    // Mutation
    renameMutation,

    // Derived booleans
    hasLoadedIssueContexts: (loadedIssueContexts?.length ?? 0) > 0,
    hasLoadedPRContexts: (loadedPRContexts?.length ?? 0) > 0,
    hasLoadedSecurityContexts: (loadedSecurityContexts?.length ?? 0) > 0,
    hasLoadedAdvisoryContexts: (loadedAdvisoryContexts?.length ?? 0) > 0,
    hasLoadedLinearContexts: (loadedLinearContexts?.length ?? 0) > 0,
    hasAttachedContexts: (attachedSavedContexts?.length ?? 0) > 0,
    hasContexts: filteredContexts.length > 0,
    hasSessions: filteredEntries.length > 0,
  }
}
