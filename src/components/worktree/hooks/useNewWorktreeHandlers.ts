import { useCallback, useState } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { githubQueryKeys } from '@/services/github'
import { projectsQueryKeys } from '@/services/projects'
import type {
  GitHubIssue,
  GitHubPullRequest,
  DependabotAlert,
  RepositoryAdvisory,
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

type Data = ReturnType<typeof useNewWorktreeData>

interface Setters {
  setActiveTab: (tab: TabId) => void
  setSearchQuery: (q: string) => void
  setSelectedItemIndex: (i: number) => void
  setIncludeClosed: (v: boolean) => void
}

export function useNewWorktreeHandlers(data: Data, setters: Setters) {
  const {
    queryClient,
    selectedProjectId,
    selectedProject,
    hasBaseSession,
    baseSession,
    createWorktree,
    createBaseSession,
    createWorktreeFromBranch,
  } = data

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

    if (hasBaseSession && baseSession) {
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
    hasBaseSession,
    baseSession,
    createBaseSession,
    handleOpenChange,
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
    [selectedProjectId, selectedProject, createWorktree, handleOpenChange]
  )

  const handleSelectIssueAndInvestigate = useCallback(
    async (issue: GitHubIssue, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

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
        useUIStore.getState().markWorktreeForAutoInvestigate(worktree.id)

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
    [selectedProjectId, selectedProject, createWorktree, handleOpenChange]
  )

  /** Start background investigation for multiple issues at once (new-session multi-select). */
  const handleBulkInvestigateIssues = useCallback(
    async (issues: GitHubIssue[]) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }
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
          useUIStore.getState().markWorktreeForAutoInvestigate(worktree.id)
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
    [selectedProjectId, selectedProject, createWorktree]
  )

  const handleBulkInvestigatePRs = useCallback(
    async (prs: GitHubPullRequest[]) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }
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
          useUIStore.getState().markWorktreeForAutoInvestigatePR(worktree.id)
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
    [selectedProjectId, selectedProject, createWorktree]
  )

  const handleBulkInvestigateSecurity = useCallback(
    async (items: SecuritySelection[]) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }
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
    [selectedProjectId, selectedProject, createWorktree]
  )

  const handleBulkInvestigateLinearIssues = useCallback(
    async (issues: LinearIssue[]) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }
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
    [selectedProjectId, createWorktree]
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
    [selectedProjectId, selectedProject, createWorktree, handleOpenChange]
  )

  const handleSelectPRAndInvestigate = useCallback(
    async (pr: GitHubPullRequest, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

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
        useUIStore.getState().markWorktreeForAutoInvestigatePR(worktree.id)

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
    [selectedProjectId, selectedProject, createWorktree, handleOpenChange]
  )

  const handleSelectSecurityAlert = useCallback(
    async (alert: DependabotAlert, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

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
    [selectedProjectId, selectedProject, createWorktree, handleOpenChange]
  )

  const handleSelectSecurityAlertAndInvestigate = useCallback(
    async (alert: DependabotAlert, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

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
    [selectedProjectId, selectedProject, createWorktree, handleOpenChange]
  )

  const handleSelectAdvisory = useCallback(
    async (advisory: RepositoryAdvisory, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

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
    [selectedProjectId, selectedProject, createWorktree, handleOpenChange]
  )

  const handleSelectAdvisoryAndInvestigate = useCallback(
    async (advisory: RepositoryAdvisory, background = false) => {
      const projectPath = selectedProject?.path
      if (!selectedProjectId || !projectPath) {
        toast.error('No project selected')
        return
      }

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
    [selectedProjectId, selectedProject, createWorktree, handleOpenChange]
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
    [selectedProjectId, createWorktree, handleOpenChange]
  )

  const handleSelectLinearIssueAndInvestigate = useCallback(
    async (issue: LinearIssue, background = false) => {
      if (!selectedProjectId) {
        toast.error('No project selected')
        return
      }

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
    [selectedProjectId, createWorktree, handleOpenChange]
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
  }
}
