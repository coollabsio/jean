import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  type ElementType,
} from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  CircleDot,
  GitPullRequest,
  Shield,
  ShieldAlert,
  Search,
  Loader2,
  AlertCircle,
  Wand2,
} from 'lucide-react'
import { toast } from 'sonner'
import { getModifierSymbol } from '@/lib/platform'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { useProjects, isTauri, useCreateWorktree } from '@/services/projects'
import { isFolder } from '@/types/projects'
import {
  isGhAuthError,
  githubQueryKeys,
  parseLabelQuery,
} from '@/services/github'
import { GhAuthError } from '@/components/shared/GhAuthError'
import { IssuePreviewModal } from '@/components/worktree/IssuePreviewModal'
import { useGhLogin } from '@/hooks/useGhLogin'
import { invoke } from '@/lib/transport'
import type {
  GitHubIssue,
  GitHubIssueListResult,
  GitHubPullRequest,
  DependabotAlert,
  RepositoryAdvisory,
  IssueContext,
  PullRequestContext,
  SecurityAlertContext,
  AdvisoryContext,
} from '@/types/github'
import type { Project } from '@/types/projects'

// =============================================================================
// Types
// =============================================================================

type DashboardTab = 'issues' | 'prs' | 'security' | 'advisories'

interface PreviewState {
  projectPath: string
  type: 'issue' | 'pr' | 'security' | 'advisory'
  number: number
  ghsaId?: string
}

// =============================================================================
// Tab Bar
// =============================================================================

const TABS: { id: DashboardTab; label: string; icon: ElementType }[] = [
  { id: 'issues', label: 'Issues', icon: CircleDot },
  { id: 'prs', label: 'Pull Requests', icon: GitPullRequest },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'advisories', label: 'Advisories', icon: ShieldAlert },
]

function DashboardTabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: DashboardTab
  onTabChange: (tab: DashboardTab) => void
}) {
  return (
    <div className="flex border-b border-border flex-shrink-0">
      {TABS.map((tab, idx) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          tabIndex={-1}
          className={cn(
            'flex-1 px-4 py-2 text-sm font-medium transition-colors',
            'flex items-center justify-center gap-1.5',
            'hover:bg-accent focus:outline-none',
            'border-b-2',
            activeTab === tab.id
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground'
          )}
        >
          <tab.icon className="h-4 w-4" />
          <span className="hidden sm:inline">{tab.label}</span>
          <kbd className="ml-1 hidden sm:inline-flex h-4 items-center justify-center rounded border border-border bg-muted px-1 text-[10px] text-muted-foreground">
            {getModifierSymbol()}
            {idx + 1}
          </kbd>
        </button>
      ))}
    </div>
  )
}

// =============================================================================
// Investigate button (shared by all item rows)
// =============================================================================

