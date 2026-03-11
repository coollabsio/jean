import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { cn } from '@/lib/utils'
import {
  Search,
  MoreHorizontal,
  Settings,
  Plus,
  FileJson,
  Clock3,
  GitBranch,
  MessageSquare,
  Code,
  ExternalLink,
  Folder,
  FolderOpen,
  Home,
  Terminal,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { GitStatusBadges } from '@/components/ui/git-status-badges'
import {
  useWorktrees,
  useProjects,
  useJeanConfig,
  isTauri,
  useCreateBaseSession,
  useOpenProjectOnGitHub,
  useOpenProjectWorktreesFolder,
  useOpenWorktreeInEditor,
  useOpenWorktreeInFinder,
  useOpenWorktreeInTerminal,
  useRemoveProject,
  projectsQueryKeys,
} from '@/services/projects'
import {
  chatQueryKeys,
  useCreateSession,
  cancelChatMessage,
} from '@/services/chat'
import { useGitStatus } from '@/services/git-status'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { isBaseSession, type Worktree } from '@/types/projects'
import { getEditorLabel, getTerminalLabel } from '@/types/preferences'
import type { LabelData, Session, WorktreeSessions } from '@/types/chat'
import { NewIssuesBadge } from '@/components/shared/NewIssuesBadge'
import { OpenPRsBadge } from '@/components/shared/OpenPRsBadge'
import { FailedRunsBadge } from '@/components/shared/FailedRunsBadge'
import { SecurityAlertsBadge } from '@/components/shared/SecurityAlertsBadge'
import { PlanDialog } from '@/components/chat/PlanDialog'
import { RecapDialog } from '@/components/chat/RecapDialog'
import { SessionChatModal } from '@/components/chat/SessionChatModal'


import { LabelModal } from '@/components/chat/LabelModal'
import { getLabelTextColor } from '@/lib/label-colors'
import {
  type SessionCardData,
  computeSessionCardData,
  groupCardsByStatus,
  flattenGroups,
} from '@/components/chat/session-card-utils'
import { WorktreeSetupCard } from '@/components/chat/WorktreeSetupCard'
import { OpenInButton } from '@/components/open-in/OpenInButton'
import { useCanvasStoreState } from '@/components/chat/hooks/useCanvasStoreState'
import { usePlanApproval } from '@/components/chat/hooks/usePlanApproval'
import { useClearContextApproval } from '@/components/chat/hooks/useClearContextApproval'
import { useWorktreeApproval } from '@/components/chat/hooks/useWorktreeApproval'
import { useCanvasKeyboardNav } from '@/components/chat/hooks/useCanvasKeyboardNav'
import { useCanvasShortcutEvents } from '@/components/chat/hooks/useCanvasShortcutEvents'
import {
  useArchiveWorktree,
  useDeleteWorktree,
  useCloseBaseSessionClean,
  useCloseBaseSessionArchive,
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import { CloseWorktreeDialog } from '@/components/chat/CloseWorktreeDialog'
const GitDiffModal = lazy(() =>
  import('@/components/chat/GitDiffModal').then(mod => ({
    default: mod.GitDiffModal,
  }))
)
import type { DiffRequest } from '@/types/git-diff'
import { toast } from 'sonner'
import { useTerminalStore } from '@/store/terminal-store'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  gitPush,
  fetchWorktreesStatus,
  triggerImmediateGitPoll,
  performGitPull,
} from '@/services/git-status'
import { useRemotePicker } from '@/hooks/useRemotePicker'

interface ProjectCanvasViewProps {
  projectId: string
}

interface WorktreeSection {
  worktree: Worktree
  cards: SessionCardData[]
  isPending?: boolean
}

interface FlatCard {
  worktreeId: string
  worktreePath: string
  card: SessionCardData | null // null for pending worktrees
  globalIndex: number
  isPending?: boolean
}

type ActiveStatus =
  | 'waiting'
  | 'planning'
  | 'vibing'
  | 'yoloing'
  | 'review'
  | null

function getActiveStatus(cards: SessionCardData[]): ActiveStatus {
  if (cards.some(c => c.status === 'waiting' || c.status === 'permission'))
    return 'waiting'
  if (cards.some(c => c.status === 'yoloing')) return 'yoloing'
  if (cards.some(c => c.status === 'vibing')) return 'vibing'
  if (cards.some(c => c.status === 'planning')) return 'planning'
  if (cards.some(c => c.status === 'review' || c.status === 'completed'))
    return 'review'
  return null
}

function formatRelativeTime(timestamp?: number): string | null {
  if (!timestamp) return null
  // Some timestamps are stored in seconds; normalize to milliseconds.
  const normalizedTimestamp =
    timestamp > 0 && timestamp < 1_000_000_000_000
      ? timestamp * 1000
      : timestamp
  const diffMs = Date.now() - normalizedTimestamp
  if (diffMs < 0) return 'just now'
  const minuteMs = 60_000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs))
    return `${minutes}m ago`
  }
  if (diffMs < dayMs) {
    const hours = Math.floor(diffMs / hourMs)
    return `${hours}h ago`
  }
  const days = Math.floor(diffMs / dayMs)
  return `${days}d ago`
}

function getSessionMetrics(cards: SessionCardData[]) {
  const waitingCount = cards.filter(
    c => c.status === 'waiting' || c.status === 'permission'
  ).length
  const reviewCount = cards.filter(
    c => c.status === 'review' || c.status === 'completed'
  ).length
  const activeCount = cards.filter(
    c =>
      c.status === 'planning' || c.status === 'vibing' || c.status === 'yoloing'
  ).length
  const latestUpdatedAt = cards.reduce(
    (latest, card) => Math.max(latest, card.session.updated_at ?? card.session.created_at),
    0
  )

  return {
    totalCount: cards.length,
    waitingCount,
    reviewCount,
    activeCount,
    latestUpdatedAt,
  }
}

