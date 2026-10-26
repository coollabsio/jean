import { useCallback, useMemo, useRef, useState } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useUIStore, type InvestigationOverride } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { getGitHubDiscussion, githubQueryKeys } from '@/services/github'
import { projectsQueryKeys } from '@/services/projects'
import type {
  GitHubIssue,
  GitHubPullRequest,
  DependabotAlert,
  RepositoryAdvisory,
  GitHubDiscussion,
  IssueContext,
  PullRequestContext,
  SecurityAlertContext,
  AdvisoryContext,
} from '@/types/github'
import type { LinearIssue, LinearIssueDetail } from '@/types/linear'
import type { SentryIssue, SentryIssueContext } from '@/types/sentry'
import type { useNewWorktreeData } from './useNewWorktreeData'
import type { TabId } from '../NewWorktreeModal'
import type { SecuritySelection } from '../SecurityAlertsTab'
import { reportBulkInvestigateResults } from '../bulkInvestigateUtils'
import {
  contextLinkMatchLabel,
  openContextLinkMatch,
  type ContextLinkRef,
} from '@/hooks/useContextLinkUsage'
import type { GetContextLinkMatches } from '../ContextLinkBadge'
import { isStartOnHostCancelled } from '@/lib/start-on-host'

type Data = ReturnType<typeof useNewWorktreeData>

interface Setters {
  setActiveTab: (tab: TabId) => void
  setSearchQuery: (q: string) => void
  setSelectedItemIndex: (i: number) => void
  setIncludeClosed: (v: boolean) => void
}