function InvestigateButton({
  isCreating,
  tooltip,
  onClick,
}: {
  isCreating: boolean
  tooltip: string
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          disabled={isCreating}
          className="inline-flex h-6 w-6 items-center justify-center rounded px-1 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {isCreating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Wand2 className="h-3 w-3 text-current dark:text-yellow-400" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

// =============================================================================
// Item renderers
// =============================================================================

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500/10 text-red-600 border-red-500/20',
  high: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
  medium: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
  low: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
}

function IssueRow({
  issue,
  isCreating,
  onClick,
  onInvestigate,
  onLabelClick,
}: {
  issue: GitHubIssue
  isCreating: boolean
  onClick: () => void
  onInvestigate: (background: boolean) => void
  onLabelClick?: (label: string) => void
}) {
  return (
    <div
      className={cn(
        'group w-full flex items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-accent',
        isCreating && 'opacity-50'
      )}
    >
      {isCreating ? (
        <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
      ) : (
        <CircleDot
          className={cn(
            'h-4 w-4 mt-0.5 flex-shrink-0',
            issue.state === 'OPEN' ? 'text-green-500' : 'text-purple-500'
          )}
        />
      )}
      <button
        onClick={onClick}
        disabled={isCreating}
        className="flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">#{issue.number}</span>
          <span className="text-sm font-medium truncate">{issue.title}</span>
        </div>
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {issue.labels.slice(0, 3).map(label => (
              <span
                key={label.name}
                className={cn(
                  'px-1.5 py-0.5 text-xs rounded-full',
                  onLabelClick &&
                    'cursor-pointer hover:opacity-75 transition-opacity'
                )}
                style={{
                  backgroundColor: `#${label.color}20`,
                  color: `#${label.color}`,
                  border: `1px solid #${label.color}40`,
                }}
                onClick={
                  onLabelClick
                    ? e => {
                        e.stopPropagation()
                        onLabelClick(label.name)
                      }
                    : undefined
                }
              >
                {label.name}
              </span>
            ))}
          </div>
        )}
      </button>
      <div className="shrink-0 self-center">
        <InvestigateButton
          isCreating={isCreating}
          tooltip={`Investigate issue (${getModifierSymbol()}+Click = background)`}
          onClick={e => {
            e.stopPropagation()
            onInvestigate(e.metaKey || e.ctrlKey)
          }}
        />
      </div>
    </div>
  )
}

function PRRow({
  pr,
  isCreating,
  onClick,
  onInvestigate,
  onLabelClick,
}: {
  pr: GitHubPullRequest
  isCreating: boolean
  onClick: () => void
  onInvestigate: (background: boolean) => void
  onLabelClick?: (label: string) => void
}) {
  return (
    <div
      className={cn(
        'group w-full flex items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-accent',
        isCreating && 'opacity-50'
      )}
    >
      {isCreating ? (
        <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
      ) : (
        <GitPullRequest
          className={cn(
            'h-4 w-4 mt-0.5 flex-shrink-0',
            pr.state === 'OPEN'
              ? 'text-green-500'
              : pr.state === 'MERGED'
                ? 'text-purple-500'
                : 'text-red-500'
          )}
        />
      )}
      <button
        onClick={onClick}
        disabled={isCreating}
        className="flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">#{pr.number}</span>
          <span className="text-sm font-medium truncate">{pr.title}</span>
          {pr.isDraft && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
              Draft
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {pr.headRefName} → {pr.baseRefName}
        </span>
        {pr.labels.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {pr.labels.slice(0, 3).map(label => (
              <span
                key={label.name}
                className={cn(
                  'px-1.5 py-0.5 text-xs rounded-full',
                  onLabelClick &&
                    'cursor-pointer hover:opacity-75 transition-opacity'
                )}
                style={{
                  backgroundColor: `#${label.color}20`,
                  color: `#${label.color}`,
                  border: `1px solid #${label.color}40`,
                }}
                onClick={
                  onLabelClick
                    ? e => {
                        e.stopPropagation()
                        onLabelClick(label.name)
                      }
                    : undefined
                }
              >
                {label.name}
              </span>
            ))}
          </div>
        )}
      </button>
      <div className="shrink-0 self-center">
        <InvestigateButton
          isCreating={isCreating}
          tooltip={`Investigate PR (${getModifierSymbol()}+Click = background)`}
          onClick={e => {
            e.stopPropagation()
            onInvestigate(e.metaKey || e.ctrlKey)
          }}
        />
      </div>
    </div>
  )
}

