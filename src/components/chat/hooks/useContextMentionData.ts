import { useMemo } from 'react'
import {
  filterAdvisories,
  filterDiscussions,
  filterIssues,
  filterPRs,
  filterSecurityAlerts,
  mergeWithSearchResults,
  parseItemNumber,
  prependExactMatch,
  useDependabotAlert,
  useDependabotAlerts,
  useGetGitHubDiscussionByNumber,
  useGetGitHubIssueByNumber,
  useGetGitHubPRByNumber,
  useGitHubDiscussions,
  useGitHubIssues,
  useGitHubPRs,
  useRepositoryAdvisories,
  useRepositoryAdvisory,
  useSearchGitHubDiscussions,
  useSearchGitHubIssues,
  useSearchGitHubPRs,
} from '@/services/github'
import {
  filterLinearIssues,
  parseLinearItemNumber,
  useGetLinearIssueByNumber,
  useLinearIssues,
  useSearchLinearIssues,
} from '@/services/linear'
import type {
  DependabotAlert,
  GitHubDiscussion,
  GitHubIssue,
  GitHubPullRequest,
  RepositoryAdvisory,
} from '@/types/github'
import type { LinearIssue } from '@/types/linear'

export type ContextMentionType =
  | 'issue'
  | 'pr'
  | 'discussion'
  | 'security'
  | 'advisory'
  | 'linear'

export interface ContextMentionItem {
  id: string
  type: ContextMentionType
  label: string
  title: string
  badge?: string
  issue?: GitHubIssue
  pr?: GitHubPullRequest
  discussion?: GitHubDiscussion
  securityAlert?: DependabotAlert
  advisory?: RepositoryAdvisory
  linearIssue?: LinearIssue
}

export interface ContextMentionGroup {
  id: ContextMentionType
  heading: string
  items: ContextMentionItem[]
  hasMore?: boolean
}

function lowerTrim(query: string) {
  return query.trim().toLowerCase()
}

function parseGhsaId(query: string): string | null {
  const trimmed = query.trim().toUpperCase()
  return /^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(trimmed)
    ? trimmed
    : null
}

function issueToItem(issue: GitHubIssue): ContextMentionItem {
  return {
    id: `issue:${issue.number}`,
    type: 'issue',
    label: `#${issue.number}`,
    title: issue.title,
    issue,
  }
}

function prToItem(pr: GitHubPullRequest): ContextMentionItem {
  return {
    id: `pr:${pr.number}`,
    type: 'pr',
    label: `PR #${pr.number}`,
    title: pr.title,
    badge: pr.isDraft ? 'draft' : undefined,
    pr,
  }
}

function discussionToItem(discussion: GitHubDiscussion): ContextMentionItem {
  return {
    id: `discussion:${discussion.number}`,
    type: 'discussion',
    label: `Discussion #${discussion.number}`,
    title: discussion.title,
    badge: discussion.isAnswered ? 'answered' : discussion.category?.name,
    discussion,
  }
}

function securityToItem(alert: DependabotAlert): ContextMentionItem {
  return {
    id: `security:${alert.number}`,
    type: 'security',
    label: `Security #${alert.number}`,
    title: alert.summary,
    badge: alert.severity,
    securityAlert: alert,
  }
}

function advisoryToItem(advisory: RepositoryAdvisory): ContextMentionItem {
  return {
    id: `advisory:${advisory.ghsaId}`,
    type: 'advisory',
    label: advisory.ghsaId,
    title: advisory.summary,
    badge: advisory.severity,
    advisory,
  }
}

function linearToItem(issue: LinearIssue): ContextMentionItem {
  return {
    id: `linear:${issue.id}`,
    type: 'linear',
    label: issue.identifier,
    title: issue.title,
    badge: issue.priorityLabel,
    linearIssue: issue,
  }
}

function isOpenIssue(issue: GitHubIssue): boolean {
  return issue.state.toLowerCase() === 'open'
}

function isOpenPR(pr: GitHubPullRequest): boolean {
  return pr.state.toLowerCase() === 'open'
}

function isOpenSecurityAlert(alert: DependabotAlert): boolean {
  return alert.state.toLowerCase() === 'open'
}

function isOpenAdvisory(advisory: RepositoryAdvisory): boolean {
  return advisory.state.toLowerCase() !== 'closed'
}

function isOpenLinearIssue(issue: LinearIssue): boolean {
  const type = issue.state.type.toLowerCase()
  return type !== 'completed' && type !== 'cancelled'
}