function WorktreeSectionHeader({
  worktree,
  projectId,
  defaultBranch,
  cards,
  showDetails = false,
  isSelected,
  shortcutNumber,
  onRowClick,
}: {
  worktree: Worktree
  projectId: string
  defaultBranch: string
  cards?: SessionCardData[]
  showDetails?: boolean
  isSelected?: boolean
  shortcutNumber?: number
  onRowClick?: () => void
}) {
  const isBase = isBaseSession(worktree)
  const { data: gitStatus } = useGitStatus(worktree.id)
  const [diffRequest, setDiffRequest] = useState<DiffRequest | null>(null)

  // Sync git diff modal open state to UI store (blocks execute_run keybinding)
  useEffect(() => {
    useUIStore.getState().setGitDiffModalOpen(!!diffRequest)
    return () => useUIStore.getState().setGitDiffModalOpen(false)
  }, [diffRequest])

  const hasRunningTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktree.id] ?? []
    // Show spinner when a run-script terminal exists: covers both "pending" (created
    // by startRun on canvas, PTY starts when session opens) and "running" (PTY active).
    // Terminal entry is removed on successful exit, so spinner clears automatically.
    return terminals.some(t => !!t.command)
  })

  const behindCount =
    gitStatus?.behind_count ?? worktree.cached_behind_count ?? 0
  const unpushedCount =
    gitStatus?.unpushed_count ?? worktree.cached_unpushed_count ?? 0

  // Diff stats: branch diff + uncommitted for non-base; uncommitted only for base
  const branchDiffAdded =
    gitStatus?.branch_diff_added ?? worktree.cached_branch_diff_added ?? 0
  const branchDiffRemoved =
    gitStatus?.branch_diff_removed ?? worktree.cached_branch_diff_removed ?? 0
  const uncommittedAdded =
    gitStatus?.uncommitted_added ?? worktree.cached_uncommitted_added ?? 0
  const uncommittedRemoved =
    gitStatus?.uncommitted_removed ?? worktree.cached_uncommitted_removed ?? 0
  const diffAdded = isBase
    ? uncommittedAdded
    : branchDiffAdded + uncommittedAdded
  const diffRemoved = isBase
    ? uncommittedRemoved
    : branchDiffRemoved + uncommittedRemoved

  const pickRemoteOrRun = useRemotePicker(worktree.path)

  const handlePull = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      await performGitPull({
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        baseBranch: defaultBranch,
        projectId,
      })
    },
    [worktree.id, worktree.path, defaultBranch, projectId]
  )

  const handlePush = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      pickRemoteOrRun(async remote => {
        const toastId = toast.loading('Pushing changes...')
        try {
          const result = await gitPush(worktree.path, worktree.pr_number, remote)
          triggerImmediateGitPoll()
          fetchWorktreesStatus(projectId)
          if (result.fellBack) {
            toast.warning('Could not push to PR branch, pushed to new branch instead', { id: toastId })
          } else {
            toast.success('Changes pushed', { id: toastId })
          }
        } catch (error) {
          toast.error(`Push failed: ${error}`, { id: toastId })
        }
      })
    },
    [worktree.path, worktree.pr_number, projectId, pickRemoteOrRun]
  )

  const handleDiffClick = useCallback(() => {
    setDiffRequest({
      type: isBase ? 'uncommitted' : 'branch',
      worktreePath: worktree.path,
      baseBranch: defaultBranch,
    })
  }, [isBase, worktree.path, defaultBranch])

  const sessionMetrics = useMemo(
    () => (cards && cards.length > 0 ? getSessionMetrics(cards) : null),
    [cards]
  )

  const uniqueSessionLabels = useMemo(() => {
    if (!cards) return []
    const seen = new Set<string>()
    const result: LabelData[] = []
    for (const card of cards) {
      if (card.label && !seen.has(card.label.name)) {
        seen.add(card.label.name)
        result.push(card.label)
      }
    }
    return result
  }, [cards])

  const lastActivity = formatRelativeTime(sessionMetrics?.latestUpdatedAt)
  const displayBranch = gitStatus?.current_branch ?? worktree.branch

  return (
    <>
      <div
        className={cn(
          'group relative border border-transparent transition-colors',
          showDetails
            ? 'mb-1 rounded-md px-3 py-2'
            : 'mb-0.5 flex items-center gap-2',
          onRowClick &&
            (showDetails
              ? 'cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60'
              : 'cursor-pointer px-2 -mx-2 py-1 hover:bg-muted/50'),
          isSelected && onRowClick && 'border-border/40 bg-muted/35'
        )}
        onClick={onRowClick}
        onKeyDown={e => {
          if (!onRowClick) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onRowClick()
          }
        }}
        role={onRowClick ? 'button' : undefined}
        tabIndex={onRowClick ? 0 : undefined}
        aria-label={
          onRowClick
            ? `Open ${isBase ? 'Base Session' : worktree.name}`
            : undefined
        }
      >
        {showDetails && isSelected && onRowClick && (
          <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-primary" />
        )}

        <div className={cn(showDetails ? 'flex flex-col gap-1.5' : 'contents')}>
          <div className="flex min-w-0 items-start gap-2 sm:items-center">
            {shortcutNumber !== undefined && (
              <kbd className="hidden shrink-0 h-4 min-w-4 items-center justify-center rounded border border-border/50 bg-muted/50 px-0.5 font-mono text-muted-foreground sm:inline-flex">
                <span className='text-[9px]'>⌘{shortcutNumber}</span>
              </kbd>
            )}
            {hasRunningTerminal && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="shrink-0 block h-3 w-3 square-spinner" />
                </TooltipTrigger>
                <TooltipContent>
                  Dev server running in terminal. Press ⌘R to open
                </TooltipContent>
              </Tooltip>
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-1 font-medium sm:flex-row sm:items-center sm:gap-1.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate">
                  {isBase ? 'Base Session' : worktree.name}
                </span>
                {displayBranch && (
                  <span className="hidden items-center gap-1 rounded-full border border-border/50 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground sm:inline-flex">
                    <GitBranch className="h-2.5 w-2.5" />
                    <span className="max-w-40 truncate">{displayBranch}</span>
                  </span>
                )}
                {worktree.label && (
                  <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: worktree.label.color,
                      color: getLabelTextColor(worktree.label.color),
                    }}
                  >
                    {worktree.label.name}
                  </span>
                )}
                <span
                  className="inline-flex items-center font-normal hover:bg-muted/50 rounded px-1.5 py-0.5"
                  onClick={e => e.stopPropagation()}
                >
                  <GitStatusBadges
                    behindCount={behindCount}
                    unpushedCount={unpushedCount}
                    diffAdded={diffAdded}
                    diffRemoved={diffRemoved}
                    onPull={handlePull}
                    onPush={handlePush}
                    onDiffClick={handleDiffClick}
                  />
                </span>
              </span>
              {displayBranch && (
                <span className="inline-flex max-w-full items-center gap-1 self-start rounded-full border border-border/50 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground sm:hidden">
                  <GitBranch className="h-2.5 w-2.5 shrink-0" />
                  <span className="max-w-full truncate">{displayBranch}</span>
                </span>
              )}
            </span>
          </div>
          {showDetails && sessionMetrics && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded bg-muted/50 border border-border/50 px-2 py-0.5">
                <MessageSquare className="h-3 w-3" />
                {sessionMetrics.totalCount} sessions
              </span>
              {sessionMetrics.reviewCount > 0 && (
                <span className="rounded  bg-green-500/10 px-2 py-0.5 text-green-600">
                  {sessionMetrics.reviewCount} review
                </span>
              )}
              {sessionMetrics.waitingCount > 0 && (
                <span className="rounded bg-yellow-500/90 px-2 py-0.5 text-black">
                  {sessionMetrics.waitingCount} waiting
                </span>
              )}
              {sessionMetrics.activeCount > 0 && (
                <span className="rounded bg-sky-500/10 px-2 py-0.5 text-sky-600">
                  {sessionMetrics.activeCount} active
                </span>
              )}
              {uniqueSessionLabels.map(label => (
                <span
                  key={label.name}
                  className="rounded px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: label.color,
                    color: getLabelTextColor(label.color),
                  }}
                >
                  {label.name}
                </span>
              ))}
              {lastActivity && (
                <span className="inline-flex items-center gap-1 rounded px-2 py-0.5">
                  <Clock3 className="h-3 w-3" />
                  {lastActivity}
                </span>
              )}
              {onRowClick && (
                <span className="ml-auto hidden text-[11px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 sm:inline-flex">
                  Press Enter to open
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <Suspense fallback={null}>
        <GitDiffModal
          diffRequest={diffRequest}
          onClose={() => setDiffRequest(null)}
          uncommittedStats={{
            added: uncommittedAdded,
            removed: uncommittedRemoved,
          }}
          branchStats={{ added: branchDiffAdded, removed: branchDiffRemoved }}
        />
      </Suspense>
    </>
  )
}