function SecurityAlertRow({
  alert,
  isCreating,
  onClick,
  onInvestigate,
}: {
  alert: DependabotAlert
  isCreating: boolean
  onClick: () => void
  onInvestigate: (background: boolean) => void
}) {
  const severityClass =
    SEVERITY_COLORS[alert.severity.toLowerCase()] ??
    'bg-muted text-muted-foreground border-border'

  return (
    <div
      className={cn(
        'group w-full flex items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-accent',
        isCreating && 'opacity-50'
      )}
    >
      {isCreating ? (
        <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
      ) : (
        <Shield
          className={cn(
            'h-4 w-4 mt-0.5 flex-shrink-0',
            alert.state === 'open' ? 'text-orange-500' : 'text-muted-foreground'
          )}
        />
      )}
      <button
        onClick={onClick}
        disabled={isCreating}
        className="flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium border',
              severityClass
            )}
          >
            {alert.severity}
          </span>
          <span className="text-xs text-muted-foreground">#{alert.number}</span>
          <span className="text-sm font-medium truncate">
            {alert.packageName}
          </span>
        </div>
        <span className="text-xs text-muted-foreground truncate block">
          {alert.summary}
        </span>
      </button>
      <div className="shrink-0 self-center">
        <InvestigateButton
          isCreating={isCreating}
          tooltip={`Investigate alert (${getModifierSymbol()}+Click = background)`}
          onClick={e => {
            e.stopPropagation()
            onInvestigate(e.metaKey || e.ctrlKey)
          }}
        />
      </div>
    </div>
  )
}

function AdvisoryRow({
  advisory,
  isCreating,
  onClick,
  onInvestigate,
}: {
  advisory: RepositoryAdvisory
  isCreating: boolean
  onClick: () => void
  onInvestigate: (background: boolean) => void
}) {
  const severityClass =
    SEVERITY_COLORS[advisory.severity.toLowerCase()] ??
    'bg-muted text-muted-foreground border-border'

  return (
    <div
      className={cn(
        'group w-full flex items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-accent',
        isCreating && 'opacity-50'
      )}
    >
      {isCreating ? (
        <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" />
      ) : (
        <ShieldAlert
          className={cn(
            'h-4 w-4 mt-0.5 flex-shrink-0',
            advisory.state === 'published'
              ? 'text-orange-500'
              : 'text-muted-foreground'
          )}
        />
      )}
      <button
        onClick={onClick}
        disabled={isCreating}
        className="flex-1 min-w-0 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium border',
              severityClass
            )}
          >
            {advisory.severity}
          </span>
          <span className="text-sm font-medium truncate">
            {advisory.summary}
          </span>
        </div>
        <span className="text-xs text-muted-foreground/60">
          {advisory.ghsaId}
        </span>
      </button>
      <div className="shrink-0 self-center">
        <InvestigateButton
          isCreating={isCreating}
          tooltip={`Investigate advisory (${getModifierSymbol()}+Click = background)`}
          onClick={e => {
            e.stopPropagation()
            onInvestigate(e.metaKey || e.ctrlKey)
          }}
        />
      </div>
    </div>
  )
}

// =============================================================================
// Project section header
// =============================================================================

function ProjectSection({
  project,
  count,
  children,
}: {
  project: Project
  count: number
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-muted/80 backdrop-blur-sm border-b border-border">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {project.name}
        </span>
        <span className="text-xs text-muted-foreground bg-background border border-border rounded-full px-1.5 py-0.5 leading-none">
          {count}
        </span>
      </div>
      {children}
    </div>
  )
}

// =============================================================================
// Main modal
// =============================================================================