export function useNewWorktreeHandlers(
  data: Data,
  setters: Setters,
  investigationOverride?: InvestigationOverride,
  getMatches?: GetContextLinkMatches,
  startOnHost?: {
    run: () => Promise<{ projectId: string }>
    hostId: string
  }
) {
  const {
    queryClient,
    selectedProjectId,
    selectedProject,
    hasBaseSession,
    baseSession,
    createWorktree: createWorktreeRaw,
    createBaseSession: createBaseSessionRaw,
    createWorktreeFromBranch: createWorktreeFromBranchRaw,
  } = data

  const ensureInflight = useRef(new Map<string, Promise<string>>())
  const ensureRun = startOnHost?.run
  const hostKey = startOnHost?.hostId ?? ''
  const ensureProjectId = useCallback(() => {
    if (!ensureRun) {
      if (!selectedProjectId) {
        return Promise.reject(new Error('No project selected'))
      }
      return Promise.resolve(selectedProjectId)
    }
    const existing = ensureInflight.current.get(hostKey)
    if (existing) return existing
    const pending = ensureRun()
      .then(result => result.projectId)
      .catch(error => {
        ensureInflight.current.delete(hostKey)
        throw error
      })
    ensureInflight.current.set(hostKey, pending)
    return pending
  }, [ensureRun, hostKey, selectedProjectId])

  const createWorktree = useMemo(() => {
    if (!createWorktreeRaw) return createWorktreeRaw
    return {
      ...createWorktreeRaw,
      mutate: (
        vars: Parameters<typeof createWorktreeRaw.mutate>[0],
        opts?: Parameters<typeof createWorktreeRaw.mutate>[1]
      ) => {
        void ensureProjectId()
          .then(projectId => {
            if (selectedProjectId) {
              useProjectsStore.getState().expandProject(selectedProjectId)
            }
            createWorktreeRaw.mutate({ ...vars, projectId }, opts)
          })
          .catch(error => {
            if (isStartOnHostCancelled(error)) return
            opts?.onError?.(error as never, vars, undefined, undefined as never)
            const message =
              error instanceof Error ? error.message : String(error)
            toast.error(message)
          })
      },
      mutateAsync: async (
        vars: Parameters<typeof createWorktreeRaw.mutateAsync>[0]
      ) => {
        const projectId = await ensureProjectId()
        if (selectedProjectId) {
          useProjectsStore.getState().expandProject(selectedProjectId)
        }
        return createWorktreeRaw.mutateAsync({ ...vars, projectId })
      },
    }
  }, [createWorktreeRaw, ensureProjectId, selectedProjectId])

  const createBaseSession = useMemo(() => {
    if (!createBaseSessionRaw) return createBaseSessionRaw
    return {
      ...createBaseSessionRaw,
      mutate: (
        _projectId: string,
        opts?: { onError?: (error: unknown) => void }
      ) => {
        void ensureProjectId()
          .then(resolvedId => {
            if (selectedProjectId) {
              useProjectsStore.getState().expandProject(selectedProjectId)
            }
            createBaseSessionRaw.mutate(resolvedId, opts)
          })
          .catch(error => {
            if (isStartOnHostCancelled(error)) return
            opts?.onError?.(error)
            const message =
              error instanceof Error ? error.message : String(error)
            toast.error(message)
          })
      },
    }
  }, [createBaseSessionRaw, ensureProjectId, selectedProjectId])

  const createWorktreeFromBranch = useMemo(() => {
    if (!createWorktreeFromBranchRaw) return createWorktreeFromBranchRaw
    return {
      ...createWorktreeFromBranchRaw,
      mutate: (
        vars: Parameters<typeof createWorktreeFromBranchRaw.mutate>[0],
        opts?: Parameters<typeof createWorktreeFromBranchRaw.mutate>[1]
      ) => {
        void ensureProjectId()
          .then(projectId => {
            if (selectedProjectId) {
              useProjectsStore.getState().expandProject(selectedProjectId)
            }
            createWorktreeFromBranchRaw.mutate({ ...vars, projectId }, opts)
          })
          .catch(error => {
            if (isStartOnHostCancelled(error)) return
            opts?.onError?.(error as never, vars, undefined, undefined as never)
            const message =
              error instanceof Error ? error.message : String(error)
            toast.error(message)
          })
      },
    }
  }, [createWorktreeFromBranchRaw, ensureProjectId, selectedProjectId])

  const {
    setActiveTab,
    setSearchQuery,
    setSelectedItemIndex,
    setIncludeClosed,
  } = setters

  // In-flight state
  const [creatingFromNumber, setCreatingFromNumber] = useState<number | null>(
    null
  )
  const [creatingFromLinearId, setCreatingFromLinearId] = useState<
    string | null
  >(null)
  const [creatingFromSentryId, setCreatingFromSentryId] = useState<
    string | null
  >(null)
  const [creatingFromBranch, setCreatingFromBranch] = useState<string | null>(
    null
  )
  const [creatingFromGhsaId, setCreatingFromGhsaId] = useState<string | null>(
    null
  )
  const [stackingFromPR, setStackingFromPR] = useState<number | null>(null)
  const [isBulkInvestigating, setIsBulkInvestigating] = useState(false)

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setCreatingFromNumber(null)
      setCreatingFromLinearId(null)
      setCreatingFromSentryId(null)
      setCreatingFromBranch(null)
      setCreatingFromGhsaId(null)
      setStackingFromPR(null)
      setIsBulkInvestigating(false)
      setSearchQuery('')
      setSelectedItemIndex(0)

      if (open) {
        const { newWorktreeModalDefaultTab, setNewWorktreeModalDefaultTab } =
          useUIStore.getState()
        setActiveTab(
          newWorktreeModalDefaultTab ?? (selectedProjectId ? 'issues' : 'quick')
        )
        setNewWorktreeModalDefaultTab(null)
        setIncludeClosed(false)

        // Invalidate caches
        const projectPath = selectedProject?.path
        if (projectPath) {
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.issues(projectPath, 'open'),
          })
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.issues(projectPath, 'all'),
          })
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.prs(projectPath, 'open'),
          })
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.prs(projectPath, 'all'),
          })
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.securityAlerts(projectPath, 'open'),
          })
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.securityAlerts(projectPath, 'all'),
          })
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.advisories(projectPath, 'published'),
          })
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.advisories(projectPath, 'all'),
          })
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.discussions(projectPath, 'open'),
          })
          queryClient.invalidateQueries({
            queryKey: githubQueryKeys.discussions(projectPath, 'all'),
          })
        }
        if (selectedProjectId) {
          queryClient.invalidateQueries({
            queryKey: [
              ...projectsQueryKeys.detail(selectedProjectId),
              'branches',
            ],
          })
          // Invalidate Linear issues cache
          queryClient.invalidateQueries({
            queryKey: ['linear', 'issues', selectedProjectId],
          })
          queryClient.invalidateQueries({
            queryKey: ['sentry', 'issues', selectedProjectId],
          })
        }
      }
      useUIStore.getState().setNewWorktreeModalOpen(open)
    },
    [
      selectedProject,
      queryClient,
      selectedProjectId,
      setActiveTab,
      setSearchQuery,
      setSelectedItemIndex,
      setIncludeClosed,
    ]
  )

  /**
   * Central duplicate guard: when an item already has a worktree/session,
   * open that instead of creating another one. Returns true if handled.
   */
  const openExistingMatch = useCallback(
    (ref: ContextLinkRef, label: string): boolean => {
      const match = getMatches?.(ref)[0]
      if (!match) return false
      handleOpenChange(false)
      openContextLinkMatch(match)
      toast.info(
        `${label} already has a worktree — opened ${contextLinkMatchLabel(match)}`
      )
      return true
    },
    [getMatches, handleOpenChange]
  )

  /** Drop items that already have a worktree/session; toast how many were skipped. */
  const skipLinkedItems = useCallback(
    <T>(items: T[], toRef: (item: T) => ContextLinkRef): T[] => {
      if (!getMatches) return items
      const remaining = items.filter(
        item => getMatches(toRef(item)).length === 0
      )
      const skipped = items.length - remaining.length
      if (skipped > 0) {
        toast.info(
          `Skipped ${skipped} ${skipped === 1 ? 'item' : 'items'} that already ${skipped === 1 ? 'has' : 'have'} a worktree`
        )
      }
      return remaining
    },
    [getMatches]
  )

  const handleCreateWorktree = useCallback(
    (customName?: string, baseBranch?: string) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }
      createWorktree.mutate({
        projectId: selectedProjectId,
        customName,
        baseBranch,
      })
      handleOpenChange(false)
    },
    [selectedProjectId, createWorktree, handleOpenChange]
  )

  const handleBaseSession = useCallback(() => {
    if (!selectedProjectId) {
      toast.error('No project selected')
      return
    }

    const targetIsCurrent =
      !startOnHost ||
      startOnHost.hostId === (selectedProject?.serverId ?? 'local')

    if (targetIsCurrent && hasBaseSession && baseSession) {
      const { selectWorktree } = useProjectsStore.getState()
      selectWorktree(baseSession.id)
      useChatStore
        .getState()
        .registerWorktreePath(baseSession.id, baseSession.path)

      // Close NewWorktreeModal first
      handleOpenChange(false)

      // Open the base session in SessionChatModal via custom event
      window.dispatchEvent(
        new CustomEvent('open-worktree-modal', {
          detail: {
            worktreeId: baseSession.id,
            worktreePath: baseSession.path,
          },
        })
      )
      toast.success(`Switched to base session: ${baseSession.name}`)
      return
    } else {
      createBaseSession.mutate(selectedProjectId)
    }
    handleOpenChange(false)
  }, [
    selectedProjectId,
    selectedProject,
    hasBaseSession,
    baseSession,
    createBaseSession,
    handleOpenChange,
    startOnHost,
  ])

  const handleSelectBranch = useCallback(
    (branchName: string, background = false) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }
      setCreatingFromBranch(branchName)
      if (background)
        useUIStore.getState().incrementPendingBackgroundCreations()
      createWorktreeFromBranch.mutate(
        { projectId: selectedProjectId, branchName, background },
        {
          onError: () => setCreatingFromBranch(null),
          onSuccess: () => {
            if (background) setCreatingFromBranch(null)
          },
        }
      )
      if (!background) handleOpenChange(false)
    },
    [selectedProjectId, createWorktreeFromBranch, handleOpenChange]
  )

  const handleSelectIssue = useCallback(
    async (issue: GitHubIssue, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

      if (
        openExistingMatch(
          { type: 'issue', id: issue.number },
          `Issue #${issue.number}`
        )
      )
        return

      setCreatingFromNumber(issue.number)

      try {
        const issueDetail = await invoke<
          GitHubIssue & {
            comments: {
              body: string
              author: { login: string }
              created_at: string
            }[]
          }
        >('get_github_issue', {
          projectPath,
          issueNumber: issue.number,
        })

        const issueContext: IssueContext = {
          number: issueDetail.number,
          title: issueDetail.title,
          body: issueDetail.body,
          comments: (issueDetail.comments ?? []).flatMap(c =>
            c && c.created_at && c.author
              ? [
                  {
                    body: c.body ?? '',
                    author: { login: c.author.login ?? '' },
                    createdAt: c.created_at,
                  },
                ]
              : []
          ),
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        createWorktree.mutate({
          projectId: selectedProjectId,
          issueContext,
          background,
        })

        if (background) {
          setCreatingFromNumber(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to fetch issue details: ${error}`)
        setCreatingFromNumber(null)
      }
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      handleOpenChange,
      openExistingMatch,
    ]
  )

  const handleSelectIssueAndInvestigate = useCallback(
    async (issue: GitHubIssue, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

      if (
        openExistingMatch(
          { type: 'issue', id: issue.number },
          `Issue #${issue.number}`
        )
      )
        return

      setCreatingFromNumber(issue.number)

      try {
        const issueDetail = await invoke<
          GitHubIssue & {
            comments: {
              body: string
              author: { login: string }
              created_at: string
            }[]
          }
        >('get_github_issue', {
          projectPath,
          issueNumber: issue.number,
        })

        const issueContext: IssueContext = {
          number: issueDetail.number,
          title: issueDetail.title,
          body: issueDetail.body,
          comments: (issueDetail.comments ?? []).flatMap(c =>
            c && c.created_at && c.author
              ? [
                  {
                    body: c.body ?? '',
                    author: { login: c.author.login ?? '' },
                    createdAt: c.created_at,
                  },
                ]
              : []
          ),
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()

        const worktree = await createWorktree.mutateAsync({
          projectId: selectedProjectId,
          issueContext,
          background,
        })
        useUIStore
          .getState()
          .markWorktreeForAutoInvestigate(worktree.id, investigationOverride)

        if (background) {
          setCreatingFromNumber(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to fetch issue details: ${error}`)
        setCreatingFromNumber(null)
      }
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      handleOpenChange,
      openExistingMatch,
      investigationOverride,
    ]
  )

  /** Start background investigation for multiple issues at once (new-session multi-select). */
  const handleBulkInvestigateIssues = useCallback(
    async (selectedIssues: GitHubIssue[]) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }
      const issues = skipLinkedItems(selectedIssues, issue => ({
        type: 'issue',
        id: issue.number,
      }))
      if (issues.length < 1) return

      setIsBulkInvestigating(true)
      const toastId = toast.loading(
        `Starting investigation of ${issues.length} issues…`
      )

      const results = await Promise.allSettled(
        issues.map(async issue => {
          const issueDetail = await invoke<
            GitHubIssue & {
              comments: {
                body: string
                author: { login: string }
                created_at: string
              }[]
            }
          >('get_github_issue', {
            projectPath,
            issueNumber: issue.number,
          })

          const issueContext: IssueContext = {
            number: issueDetail.number,
            title: issueDetail.title,
            body: issueDetail.body,
            comments: (issueDetail.comments ?? []).flatMap(c =>
              c && c.created_at && c.author
                ? [
                    {
                      body: c.body ?? '',
                      author: { login: c.author.login ?? '' },
                      createdAt: c.created_at,
                    },
                  ]
                : []
            ),
          }

          useUIStore.getState().incrementPendingBackgroundCreations()
          const worktree = await createWorktree.mutateAsync({
            projectId: selectedProjectId,
            issueContext,
            background: true,
          })
          useUIStore
            .getState()
            .markWorktreeForAutoInvestigate(worktree.id, investigationOverride)
          return issue.number
        })
      )

      setIsBulkInvestigating(false)
      const succeeded = results.filter(r => r.status === 'fulfilled').length
      reportBulkInvestigateResults(
        toastId,
        succeeded,
        results.length - succeeded,
        'issue',
        'issues'
      )
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      investigationOverride,
      skipLinkedItems,
    ]
  )

  const handleBulkInvestigatePRs = useCallback(
    async (selectedPrs: GitHubPullRequest[]) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }
      const prs = skipLinkedItems(selectedPrs, pr => ({
        type: 'pr',
        id: pr.number,
      }))
      if (prs.length < 1) return

      setIsBulkInvestigating(true)
      const toastId = toast.loading(
        `Starting investigation of ${prs.length} PRs…`
      )

      const results = await Promise.allSettled(
        prs.map(async pr => {
          const prDetail = await invoke<
            GitHubPullRequest & {
              comments: {
                body: string
                author: { login: string }
                created_at: string
              }[]
              reviews: {
                body: string
                state: string
                author: { login: string }
                submittedAt?: string
              }[]
            }
          >('get_github_pr', {
            projectPath,
            prNumber: pr.number,
          })

          const prContext: PullRequestContext = {
            number: prDetail.number,
            title: prDetail.title,
            body: prDetail.body,
            headRefName: prDetail.headRefName,
            baseRefName: prDetail.baseRefName,
            comments: (prDetail.comments ?? []).flatMap(c =>
              c && c.created_at && c.author
                ? [
                    {
                      body: c.body ?? '',
                      author: { login: c.author.login ?? '' },
                      createdAt: c.created_at,
                    },
                  ]
                : []
            ),
            reviews: (prDetail.reviews ?? []).flatMap(r =>
              r && r.author
                ? [
                    {
                      body: r.body ?? '',
                      state: r.state,
                      author: { login: r.author.login ?? '' },
                      submittedAt: r.submittedAt,
                    },
                  ]
                : []
            ),
          }

          useUIStore.getState().incrementPendingBackgroundCreations()
          const worktree = await createWorktree.mutateAsync({
            projectId: selectedProjectId,
            prContext,
            background: true,
          })
          useUIStore
            .getState()
            .markWorktreeForAutoInvestigatePR(
              worktree.id,
              investigationOverride
            )
          return pr.number
        })
      )

      setIsBulkInvestigating(false)
      const succeeded = results.filter(r => r.status === 'fulfilled').length
      reportBulkInvestigateResults(
        toastId,
        succeeded,
        results.length - succeeded,
        'PR',
        'PRs'
      )
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      investigationOverride,
      skipLinkedItems,
    ]
  )

  const handleBulkInvestigateSecurity = useCallback(
    async (selectedItems: SecuritySelection[]) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }
      const items = skipLinkedItems(selectedItems, item =>
        item.kind === 'alert'
          ? { type: 'security', id: item.alert.number }
          : { type: 'advisory', id: item.advisory.ghsaId }
      )
      if (items.length < 1) return

      setIsBulkInvestigating(true)
      const toastId = toast.loading(
        `Starting investigation of ${items.length} security items…`
      )

      const results = await Promise.allSettled(
        items.map(async item => {
          if (item.kind === 'alert') {
            const alertDetail = await invoke<DependabotAlert>(
              'get_dependabot_alert',
              {
                projectPath,
                alertNumber: item.alert.number,
              }
            )
            const securityContext: SecurityAlertContext = {
              number: alertDetail.number,
              packageName: alertDetail.packageName,
              packageEcosystem: alertDetail.packageEcosystem,
              severity: alertDetail.severity,
              summary: alertDetail.summary,
              description: alertDetail.description,
              ghsaId: alertDetail.ghsaId,
              cveId: alertDetail.cveId,
              manifestPath: alertDetail.manifestPath,
              htmlUrl: alertDetail.htmlUrl,
            }
            useUIStore.getState().incrementPendingBackgroundCreations()
            const worktree = await createWorktree.mutateAsync({
              projectId: selectedProjectId,
              securityContext,
              background: true,
            })
            useUIStore
              .getState()
              .markWorktreeForAutoInvestigateSecurityAlert(worktree.id)
            return `alert:${item.alert.number}`
          }

          const advisoryDetail = await invoke<RepositoryAdvisory>(
            'get_repository_advisory',
            {
              projectPath,
              ghsaId: item.advisory.ghsaId,
            }
          )
          const advisoryContext: AdvisoryContext = {
            ghsaId: advisoryDetail.ghsaId,
            severity: advisoryDetail.severity,
            summary: advisoryDetail.summary,
            description: advisoryDetail.description,
            cveId: advisoryDetail.cveId,
            vulnerabilities: advisoryDetail.vulnerabilities.map(v => ({
              packageName: v.packageName,
              packageEcosystem: v.packageEcosystem,
              vulnerableVersionRange: v.vulnerableVersionRange,
              patchedVersions: v.patchedVersions,
            })),
            htmlUrl: advisoryDetail.htmlUrl,
          }
          useUIStore.getState().incrementPendingBackgroundCreations()
          const worktree = await createWorktree.mutateAsync({
            projectId: selectedProjectId,
            advisoryContext,
            background: true,
          })
          useUIStore
            .getState()
            .markWorktreeForAutoInvestigateAdvisory(worktree.id)
          return `advisory:${item.advisory.ghsaId}`
        })
      )

      setIsBulkInvestigating(false)
      const succeeded = results.filter(r => r.status === 'fulfilled').length
      reportBulkInvestigateResults(
        toastId,
        succeeded,
        results.length - succeeded,
        'item',
        'items'
      )
    },
    [selectedProjectId, selectedProject, createWorktree, skipLinkedItems]
  )

  const handleBulkInvestigateLinearIssues = useCallback(
    async (selectedIssues: LinearIssue[]) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }
      const issues = skipLinkedItems(selectedIssues, issue => ({
        type: 'linear',
        id: issue.identifier,
      }))
      if (issues.length < 1) return

      setIsBulkInvestigating(true)
      const toastId = toast.loading(
        `Starting investigation of ${issues.length} Linear issues…`
      )

      const results = await Promise.allSettled(
        issues.map(async issue => {
          const detail = await invoke<LinearIssueDetail>('get_linear_issue', {
            projectId: selectedProjectId,
            issueId: issue.id,
          })
          const linearContext = {
            id: detail.id,
            identifier: detail.identifier,
            title: detail.title,
            description: detail.description,
            comments: detail.comments ?? [],
          }
          useUIStore.getState().incrementPendingBackgroundCreations()
          const worktree = await createWorktree.mutateAsync({
            projectId: selectedProjectId,
            linearContext,
            background: true,
          })
          useUIStore
            .getState()
            .markWorktreeForAutoInvestigateLinearIssue(worktree.id)
          return issue.id
        })
      )

      setIsBulkInvestigating(false)
      const succeeded = results.filter(r => r.status === 'fulfilled').length
      reportBulkInvestigateResults(
        toastId,
        succeeded,
        results.length - succeeded,
        'issue',
        'issues'
      )
    },
    [selectedProjectId, createWorktree, skipLinkedItems]
  )

  const handleBulkInvestigateSentryIssues = useCallback(
    async (issues: SentryIssue[]) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }
      if (issues.length < 1) return

      setIsBulkInvestigating(true)
      const toastId = toast.loading(
        `Starting investigation of ${issues.length} Sentry issues…`
      )

      const results = await Promise.allSettled(
        issues.map(async issue => {
          const sentryContext = await invoke<SentryIssueContext>(
            'get_sentry_issue',
            { projectId: selectedProjectId, issueId: issue.id }
          )
          useUIStore.getState().incrementPendingBackgroundCreations()
          const worktree = await createWorktree.mutateAsync({
            projectId: selectedProjectId,
            sentryContext,
            background: true,
          })
          useUIStore
            .getState()
            .markWorktreeForAutoInvestigateSentryIssue(worktree.id)
          return issue.id
        })
      )

      setIsBulkInvestigating(false)
      const succeeded = results.filter(r => r.status === 'fulfilled').length
      reportBulkInvestigateResults(
        toastId,
        succeeded,
        results.length - succeeded,
        'issue',
        'issues'
      )
    },
    [selectedProjectId, createWorktree]
  )

  const handleSelectPR = useCallback(
    async (pr: GitHubPullRequest, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

      if (openExistingMatch({ type: 'pr', id: pr.number }, `PR #${pr.number}`))
        return

      setCreatingFromNumber(pr.number)

      try {
        const prDetail = await invoke<
          GitHubPullRequest & {
            comments: {
              body: string
              author: { login: string }
              created_at: string
            }[]
            reviews: {
              body: string
              state: string
              author: { login: string }
              submittedAt?: string
            }[]
          }
        >('get_github_pr', {
          projectPath,
          prNumber: pr.number,
        })

        const prContext: PullRequestContext = {
          number: prDetail.number,
          title: prDetail.title,
          body: prDetail.body,
          headRefName: prDetail.headRefName,
          baseRefName: prDetail.baseRefName,
          comments: (prDetail.comments ?? []).flatMap(c =>
            c && c.created_at && c.author
              ? [
                  {
                    body: c.body ?? '',
                    author: { login: c.author.login ?? '' },
                    createdAt: c.created_at,
                  },
                ]
              : []
          ),
          reviews: (prDetail.reviews ?? []).flatMap(r =>
            r && r.author
              ? [
                  {
                    body: r.body ?? '',
                    state: r.state,
                    author: { login: r.author.login ?? '' },
                    submittedAt: r.submittedAt,
                  },
                ]
              : []
          ),
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        createWorktree.mutate({
          projectId: selectedProjectId,
          prContext,
          background,
        })

        if (background) {
          setCreatingFromNumber(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to fetch PR details: ${error}`)
        setCreatingFromNumber(null)
      }
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      handleOpenChange,
      openExistingMatch,
    ]
  )

  const handleSelectPRAndInvestigate = useCallback(
    async (pr: GitHubPullRequest, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

      if (openExistingMatch({ type: 'pr', id: pr.number }, `PR #${pr.number}`))
        return

      setCreatingFromNumber(pr.number)

      try {
        const prDetail = await invoke<
          GitHubPullRequest & {
            comments: {
              body: string
              author: { login: string }
              created_at: string
            }[]
            reviews: {
              body: string
              state: string
              author: { login: string }
              submittedAt?: string
            }[]
          }
        >('get_github_pr', {
          projectPath,
          prNumber: pr.number,
        })

        const prContext: PullRequestContext = {
          number: prDetail.number,
          title: prDetail.title,
          body: prDetail.body,
          headRefName: prDetail.headRefName,
          baseRefName: prDetail.baseRefName,
          comments: (prDetail.comments ?? []).flatMap(c =>
            c && c.created_at && c.author
              ? [
                  {
                    body: c.body ?? '',
                    author: { login: c.author.login ?? '' },
                    createdAt: c.created_at,
                  },
                ]
              : []
          ),
          reviews: (prDetail.reviews ?? []).flatMap(r =>
            r && r.author
              ? [
                  {
                    body: r.body ?? '',
                    state: r.state,
                    author: { login: r.author.login ?? '' },
                    submittedAt: r.submittedAt,
                  },
                ]
              : []
          ),
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()

        const worktree = await createWorktree.mutateAsync({
          projectId: selectedProjectId,
          prContext,
          background,
        })
        useUIStore
          .getState()
          .markWorktreeForAutoInvestigatePR(worktree.id, investigationOverride)

        if (background) {
          setCreatingFromNumber(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to fetch PR details: ${error}`)
        setCreatingFromNumber(null)
      }
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      handleOpenChange,
      openExistingMatch,
      investigationOverride,
    ]
  )

  const handleSelectSecurityAlert = useCallback(
    async (alert: DependabotAlert, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

      if (
        openExistingMatch(
          { type: 'security', id: alert.number },
          `Alert #${alert.number}`
        )
      )
        return

      setCreatingFromNumber(alert.number)

      try {
        const alertDetail = await invoke<DependabotAlert>(
          'get_dependabot_alert',
          {
            projectPath,
            alertNumber: alert.number,
          }
        )

        const securityContext: SecurityAlertContext = {
          number: alertDetail.number,
          packageName: alertDetail.packageName,
          packageEcosystem: alertDetail.packageEcosystem,
          severity: alertDetail.severity,
          summary: alertDetail.summary,
          description: alertDetail.description,
          ghsaId: alertDetail.ghsaId,
          cveId: alertDetail.cveId,
          manifestPath: alertDetail.manifestPath,
          htmlUrl: alertDetail.htmlUrl,
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        createWorktree.mutate({
          projectId: selectedProjectId,
          securityContext,
          background,
        })

        if (background) {
          setCreatingFromNumber(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to fetch security alert details: ${error}`)
        setCreatingFromNumber(null)
      }
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      handleOpenChange,
      openExistingMatch,
    ]
  )

  const handleSelectSecurityAlertAndInvestigate = useCallback(
    async (alert: DependabotAlert, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

      if (
        openExistingMatch(
          { type: 'security', id: alert.number },
          `Alert #${alert.number}`
        )
      )
        return

      setCreatingFromNumber(alert.number)

      try {
        const alertDetail = await invoke<DependabotAlert>(
          'get_dependabot_alert',
          {
            projectPath,
            alertNumber: alert.number,
          }
        )

        const securityContext: SecurityAlertContext = {
          number: alertDetail.number,
          packageName: alertDetail.packageName,
          packageEcosystem: alertDetail.packageEcosystem,
          severity: alertDetail.severity,
          summary: alertDetail.summary,
          description: alertDetail.description,
          ghsaId: alertDetail.ghsaId,
          cveId: alertDetail.cveId,
          manifestPath: alertDetail.manifestPath,
          htmlUrl: alertDetail.htmlUrl,
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()

        const worktree = await createWorktree.mutateAsync({
          projectId: selectedProjectId,
          securityContext,
          background,
        })
        useUIStore
          .getState()
          .markWorktreeForAutoInvestigateSecurityAlert(worktree.id)

        if (background) {
          setCreatingFromNumber(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to fetch security alert details: ${error}`)
        setCreatingFromNumber(null)
      }
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      handleOpenChange,
      openExistingMatch,
    ]
  )

  const handleSelectAdvisory = useCallback(
    async (advisory: RepositoryAdvisory, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

      if (
        openExistingMatch(
          { type: 'advisory', id: advisory.ghsaId },
          advisory.ghsaId
        )
      )
        return

      setCreatingFromGhsaId(advisory.ghsaId)

      try {
        const advisoryDetail = await invoke<RepositoryAdvisory>(
          'get_repository_advisory',
          {
            projectPath,
            ghsaId: advisory.ghsaId,
          }
        )

        const advisoryContext: AdvisoryContext = {
          ghsaId: advisoryDetail.ghsaId,
          severity: advisoryDetail.severity,
          summary: advisoryDetail.summary,
          description: advisoryDetail.description,
          cveId: advisoryDetail.cveId,
          vulnerabilities: advisoryDetail.vulnerabilities.map(v => ({
            packageName: v.packageName,
            packageEcosystem: v.packageEcosystem,
            vulnerableVersionRange: v.vulnerableVersionRange,
            patchedVersions: v.patchedVersions,
          })),
          htmlUrl: advisoryDetail.htmlUrl,
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        createWorktree.mutate({
          projectId: selectedProjectId,
          advisoryContext,
          background,
        })

        if (background) {
          setCreatingFromGhsaId(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to fetch advisory details: ${error}`)
        setCreatingFromGhsaId(null)
      }
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      handleOpenChange,
      openExistingMatch,
    ]
  )

  const handleSelectAdvisoryAndInvestigate = useCallback(
    async (advisory: RepositoryAdvisory, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

      if (
        openExistingMatch(
          { type: 'advisory', id: advisory.ghsaId },
          advisory.ghsaId
        )
      )
        return

      setCreatingFromGhsaId(advisory.ghsaId)

      try {
        const advisoryDetail = await invoke<RepositoryAdvisory>(
          'get_repository_advisory',
          {
            projectPath,
            ghsaId: advisory.ghsaId,
          }
        )

        const advisoryContext: AdvisoryContext = {
          ghsaId: advisoryDetail.ghsaId,
          severity: advisoryDetail.severity,
          summary: advisoryDetail.summary,
          description: advisoryDetail.description,
          cveId: advisoryDetail.cveId,
          vulnerabilities: advisoryDetail.vulnerabilities.map(v => ({
            packageName: v.packageName,
            packageEcosystem: v.packageEcosystem,
            vulnerableVersionRange: v.vulnerableVersionRange,
            patchedVersions: v.patchedVersions,
          })),
          htmlUrl: advisoryDetail.htmlUrl,
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()

        const worktree = await createWorktree.mutateAsync({
          projectId: selectedProjectId,
          advisoryContext,
          background,
        })
        useUIStore
          .getState()
          .markWorktreeForAutoInvestigateAdvisory(worktree.id)

        if (background) {
          setCreatingFromGhsaId(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to fetch advisory details: ${error}`)
        setCreatingFromGhsaId(null)
      }
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      handleOpenChange,
      openExistingMatch,
    ]
  )

  // =========================================================================
  // Linear issue handlers
  // =========================================================================

  const handleSelectLinearIssue = useCallback(
    async (issue: LinearIssue, background = false) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }

      if (
        openExistingMatch(
          { type: 'linear', id: issue.identifier },
          issue.identifier
        )
      )
        return

      setCreatingFromLinearId(issue.id)

      try {
        const detail = await invoke<LinearIssueDetail>('get_linear_issue', {
          projectId: selectedProjectId,
          issueId: issue.id,
        })

        const linearContext = {
          id: detail.id,
          identifier: detail.identifier,
          title: detail.title,
          description: detail.description,
          comments: detail.comments ?? [],
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        createWorktree.mutate({
          projectId: selectedProjectId,
          linearContext,
          background,
        })

        if (background) {
          setCreatingFromLinearId(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to fetch Linear issue details: ${error}`)
        setCreatingFromLinearId(null)
      }
    },
    [selectedProjectId, createWorktree, handleOpenChange, openExistingMatch]
  )

  const handleSelectLinearIssueAndInvestigate = useCallback(
    async (issue: LinearIssue, background = false) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }

      if (
        openExistingMatch(
          { type: 'linear', id: issue.identifier },
          issue.identifier
        )
      )
        return

      setCreatingFromLinearId(issue.id)

      try {
        const detail = await invoke<LinearIssueDetail>('get_linear_issue', {
          projectId: selectedProjectId,
          issueId: issue.id,
        })

        const linearContext = {
          id: detail.id,
          identifier: detail.identifier,
          title: detail.title,
          description: detail.description,
          comments: detail.comments ?? [],
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        const worktree = await createWorktree.mutateAsync({
          projectId: selectedProjectId,
          linearContext,
          background,
        })

        if (worktree) {
          useUIStore
            .getState()
            .markWorktreeForAutoInvestigateLinearIssue(worktree.id)
        }

        if (background) {
          setCreatingFromLinearId(null)
        } else {
          handleOpenChange(false)
        }
      } catch (error) {
        toast.error(`Failed to create worktree from Linear issue: ${error}`)
        setCreatingFromLinearId(null)
      }
    },
    [selectedProjectId, createWorktree, handleOpenChange, openExistingMatch]
  )

  // =========================================================================
  // Sentry issue handlers
  // =========================================================================

  const createFromSentryIssue = useCallback(
    async (issue: SentryIssue, investigate: boolean, background = false) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }

      setCreatingFromSentryId(issue.id)
      try {
        const sentryContext = await invoke<SentryIssueContext>(
          'get_sentry_issue',
          { projectId: selectedProjectId, issueId: issue.id }
        )
        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        const worktree = await createWorktree.mutateAsync({
          projectId: selectedProjectId,
          sentryContext,
          background,
        })
        if (investigate) {
          useUIStore
            .getState()
            .markWorktreeForAutoInvestigateSentryIssue(worktree.id)
        }
        if (background) setCreatingFromSentryId(null)
        else handleOpenChange(false)
      } catch (error) {
        toast.error(`Failed to create worktree from Sentry issue: ${error}`)
        setCreatingFromSentryId(null)
      }
    },
    [selectedProjectId, createWorktree, handleOpenChange]
  )

  const handleSelectSentryIssue = useCallback(
    (issue: SentryIssue, background = false) =>
      createFromSentryIssue(issue, false, background),
    [createFromSentryIssue]
  )

  const handleSelectSentryIssueAndInvestigate = useCallback(
    (issue: SentryIssue, background = false) =>
      createFromSentryIssue(issue, true, background),
    [createFromSentryIssue]
  )

  // =========================================================================
  // Discussion handler (context only, no investigate)
  // =========================================================================

  const handleSelectDiscussion = useCallback(
    async (discussion: GitHubDiscussion, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

      if (
        openExistingMatch(
          { type: 'discussion', id: discussion.number },
          `Discussion #${discussion.number}`
        )
      )
        return

      setCreatingFromNumber(discussion.number)
      try {
        const detail = await getGitHubDiscussion(projectPath, discussion.number)
        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        await createWorktree.mutateAsync({
          projectId: selectedProjectId,
          discussionContext: {
            number: detail.number,
            title: detail.title,
            content: detail.content,
          },
          background,
        })
        if (background) setCreatingFromNumber(null)
        else handleOpenChange(false)
      } catch (error) {
        toast.error(`Failed to create worktree from discussion: ${error}`)
        setCreatingFromNumber(null)
      }
    },
    [
      selectedProjectId,
      selectedProject,
      createWorktree,
      handleOpenChange,
      openExistingMatch,
    ]
  )

  // =========================================================================
  // Stack handler: create a new worktree branched off a PR head
  // =========================================================================

  const handleStackOnPR = useCallback(
    (pr: GitHubPullRequest, background = false) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }
      setStackingFromPR(pr.number)
      if (background)
        useUIStore.getState().incrementPendingBackgroundCreations()
      createWorktree.mutate(
        {
          projectId: selectedProjectId,
          baseBranch: pr.headRefName,
          background,
        },
        {
          onError: () => setStackingFromPR(null),
          onSuccess: () => {
            if (background) setStackingFromPR(null)
          },
        }
      )
      if (!background) handleOpenChange(false)
    },
    [selectedProjectId, createWorktree, handleOpenChange]
  )

  return {
    creatingFromNumber,
    creatingFromLinearId,
    creatingFromSentryId,
    creatingFromBranch,
    creatingFromGhsaId,
    stackingFromPR,
    isBulkInvestigating,
    handleOpenChange,
    handleCreateWorktree,
    handleBaseSession,
    handleSelectBranch,
    handleSelectIssue,
    handleSelectIssueAndInvestigate,
    handleBulkInvestigateIssues,
    handleSelectPR,
    handleSelectPRAndInvestigate,
    handleBulkInvestigatePRs,
    handleStackOnPR,
    handleSelectSecurityAlert,
    handleSelectSecurityAlertAndInvestigate,
    handleSelectAdvisory,
    handleSelectAdvisoryAndInvestigate,
    handleBulkInvestigateSecurity,
    handleSelectLinearIssue,
    handleSelectLinearIssueAndInvestigate,
    handleBulkInvestigateLinearIssues,
    handleSelectSentryIssue,
    handleSelectSentryIssueAndInvestigate,
    handleBulkInvestigateSentryIssues,
    handleSelectDiscussion,
  }
}