export function ProjectCanvasView({ projectId }: ProjectCanvasViewProps) {
  const { data: preferences } = usePreferences()

  // Project action mutations
  const createBaseSession = useCreateBaseSession()
  const removeProject = useRemoveProject()
  const openOnGitHub = useOpenProjectOnGitHub()
  const openInFinder = useOpenWorktreeInFinder()
  const openWorktreesFolder = useOpenProjectWorktreesFolder()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInEditor = useOpenWorktreeInEditor()

  const [searchQuery, setSearchQuery] = useState('')

  // Get project info
  const { data: projects = [], isLoading: projectsLoading } = useProjects()
  const project = projects.find(p => p.id === projectId)

  // Get worktrees
  const { data: worktrees = [], isLoading: worktreesLoading } =
    useWorktrees(projectId)

  // Filter worktrees: include ready, pending, and error (exclude deleting)
  const visibleWorktrees = useMemo(() => {
    return worktrees.filter(wt => wt.status !== 'deleting')
  }, [worktrees])

  // Separate ready and pending worktrees for different handling
  const readyWorktrees = useMemo(() => {
    return visibleWorktrees.filter(
      wt => !wt.status || wt.status === 'ready' || wt.status === 'error'
    )
  }, [visibleWorktrees])

  const pendingWorktrees = useMemo(() => {
    return visibleWorktrees.filter(wt => wt.status === 'pending')
  }, [visibleWorktrees])

  // Load sessions for all worktrees dynamically using useQueries
  const sessionQueries = useQueries({
    queries: readyWorktrees.map(wt => ({
      queryKey: [...chatQueryKeys.sessions(wt.id), 'with-counts'],
      queryFn: async (): Promise<WorktreeSessions> => {
        if (!isTauri() || !wt.id || !wt.path) {
          return {
            worktree_id: wt.id,
            sessions: [],
            active_session_id: null,
            version: 2,
          }
        }
        return invoke<WorktreeSessions>('get_sessions', {
          worktreeId: wt.id,
          worktreePath: wt.path,
          includeMessageCounts: true,
        })
      },
      enabled: !!wt.id && !!wt.path,
    })),
  })

  // Derive a stable fingerprint from query data to avoid re-computing
  // sessionsByWorktreeId when useQueries returns a new array with same data.
  const sessionsFingerprint = sessionQueries
    .map(q => `${q.data?.worktree_id}:${q.dataUpdatedAt}:${q.isLoading}`)
    .join('|')

  // Build a Map of worktree ID -> session data for stable lookups
  const sessionsByWorktreeId = useMemo(() => {
    const map = new Map<string, { sessions: Session[]; isLoading: boolean }>()
    for (const query of sessionQueries) {
      const worktreeId = query.data?.worktree_id
      if (worktreeId) {
        map.set(worktreeId, {
          sessions: query.data?.sessions ?? [],
          isLoading: query.isLoading,
        })
      }
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsFingerprint])

  // Keep a ref to sessionsByWorktreeId so effects/callbacks can read the
  // latest value without re-triggering when the Map reference changes.
  const sessionsByWorktreeIdRef = useRef(sessionsByWorktreeId)
  sessionsByWorktreeIdRef.current = sessionsByWorktreeId

  // Use shared store state hook
  const storeState = useCanvasStoreState()

  // Build worktree sections with computed card data
  const worktreeSections: WorktreeSection[] = useMemo(() => {
    const result: WorktreeSection[] = []

    // Add pending worktrees first (newest first by created_at)
    const sortedPending = [...pendingWorktrees].sort(
      (a, b) => b.created_at - a.created_at
    )
    for (const worktree of sortedPending) {
      // Include pending worktrees even without sessions - show setup card
      result.push({ worktree, cards: [], isPending: true })
    }

    // Sort ready worktrees: base sessions first, then by created_at (newest first)
    const sortedWorktrees = [...readyWorktrees].sort((a, b) => {
      const aIsBase = isBaseSession(a)
      const bIsBase = isBaseSession(b)
      if (aIsBase && !bIsBase) return -1
      if (!aIsBase && bIsBase) return 1
      return b.created_at - a.created_at
    })

    for (const worktree of sortedWorktrees) {
      const sessionData = sessionsByWorktreeId.get(worktree.id)
      const sessions = sessionData?.sessions ?? []

      // Base sessions are always visible (not searchable)
      const isBase = isBaseSession(worktree)

      // Filter sessions based on search query
      const filteredSessions =
        searchQuery.trim() && !isBase
          ? sessions.filter(
              session =>
                session.name
                  .toLowerCase()
                  .includes(searchQuery.toLowerCase()) ||
                worktree.name
                  .toLowerCase()
                  .includes(searchQuery.toLowerCase()) ||
                worktree.branch
                  .toLowerCase()
                  .includes(searchQuery.toLowerCase())
            )
          : sessions

      // Compute card data for each session
      const cards = filteredSessions.map(session =>
        computeSessionCardData(session, storeState)
      )

      // Sort: labeled first, grouped by label name, then unlabeled
      cards.sort((a, b) => {
        if (a.label && !b.label) return -1
        if (!a.label && b.label) return 1
        if (a.label && b.label) return a.label.name.localeCompare(b.label.name)
        return 0
      })

      // Re-order by status group so flat array matches visual group order
      const grouped = flattenGroups(groupCardsByStatus(cards))

      // Only include worktrees that have sessions (after filtering)
      if (grouped.length > 0) {
        result.push({ worktree, cards: grouped })
      }
    }

    return result
  }, [
    readyWorktrees,
    pendingWorktrees,
    sessionsByWorktreeId,
    storeState,
    searchQuery,
  ])

  const projectSummary = useMemo(() => {
    let reviewCount = 0
    let waitingCount = 0
    let activeCount = 0
    let totalReady = 0
    for (const section of worktreeSections) {
      if (section.isPending) continue
      totalReady++
      const status = getActiveStatus(section.cards)
      if (status === 'review') reviewCount++
      if (status === 'waiting') waitingCount++
      if (
        status === 'planning' ||
        status === 'vibing' ||
        status === 'yoloing'
      ) {
        activeCount++
      }
    }
    return { totalReady, reviewCount, waitingCount, activeCount }
  }, [worktreeSections])

  // Build flat array of all cards for keyboard navigation
  const flatCards: FlatCard[] = useMemo(() => {
    const result: FlatCard[] = []
    let globalIndex = 0
    for (const section of worktreeSections) {
      // One entry per worktree
      result.push({
        worktreeId: section.worktree.id,
        worktreePath: section.worktree.path,
        card: section.cards[0] ?? null,
        globalIndex,
        isPending: section.isPending,
      })
      globalIndex++
    }
    return result
  }, [worktreeSections])

  // Selection state
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [selectedWorktreeModal, setSelectedWorktreeModal] = useState<{
    worktreeId: string
    worktreePath: string
  } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Track highlighted card to survive reordering
  const highlightedCardRef = useRef<{
    worktreeId: string
    sessionId: string
  } | null>(null)

  // Worktree close confirmation (CMD+W on canvas)
  const [closeWorktreeTarget, setCloseWorktreeTarget] = useState<{
    worktreeId: string
    branchName?: string
  } | null>(null)

  // Git diff modal (CMD+G on canvas)
  const [canvasDiffRequest, setCanvasDiffRequest] =
    useState<DiffRequest | null>(null)

  // Sync canvas-level git diff modal open state to UI store (blocks execute_run keybinding)
  useEffect(() => {
    useUIStore.getState().setGitDiffModalOpen(!!canvasDiffRequest)
    return () => useUIStore.getState().setGitDiffModalOpen(false)
  }, [canvasDiffRequest])

  // Get current selected card's worktree info for hooks
  const selectedFlatCard =
    selectedIndex !== null ? flatCards[selectedIndex] : null

  // Use shared hooks - pass the currently selected card's worktree
  const { handlePlanApproval, handlePlanApprovalYolo } = usePlanApproval({
    worktreeId: selectedFlatCard?.worktreeId ?? '',
    worktreePath: selectedFlatCard?.worktreePath ?? '',
  })
  const { handleClearContextApproval, handleClearContextApprovalBuild } = useClearContextApproval({
    worktreeId: selectedFlatCard?.worktreeId ?? '',
    worktreePath: selectedFlatCard?.worktreePath ?? '',
  })
  const { handleWorktreeApproval, handleWorktreeApprovalYolo } = useWorktreeApproval({
    worktreeId: selectedFlatCard?.worktreeId ?? '',
    worktreePath: selectedFlatCard?.worktreePath ?? '',
    projectId: projectId ?? null,
  })

  // Archive mutations - need to handle per-worktree
  const archiveWorktree = useArchiveWorktree()
  const deleteWorktree = useDeleteWorktree()
  const closeBaseSessionClean = useCloseBaseSessionClean()
  const closeBaseSessionArchive = useCloseBaseSessionArchive()

  const closeWorktreeDirectly = useCallback(
    (worktreeId: string) => {
      if (!project) return
      const wt = visibleWorktrees.find(w => w.id === worktreeId)
      if (!wt) return
      if (isBaseSession(wt)) {
        if (preferences?.removal_behavior === 'delete') {
          closeBaseSessionClean.mutate({
            worktreeId: wt.id,
            projectId: project.id,
          })
        } else {
          closeBaseSessionArchive.mutate({
            worktreeId: wt.id,
            projectId: project.id,
          })
        }
      } else if (preferences?.removal_behavior === 'delete') {
        deleteWorktree.mutate({ worktreeId: wt.id, projectId: project.id })
      } else {
        archiveWorktree.mutate({ worktreeId: wt.id, projectId: project.id })
      }
    },
    [
      project,
      visibleWorktrees,
      preferences?.removal_behavior,
      archiveWorktree,
      deleteWorktree,
      closeBaseSessionClean,
      closeBaseSessionArchive,
    ]
  )

  const handleConfirmCloseWorktree = useCallback(() => {
    if (!closeWorktreeTarget) return
    closeWorktreeDirectly(closeWorktreeTarget.worktreeId)
    setCloseWorktreeTarget(null)
  }, [closeWorktreeTarget, closeWorktreeDirectly])

  // Listen for focus-canvas-search event
  useEffect(() => {
    const handleFocusSearch = () => searchInputRef.current?.focus()
    window.addEventListener('focus-canvas-search', handleFocusSearch)
    return () =>
      window.removeEventListener('focus-canvas-search', handleFocusSearch)
  }, [])

  // Track session modal open state for magic command keybindings
  useEffect(() => {
    useUIStore
      .getState()
      .setSessionChatModalOpen(
        !!selectedWorktreeModal,
        selectedWorktreeModal?.worktreeId ?? null
      )
  }, [selectedWorktreeModal])

  // Close modal when worktree is deleted/archived (e.g. PR merged)
  useEffect(() => {
    const handleCloseModal = (e: CustomEvent<{ worktreeId: string }>) => {
      if (selectedWorktreeModal?.worktreeId === e.detail.worktreeId) {
        setSelectedWorktreeModal(null)
      }
    }
    window.addEventListener('close-worktree-modal', handleCloseModal as EventListener)
    return () =>
      window.removeEventListener('close-worktree-modal', handleCloseModal as EventListener)
  }, [selectedWorktreeModal?.worktreeId])

  // Record last opened worktree+session per project for restoration on project switch
  const activeSessionIdForModal = useChatStore(state =>
    selectedWorktreeModal
      ? state.activeSessionIds[selectedWorktreeModal.worktreeId]
      : undefined
  )
  useEffect(() => {
    if (!selectedWorktreeModal || !activeSessionIdForModal) return
    useChatStore
      .getState()
      .setLastOpenedForProject(
        projectId,
        selectedWorktreeModal.worktreeId,
        activeSessionIdForModal
      )
  }, [projectId, selectedWorktreeModal, activeSessionIdForModal])

  // Track highlighted card when selectedIndex changes (for surviving reorders)
  const handleSelectedIndexChange = useCallback(
    (index: number | null) => {
      setSelectedIndex(index)
      if (index !== null && flatCards[index]?.card) {
        highlightedCardRef.current = {
          worktreeId: flatCards[index].worktreeId,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          sessionId: flatCards[index].card!.session.id,
        }
      }
    },
    [flatCards]
  )

  // Re-sync selectedIndex when flatCards reorders (status changes, etc.)
  useEffect(() => {
    const highlighted = selectedWorktreeModal
      ? { worktreeId: selectedWorktreeModal.worktreeId }
      : highlightedCardRef.current
    if (!highlighted) return
    const cardIndex = flatCards.findIndex(fc => fc.worktreeId === highlighted.worktreeId)
    if (cardIndex !== -1 && cardIndex !== selectedIndex) {
      setSelectedIndex(cardIndex)
    }
  }, [selectedWorktreeModal, flatCards, selectedIndex])

  // Keep a valid selection when the selected item disappears (archive/delete/close).
  // In list layout this prefers the previous row, matching expected canvas behavior.
  useEffect(() => {
    if (selectedIndex === null) return
    if (flatCards.length === 0) {
      setSelectedIndex(null)
      highlightedCardRef.current = null
      return
    }

    const selectedItem = flatCards[selectedIndex]
    if (selectedItem) return

    const fallbackIndex = Math.max(
      0,
      Math.min(selectedIndex - 1, flatCards.length - 1)
    )
    const fallbackItem = flatCards[fallbackIndex]
    setSelectedIndex(fallbackIndex)

    if (fallbackItem?.card) {
      highlightedCardRef.current = {
        worktreeId: fallbackItem.worktreeId,
        sessionId: fallbackItem.card.session.id,
      }
    } else {
      highlightedCardRef.current = null
    }
  }, [flatCards, selectedIndex])

  // Auto-open session modal for newly created worktrees
  useEffect(() => {
    const currentSessions = sessionsByWorktreeIdRef.current
    for (const [worktreeId, sessionData] of currentSessions) {
      if (!sessionData.sessions.length) continue

      const autoOpen = useUIStore.getState().consumeAutoOpenSession(worktreeId)
      if (!autoOpen.shouldOpen) continue

      const worktree = readyWorktrees.find(w => w.id === worktreeId)
      // Use specific session if provided, otherwise fall back to first session
      const targetSessionId = autoOpen.sessionId
      const targetSession = targetSessionId
        ? sessionData.sessions.find(s => s.id === targetSessionId)
        : sessionData.sessions[0]

      // If requested session hasn't arrived in this query yet, re-queue and retry later.
      if (targetSessionId && !targetSession) {
        useUIStore
          .getState()
          .markWorktreeForAutoOpenSession(worktreeId, targetSessionId)
        continue
      }

      if (worktree && targetSession) {
        // Find the index in flatCards for keyboard selection
        const cardIndex = flatCards.findIndex(
          fc =>
            fc.worktreeId === worktreeId &&
            fc.card?.session.id === targetSession.id
        )
        if (cardIndex !== -1) {
          setSelectedIndex(cardIndex)
          highlightedCardRef.current = {
            worktreeId,
            sessionId: targetSession.id,
          }
        }

        // Set active session so the modal opens on the right tab
        useChatStore.getState().setActiveSession(worktreeId, targetSession.id)
        setSelectedWorktreeModal({
          worktreeId,
          worktreePath: worktree.path,
        })
        break // Only one per render cycle
      }
    }
    // sessionsFingerprint tracks when session data changes (stable string, not Map reference)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsFingerprint, readyWorktrees, flatCards])

  // Auto-select session when dashboard opens (visual selection only, no modal unless restore_last_session is on)
  // Prefers last opened per project, then persisted active session per worktree, falls back to first card
  useEffect(() => {
    if (selectedIndex !== null || selectedWorktreeModal) return
    if (flatCards.length === 0) return

    const { activeSessionIds, lastActiveWorktreeId, lastOpenedPerProject } =
      useChatStore.getState()
    let targetIndex = -1
    let shouldAutoOpenModal = false
    let resolvedLastOpenedSessionId: string | null = null

    // First: check lastOpenedPerProject for this project
    const lastOpened = lastOpenedPerProject[projectId]
    if (lastOpened) {
      const worktreeSessions =
        sessionsByWorktreeIdRef.current.get(lastOpened.worktreeId)?.sessions ?? []
      const hasSavedSession = worktreeSessions.some(
        session => session.id === lastOpened.sessionId
      )
      resolvedLastOpenedSessionId = hasSavedSession
        ? lastOpened.sessionId
        : (worktreeSessions[0]?.id ?? null)

      for (const fc of flatCards) {
        if (!fc.card || fc.isPending) continue
        if (
          fc.worktreeId === lastOpened.worktreeId &&
          fc.card.session.id === lastOpened.sessionId
        ) {
          targetIndex = fc.globalIndex
          // Auto-open modal if restore_last_session is enabled
          if (preferences?.restore_last_session) {
            shouldAutoOpenModal = true
          }
          break
        }
      }

      // In list layout (or reordered cards), there may be only one card per worktree,
      // so exact session match can fail even when the worktree exists.
      if (targetIndex === -1) {
        const worktreeCard = flatCards.find(
          fc =>
            !fc.isPending &&
            fc.card !== null &&
            fc.worktreeId === lastOpened.worktreeId
        )
        if (worktreeCard) {
          targetIndex = worktreeCard.globalIndex
          if (preferences?.restore_last_session) {
            shouldAutoOpenModal = true
          }
        }
      }
    }

    // Second: check the last active worktree's session
    if (targetIndex === -1 && lastActiveWorktreeId) {
      const lastActiveSessionId = activeSessionIds[lastActiveWorktreeId]
      if (lastActiveSessionId) {
        for (const fc of flatCards) {
          if (!fc.card || fc.isPending) continue
          if (
            fc.worktreeId === lastActiveWorktreeId &&
            fc.card.session.id === lastActiveSessionId
          ) {
            targetIndex = fc.globalIndex
            break
          }
        }
      }
    }

    // Fallback: check any worktree's persisted active session
    if (targetIndex === -1) {
      for (const fc of flatCards) {
        if (!fc.card || fc.isPending) continue
        const activeId = activeSessionIds[fc.worktreeId]
        if (activeId && fc.card.session.id === activeId) {
          targetIndex = fc.globalIndex
          break
        }
      }
    }

    // Fall back to first non-pending card
    if (targetIndex === -1) {
      const firstCardIndex = flatCards.findIndex(
        fc => fc.card !== null && !fc.isPending
      )
      if (firstCardIndex === -1) return
      targetIndex = firstCardIndex
    }

    const targetCard = flatCards[targetIndex]
    setSelectedIndex(targetIndex)
    if (targetCard?.card) {
      // Sync projects store so commands (CMD+O, open terminal, etc.) work immediately
      useProjectsStore.getState().selectWorktree(targetCard.worktreeId)
      useChatStore
        .getState()
        .registerWorktreePath(targetCard.worktreeId, targetCard.worktreePath)

      // Auto-open SessionChatModal if restore_last_session is enabled
      if (shouldAutoOpenModal) {
        const sessionIdToOpen =
          lastOpened && targetCard.worktreeId === lastOpened.worktreeId
            ? (resolvedLastOpenedSessionId ?? targetCard.card.session.id)
            : targetCard.card.session.id

        useChatStore
          .getState()
          .setActiveSession(targetCard.worktreeId, sessionIdToOpen)
        setSelectedWorktreeModal({
          worktreeId: targetCard.worktreeId,
          worktreePath: targetCard.worktreePath,
        })
      }
    }
  }, [
    flatCards,
    selectedIndex,
    selectedWorktreeModal,
    projectId,
    preferences?.restore_last_session,
  ])

  // Mutations
  const createSession = useCreateSession()

  // Handle clicking on a worktree row - open modal
  const handleWorktreeClick = useCallback(
    (worktreeId: string, worktreePath: string) => {
      setSelectedWorktreeModal({ worktreeId, worktreePath })

      // Persist last-opened project context immediately on open so project switch
      // restore does not depend on a subsequent tab change event.
      const { activeSessionIds, setActiveSession, setLastOpenedForProject } =
        useChatStore.getState()
      const existingSessionId = activeSessionIds[worktreeId]
      const firstSessionId = sessionsByWorktreeIdRef.current.get(worktreeId)?.sessions[0]?.id
      const targetSessionId = existingSessionId ?? firstSessionId

      if (targetSessionId) {
        if (!existingSessionId) {
          setActiveSession(worktreeId, targetSessionId)
        }
        setLastOpenedForProject(projectId, worktreeId, targetSessionId)
      }
    },
    [projectId]
  )

  // Handle selection from keyboard nav
  const handleSelect = useCallback(
    (index: number) => {
      const item = flatCards[index]
      if (item && !item.isPending) {
        handleWorktreeClick(item.worktreeId, item.worktreePath)
      }
    },
    [flatCards, handleWorktreeClick]
  )

  // Handle selection change for tracking in store
  const syncSelectionToStore = useCallback(
    (index: number) => {
      const item = flatCards[index]
      if (item) {
        // Sync projects store so CMD+O, CMD+M (magic modal), etc. use the correct worktree
        useProjectsStore.getState().selectWorktree(item.worktreeId)
        // Register worktree path so OpenInModal can find it
        useChatStore
          .getState()
          .registerWorktreePath(item.worktreeId, item.worktreePath)
      }
    },
    [flatCards]
  )

  // Keep selectedWorktreeId in sync whenever selectedIndex changes (click, keyboard, or external)
  // This fixes the bug where closing a session calls selectProject() which clears selectedWorktreeId,
  // but the dashboard still has a card selected via selectedIndex
  useEffect(() => {
    if (selectedIndex !== null) {
      syncSelectionToStore(selectedIndex)
    }
  }, [selectedIndex, syncSelectionToStore])

  // CMD+1–9: open worktree by index (dispatched by centralized keybinding system)
  useEffect(() => {
    const handleOpenWorktreeByIndex = (e: Event) => {
      const index = (e as CustomEvent).detail?.index as number
      if (typeof index !== 'number') return
      // Find the nth non-pending worktree section
      let count = 0
      for (const section of worktreeSections) {
        if (section.isPending) continue
        if (count === index) {
          const flatIndex = flatCards.findIndex(
            fc => fc.worktreeId === section.worktree.id
          )
          if (flatIndex >= 0) handleSelectedIndexChange(flatIndex)
          handleWorktreeClick(section.worktree.id, section.worktree.path)
          return
        }
        count++
      }
    }

    window.addEventListener('open-worktree-by-index', handleOpenWorktreeByIndex)
    return () =>
      window.removeEventListener(
        'open-worktree-by-index',
        handleOpenWorktreeByIndex
      )
  }, [worktreeSections, flatCards, handleWorktreeClick, handleSelectedIndexChange])

  // Cancel running session via cancel-prompt event (dispatched by centralized keybinding system)
  useEffect(() => {
    const handleCancelPrompt = () => {
      // Skip when session modal is open — ChatWindow handles it in that case
      if (useUIStore.getState().sessionChatModalOpen) return

      if (!selectedFlatCard?.card) return
      const sessionId = selectedFlatCard.card.session.id
      const worktreeId = selectedFlatCard.worktreeId
      const isSending =
        useChatStore.getState().sendingSessionIds[sessionId] ?? false
      if (isSending) {
        cancelChatMessage(sessionId, worktreeId)
      }
    }

    window.addEventListener('cancel-prompt', handleCancelPrompt)
    return () => window.removeEventListener('cancel-prompt', handleCancelPrompt)
  }, [selectedFlatCard])

  // Get selected card for shortcut events
  const selectedCard = selectedFlatCard?.card ?? null

  // Shortcut events (plan, recap, approve) - must be before keyboard nav to get dialog states
  const {
    planDialogPath,
    planDialogContent,
    planApprovalContext,
    planDialogCard,
    closePlanDialog,
    recapDialogDigest,
    isRecapDialogOpen,
    isGeneratingRecap,
    regenerateRecap,
    closeRecapDialog,
  } = useCanvasShortcutEvents({
    selectedCard,
    enabled: !selectedWorktreeModal && selectedIndex !== null,
    worktreeId: selectedFlatCard?.worktreeId ?? '',
    worktreePath: selectedFlatCard?.worktreePath ?? '',
    onPlanApproval: (card, updatedPlan) =>
      handlePlanApproval(card, updatedPlan),
    onPlanApprovalYolo: (card, updatedPlan) =>
      handlePlanApprovalYolo(card, updatedPlan),
    onClearContextApproval: (card, updatedPlan) =>
      handleClearContextApproval(card, updatedPlan),
    onClearContextApprovalBuild: (card, updatedPlan) =>
      handleClearContextApprovalBuild(card, updatedPlan),
    onWorktreeApproval: handleWorktreeApproval
      ? (card, updatedPlan) => handleWorktreeApproval(card, updatedPlan)
      : null,
    onWorktreeApprovalYolo: handleWorktreeApprovalYolo
      ? (card, updatedPlan) => handleWorktreeApprovalYolo(card, updatedPlan)
      : null,
    skipLabelHandling: true,
  })

  // Worktree label modal state
  const queryClient = useQueryClient()
  const [worktreeLabelModalOpen, setWorktreeLabelModalOpen] = useState(false)
  const [worktreeLabelTarget, setWorktreeLabelTarget] = useState<{
    worktreeId: string
    currentLabel: LabelData | null
  } | null>(null)

  // Listen for toggle-session-label event — open label modal for worktree
  useEffect(() => {
    if (!!selectedWorktreeModal || selectedIndex === null) return

    const handleToggleLabel = () => {
      const flatCard = flatCards[selectedIndex]
      if (!flatCard) return

      const section = worktreeSections.find(
        s => s.worktree.id === flatCard.worktreeId
      )
      if (!section) return

      setWorktreeLabelTarget({
        worktreeId: section.worktree.id,
        currentLabel: section.worktree.label ?? null,
      })
      setWorktreeLabelModalOpen(true)
    }

    window.addEventListener('toggle-session-label', handleToggleLabel)
    return () =>
      window.removeEventListener('toggle-session-label', handleToggleLabel)
  }, [selectedWorktreeModal, selectedIndex, flatCards, worktreeSections])

  // CMD+G: Open git diff for selected worktree
  useEffect(() => {
    if (!!selectedWorktreeModal || selectedIndex === null) return

    const handleOpenGitDiff = () => {
      const flatCard = flatCards[selectedIndex]
      if (!flatCard) return

      const section = worktreeSections.find(
        s => s.worktree.id === flatCard.worktreeId
      )
      if (!section) return

      const isBase = isBaseSession(section.worktree)
      const baseBranch = project?.default_branch ?? 'main'

      setCanvasDiffRequest(prev => {
        if (prev) {
          return {
            ...prev,
            type: prev.type === 'uncommitted' ? 'branch' : 'uncommitted',
          }
        }
        return {
          type: isBase ? 'uncommitted' : 'branch',
          worktreePath: section.worktree.path,
          baseBranch,
        }
      })
    }

    window.addEventListener('open-git-diff', handleOpenGitDiff)
    return () => window.removeEventListener('open-git-diff', handleOpenGitDiff)
  }, [
    selectedWorktreeModal,
    selectedIndex,
    flatCards,
    worktreeSections,
    project?.default_branch,
  ])

  const handleWorktreeLabelApply = useCallback(
    async (label: LabelData | null) => {
      if (!worktreeLabelTarget) return

      try {
        await invoke('update_worktree_label', {
          worktreeId: worktreeLabelTarget.worktreeId,
          label,
        })
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        })
      } catch (error) {
        toast.error(`Failed to update label: ${error}`)
      }
    },
    [worktreeLabelTarget, queryClient, projectId]
  )

  // Keyboard navigation - disable when any modal/dialog is open
  const isModalOpen =
    !!selectedWorktreeModal ||
    !!planDialogPath ||
    !!planDialogContent ||
    isRecapDialogOpen ||
    worktreeLabelModalOpen
  const { cardRefs } = useCanvasKeyboardNav({
    cards: flatCards,
    selectedIndex,
    onSelectedIndexChange: handleSelectedIndexChange,
    onSelect: handleSelect,
    enabled: !isModalOpen,
    onSelectionChange: syncSelectionToStore,
  })

  // Handle approve from dialog (with updated plan content)
  const handleDialogApprove = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        handlePlanApproval(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, handlePlanApproval]
  )

  const handleDialogApproveYolo = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        handlePlanApprovalYolo(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, handlePlanApprovalYolo]
  )

  const handleDialogClearContextApprove = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        handleClearContextApproval(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, handleClearContextApproval]
  )

  const handleDialogClearContextApproveBuild = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        handleClearContextApprovalBuild(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, handleClearContextApprovalBuild]
  )

  const handleDialogWorktreeApprove = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard && handleWorktreeApproval) {
        handleWorktreeApproval(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, handleWorktreeApproval]
  )

  const handleDialogWorktreeApproveYolo = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard && handleWorktreeApprovalYolo) {
        handleWorktreeApprovalYolo(planDialogCard, updatedPlan)
      }
    },
    [planDialogCard, handleWorktreeApprovalYolo]
  )

  // Listen for close-session-or-worktree event to handle CMD+W
  useEffect(() => {
    const handleCloseSessionOrWorktree = (e: Event) => {
      // If modal is open, SessionChatModal intercepts CMD+W — let it handle
      if (selectedWorktreeModal) return

      // Consume the event to prevent the legacy useCloseSessionOrWorktreeKeybinding fallback
      e.stopImmediatePropagation()

      // No modal open — close the worktree of the selected card
      if (selectedIndex !== null && flatCards[selectedIndex]) {
        const item = flatCards[selectedIndex]
        if (!item.card) return // pending worktree, skip

        const section = worktreeSections.find(
          s => s.worktree.id === item.worktreeId
        )
        if (preferences?.confirm_session_close === false) {
          closeWorktreeDirectly(item.worktreeId)
        } else {
          setCloseWorktreeTarget({
            worktreeId: item.worktreeId,
            branchName: section?.worktree.branch,
          })
        }
      }
    }

    window.addEventListener(
      'close-session-or-worktree',
      handleCloseSessionOrWorktree,
      {
        capture: true,
      }
    )
    return () =>
      window.removeEventListener(
        'close-session-or-worktree',
        handleCloseSessionOrWorktree,
        { capture: true }
      )
  }, [
    selectedWorktreeModal,
    selectedIndex,
    flatCards,
    worktreeSections,
    preferences?.confirm_session_close,
    closeWorktreeDirectly,
  ])

  // Listen for create-new-session event to handle CMD+T
  useEffect(() => {
    const handleCreateNewSession = (e: Event) => {
      // Don't create if modal is already open
      if (selectedWorktreeModal) return

      // Use selected card, or fallback to first card
      const item =
        selectedIndex !== null ? flatCards[selectedIndex] : flatCards[0]
      if (!item) return

      e.stopImmediatePropagation()

      createSession.mutate(
        { worktreeId: item.worktreeId, worktreePath: item.worktreePath },
        {
          onSuccess: session => {
            // Update highlighted ref so canvas stays on new session after modal close
            highlightedCardRef.current = {
              worktreeId: item.worktreeId,
              sessionId: session.id,
            }
            useChatStore
              .getState()
              .setActiveSession(item.worktreeId, session.id)
            setSelectedWorktreeModal({
              worktreeId: item.worktreeId,
              worktreePath: item.worktreePath,
            })
          },
        }
      )
    }

    window.addEventListener('create-new-session', handleCreateNewSession, {
      capture: true,
    })
    return () =>
      window.removeEventListener('create-new-session', handleCreateNewSession, {
        capture: true,
      })
  }, [selectedWorktreeModal, selectedIndex, flatCards, createSession])

  // Listen for open-session-modal event (fired by ChatWindow when creating new session inside modal,
  // or by UnreadBell/UnreadSessionsModal to open a session on the project canvas)
  useEffect(() => {
    const handleOpenSessionModal = (
      e: CustomEvent<{
        sessionId: string
        worktreeId?: string
        worktreePath?: string
      }>
    ) => {
      const { sessionId, worktreeId, worktreePath } = e.detail

      // If worktreeId/worktreePath provided, open the modal for that worktree
      // (e.g. from UnreadBell navigating to a session on the project canvas)
      if (worktreeId && worktreePath) {
        useChatStore.getState().setActiveSession(worktreeId, sessionId)
        setSelectedWorktreeModal({ worktreeId, worktreePath })
        return
      }

      // Otherwise, the modal is already open — just switch tab
      if (selectedWorktreeModal) {
        useChatStore
          .getState()
          .setActiveSession(
            selectedWorktreeModal.worktreeId,
            e.detail.sessionId
          )
      }
    }

    window.addEventListener(
      'open-session-modal',
      handleOpenSessionModal as EventListener
    )
    return () =>
      window.removeEventListener(
        'open-session-modal',
        handleOpenSessionModal as EventListener
      )
  }, [selectedWorktreeModal])

  // Periodically refresh git status for all worktrees while on the dashboard
  useEffect(() => {
    if (!isTauri() || !projectId || readyWorktrees.length === 0) return

    const interval = setInterval(() => {
      if (document.hasFocus()) {
        fetchWorktreesStatus(projectId)
      }
    }, 60_000) // 1 minute

    return () => clearInterval(interval)
  }, [projectId, readyWorktrees.length])

  // Refresh git status when session modal closes (user returns to canvas)
  const prevModalRef = useRef(selectedWorktreeModal)
  useEffect(() => {
    const wasOpen = !!prevModalRef.current
    const isOpen = !!selectedWorktreeModal
    prevModalRef.current = selectedWorktreeModal

    if (wasOpen && !isOpen && isTauri() && projectId) {
      fetchWorktreesStatus(projectId)
    }
  }, [selectedWorktreeModal, projectId])

  // Check if loading
  const isLoading =
    projectsLoading ||
    worktreesLoading ||
    (readyWorktrees.length > 0 &&
      readyWorktrees.some(wt => !sessionsByWorktreeId.has(wt.id)))

  if (isLoading && worktreeSections.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No project selected
      </div>
    )
  }

  // Track global card index for refs
  let cardIndex = 0

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex-1 flex flex-col overflow-auto">
        {/* Header with Search - sticky over content */}
        <div className="sticky top-0 z-10 flex items-center gap-4 bg-background/60 backdrop-blur-md px-4 py-3 border-b border-border/30 min-h-[61px]">
          <div className="flex flex-col shrink-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{project.name}</h2>
              <NewIssuesBadge projectPath={project.path} projectId={projectId} />
              <OpenPRsBadge projectPath={project.path} projectId={projectId} />
              <SecurityAlertsBadge projectPath={project.path} projectId={projectId} />
              <FailedRunsBadge projectPath={project.path} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    aria-label="Project actions"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuItem
                    onSelect={() =>
                      useProjectsStore.getState().openProjectSettings(projectId)
                    }
                  >
                    <Settings className="h-4 w-4" />
                    Project Settings
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    onSelect={() => createBaseSession.mutate(projectId)}
                  >
                    <Home className="h-4 w-4" />
                    {worktrees.find(isBaseSession)
                      ? 'Open Base Session'
                      : 'New Base Session'}
                  </DropdownMenuItem>

                  <DropdownMenuItem
                    onSelect={() => {
                      useProjectsStore.getState().selectProject(projectId)
                      useUIStore.getState().setNewWorktreeModalOpen(true)
                    }}
                  >
                    <Plus className="h-4 w-4" />
                    New Worktree
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    onSelect={() =>
                      openInEditor.mutate({
                        worktreePath: project.path,
                        editor: preferences?.editor,
                      })
                    }
                  >
                    <Code className="h-4 w-4" />
                    Open in {getEditorLabel(preferences?.editor)}
                  </DropdownMenuItem>

                  <DropdownMenuItem
                    onSelect={() => openInFinder.mutate(project.path)}
                  >
                    <FolderOpen className="h-4 w-4" />
                    Open in Finder
                  </DropdownMenuItem>

                  <DropdownMenuItem
                    onSelect={() =>
                      openInTerminal.mutate({
                        worktreePath: project.path,
                        terminal: preferences?.terminal,
                      })
                    }
                  >
                    <Terminal className="h-4 w-4" />
                    Open in {getTerminalLabel(preferences?.terminal)}
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    onSelect={() => openWorktreesFolder.mutate(projectId)}
                  >
                    <Folder className="h-4 w-4" />
                    Open Worktrees Folder
                  </DropdownMenuItem>

                  <DropdownMenuItem
                    onSelect={() => openOnGitHub.mutate(projectId)}
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open on GitHub
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => removeProject.mutate(projectId)}
                    disabled={worktrees.length > 0}
                    className="whitespace-nowrap"
                  >
                    <Trash2 className="h-4 w-4 shrink-0" />
                    Remove Project
                    {worktrees.length > 0 && (
                      <span className="ml-auto text-xs opacity-60 shrink-0">
                        ({worktrees.length} worktrees)
                      </span>
                    )}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <p className="text-xs text-muted-foreground whitespace-nowrap">
              {projectSummary.totalReady > 0 ? (
                <>
                  {projectSummary.totalReady} worktrees
                  {projectSummary.reviewCount > 0 &&
                    ` · ${projectSummary.reviewCount} review`}
                  {projectSummary.waitingCount > 0 &&
                    ` · ${projectSummary.waitingCount} waiting`}
                  {projectSummary.activeCount > 0 &&
                    ` · ${projectSummary.activeCount} active`}
                </>
              ) : (
                <span className="invisible">0 worktrees</span>
              )}
            </p>
          </div>
          {(worktreeSections.length > 0 || searchQuery) && (
            <>
              <div className="flex-1 flex justify-center max-w-md mx-auto">
                <div className="relative w-full">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchInputRef}
                    placeholder="Search worktrees and sessions..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    aria-label="Search worktrees and sessions"
                    name="worktree-search"
                    className="pl-9 bg-transparent border-border/30"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <OpenInButton worktreePath={project.path} />
              </div>
            </>
          )}
        </div>

        {/* Canvas View */}
        <div
          className={`flex-1 pb-16 ${worktreeSections.length === 0 && !searchQuery ? '' : 'pt-5 px-4'}`}
        >
          {worktreeSections.length === 0 ? (
            searchQuery ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                No worktrees or sessions match your search
              </div>
            ) : (
              <EmptyDashboardTabs
                projectId={projectId}
                projectPath={project?.path ?? null}
              />
            )
          ) : (
            <div className="flex flex-col gap-1">
              {(() => {
                let shortcutNum = 0
                return worktreeSections.map(section => {
                  const currentIndex = cardIndex++
                  if (section.isPending) {
                    return (
                      <WorktreeSetupCard
                        key={section.worktree.id}
                        ref={el => {
                          cardRefs.current[currentIndex] = el
                        }}
                        worktree={section.worktree}
                        layout="list"
                        isSelected={selectedIndex === currentIndex}
                        onSelect={() => handleSelectedIndexChange(currentIndex)}
                      />
                    )
                  }
                  const thisShortcut = ++shortcutNum <= 9 ? shortcutNum : undefined
                  return (
                    <div
                      key={section.worktree.id}
                      ref={el => {
                        cardRefs.current[currentIndex] = el
                      }}
                    >
                      <WorktreeSectionHeader
                        worktree={section.worktree}
                        projectId={projectId}
                        defaultBranch={project.default_branch}
                        cards={section.cards}
                        showDetails={true}
                        isSelected={selectedIndex === currentIndex}
                        shortcutNumber={thisShortcut}
                        onRowClick={() => {
                          handleSelectedIndexChange(currentIndex)
                          handleWorktreeClick(
                            section.worktree.id,
                            section.worktree.path
                          )
                        }}
                      />
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Plan Dialog */}
      {planDialogPath ? (
        <PlanDialog
          filePath={planDialogPath}
          isOpen={true}
          onClose={closePlanDialog}
          editable={true}
          approvalContext={planApprovalContext ?? undefined}
          onApprove={handleDialogApprove}
          onApproveYolo={handleDialogApproveYolo}
          onClearContextApprove={handleDialogClearContextApprove}
          onClearContextBuildApprove={handleDialogClearContextApproveBuild}
          onWorktreeBuildApprove={handleWorktreeApproval ? handleDialogWorktreeApprove : undefined}
          onWorktreeYoloApprove={handleWorktreeApprovalYolo ? handleDialogWorktreeApproveYolo : undefined}
        />
      ) : planDialogContent ? (
        <PlanDialog
          content={planDialogContent}
          isOpen={true}
          onClose={closePlanDialog}
          editable={true}
          approvalContext={planApprovalContext ?? undefined}
          onApprove={handleDialogApprove}
          onApproveYolo={handleDialogApproveYolo}
          onClearContextApprove={handleDialogClearContextApprove}
          onClearContextBuildApprove={handleDialogClearContextApproveBuild}
          onWorktreeBuildApprove={handleWorktreeApproval ? handleDialogWorktreeApprove : undefined}
          onWorktreeYoloApprove={handleWorktreeApprovalYolo ? handleDialogWorktreeApproveYolo : undefined}
        />
      ) : null}

      {/* Recap Dialog */}
      <RecapDialog
        digest={recapDialogDigest}
        isOpen={isRecapDialogOpen}
        onClose={closeRecapDialog}
        isGenerating={isGeneratingRecap}
        onRegenerate={regenerateRecap}
      />

      {/* Worktree Label Modal */}
      <LabelModal
        key={worktreeLabelTarget?.worktreeId ?? 'wt-label'}
        isOpen={worktreeLabelModalOpen}
        onClose={() => {
          setWorktreeLabelModalOpen(false)
          setWorktreeLabelTarget(null)
        }}
        sessionId={null}
        currentLabel={worktreeLabelTarget?.currentLabel ?? null}
        onApply={handleWorktreeLabelApply}
        extraLabels={worktreeSections
          .map(s => s.worktree.label)
          .filter((l): l is LabelData => !!l)}
      />

      {/* Session Chat Modal */}
      <SessionChatModal
        worktreeId={selectedWorktreeModal?.worktreeId ?? ''}
        worktreePath={selectedWorktreeModal?.worktreePath ?? ''}
        isOpen={!!selectedWorktreeModal}
        onClose={() => setSelectedWorktreeModal(null)}
        onCloseWorktree={() => setSelectedWorktreeModal(null)}
      />

      {/* Git Diff Modal (CMD+G on canvas) */}
      <Suspense fallback={null}>
        <GitDiffModal
          diffRequest={canvasDiffRequest}
          onClose={() => setCanvasDiffRequest(null)}
        />
      </Suspense>

      <CloseWorktreeDialog
        open={!!closeWorktreeTarget}
        onOpenChange={open => {
          if (!open) setCloseWorktreeTarget(null)
        }}
        onConfirm={handleConfirmCloseWorktree}
        branchName={closeWorktreeTarget?.branchName}
      />
    </div>
  )
}

function EmptyDashboardTabs({
  projectId,
  projectPath,
}: {
  projectId: string
  projectPath: string | null
}) {
  const shortcut = formatShortcutDisplay(DEFAULT_KEYBINDINGS.new_worktree)
  const { data: jeanConfig } = useJeanConfig(projectPath)
  const { openProjectSettings } = useProjectsStore.getState()

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Your imagination is the only limit
        </p>
        <Button
          variant="outline"
          size="lg"
          className="gap-2"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('create-new-worktree'))
          }
        >
          <Plus className="h-4 w-4" />
          Start Building
          <kbd className="pointer-events-none ml-1 inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            {shortcut}
          </kbd>
        </Button>
        {!jeanConfig && (
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            onClick={() => openProjectSettings(projectId, 'jean-json')}
          >
            <FileJson className="h-3 w-3" />
            Add a jean.json to automate setup &amp; dev server
          </button>
        )}
      </div>
    </div>
  )
}