export function useContextMentionData({
  open,
  projectPath,
  projectId,
  query,
  includeClosed,
  issueLimit = 8,
  prLimit = 8,
  discussionLimit = 8,
}: {
  open: boolean
  projectPath: string | null
  projectId: string | null
  query: string
  includeClosed: boolean
  issueLimit?: number
  prLimit?: number
  discussionLimit?: number
}): {
  groups: ContextMentionGroup[]
  isFetching: boolean
  /** Fetch the next GitHub page when `limit` passes the loaded discussions */
  loadMoreDiscussions: (limit: number) => void
} {
  const enabledProjectPath = open ? projectPath : null
  const enabledProjectId = open ? projectId : null
  const activeQuery = open ? query : ''
  const itemNumber = parseItemNumber(activeQuery)
  const linearNumber = parseLinearItemNumber(activeQuery)
  const ghsaId = parseGhsaId(activeQuery)

  const issueState = includeClosed ? 'all' : 'open'
  const prState = includeClosed ? 'all' : 'open'
  const discussionState = includeClosed ? 'all' : 'open'
  const securityState = includeClosed ? 'all' : 'open'
  const advisoryState = includeClosed ? 'all' : 'published'

  const { data: issueResult, isFetching: isFetchingIssues } = useGitHubIssues(
    enabledProjectPath,
    issueState,
    { enabled: open, ownerId: enabledProjectId ?? undefined }
  )
  const { data: prs = [], isFetching: isFetchingPRs } = useGitHubPRs(
    enabledProjectPath,
    prState,
    { enabled: open, ownerId: enabledProjectId ?? undefined }
  )
  const {
    data: discussions = [],
    isFetching: isFetchingDiscussions,
    hasNextPage: hasMoreDiscussionPages,
    fetchNextPage: fetchNextDiscussionPage,
  } = useGitHubDiscussions(enabledProjectPath, discussionState, {
    enabled: open,
  })
  const { data: alerts = [], isFetching: isFetchingAlerts } =
    useDependabotAlerts(enabledProjectPath, securityState, { enabled: open })
  const { data: advisories = [], isFetching: isFetchingAdvisories } =
    useRepositoryAdvisories(enabledProjectPath, advisoryState, {
      enabled: open,
    })
  const { data: linearResult, isFetching: isFetchingLinear } = useLinearIssues(
    enabledProjectId,
    { enabled: open }
  )

  const { data: searchedIssues, isFetching: isSearchingIssues } =
    useSearchGitHubIssues(enabledProjectPath, activeQuery)
  const { data: searchedPRs, isFetching: isSearchingPRs } = useSearchGitHubPRs(
    enabledProjectPath,
    activeQuery
  )
  const { data: searchedDiscussions, isFetching: isSearchingDiscussions } =
    useSearchGitHubDiscussions(enabledProjectPath, activeQuery)
  const { data: searchedLinear, isFetching: isSearchingLinear } =
    useSearchLinearIssues(enabledProjectId, activeQuery, { enabled: open })

  const { data: exactIssue, isFetching: isFetchingExactIssue } =
    useGetGitHubIssueByNumber(enabledProjectPath, activeQuery)
  const { data: exactPR, isFetching: isFetchingExactPR } =
    useGetGitHubPRByNumber(enabledProjectPath, activeQuery)
  const { data: exactDiscussion, isFetching: isFetchingExactDiscussion } =
    useGetGitHubDiscussionByNumber(enabledProjectPath, activeQuery)
  const { data: exactSecurity, isFetching: isFetchingExactSecurity } =
    useDependabotAlert(enabledProjectPath, itemNumber)
  const { data: exactAdvisory, isFetching: isFetchingExactAdvisory } =
    useRepositoryAdvisory(enabledProjectPath, ghsaId)
  const { data: exactLinear, isFetching: isFetchingExactLinear } =
    useGetLinearIssueByNumber(enabledProjectId, activeQuery, { enabled: open })

  const groups = useMemo<ContextMentionGroup[]>(() => {
    if (!open) return []

    const q = lowerTrim(activeQuery)
    const bareNumberSearch = Boolean(itemNumber)
    const issueList = issueResult?.issues ?? []
    const linearIssues = linearResult?.issues ?? []

    const issueVisible = (issue: GitHubIssue) =>
      includeClosed || isOpenIssue(issue)
    const prVisible = (pr: GitHubPullRequest) => includeClosed || isOpenPR(pr)
    const discussionVisible = (discussion: GitHubDiscussion) =>
      includeClosed || !discussion.closed
    const securityVisible = (alert: DependabotAlert) =>
      includeClosed || isOpenSecurityAlert(alert)
    const advisoryVisible = (advisory: RepositoryAdvisory) =>
      includeClosed || isOpenAdvisory(advisory)
    const linearVisible = (issue: LinearIssue) =>
      includeClosed || isOpenLinearIssue(issue)

    const visibleExactIssue =
      exactIssue && issueVisible(exactIssue) ? exactIssue : null
    const visibleExactPR = exactPR && prVisible(exactPR) ? exactPR : null
    const visibleExactDiscussion =
      exactDiscussion && discussionVisible(exactDiscussion)
        ? exactDiscussion
        : null
    const visibleExactSecurity =
      exactSecurity && securityVisible(exactSecurity) ? exactSecurity : null
    const visibleExactAdvisory =
      exactAdvisory && advisoryVisible(exactAdvisory) ? exactAdvisory : null
    const visibleExactLinear =
      exactLinear && linearVisible(exactLinear) ? exactLinear : null

    const filteredIssues = bareNumberSearch
      ? prependExactMatch([], visibleExactIssue)
      : prependExactMatch(
          mergeWithSearchResults(
            filterIssues(issueList, activeQuery),
            searchedIssues
          ).filter(issueVisible),
          visibleExactIssue
        )

    const filteredPRs = bareNumberSearch
      ? prependExactMatch([], visibleExactPR)
      : prependExactMatch(
          mergeWithSearchResults(
            filterPRs(prs, activeQuery),
            searchedPRs
          ).filter(prVisible),
          visibleExactPR
        )

    const filteredDiscussions = bareNumberSearch
      ? prependExactMatch([], visibleExactDiscussion)
      : prependExactMatch(
          mergeWithSearchResults(
            filterDiscussions(discussions, activeQuery),
            searchedDiscussions
          ).filter(discussionVisible),
          visibleExactDiscussion
        )

    const filteredAlerts = bareNumberSearch
      ? visibleExactSecurity
        ? [visibleExactSecurity]
        : []
      : filterSecurityAlerts(alerts, activeQuery).filter(securityVisible)

    const filteredAdvisories =
      ghsaId && visibleExactAdvisory
        ? [visibleExactAdvisory]
        : filterAdvisories(advisories, activeQuery).filter(advisoryVisible)

    const mergedLinear = new Map<string, LinearIssue>()
    if (linearNumber && visibleExactLinear) {
      mergedLinear.set(visibleExactLinear.id, visibleExactLinear)
    }
    for (const issue of filterLinearIssues(linearIssues, activeQuery).filter(
      linearVisible
    )) {
      mergedLinear.set(issue.id, issue)
    }
    for (const issue of (searchedLinear ?? []).filter(linearVisible)) {
      mergedLinear.set(issue.id, issue)
    }

    const allGroups: ContextMentionGroup[] = [
      {
        id: 'issue',
        heading: 'GitHub Issues',
        items: filteredIssues.slice(0, issueLimit).map(issueToItem),
        hasMore: filteredIssues.length > issueLimit,
      },
      {
        id: 'pr',
        heading: 'GitHub Pull Requests',
        items: filteredPRs.slice(0, prLimit).map(prToItem),
        hasMore: filteredPRs.length > prLimit,
      },
      {
        id: 'discussion',
        heading: 'GitHub Discussions',
        items: filteredDiscussions
          .slice(0, discussionLimit)
          .map(discussionToItem),
        hasMore:
          filteredDiscussions.length > discussionLimit ||
          (!q && hasMoreDiscussionPages),
      },
      {
        id: 'security',
        heading: 'Security Alerts',
        items: filteredAlerts.slice(0, 8).map(securityToItem),
      },
      {
        id: 'advisory',
        heading: 'Security Advisories',
        items: filteredAdvisories.slice(0, 8).map(advisoryToItem),
      },
      {
        id: 'linear',
        heading: 'Linear Issues',
        items: Array.from(mergedLinear.values()).slice(0, 8).map(linearToItem),
      },
    ]

    if (!q) {
      return allGroups.filter(group => group.items.length > 0)
    }

    return allGroups.filter(group => group.items.length > 0)
  }, [
    activeQuery,
    advisories,
    alerts,
    discussionLimit,
    discussions,
    hasMoreDiscussionPages,
    exactAdvisory,
    exactDiscussion,
    exactIssue,
    exactLinear,
    exactPR,
    exactSecurity,
    ghsaId,
    includeClosed,
    issueLimit,
    issueResult,
    itemNumber,
    linearNumber,
    linearResult,
    open,
    prs,
    prLimit,
    searchedDiscussions,
    searchedIssues,
    searchedLinear,
    searchedPRs,
  ])

  const loadMoreDiscussions = (limit: number) => {
    if (limit > discussions.length && hasMoreDiscussionPages) {
      void fetchNextDiscussionPage()
    }
  }

  return {
    groups,
    loadMoreDiscussions,
    isFetching:
      isFetchingIssues ||
      isFetchingPRs ||
      isFetchingDiscussions ||
      isFetchingAlerts ||
      isFetchingAdvisories ||
      isFetchingLinear ||
      isSearchingIssues ||
      isSearchingPRs ||
      isSearchingDiscussions ||
      isSearchingLinear ||
      isFetchingExactIssue ||
      isFetchingExactPR ||
      isFetchingExactDiscussion ||
      isFetchingExactSecurity ||
      isFetchingExactAdvisory ||
      isFetchingExactLinear,
  }
}