export function GitHubDashboardModal() {
  const githubDashboardOpen = useUIStore(state => state.githubDashboardOpen)
  const setGitHubDashboardOpen = useUIStore(
    state => state.setGitHubDashboardOpen
  )
  const [activeTab, setActiveTab] = useState<DashboardTab>('issues')
  const [searchQuery, setSearchQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<string>('all')

  const handleLabelClick = useCallback((labelName: string) => {
    const token = `label:"${labelName}"`
    setSearchQuery(prev =>
      prev.includes(token) ? prev : prev ? `${prev} ${token}` : token
    )
  }, [])
  const [preview, setPreview] = useState<PreviewState | null>(null)
  // Track which item is being created (number for issues/prs/alerts, ghsaId for advisories)
  const [creatingId, setCreatingId] = useState<string | null>(null)

  // Tab switching via Cmd/Ctrl+1-4 (dispatched from useMainWindowEventListeners)
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent<{ tab: DashboardTab }>).detail.tab
      setActiveTab(tab)
    }
    window.addEventListener('switch-dashboard-tab', handler)
    return () => window.removeEventListener('switch-dashboard-tab', handler)
  }, [])

  const { data: allProjects = [] } = useProjects()
  const { triggerLogin, isGhInstalled } = useGhLogin()
  const createWorktree = useCreateWorktree()

  // Only query projects with a valid path (exclude folders)
  const projects = useMemo(
    () => allProjects.filter(p => !isFolder(p) && p.path),
    [allProjects]
  )

  // Fetch issues for all projects in parallel
  const issueResults = useQueries({
    queries: projects.map(p => ({
      queryKey: githubQueryKeys.issues(p.path, 'open'),
      queryFn: async (): Promise<GitHubIssueListResult> => {
        if (!isTauri()) return { issues: [], totalCount: 0 }
        try {
          return await invoke<GitHubIssueListResult>('list_github_issues', {
            projectPath: p.path,
            state: 'open',
          })
        } catch (error) {
          if (isGhAuthError(error)) throw error
          return { issues: [], totalCount: 0 }
        }
      },
      enabled: projects.length > 0,
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      retry: 1,
    })),
  })

  // Fetch PRs for all projects in parallel
  const prResults = useQueries({
    queries: projects.map(p => ({
      queryKey: githubQueryKeys.prs(p.path, 'open'),
      queryFn: async (): Promise<GitHubPullRequest[]> => {
        if (!isTauri()) return []
        try {
          return await invoke<GitHubPullRequest[]>('list_github_prs', {
            projectPath: p.path,
            state: 'open',
          })
        } catch (error) {
          if (isGhAuthError(error)) throw error
          return []
        }
      },
      enabled: projects.length > 0,
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      retry: 1,
    })),
  })

  // Fetch security alerts for all projects in parallel
  const securityResults = useQueries({
    queries: projects.map(p => ({
      queryKey: githubQueryKeys.securityAlerts(p.path, 'open'),
      queryFn: async (): Promise<DependabotAlert[]> => {
        if (!isTauri()) return []
        try {
          return await invoke<DependabotAlert[]>('list_dependabot_alerts', {
            projectPath: p.path,
            state: 'open',
          })
        } catch (error) {
          if (isGhAuthError(error)) throw error
          return []
        }
      },
      enabled: projects.length > 0,
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      retry: 1,
    })),
  })

  // Fetch advisories for all projects in parallel
  const advisoryResults = useQueries({
    queries: projects.map(p => ({
      queryKey: githubQueryKeys.advisories(p.path, 'all'),
      queryFn: async (): Promise<RepositoryAdvisory[]> => {
        if (!isTauri()) return []
        try {
          return await invoke<RepositoryAdvisory[]>(
            'list_repository_advisories',
            {
              projectPath: p.path,
              state: null,
            }
          )
        } catch (error) {
          if (isGhAuthError(error)) throw error
          return []
        }
      },
      enabled: projects.length > 0,
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      retry: 1,
    })),
  })

  // ==========================================================================
  // Investigate handlers
  // ==========================================================================

  const handleInvestigateIssue = useCallback(
    async (
      issue: GitHubIssue,
      projectId: string,
      projectPath: string,
      background: boolean
    ) => {
      setCreatingId(`issue-${issue.number}`)
      try {
        const detail = await invoke<
          GitHubIssue & {
            comments: {
              body: string
              author: { login: string }
              created_at: string
            }[]
          }
        >('get_github_issue', { projectPath, issueNumber: issue.number })

        const issueContext: IssueContext = {
          number: detail.number,
          title: detail.title,
          body: detail.body,
          comments: (detail.comments ?? [])
            .filter(c => c && c.created_at && c.author)
            .map(c => ({
              body: c.body ?? '',
              author: { login: c.author.login ?? '' },
              createdAt: c.created_at,
            })),
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        const worktree = await createWorktree.mutateAsync({
          projectId,
          issueContext,
          background,
        })
        useUIStore.getState().markWorktreeForAutoInvestigate(worktree.id)
      } catch (error) {
        toast.error(`Failed: ${error}`)
      } finally {
        setCreatingId(null)
      }
    },
    [createWorktree]
  )

  const handleInvestigatePR = useCallback(
    async (
      pr: GitHubPullRequest,
      projectId: string,
      projectPath: string,
      background: boolean
    ) => {
      setCreatingId(`pr-${pr.number}`)
      try {
        const detail = await invoke<
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
        >('get_github_pr', { projectPath, prNumber: pr.number })

        const prContext: PullRequestContext = {
          number: detail.number,
          title: detail.title,
          body: detail.body,
          headRefName: detail.headRefName,
          baseRefName: detail.baseRefName,
          comments: (detail.comments ?? [])
            .filter(c => c && c.created_at && c.author)
            .map(c => ({
              body: c.body ?? '',
              author: { login: c.author.login ?? '' },
              createdAt: c.created_at,
            })),
          reviews: (detail.reviews ?? [])
            .filter(r => r && r.author)
            .map(r => ({
              body: r.body ?? '',
              state: r.state,
              author: { login: r.author.login ?? '' },
              submittedAt: r.submittedAt,
            })),
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        const worktree = await createWorktree.mutateAsync({
          projectId,
          prContext,
          background,
        })
        useUIStore.getState().markWorktreeForAutoInvestigatePR(worktree.id)
      } catch (error) {
        toast.error(`Failed: ${error}`)
      } finally {
        setCreatingId(null)
      }
    },
    [createWorktree]
  )

  const handleInvestigateSecurityAlert = useCallback(
    async (
      alert: DependabotAlert,
      projectId: string,
      projectPath: string,
      background: boolean
    ) => {
      setCreatingId(`security-${alert.number}`)
      try {
        const detail = await invoke<DependabotAlert>('get_dependabot_alert', {
          projectPath,
          alertNumber: alert.number,
        })

        const securityContext: SecurityAlertContext = {
          number: detail.number,
          packageName: detail.packageName,
          packageEcosystem: detail.packageEcosystem,
          severity: detail.severity,
          summary: detail.summary,
          description: detail.description,
          ghsaId: detail.ghsaId,
          cveId: detail.cveId,
          manifestPath: detail.manifestPath,
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        const worktree = await createWorktree.mutateAsync({
          projectId,
          securityContext,
          background,
        })
        useUIStore
          .getState()
          .markWorktreeForAutoInvestigateSecurityAlert(worktree.id)
      } catch (error) {
        toast.error(`Failed: ${error}`)
      } finally {
        setCreatingId(null)
      }
    },
    [createWorktree]
  )

  const handleInvestigateAdvisory = useCallback(
    async (
      advisory: RepositoryAdvisory,
      projectId: string,
      projectPath: string,
      background: boolean
    ) => {
      setCreatingId(`advisory-${advisory.ghsaId}`)
      try {
        const detail = await invoke<RepositoryAdvisory>(
          'get_repository_advisory',
          { projectPath, ghsaId: advisory.ghsaId }
        )

        const advisoryContext: AdvisoryContext = {
          ghsaId: detail.ghsaId,
          severity: detail.severity,
          summary: detail.summary,
          description: detail.description,
          cveId: detail.cveId,
          vulnerabilities: detail.vulnerabilities.map(v => ({
            packageName: v.packageName,
            packageEcosystem: v.packageEcosystem,
            vulnerableVersionRange: v.vulnerableVersionRange,
            patchedVersions: v.patchedVersions,
          })),
        }

        if (background)
          useUIStore.getState().incrementPendingBackgroundCreations()
        const worktree = await createWorktree.mutateAsync({
          projectId,
          advisoryContext,
          background,
        })
        useUIStore
          .getState()
          .markWorktreeForAutoInvestigateAdvisory(worktree.id)
      } catch (error) {
        toast.error(`Failed: ${error}`)
      } finally {
        setCreatingId(null)
      }
    },
    [createWorktree]
  )

  // ==========================================================================
  // Derived data
  // ==========================================================================

  const activeResults =
    activeTab === 'issues'
      ? issueResults
      : activeTab === 'prs'
        ? prResults
        : activeTab === 'security'
          ? securityResults
          : advisoryResults

  const authError = activeResults.find(r => isGhAuthError(r.error))

  const filteredProjects = useMemo(
    () =>
      projectFilter === 'all'
        ? projects
        : projects.filter(p => p.id === projectFilter),
    [projects, projectFilter]
  )

  const { labels: labelFilters, textQuery: q } = useMemo(
    () => parseLabelQuery(searchQuery),
    [searchQuery]
  )

  const isLoading = activeResults.some(r => r.isLoading)

  const projectData = useMemo(() => {
    return filteredProjects.map(project => {
      const projectIdx = projects.indexOf(project)
      if (projectIdx === -1) return { project, items: [] as unknown[] }

      if (activeTab === 'issues') {
        const issueData = issueResults[projectIdx]?.data
        const issues = (
          Array.isArray(issueData) ? issueData : (issueData?.issues ?? [])
        ) as GitHubIssue[]
        const filtered = issues.filter(i => {
          if (labelFilters.length > 0) {
            const iLabels = i.labels.map(l => l.name.toLowerCase())
            if (!labelFilters.every(l => iLabels.some(il => il.includes(l))))
              return false
          }
          if (!q) return true
          return (
            i.title.toLowerCase().includes(q) ||
            i.number.toString().includes(q) ||
            i.labels.some(l => l.name.toLowerCase().includes(q))
          )
        })
        return { project, items: filtered }
      }

      if (activeTab === 'prs') {
        const prs = (prResults[projectIdx]?.data ?? []) as GitHubPullRequest[]
        const filtered = prs.filter(p => {
          if (labelFilters.length > 0) {
            const pLabels = p.labels.map(l => l.name.toLowerCase())
            if (!labelFilters.every(l => pLabels.some(pl => pl.includes(l))))
              return false
          }
          if (!q) return true
          return (
            p.title.toLowerCase().includes(q) ||
            p.number.toString().includes(q) ||
            p.labels.some(l => l.name.toLowerCase().includes(q))
          )
        })
        return { project, items: filtered }
      }

      if (activeTab === 'security') {
        const alerts = (securityResults[projectIdx]?.data ??
          []) as DependabotAlert[]
        const filtered = q
          ? alerts.filter(
              a =>
                a.packageName.toLowerCase().includes(q) ||
                a.summary.toLowerCase().includes(q) ||
                a.number.toString().includes(q)
            )
          : alerts
        return { project, items: filtered }
      }

      const advisories = (advisoryResults[projectIdx]?.data ??
        []) as RepositoryAdvisory[]
      const filtered = q
        ? advisories.filter(
            a =>
              a.summary.toLowerCase().includes(q) ||
              a.ghsaId.toLowerCase().includes(q)
          )
        : advisories
      return { project, items: filtered }
    })
  }, [
    filteredProjects,
    projects,
    activeTab,
    issueResults,
    prResults,
    securityResults,
    advisoryResults,
    q,
    labelFilters,
  ])

  const totalCount = projectData.reduce(
    (sum, { items }) => sum + items.length,
    0
  )

  return (
    <Dialog open={githubDashboardOpen} onOpenChange={setGitHubDashboardOpen}>
      <DialogContent
        className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[90vw] sm:!max-w-[90vw] sm:!h-[85vh] sm:!max-h-[85vh] sm:!rounded-lg p-0 flex flex-col overflow-hidden"
        aria-describedby={undefined}
      >
        <DialogHeader className="px-4 pt-5 pb-2 flex-shrink-0">
          <div className="flex items-center gap-3 pr-6">
            <DialogTitle className="shrink-0">GitHub Dashboard</DialogTitle>
            <Select value={projectFilter} onValueChange={setProjectFilter}>
              <SelectTrigger className="!h-7 py-0 text-xs w-44 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Projects</SelectItem>
                {projects.map(p => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="pl-8 !h-7 py-0 text-xs"
              />
            </div>
          </div>
        </DialogHeader>

        <DashboardTabBar activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Content */}
        <ScrollArea className="flex-1 min-h-0">
          {authError ? (
            <GhAuthError onLogin={triggerLogin} isGhInstalled={isGhInstalled} />
          ) : isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : totalCount === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <AlertCircle className="h-5 w-5" />
              <p className="text-sm">
                {q || labelFilters.length > 0
                  ? 'No results match your search'
                  : `No ${activeTab === 'issues' ? 'open issues' : activeTab === 'prs' ? 'open pull requests' : activeTab === 'security' ? 'security alerts' : 'advisories'} found`}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {projectData
                .filter(({ items }) => items.length > 0)
                .map(({ project, items }) => (
                  <ProjectSection
                    key={project.id}
                    project={project}
                    count={items.length}
                  >
                    {activeTab === 'issues' &&
                      (items as GitHubIssue[]).map(issue => (
                        <IssueRow
                          key={issue.number}
                          issue={issue}
                          isCreating={creatingId === `issue-${issue.number}`}
                          onClick={() =>
                            setPreview({
                              projectPath: project.path,
                              type: 'issue',
                              number: issue.number,
                            })
                          }
                          onInvestigate={bg =>
                            handleInvestigateIssue(
                              issue,
                              project.id,
                              project.path,
                              bg
                            )
                          }
                          onLabelClick={handleLabelClick}
                        />
                      ))}
                    {activeTab === 'prs' &&
                      (items as GitHubPullRequest[]).map(pr => (
                        <PRRow
                          key={pr.number}
                          pr={pr}
                          isCreating={creatingId === `pr-${pr.number}`}
                          onClick={() =>
                            setPreview({
                              projectPath: project.path,
                              type: 'pr',
                              number: pr.number,
                            })
                          }
                          onInvestigate={bg =>
                            handleInvestigatePR(
                              pr,
                              project.id,
                              project.path,
                              bg
                            )
                          }
                          onLabelClick={handleLabelClick}
                        />
                      ))}
                    {activeTab === 'security' &&
                      (items as DependabotAlert[]).map(alert => (
                        <SecurityAlertRow
                          key={alert.number}
                          alert={alert}
                          isCreating={creatingId === `security-${alert.number}`}
                          onClick={() =>
                            setPreview({
                              projectPath: project.path,
                              type: 'security',
                              number: alert.number,
                            })
                          }
                          onInvestigate={bg =>
                            handleInvestigateSecurityAlert(
                              alert,
                              project.id,
                              project.path,
                              bg
                            )
                          }
                        />
                      ))}
                    {activeTab === 'advisories' &&
                      (items as RepositoryAdvisory[]).map(advisory => (
                        <AdvisoryRow
                          key={advisory.ghsaId}
                          advisory={advisory}
                          isCreating={
                            creatingId === `advisory-${advisory.ghsaId}`
                          }
                          onClick={() =>
                            setPreview({
                              projectPath: project.path,
                              type: 'advisory',
                              number: 0,
                              ghsaId: advisory.ghsaId,
                            })
                          }
                          onInvestigate={bg =>
                            handleInvestigateAdvisory(
                              advisory,
                              project.id,
                              project.path,
                              bg
                            )
                          }
                        />
                      ))}
                  </ProjectSection>
                ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>

      {preview && (
        <IssuePreviewModal
          open={!!preview}
          onOpenChange={open => {
            if (!open) setPreview(null)
          }}
          projectPath={preview.projectPath}
          type={preview.type}
          number={preview.number}
          ghsaId={preview.ghsaId}
        />
      )}
    </Dialog>
  )
}
