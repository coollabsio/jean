import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  attachClosestEdge,
  type Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge'
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
import { isLocalBackend } from '@/lib/environment'
import { dismissibleToast } from '@/lib/dismissible-toast'
import {
  Search,
  X,
  MoreHorizontal,
  ArrowUpDown,
  Settings,
  Plus,
  FileJson,
  Clock3,
  Activity,
  AlertCircle,
  CircleDot,
  GitBranch,
  GitBranchPlus,
  GitPullRequestArrow,
  ShieldAlert,
  Code,
  ExternalLink,
  Folder,
  FolderOpen,
  Home,
  Terminal,
  Trash2,
  GripVertical,
  Tag,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  useReorderWorktrees,
  projectsQueryKeys,
  type PackageScript,
} from '@/services/projects'
import { chatQueryKeys, cancelChatMessage } from '@/services/chat'
import {
  useDependabotAlerts,
  useGitHubIssues,
  useGitHubPRs,
  useRepositoryAdvisories,
  useWorkflowRuns,
} from '@/services/github'
import { useGhCliAuth } from '@/services/gh-cli'
import { useGitStatus } from '@/services/git-status'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useTerminalStore } from '@/store/terminal-store'
import { isBaseSession, type Worktree } from '@/types/projects'
import { getEditorLabel, getTerminalLabel } from '@/types/preferences'
import type { LabelData, Session, WorktreeSessions } from '@/types/chat'
import { NewIssuesBadge } from '@/components/shared/NewIssuesBadge'
import { OpenPRsBadge } from '@/components/shared/OpenPRsBadge'
import { FailedRunsBadge } from '@/components/shared/FailedRunsBadge'
import { SecurityAlertsBadge } from '@/components/shared/SecurityAlertsBadge'
import { PlanDialog } from '@/components/chat/PlanDialog'
import { SessionChatModal } from '@/components/chat/SessionChatModal'
import {
  getStackedBaseBranch,
  shouldShowWorktreeBranchBadge,
} from '@/components/chat/worktree-branch-badge'

import { LabelModal } from '@/components/chat/LabelModal'
import { getLabelTextColor } from '@/lib/label-colors'
import {
  countWorktreesWithLabel,
  deleteLabelFromRegistry,
  getWorktreeLabels,
  getPinnedWorktreeLabelTabs,
  mergeLabelRegistry,
  mergePinnedLabels,
  removeLabelFromLabels,
  setLabelPinned,
  type PinnedWorktreeLabelTab,
  updateWorktreeLabelsByName,
} from '@/lib/worktree-labels'
import {
  type SessionCardData,
  computeSessionCardData,
  groupCardsByStatus,
  flattenGroups,
} from '@/components/chat/session-card-utils'
import { WorktreeSetupCard } from '@/components/chat/WorktreeSetupCard'
import { OpenInButton } from '@/components/open-in/OpenInButton'
import { ScriptsButton } from '@/components/open-in/ScriptsButton'
import { useCanvasStoreState } from '@/components/chat/hooks/useCanvasStoreState'
import {
  type WorktreeSortMode,
  compareWorktreesForCanvasSort,
  getSessionActivityTimestamp,
  getWorktreeLastActivity,
} from '@/components/projects/worktree-sort-utils'
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
import { TerminalStatusIndicator } from '@/hooks/useWorktreeTerminalStatus'
import { usePreferences } from '@/services/preferences'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import { CloseWorktreeDialog } from '@/components/chat/CloseWorktreeDialog'
import { useIsMobile } from '@/hooks/use-mobile'
import { hasBackendTransport } from '@/lib/environment'
import { consumeWebReloadState } from '@/lib/web-reload-state'
import {
  shouldDisableWorktreeTextSelection,
  shouldShowWorktreeLabelContextMenu,
} from './worktree-label-context'
import {
  CANVAS_FILTER_TABS,
  getCanvasFilterTabCount,
  isLabelFilterTab,
  matchesCanvasFilterTab,
  type CanvasFilterTab,
  type CanvasPredefinedFilterTab,
  type CanvasPredefinedFilterTabItem,
} from './canvas-worktree-filters'
import { getCanvasStatusRefreshMs } from './canvas-status-refresh'
import { getWorktreeLabelContainerClassName } from './worktree-label-layout'
const GitDiffModal = lazy(() =>
  import('@/components/chat/GitDiffModal').then(mod => ({
    default: mod.GitDiffModal,
  }))
)
const LinkedProjectsModal = lazy(() =>
  import('@/components/magic/LinkedProjectsModal').then(mod => ({
    default: mod.LinkedProjectsModal,
  }))
)
import type { DiffRequest } from '@/types/git-diff'
import { toast } from 'sonner'
import {
  gitPush,
  fetchWorktreesStatus,
  triggerImmediateGitPoll,
  performGitPull,
} from '@/services/git-status'
import { pushNeedsRemotePicker, useRemotePicker } from '@/hooks/useRemotePicker'
import {
  DRAG_SCOPE_CANVAS_WORKTREE_LIST,
  isWorktreeDragData,
} from '@/lib/drag-and-drop/types'
import { reorderWithClosestEdge } from '@/lib/drag-and-drop/reorder'
import { announceDrag } from '@/lib/drag-and-drop/live-region'
import { DropIndicator } from '@/components/drag-and-drop/DropIndicator'
import {
  applyWorktreeDropSnapshot,
  emptyWorktreeDropSnapshot,
  getSnapshotFromWorktreeDropTarget,
  getSnapshotFromWorktreeElement,
  getWorktreeDropTargetForScope,
  getWorktreeElementFromEventTarget,
  getWorktreeElementFromPoint,
  type WorktreeDropSnapshot,
  type WorktreeReorderDragState,
} from '@/lib/drag-and-drop/worktree-reorder-ux'
import { openCanvasConflictResolution } from './conflict-resolution-navigation'

interface ProjectCanvasViewProps {
  projectId: string
}

const EMPTY_PINNED_LABELS: LabelData[] = []
const EMPTY_LABELS: LabelData[] = []

interface WorktreeSection {
  worktree: Worktree
  cards: SessionCardData[]
  isPending?: boolean
}

function canManuallyReorderWorktree(worktree: Worktree): boolean {
  return (
    !isBaseSession(worktree) &&
    (!worktree.status ||
      worktree.status === 'ready' ||
      worktree.status === 'error')
  )
}

type CanvasWorktreeDragState = WorktreeReorderDragState

function SortableCanvasWorktreeSection({
  section,
  disabled,
  isDragging,
  closestEdge,
  projectId,
  children,
}: {
  section: WorktreeSection
  disabled: boolean
  isDragging: boolean
  closestEdge: Edge | null
  projectId: string
  children: React.ReactNode
}) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const dragHandleRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    const cleanupFns = [
      dropTargetForElements({
        element,
        canDrop: ({ source }) => {
          return (
            !disabled &&
            isWorktreeDragData(source.data) &&
            source.data.projectId === projectId &&
            source.data.scope === DRAG_SCOPE_CANVAS_WORKTREE_LIST &&
            source.data.worktreeId !== section.worktree.id
          )
        },
        getData: ({ input, element }) => {
          return attachClosestEdge(
            {
              type: 'worktree-section',
              projectId,
              worktreeId: section.worktree.id,
              scope: DRAG_SCOPE_CANVAS_WORKTREE_LIST,
            },
            {
              input,
              element,
              allowedEdges: ['top', 'bottom'],
            }
          )
        },
      }),
    ]

    const dragHandle = dragHandleRef.current
    if (!disabled && dragHandle) {
      cleanupFns.push(
        draggable({
          element,
          dragHandle,
          canDrag: () => !disabled,
          getInitialData: () => ({
            type: 'worktree-section',
            projectId,
            worktreeId: section.worktree.id,
            scope: DRAG_SCOPE_CANVAS_WORKTREE_LIST,
          }),
        })
      )
    }

    return combine(...cleanupFns)
  }, [disabled, projectId, section.worktree.id])

  return (
    <div
      ref={elementRef}
      data-pdnd-worktree-id={section.worktree.id}
      data-pdnd-worktree-scope={DRAG_SCOPE_CANVAS_WORKTREE_LIST}
      className={cn('relative transition-opacity', isDragging && 'opacity-40')}
    >
      <DropIndicator edge={closestEdge} insetClassName="left-0 right-0" />
      {!disabled && (
        <button
          ref={dragHandleRef}
          type="button"
          className="absolute -left-5 top-2 z-10 flex h-7 w-5 cursor-grab items-center justify-center rounded text-muted-foreground/45 opacity-0 transition-opacity hover:bg-muted/70 hover:text-muted-foreground group-hover/canvas-list:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 active:cursor-grabbing"
          aria-label={`Reorder ${isBaseSession(section.worktree) ? 'Base Session' : section.worktree.name}`}
          onClick={event => event.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      {children}
    </div>
  )
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

interface CanvasLabelFilterTabItem extends PinnedWorktreeLabelTab {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
}

type CanvasFilterTabItem =
  | CanvasPredefinedFilterTabItem
  | CanvasLabelFilterTabItem

function isLabelFilterTabItem(
  tab: CanvasFilterTabItem
): tab is CanvasLabelFilterTabItem {
  return isLabelFilterTab(tab.value)
}

function getActiveStatus(cards: SessionCardData[]): ActiveStatus {
  if (cards.some(c => c.status === 'waiting' || c.status === 'permission'))
    return 'waiting'
  if (cards.some(c => c.status === 'planning')) return 'planning'
  if (cards.some(c => c.status === 'vibing')) return 'vibing'
  if (cards.some(c => c.status === 'yoloing')) return 'yoloing'
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
  const planningCount = cards.filter(c => c.status === 'planning').length
  const buildingCount = cards.filter(c => c.status === 'vibing').length
  const yoloCount = cards.filter(c => c.status === 'yoloing').length
  const activeCount = planningCount + buildingCount + yoloCount
  const latestActivityAt = cards.reduce(
    (latest, card) =>
      Math.max(latest, getSessionActivityTimestamp(card.session)),
    0
  )

  return {
    totalCount: cards.length,
    waitingCount,
    reviewCount,
    planningCount,
    buildingCount,
    yoloCount,
    activeCount,
    latestActivityAt,
  }
}

function WorktreeSectionHeader({
  worktree,
  projectId,
  defaultBranch,
  openPRs,
  cards,
  showDetails = false,
  isSelected,
  shortcutNumber,
  onRowClick,
  onDiffClick,
  onSetLabels,
  onResolveConflicts,
  disableTextSelection = false,
}: {
  worktree: Worktree
  projectId: string
  defaultBranch: string
  openPRs?: { number: number; headRefName: string }[]
  cards?: SessionCardData[]
  showDetails?: boolean
  isSelected?: boolean
  shortcutNumber?: number
  onRowClick?: () => void
  onDiffClick?: (
    worktreePath: string,
    baseBranch: string,
    type: 'uncommitted' | 'branch'
  ) => void
  onSetLabels?: () => void
  onResolveConflicts?: (worktree: Worktree) => void
  disableTextSelection?: boolean
}) {
  const stackedBaseBranch = getStackedBaseBranch(
    worktree.base_branch,
    worktree.branch,
    defaultBranch
  )
  const stackedOnPR = stackedBaseBranch
    ? openPRs?.find(pr => pr.headRefName === stackedBaseBranch)
    : undefined
  const isBase = isBaseSession(worktree)
  const { data: gitStatus } = useGitStatus(worktree.id)

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
        onMergeConflict: () => onResolveConflicts?.(worktree),
      })
    },
    [
      worktree,
      worktree.id,
      worktree.path,
      defaultBranch,
      projectId,
      onResolveConflicts,
    ]
  )

  const handlePush = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()

      const runPush = async (remote?: string) => {
        const opToast = dismissibleToast.loading('Pushing changes...')
        try {
          const result = await gitPush(
            worktree.path,
            worktree.pr_number,
            remote
          )
          triggerImmediateGitPoll()
          fetchWorktreesStatus(projectId)
          if (result.fellBack) {
            opToast.warning(
              'Could not push to PR branch, pushed to new branch instead'
            )
          } else {
            opToast.success('Changes pushed')
          }
        } catch (error) {
          opToast.error(`Push failed: ${error}`)
        }
      }

      if (pushNeedsRemotePicker(worktree.pr_number)) {
        pickRemoteOrRun(runPush)
      } else {
        runPush()
      }
    },
    [pickRemoteOrRun, worktree.path, worktree.pr_number, projectId]
  )

  const handleDiffClick = useCallback(() => {
    onDiffClick?.(
      worktree.path,
      defaultBranch,
      isBase ? 'uncommitted' : 'branch'
    )
  }, [onDiffClick, isBase, worktree.path, defaultBranch])

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

  const lastActivity = formatRelativeTime(sessionMetrics?.latestActivityAt)
  const displayBranch = gitStatus?.current_branch ?? worktree.branch
  const showBranchBadge = shouldShowWorktreeBranchBadge({
    displayBranch,
    worktreeName: worktree.name,
    stackedBaseBranch,
    prNumber: worktree.pr_number,
    securityAlertNumber: worktree.security_alert_number,
    advisoryGhsaId: worktree.advisory_ghsa_id,
  })
  const worktreeLabels = getWorktreeLabels(worktree)

  const row = (
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
        isSelected && onRowClick && 'border-border/40 bg-muted/35',
        disableTextSelection && 'select-none'
      )}
      style={disableTextSelection ? { WebkitTouchCallout: 'none' } : undefined}
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
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
          {shortcutNumber !== undefined && (
            <kbd className="hidden shrink-0 h-4 min-w-4 items-center justify-center rounded border border-border/50 bg-muted/50 px-0.5 font-mono text-muted-foreground sm:inline-flex">
              <span className="text-[9px]">⌘{shortcutNumber}</span>
            </kbd>
          )}
          <TerminalStatusIndicator
            worktreeId={worktree.id}
            iconSize="h-3 w-3"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1 font-medium sm:flex-row sm:items-center sm:gap-1.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate">
                {isBase ? 'Base Session' : worktree.name}
              </span>
              {showBranchBadge && (
                <span className="hidden items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground sm:inline-flex">
                  <GitBranch className="h-2.5 w-2.5" />
                  <span className="max-w-40 truncate">{displayBranch}</span>
                  {stackedBaseBranch && (
                    <>
                      <span className="text-border">·</span>
                      <GitBranchPlus className="h-2.5 w-2.5" />
                      <span className="max-w-32 truncate">
                        {stackedBaseBranch}
                      </span>
                      {stackedOnPR && (
                        <>
                          <GitPullRequestArrow className="h-2.5 w-2.5" />#
                          {stackedOnPR.number}
                        </>
                      )}
                    </>
                  )}
                  {worktree.pr_number && (
                    <>
                      <span className="text-border">·</span>
                      <GitPullRequestArrow className="h-2.5 w-2.5" />#
                      {worktree.pr_number}
                    </>
                  )}
                  {worktree.security_alert_number && (
                    <>
                      <span className="text-border">·</span>
                      <ShieldAlert className="h-2.5 w-2.5 text-orange-500" />#
                      {worktree.security_alert_number}
                    </>
                  )}
                  {worktree.advisory_ghsa_id && (
                    <>
                      <span className="text-border">·</span>
                      <ShieldAlert className="h-2.5 w-2.5 text-orange-500" />
                      <span className="max-w-20 truncate">
                        {worktree.advisory_ghsa_id}
                      </span>
                    </>
                  )}
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
            {showBranchBadge && (
              <span className="inline-flex max-w-full items-center gap-1 self-start rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground sm:hidden">
                <GitBranch className="h-2.5 w-2.5 shrink-0" />
                <span className="max-w-full truncate">{displayBranch}</span>
                {stackedBaseBranch && (
                  <>
                    <span className="text-border">·</span>
                    <GitBranchPlus className="h-2.5 w-2.5 shrink-0" />
                    <span className="max-w-32 truncate">
                      {stackedBaseBranch}
                    </span>
                    {stackedOnPR && (
                      <>
                        <GitPullRequestArrow className="h-2.5 w-2.5 shrink-0" />
                        #{stackedOnPR.number}
                      </>
                    )}
                  </>
                )}
                {worktree.pr_number && (
                  <>
                    <span className="text-border">·</span>
                    <GitPullRequestArrow className="h-2.5 w-2.5 shrink-0" />#
                    {worktree.pr_number}
                  </>
                )}
                {worktree.security_alert_number && (
                  <>
                    <span className="text-border">·</span>
                    <ShieldAlert className="h-2.5 w-2.5 shrink-0 text-orange-500" />
                    #{worktree.security_alert_number}
                  </>
                )}
                {worktree.advisory_ghsa_id && (
                  <>
                    <span className="text-border">·</span>
                    <ShieldAlert className="h-2.5 w-2.5 shrink-0 text-orange-500" />
                    <span className="max-w-20 truncate">
                      {worktree.advisory_ghsa_id}
                    </span>
                  </>
                )}
              </span>
            )}
          </span>
          {worktreeLabels.length > 0 && (
            <span className={getWorktreeLabelContainerClassName()}>
              {worktreeLabels.slice(0, 3).map(label => (
                <span
                  key={label.name}
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: label.color,
                    color: getLabelTextColor(label.color),
                  }}
                >
                  {label.name}
                </span>
              ))}
              {worktreeLabels.length > 3 && (
                <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  +{worktreeLabels.length - 3}
                </span>
              )}
            </span>
          )}
        </div>
        {showDetails && sessionMetrics && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {sessionMetrics.waitingCount > 0 && (
              <span className="rounded bg-yellow-500/90 px-2 py-0.5 text-black">
                {sessionMetrics.waitingCount} waiting
              </span>
            )}
            {sessionMetrics.planningCount > 0 && (
              <span className="rounded bg-sky-500/10 px-2 py-0.5 text-sky-600">
                {sessionMetrics.planningCount} planning
              </span>
            )}
            {sessionMetrics.buildingCount > 0 && (
              <span className="rounded bg-indigo-500/10 px-2 py-0.5 text-indigo-600">
                {sessionMetrics.buildingCount} building
              </span>
            )}
            {sessionMetrics.yoloCount > 0 && (
              <span className="rounded bg-red-500/10 px-2 py-0.5 text-red-600">
                {sessionMetrics.yoloCount} yolo
              </span>
            )}
            {sessionMetrics.reviewCount > 0 && (
              <span className="rounded bg-green-500/10 px-2 py-0.5 text-green-600">
                {sessionMetrics.reviewCount} review
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
  )

  if (!onSetLabels) return row

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={onSetLabels}>
          <Tag className="mr-2 h-4 w-4" />
          Set labels
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ProjectCanvasView({ projectId }: ProjectCanvasViewProps) {
  const { data: preferences } = usePreferences()
  const worktreeSortMode = useProjectsStore(
    state =>
      state.projectCanvasSettings[projectId]?.worktreeSortMode ?? 'created'
  )
  const projectPinnedLabels = useProjectsStore(
    state =>
      state.projectCanvasSettings[projectId]?.pinnedLabels ??
      EMPTY_PINNED_LABELS
  )
  const projectLabels = useProjectsStore(
    state => state.projectCanvasSettings[projectId]?.labels ?? EMPTY_LABELS
  )

  // Project action mutations
  const createBaseSession = useCreateBaseSession()
  const removeProject = useRemoveProject()
  const reorderWorktrees = useReorderWorktrees()
  const openOnGitHub = useOpenProjectOnGitHub()
  const openInFinder = useOpenWorktreeInFinder()
  const openWorktreesFolder = useOpenProjectWorktreesFolder()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInEditor = useOpenWorktreeInEditor()

  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilterTab, setActiveFilterTab] = useState<CanvasFilterTab>('all')
  const isMobile = useIsMobile()
  const canOpenLocally = isLocalBackend()
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false)
  const showWorktreeLabelContextMenu = shouldShowWorktreeLabelContextMenu({
    isMobile,
    isNative: isTauri(),
  })
  const disableWorktreeTextSelection = shouldDisableWorktreeTextSelection({
    isMobile,
  })

  // Get project info
  const { data: projects = [], isLoading: projectsLoading } = useProjects()
  const project = projects.find(p => p.id === projectId)

  // Open PRs: used to link a worktree's base_branch to a PR number in row badges
  const { data: openPRs } = useGitHubPRs(project?.path ?? null, 'open')

  // Mobile-only: GitHub status counts for project dropdown menu items.
  // Trigger gh auth query directly so it works on web/mobile access (App.tsx
  // only runs it in native mode).
  useGhCliAuth({ enabled: isMobile })
  const mobileGitHubEnabled = isMobile
  const BADGE_STALE_TIME = 5 * 60 * 1000
  const { data: mobileIssueResult } = useGitHubIssues(
    project?.path ?? null,
    'open',
    { enabled: mobileGitHubEnabled, staleTime: BADGE_STALE_TIME }
  )
  const { data: mobileOpenPRs } = useGitHubPRs(project?.path ?? null, 'open', {
    enabled: mobileGitHubEnabled,
    staleTime: BADGE_STALE_TIME,
  })
  const { data: mobileAlerts } = useDependabotAlerts(
    project?.path ?? null,
    'open',
    { enabled: mobileGitHubEnabled, staleTime: BADGE_STALE_TIME }
  )
  const { data: mobileAdvisories } = useRepositoryAdvisories(
    project?.path ?? null,
    undefined,
    { enabled: mobileGitHubEnabled, staleTime: BADGE_STALE_TIME }
  )
  const { data: mobileWorkflowRuns } = useWorkflowRuns(
    project?.path ?? null,
    undefined,
    { enabled: mobileGitHubEnabled, staleTime: BADGE_STALE_TIME }
  )
  const mobileIssueCount = mobileIssueResult?.totalCount ?? 0
  const mobilePRCount = mobileOpenPRs?.length ?? 0
  const mobileSecurityCount =
    (mobileAlerts?.length ?? 0) +
    (mobileAdvisories?.filter(a => a.state === 'draft' || a.state === 'triage')
      .length ?? 0)
  const mobileWorkflowRunCount = mobileWorkflowRuns?.runs?.length ?? 0
  const mobileFailedWorkflowCount = mobileWorkflowRuns?.failedCount ?? 0

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

  const filterTabCounts = useMemo<
    Record<CanvasPredefinedFilterTab, number>
  >(() => {
    return {
      all: getCanvasFilterTabCount(visibleWorktrees, 'all'),
      manual: getCanvasFilterTabCount(visibleWorktrees, 'manual'),
      issues: getCanvasFilterTabCount(visibleWorktrees, 'issues'),
      prs: getCanvasFilterTabCount(visibleWorktrees, 'prs'),
      security: getCanvasFilterTabCount(visibleWorktrees, 'security'),
      auto_fix: getCanvasFilterTabCount(visibleWorktrees, 'auto_fix'),
    }
  }, [visibleWorktrees])

  const pinnedLabelTabs = useMemo(
    () => getPinnedWorktreeLabelTabs(visibleWorktrees, projectPinnedLabels),
    [visibleWorktrees, projectPinnedLabels]
  )

  const canvasFilterTabs = useMemo<CanvasFilterTabItem[]>(
    () => [
      ...CANVAS_FILTER_TABS,
      ...pinnedLabelTabs.map(tab => ({
        ...tab,
        icon: Tag,
      })),
    ],
    [pinnedLabelTabs]
  )

  useEffect(() => {
    if (!isLabelFilterTab(activeFilterTab)) return
    if (pinnedLabelTabs.some(tab => tab.value === activeFilterTab)) return
    setActiveFilterTab('all')
  }, [activeFilterTab, pinnedLabelTabs])

  const assignedWorktreeLabels = useMemo(() => {
    const labels: LabelData[] = []
    for (const wt of readyWorktrees) {
      labels.push(...getWorktreeLabels(wt))
    }
    for (const wt of pendingWorktrees) {
      labels.push(...getWorktreeLabels(wt))
    }
    return labels
  }, [readyWorktrees, pendingWorktrees])

  // All worktree labels (unfiltered by search) for the label modal
  const allWorktreeLabels = useMemo(
    () =>
      mergeLabelRegistry(
        mergeLabelRegistry(projectLabels, projectPinnedLabels),
        assignedWorktreeLabels
      ),
    [projectLabels, projectPinnedLabels, assignedWorktreeLabels]
  )

  // Load sessions for all worktrees dynamically using useQueries
  const sessionQueries = useQueries({
    queries: readyWorktrees.map(wt => ({
      queryKey: [...chatQueryKeys.sessions(wt.id), 'with-counts'],
      queryFn: async (): Promise<WorktreeSessions> => {
        if (!hasBackendTransport() || !wt.id || !wt.path) {
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

  // React to explicit auto-open requests immediately. The effect below still
  // reads the latest store state imperatively, but this primitive signal makes
  // queued requests re-run it without waiting for session query refetches.
  const autoOpenSessionSignal = useUIStore(state => {
    const worktreeIds = [...state.autoOpenSessionWorktreeIds].sort().join(',')
    const sessionIds = Object.entries(state.pendingAutoOpenSessionIds)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([worktreeId, sessionId]) => `${worktreeId}:${sessionId}`)
      .join(',')
    return `${worktreeIds}|${sessionIds}`
  })

  // Use shared store state hook
  const storeState = useCanvasStoreState()
  const queryClient = useQueryClient()

  const markWorktreeLastUsed = useCallback(
    (worktreeId: string) => {
      if (!isTauri()) return

      const now = Math.floor(Date.now() / 1000)

      queryClient.setQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId),
        current =>
          current?.map(worktree =>
            worktree.id === worktreeId
              ? { ...worktree, last_opened_at: now }
              : worktree
          )
      )

      void invoke('set_worktree_last_opened', { worktreeId })
        .then(() => {
          queryClient.invalidateQueries({
            queryKey: projectsQueryKeys.worktrees(projectId),
          })
        })
        .catch(() => {
          queryClient.invalidateQueries({
            queryKey: projectsQueryKeys.worktrees(projectId),
          })
        })
    },
    [projectId, queryClient]
  )

  const openWorktreeModal = useCallback(
    (worktreeId: string, worktreePath: string) => {
      markWorktreeLastUsed(worktreeId)
      setSelectedWorktreeModal({ worktreeId, worktreePath })
    },
    [markWorktreeLastUsed]
  )

  const handlePackageScript = useCallback(
    async (script: PackageScript) => {
      let baseWorktree = worktrees.find(isBaseSession)
      if (!baseWorktree) {
        try {
          baseWorktree = await createBaseSession.mutateAsync(projectId)
        } catch {
          return
        }
      }

      useTerminalStore
        .getState()
        .addTerminal(baseWorktree.id, script.command, script.name, {
          commandArgs: script.args,
        })
      openWorktreeModal(baseWorktree.id, baseWorktree.path)
      useTerminalStore.getState().setModalTerminalOpen(baseWorktree.id, true)
    },
    [createBaseSession, openWorktreeModal, projectId, worktrees]
  )

  const handleCanvasResolveConflicts = useCallback(
    (worktree: Worktree) => {
      openCanvasConflictResolution(worktree, {
        setPendingMagicCommand: cmd =>
          useChatStore.getState().setPendingMagicCommand(cmd),
        openWorktreeModal,
      })
    },
    [openWorktreeModal]
  )

  // Build worktree sections with computed card data
  const worktreeSections: WorktreeSection[] = useMemo(() => {
    const result: WorktreeSection[] = []
    const latestActivityByWorktreeId = new Map<string, number>()

    // Add pending worktrees first
    const sortedPending = [...pendingWorktrees].sort(
      (a, b) => b.created_at - a.created_at
    )
    for (const worktree of sortedPending) {
      if (!matchesCanvasFilterTab(worktree, activeFilterTab)) continue
      latestActivityByWorktreeId.set(worktree.id, worktree.created_at)
      // Include pending worktrees even without sessions - show setup card
      result.push({ worktree, cards: [], isPending: true })
    }

    const readySections: WorktreeSection[] = []
    for (const worktree of readyWorktrees) {
      if (!matchesCanvasFilterTab(worktree, activeFilterTab)) continue
      const sessionData = sessionsByWorktreeId.get(worktree.id)
      const sessions = sessionData?.sessions ?? []

      // Filter sessions based on search query (includes labels)
      const filteredSessions = searchQuery.trim()
        ? sessions.filter(session => {
            const q = searchQuery.toLowerCase()
            return (
              session.name.toLowerCase().includes(q) ||
              worktree.name.toLowerCase().includes(q) ||
              worktree.branch.toLowerCase().includes(q) ||
              (session.label?.name ?? '').toLowerCase().includes(q) ||
              (storeState.sessionLabels[session.id]?.name ?? '')
                .toLowerCase()
                .includes(q) ||
              getWorktreeLabels(worktree).some(label =>
                label.name.toLowerCase().includes(q)
              ) ||
              (worktree.pr_number != null &&
                worktree.pr_number.toString().includes(q)) ||
              (worktree.issue_number != null &&
                worktree.issue_number.toString().includes(q)) ||
              (worktree.linear_issue_identifier ?? '')
                .toLowerCase()
                .includes(q) ||
              (worktree.security_alert_number != null &&
                worktree.security_alert_number.toString().includes(q)) ||
              (worktree.advisory_ghsa_id ?? '').toLowerCase().includes(q)
            )
          })
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
      const latestActivityAt = getWorktreeLastActivity(
        filteredSessions,
        worktree.created_at
      )

      latestActivityByWorktreeId.set(worktree.id, latestActivityAt)

      // Only include worktrees that have sessions (after filtering)
      if (grouped.length > 0) {
        readySections.push({ worktree, cards: grouped })
      }
    }

    // Sort ready worktrees: base sessions first, then selected sort mode
    readySections.sort((a, b) =>
      compareWorktreesForCanvasSort(
        a.worktree,
        b.worktree,
        latestActivityByWorktreeId,
        worktreeSortMode
      )
    )

    result.push(...readySections)

    return result
  }, [
    readyWorktrees,
    pendingWorktrees,
    sessionsByWorktreeId,
    storeState,
    searchQuery,
    worktreeSortMode,
    activeFilterTab,
  ])

  const canvasReorderEnabled =
    activeFilterTab === 'all' && searchQuery.trim().length === 0

  const canvasDraggableIds = useMemo(
    () =>
      worktreeSections
        .filter(section => canManuallyReorderWorktree(section.worktree))
        .map(section => section.worktree.id),
    [worktreeSections]
  )

  const canvasDraggableIdSet = useMemo(
    () => new Set(canvasDraggableIds),
    [canvasDraggableIds]
  )
  const [canvasDragState, setCanvasDragState] =
    useState<CanvasWorktreeDragState>({
      draggingId: null,
      targetId: null,
      closestEdge: null,
    })
  const latestCanvasDropTargetRef = useRef<WorktreeDropSnapshot>(
    emptyWorktreeDropSnapshot
  )
  const canvasDragStateRef = useRef(canvasDragState)

  useEffect(() => {
    canvasDragStateRef.current = canvasDragState
  }, [canvasDragState])

  const getCanvasWorktreeDropTarget = useCallback(
    (dropTargets: { data: Record<string | symbol, unknown> }[]) =>
      getWorktreeDropTargetForScope(
        dropTargets,
        DRAG_SCOPE_CANVAS_WORKTREE_LIST
      ),
    []
  )

  const reorderCanvasFromDrop = useCallback(
    (activeId: string, overId: string, closestEdge: Edge | null) => {
      if (!canvasReorderEnabled || activeId === overId) return

      const oldIndex = canvasDraggableIds.indexOf(activeId)
      const newIndex = canvasDraggableIds.indexOf(overId)

      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return

      const reorderedDraggableIds = reorderWithClosestEdge({
        items: canvasDraggableIds,
        startIndex: oldIndex,
        indexOfTarget: newIndex,
        closestEdgeOfTarget: closestEdge,
      })
      const nextDraggableIds = [...reorderedDraggableIds]
      const fullOrderedIds = worktreeSections.map(section => {
        const worktreeId = section.worktree.id
        if (!canvasDraggableIdSet.has(worktreeId)) return worktreeId
        return nextDraggableIds.shift() ?? worktreeId
      })

      reorderWorktrees.mutate({
        projectId,
        worktreeIds: fullOrderedIds.filter(worktreeId => {
          const worktree = worktrees.find(wt => wt.id === worktreeId)
          return (
            worktree != null &&
            (isBaseSession(worktree) || canManuallyReorderWorktree(worktree))
          )
        }),
        switchToManualSort: worktreeSortMode !== 'manual',
      })
      announceDrag('Worktree section reordered')
    },
    [
      canvasDraggableIdSet,
      canvasDraggableIds,
      canvasReorderEnabled,
      projectId,
      reorderWorktrees,
      worktreeSections,
      worktrees,
      worktreeSortMode,
    ]
  )

  const nativeCanvasDropHandledRef = useRef(false)

  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) =>
        isWorktreeDragData(source.data) &&
        source.data.projectId === projectId &&
        source.data.scope === DRAG_SCOPE_CANVAS_WORKTREE_LIST,
      onDragStart: ({ source }) => {
        if (!isWorktreeDragData(source.data)) return
        latestCanvasDropTargetRef.current = emptyWorktreeDropSnapshot
        setCanvasDragState({
          draggingId: source.data.worktreeId,
          targetId: null,
          closestEdge: null,
        })
        announceDrag('Started dragging worktree section')
      },
      onDropTargetChange: ({ location }) => {
        const snapshot = getSnapshotFromWorktreeDropTarget(
          getCanvasWorktreeDropTarget(location.current.dropTargets)
        )
        latestCanvasDropTargetRef.current = snapshot
        setCanvasDragState(state => applyWorktreeDropSnapshot(state, snapshot))
      },
      onDrag: ({ location }) => {
        const snapshot = getSnapshotFromWorktreeDropTarget(
          getCanvasWorktreeDropTarget(location.current.dropTargets)
        )
        setCanvasDragState(state => {
          latestCanvasDropTargetRef.current = snapshot
          return applyWorktreeDropSnapshot(state, snapshot)
        })
      },
      onDrop: ({ source, location }) => {
        if (nativeCanvasDropHandledRef.current) {
          nativeCanvasDropHandledRef.current = false
          return
        }
        setCanvasDragState({
          draggingId: null,
          targetId: null,
          closestEdge: null,
        })
        if (!isWorktreeDragData(source.data)) return
        const targetSnapshot = getSnapshotFromWorktreeDropTarget(
          getCanvasWorktreeDropTarget(location.current.dropTargets)
        )
        const fallback = latestCanvasDropTargetRef.current
        const snapshot = targetSnapshot.targetId ? targetSnapshot : fallback
        latestCanvasDropTargetRef.current = emptyWorktreeDropSnapshot
        const { targetId, closestEdge } = snapshot
        if (!targetId) {
          announceDrag('Worktree section move cancelled')
          return
        }
        reorderCanvasFromDrop(source.data.worktreeId, targetId, closestEdge)
      },
    })
  }, [getCanvasWorktreeDropTarget, projectId, reorderCanvasFromDrop])

  const handleNativeCanvasDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canvasDragState.draggingId) return
      const target = getWorktreeElementFromEventTarget({
        eventTarget: event.target,
        scope: DRAG_SCOPE_CANVAS_WORKTREE_LIST,
      })
      const snapshot = getSnapshotFromWorktreeElement({
        element: target,
        draggingId: canvasDragState.draggingId,
        clientY: event.clientY,
      })
      if (!snapshot.targetId) return

      event.preventDefault()
      latestCanvasDropTargetRef.current = snapshot
      setCanvasDragState(state => applyWorktreeDropSnapshot(state, snapshot))
    },
    [canvasDragState.draggingId]
  )

  const handleNativeCanvasDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canvasDragState.draggingId) return
      event.preventDefault()
      event.stopPropagation()
      const fallback = latestCanvasDropTargetRef.current
      nativeCanvasDropHandledRef.current = true
      setCanvasDragState({
        draggingId: null,
        targetId: null,
        closestEdge: null,
      })
      latestCanvasDropTargetRef.current = emptyWorktreeDropSnapshot
      if (fallback.targetId) {
        reorderCanvasFromDrop(
          canvasDragState.draggingId,
          fallback.targetId,
          fallback.closestEdge
        )
      }
    },
    [canvasDragState.draggingId, reorderCanvasFromDrop]
  )

  const handleNativeCanvasDragEnd = useCallback(() => {
    latestCanvasDropTargetRef.current = emptyWorktreeDropSnapshot
    setCanvasDragState({ draggingId: null, targetId: null, closestEdge: null })
  }, [])

  useEffect(() => {
    const handleDocumentDragOver = (event: DragEvent) => {
      const draggingId = canvasDragStateRef.current.draggingId
      if (!draggingId) return
      const target = getWorktreeElementFromPoint({
        clientX: event.clientX,
        clientY: event.clientY,
        scope: DRAG_SCOPE_CANVAS_WORKTREE_LIST,
      })
      const snapshot = getSnapshotFromWorktreeElement({
        element: target,
        draggingId,
        clientY: event.clientY,
      })
      if (!snapshot.targetId) return

      event.preventDefault()
      latestCanvasDropTargetRef.current = snapshot
      setCanvasDragState(state => applyWorktreeDropSnapshot(state, snapshot))
    }

    const handleDocumentDrop = (event: DragEvent) => {
      const draggingId = canvasDragStateRef.current.draggingId
      if (!draggingId) return
      const fallback = latestCanvasDropTargetRef.current
      if (!fallback.targetId) return
      event.preventDefault()
      event.stopPropagation()
      nativeCanvasDropHandledRef.current = true
      setCanvasDragState({
        draggingId: null,
        targetId: null,
        closestEdge: null,
      })
      latestCanvasDropTargetRef.current = emptyWorktreeDropSnapshot
      reorderCanvasFromDrop(draggingId, fallback.targetId, fallback.closestEdge)
    }

    const handleDocumentDragEnd = () => {
      if (!canvasDragStateRef.current.draggingId) return
      latestCanvasDropTargetRef.current = emptyWorktreeDropSnapshot
      setCanvasDragState({
        draggingId: null,
        targetId: null,
        closestEdge: null,
      })
    }

    document.addEventListener('dragover', handleDocumentDragOver, true)
    document.addEventListener('drop', handleDocumentDrop, true)
    document.addEventListener('dragend', handleDocumentDragEnd, true)

    return () => {
      document.removeEventListener('dragover', handleDocumentDragOver, true)
      document.removeEventListener('drop', handleDocumentDrop, true)
      document.removeEventListener('dragend', handleDocumentDragEnd, true)
    }
  }, [reorderCanvasFromDrop])

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

  useEffect(() => {
    const reloadState = consumeWebReloadState(projectId)
    if (!reloadState) return

    useChatStore
      .getState()
      .setActiveSession(
        reloadState.modalWorktreeId,
        reloadState.activeSessionId
      )
    setSelectedWorktreeModal({
      worktreeId: reloadState.modalWorktreeId,
      worktreePath: reloadState.modalWorktreePath,
    })
  }, [projectId])
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Track highlighted card to survive reordering
  const highlightedCardRef = useRef<{
    worktreeId: string
    sessionId: string
  } | null>(null)
  const suppressNextRestoreAutoOpenRef = useRef(false)

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
  const { handleClearContextApproval, handleClearContextApprovalBuild } =
    useClearContextApproval({
      worktreeId: selectedFlatCard?.worktreeId ?? '',
      worktreePath: selectedFlatCard?.worktreePath ?? '',
    })
  const { handleWorktreeApproval, handleWorktreeApprovalYolo } =
    useWorktreeApproval({
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
    const handleFocusSearch = () => {
      if (isMobile) {
        setIsMobileSearchOpen(true)
      }
      setTimeout(() => searchInputRef.current?.focus(), 0)
    }
    window.addEventListener('focus-canvas-search', handleFocusSearch)
    return () =>
      window.removeEventListener('focus-canvas-search', handleFocusSearch)
  }, [isMobile])

  // Auto-focus search input when mobile search overlay opens
  useEffect(() => {
    if (isMobileSearchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [isMobileSearchOpen])

  // Track session modal open state for magic command keybindings
  useEffect(() => {
    useUIStore
      .getState()
      .setSessionChatModalOpen(
        !!selectedWorktreeModal,
        selectedWorktreeModal?.worktreeId ?? null
      )
    return () => {
      // Clear global modal flag on unmount (e.g. last session → project picker)
      useUIStore.getState().setSessionChatModalOpen(false)
    }
  }, [selectedWorktreeModal])

  // Close modal when worktree is deleted/archived (e.g. PR merged)
  useEffect(() => {
    const handleCloseModal = (e: CustomEvent<{ worktreeId: string }>) => {
      if (selectedWorktreeModal?.worktreeId === e.detail.worktreeId) {
        setSelectedWorktreeModal(null)
      }
    }
    window.addEventListener(
      'close-worktree-modal',
      handleCloseModal as EventListener
    )
    return () =>
      window.removeEventListener(
        'close-worktree-modal',
        handleCloseModal as EventListener
      )
  }, [selectedWorktreeModal?.worktreeId])

  // Open modal from external triggers (e.g. base session switch)
  useEffect(() => {
    const handleOpenModal = (
      e: CustomEvent<{ worktreeId: string; worktreePath: string }>
    ) => {
      openWorktreeModal(e.detail.worktreeId, e.detail.worktreePath)
    }
    window.addEventListener(
      'open-worktree-modal',
      handleOpenModal as EventListener
    )
    return () =>
      window.removeEventListener(
        'open-worktree-modal',
        handleOpenModal as EventListener
      )
  }, [])

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
    const cardIndex = flatCards.findIndex(
      fc => fc.worktreeId === highlighted.worktreeId
    )
    if (cardIndex !== -1 && cardIndex !== selectedIndex) {
      setSelectedIndex(cardIndex)
      return
    }
    if (cardIndex === -1 && activeFilterTab !== 'all' && flatCards.length > 0) {
      setSelectedIndex(0)
      const fallbackItem = flatCards[0]
      highlightedCardRef.current = fallbackItem?.card
        ? {
            worktreeId: fallbackItem.worktreeId,
            sessionId: fallbackItem.card.session.id,
          }
        : null
    }
  }, [selectedWorktreeModal, flatCards, selectedIndex, activeFilterTab])

  // Keep a valid selection when the selected item disappears (archive/delete/close).
  // In list layout this prefers the previous row, matching expected canvas behavior.
  // Skip while search is active — transient empty search results should not erase selection memory.
  useEffect(() => {
    if (selectedIndex === null) return
    if (searchQuery) return
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
  }, [flatCards, selectedIndex, searchQuery, activeFilterTab])

  // Auto-open session modal for newly created worktrees / unread-session clicks
  useEffect(() => {
    const currentSessions = sessionsByWorktreeIdRef.current
    const queuedWorktreeIds = [
      ...useUIStore.getState().autoOpenSessionWorktreeIds,
    ]
    for (const worktreeId of queuedWorktreeIds) {
      const worktree = readyWorktrees.find(w => w.id === worktreeId)
      if (!worktree) continue

      const targetSessionId =
        useUIStore.getState().pendingAutoOpenSessionIds[worktreeId]

      // Explicit session opens (e.g. clicking a finished unread session) should
      // not wait for dashboard session-count queries. SessionChatModal and
      // ChatWindow fetch their own data and can render from the active ID.
      if (targetSessionId) {
        const autoOpen = useUIStore
          .getState()
          .consumeAutoOpenSession(worktreeId)
        if (!autoOpen.shouldOpen) continue

        const sessionId = autoOpen.sessionId ?? targetSessionId

        const exactCardIndex = flatCards.findIndex(
          fc =>
            fc.worktreeId === worktreeId && fc.card?.session.id === sessionId
        )
        const worktreeCardIndex =
          exactCardIndex !== -1
            ? exactCardIndex
            : flatCards.findIndex(
                fc => !fc.isPending && fc.card && fc.worktreeId === worktreeId
              )
        if (worktreeCardIndex !== -1) {
          setSelectedIndex(worktreeCardIndex)
          highlightedCardRef.current = {
            worktreeId,
            sessionId,
          }
        }

        useChatStore.getState().setActiveSession(worktreeId, sessionId)
        openWorktreeModal(worktreeId, worktree.path)
        break
      }

      const sessionData = currentSessions.get(worktreeId)
      if (!sessionData?.sessions.length) continue

      const autoOpen = useUIStore.getState().consumeAutoOpenSession(worktreeId)
      if (!autoOpen.shouldOpen) continue

      // Use specific session if provided, otherwise fall back to first session
      const targetSession = sessionData.sessions[0]

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
        openWorktreeModal(worktreeId, worktree.path)
        break // Only one per render cycle
      }
    }
    // sessionsFingerprint tracks when session data changes (stable string, not Map reference)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoOpenSessionSignal,
    sessionsFingerprint,
    readyWorktrees,
    flatCards,
    openWorktreeModal,
  ])

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
        sessionsByWorktreeIdRef.current.get(lastOpened.worktreeId)?.sessions ??
        []
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
    const suppressRestoreAutoOpen = suppressNextRestoreAutoOpenRef.current
    if (suppressRestoreAutoOpen) {
      suppressNextRestoreAutoOpenRef.current = false
    }
    setSelectedIndex(targetIndex)
    if (targetCard?.card) {
      // Sync projects store so commands (CMD+O, open terminal, etc.) work immediately
      useProjectsStore.getState().selectWorktree(targetCard.worktreeId)
      useChatStore
        .getState()
        .registerWorktreePath(targetCard.worktreeId, targetCard.worktreePath)

      // Auto-open SessionChatModal if restore_last_session is enabled
      if (shouldAutoOpenModal && !suppressRestoreAutoOpen) {
        const sessionIdToOpen =
          lastOpened && targetCard.worktreeId === lastOpened.worktreeId
            ? (resolvedLastOpenedSessionId ?? targetCard.card.session.id)
            : targetCard.card.session.id

        useChatStore
          .getState()
          .setActiveSession(targetCard.worktreeId, sessionIdToOpen)
        openWorktreeModal(targetCard.worktreeId, targetCard.worktreePath)
      }
    }
  }, [
    flatCards,
    selectedIndex,
    selectedWorktreeModal,
    projectId,
    preferences?.restore_last_session,
    openWorktreeModal,
  ])

  // Handle clicking on a worktree row - open modal
  const handleWorktreeClick = useCallback(
    (worktreeId: string, worktreePath: string) => {
      openWorktreeModal(worktreeId, worktreePath)

      // Persist last-opened project context immediately on open so project switch
      // restore does not depend on a subsequent tab change event.
      const { activeSessionIds, setActiveSession, setLastOpenedForProject } =
        useChatStore.getState()
      const existingSessionId = activeSessionIds[worktreeId]
      const firstSessionId =
        sessionsByWorktreeIdRef.current.get(worktreeId)?.sessions[0]?.id
      const targetSessionId = existingSessionId ?? firstSessionId

      if (targetSessionId) {
        if (!existingSessionId) {
          setActiveSession(worktreeId, targetSessionId)
        }
        setLastOpenedForProject(projectId, worktreeId, targetSessionId)
      }
    },
    [openWorktreeModal, projectId]
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

  const moveSelectedWorktreeByKeyboard = useCallback(
    (direction: -1 | 1) => {
      if (!canvasReorderEnabled || reorderWorktrees.isPending) return

      const selectedItem =
        selectedIndex === null ? null : (flatCards[selectedIndex] ?? null)
      const selectedWorktreeId =
        selectedItem?.worktreeId ??
        useProjectsStore.getState().selectedWorktreeId ??
        null
      if (!selectedWorktreeId || selectedItem?.isPending) return

      const activeId = selectedWorktreeId
      const oldIndex = canvasDraggableIds.indexOf(activeId)
      if (oldIndex === -1) return

      const targetId = canvasDraggableIds[oldIndex + direction]
      if (!targetId) return

      if (selectedItem?.card) {
        highlightedCardRef.current = {
          worktreeId: activeId,
          sessionId: selectedItem.card.session.id,
        }
      } else {
        highlightedCardRef.current = null
      }

      reorderCanvasFromDrop(
        activeId,
        targetId,
        direction > 0 ? 'bottom' : 'top'
      )
    },
    [
      canvasDraggableIds,
      canvasReorderEnabled,
      flatCards,
      reorderCanvasFromDrop,
      reorderWorktrees.isPending,
      selectedIndex,
    ]
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

  useEffect(() => {
    const handleMoveSelectedWorktree = (event: Event) => {
      const direction = (event as CustomEvent).detail?.direction
      if (direction === 'up') moveSelectedWorktreeByKeyboard(-1)
      if (direction === 'down') moveSelectedWorktreeByKeyboard(1)
    }

    window.addEventListener(
      'move-selected-worktree',
      handleMoveSelectedWorktree
    )
    return () =>
      window.removeEventListener(
        'move-selected-worktree',
        handleMoveSelectedWorktree
      )
  }, [moveSelectedWorktreeByKeyboard])

  const handleFilterTabChange = useCallback(
    (value: CanvasFilterTab) => {
      if (value === activeFilterTab) return
      suppressNextRestoreAutoOpenRef.current = true
      setActiveFilterTab(value)
    },
    [activeFilterTab]
  )

  const handleFilterTabKeyboardNav = useCallback(
    (delta: -1 | 1) => {
      const currentIndex = canvasFilterTabs.findIndex(
        tab => tab.value === activeFilterTab
      )
      const safeCurrentIndex = currentIndex === -1 ? 0 : currentIndex
      const nextIndex =
        (safeCurrentIndex + delta + canvasFilterTabs.length) %
        canvasFilterTabs.length
      const nextTab = canvasFilterTabs[nextIndex]

      if (nextTab) {
        handleFilterTabChange(nextTab.value)
      }
    },
    [activeFilterTab, canvasFilterTabs, handleFilterTabChange]
  )
  const handleNavigateFilterTabLeft = useCallback(() => {
    handleFilterTabKeyboardNav(-1)
  }, [handleFilterTabKeyboardNav])
  const handleNavigateFilterTabRight = useCallback(() => {
    handleFilterTabKeyboardNav(1)
  }, [handleFilterTabKeyboardNav])

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
  }, [
    worktreeSections,
    flatCards,
    handleWorktreeClick,
    handleSelectedIndexChange,
  ])

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

  // Shortcut events (plan, approve) - must be before keyboard nav to get dialog states
  const {
    planDialogPath,
    planDialogContent,
    planApprovalContext,
    planDialogCard,
    closePlanDialog,
  } = useCanvasShortcutEvents({
    selectedCard,
    enabled: !selectedWorktreeModal && selectedIndex !== null,
    worktreeId: selectedFlatCard?.worktreeId ?? '',
    worktreePath: selectedFlatCard?.worktreePath ?? '',
    onPlanApproval: (card, updatedPlan) =>
      card.session.backend === 'cursor'
        ? handleClearContextApprovalBuild(card, updatedPlan)
        : handlePlanApproval(card, updatedPlan),
    onPlanApprovalYolo: (card, updatedPlan) =>
      card.session.backend === 'cursor'
        ? handleClearContextApproval(card, updatedPlan)
        : handlePlanApprovalYolo(card, updatedPlan),
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
  const [worktreeLabelModalOpen, setWorktreeLabelModalOpen] = useState(false)
  const [worktreeLabelTarget, setWorktreeLabelTarget] = useState<{
    worktreeId: string
    currentLabels: LabelData[]
  } | null>(null)
  const [labelDeleteTarget, setLabelDeleteTarget] = useState<{
    label: LabelData
    assignedCount: number
  } | null>(null)

  const openWorktreeLabelModal = useCallback(
    (worktree: Worktree) => {
      setWorktreeLabelTarget({
        worktreeId: worktree.id,
        currentLabels: mergePinnedLabels(
          getWorktreeLabels(worktree),
          projectPinnedLabels
        ),
      })
      setWorktreeLabelModalOpen(true)
    },
    [projectPinnedLabels]
  )

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

      openWorktreeLabelModal(section.worktree)
    }

    window.addEventListener('toggle-session-label', handleToggleLabel)
    return () =>
      window.removeEventListener('toggle-session-label', handleToggleLabel)
  }, [
    selectedWorktreeModal,
    selectedIndex,
    flatCards,
    worktreeSections,
    openWorktreeLabelModal,
  ])

  // Linked projects modal (opened by MagicModal via UI store)
  const linkedProjectsModalOpen = useUIStore(
    state => state.linkedProjectsModalOpen
  )
  const handleLinkedProjectsModalChange = useCallback((open: boolean) => {
    useUIStore.getState().setLinkedProjectsModalOpen(open)
  }, [])

  // CMD+G: Open git diff for selected worktree
  useEffect(() => {
    if (!!selectedWorktreeModal || selectedIndex === null) return

    const handleOpenGitDiff = (e: Event) => {
      const requestedType = (e as CustomEvent).detail?.type as
        | 'uncommitted'
        | 'branch'
        | undefined

      const flatCard = flatCards[selectedIndex]
      if (!flatCard) return

      const section = worktreeSections.find(
        s => s.worktree.id === flatCard.worktreeId
      )
      if (!section) return

      const isBase = isBaseSession(section.worktree)
      const baseBranch = project?.default_branch ?? 'main'

      setCanvasDiffRequest(prev => {
        if (requestedType) {
          return {
            type: requestedType,
            worktreePath: section.worktree.path,
            baseBranch,
          }
        }
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
    async (labels: LabelData[]) => {
      if (!worktreeLabelTarget) return

      try {
        await invoke('update_worktree_labels', {
          worktreeId: worktreeLabelTarget.worktreeId,
          labels,
        })
        useProjectsStore
          .getState()
          .setProjectCanvasLabels(
            projectId,
            mergeLabelRegistry(
              mergeLabelRegistry(
                projectLabels,
                worktreeLabelTarget.currentLabels
              ),
              labels
            )
          )
        setWorktreeLabelTarget(target =>
          target ? { ...target, currentLabels: labels } : target
        )
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        })
      } catch (error) {
        toast.error(`Failed to update labels: ${error}`)
      }
    },
    [worktreeLabelTarget, queryClient, projectId, projectLabels]
  )

  const handleLabelPinnedChange = useCallback(
    async (label: LabelData, pinned: boolean) => {
      const nextPinnedLabels = setLabelPinned(
        projectPinnedLabels,
        label,
        pinned
      )

      useProjectsStore
        .getState()
        .setProjectCanvasPinnedLabels(projectId, nextPinnedLabels)
      useProjectsStore
        .getState()
        .setProjectCanvasLabels(
          projectId,
          mergeLabelRegistry(projectLabels, [{ ...label, pinned }])
        )

      const worktreesToUpdate = worktreeSections
        .map(s => s.worktree)
        .filter(wt =>
          getWorktreeLabels(wt).some(
            existing => existing.name.toLowerCase() === label.name.toLowerCase()
          )
        )

      if (worktreesToUpdate.length > 0) {
        const results = await Promise.allSettled(
          worktreesToUpdate.map(wt =>
            invoke('update_worktree_labels', {
              worktreeId: wt.id,
              labels: getWorktreeLabels(wt).map(existing =>
                existing.name.toLowerCase() === label.name.toLowerCase()
                  ? { ...existing, pinned }
                  : existing
              ),
            })
          )
        )

        const failures = results.filter(r => r.status === 'rejected')
        if (failures.length > 0) {
          toast.error(
            `Failed to update pinned state for ${failures.length} worktree(s)`
          )
        }

        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        })
      }

      setWorktreeLabelTarget(target =>
        target
          ? {
              ...target,
              currentLabels: mergePinnedLabels(
                target.currentLabels.map(existing =>
                  existing.name.toLowerCase() === label.name.toLowerCase()
                    ? { ...existing, pinned }
                    : existing
                ),
                nextPinnedLabels
              ),
            }
          : target
      )
    },
    [
      projectId,
      projectLabels,
      projectPinnedLabels,
      queryClient,
      worktreeSections,
    ]
  )

  const handleLabelColorChange = useCallback(
    async (labelName: string, newColor: string) => {
      useProjectsStore
        .getState()
        .setProjectCanvasLabels(
          projectId,
          updateWorktreeLabelsByName(projectLabels, labelName, newColor)
        )

      if (
        projectPinnedLabels.some(
          label => label.name.toLowerCase() === labelName.toLowerCase()
        )
      ) {
        useProjectsStore.getState().setProjectCanvasPinnedLabels(
          projectId,
          projectPinnedLabels.map(label =>
            label.name.toLowerCase() === labelName.toLowerCase()
              ? { ...label, color: newColor }
              : label
          )
        )
      }

      const worktreesToUpdate = worktreeSections
        .map(s => s.worktree)
        .filter(wt =>
          getWorktreeLabels(wt).some(
            label => label.name.toLowerCase() === labelName.toLowerCase()
          )
        )

      if (worktreesToUpdate.length === 0) return

      const results = await Promise.allSettled(
        worktreesToUpdate.map(wt =>
          invoke('update_worktree_labels', {
            worktreeId: wt.id,
            labels: updateWorktreeLabelsByName(
              getWorktreeLabels(wt),
              labelName,
              newColor
            ),
          })
        )
      )

      const failures = results.filter(r => r.status === 'rejected')
      if (failures.length > 0) {
        toast.error(`Failed to update color for ${failures.length} worktree(s)`)
      }

      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })
    },
    [
      projectId,
      projectLabels,
      projectPinnedLabels,
      worktreeSections,
      queryClient,
    ]
  )

  const handleDeleteLabelRequest = useCallback(
    (label: LabelData) => {
      const allWorktrees = [...readyWorktrees, ...pendingWorktrees]
      setLabelDeleteTarget({
        label,
        assignedCount: countWorktreesWithLabel(allWorktrees, label.name),
      })
    },
    [readyWorktrees, pendingWorktrees]
  )

  const handleConfirmDeleteLabel = useCallback(async () => {
    if (!labelDeleteTarget) return

    const labelName = labelDeleteTarget.label.name
    const allWorktrees = [...readyWorktrees, ...pendingWorktrees]
    const worktreesToUpdate = allWorktrees.filter(wt =>
      getWorktreeLabels(wt).some(
        label => label.name.toLowerCase() === labelName.toLowerCase()
      )
    )

    useProjectsStore
      .getState()
      .setProjectCanvasLabels(
        projectId,
        deleteLabelFromRegistry(projectLabels, labelName)
      )
    useProjectsStore
      .getState()
      .setProjectCanvasPinnedLabels(
        projectId,
        deleteLabelFromRegistry(projectPinnedLabels, labelName)
      )

    if (worktreesToUpdate.length > 0) {
      const results = await Promise.allSettled(
        worktreesToUpdate.map(wt =>
          invoke('update_worktree_labels', {
            worktreeId: wt.id,
            labels: removeLabelFromLabels(getWorktreeLabels(wt), labelName),
          })
        )
      )

      const failures = results.filter(r => r.status === 'rejected')
      if (failures.length > 0) {
        toast.error(
          `Failed to delete label from ${failures.length} worktree(s)`
        )
      } else {
        toast.success(`Deleted label "${labelName}"`)
      }

      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })
    } else {
      toast.success(`Deleted label "${labelName}"`)
    }

    setWorktreeLabelTarget(target =>
      target
        ? {
            ...target,
            currentLabels: removeLabelFromLabels(
              target.currentLabels,
              labelName
            ),
          }
        : target
    )
    setLabelDeleteTarget(null)
  }, [
    labelDeleteTarget,
    pendingWorktrees,
    projectId,
    projectLabels,
    projectPinnedLabels,
    queryClient,
    readyWorktrees,
  ])

  // Keyboard navigation - disable when any modal/dialog is open
  const isModalOpen =
    !!selectedWorktreeModal ||
    !!planDialogPath ||
    !!planDialogContent ||
    worktreeLabelModalOpen ||
    !!labelDeleteTarget
  const { cardRefs } = useCanvasKeyboardNav({
    cards: flatCards,
    selectedIndex,
    onSelectedIndexChange: handleSelectedIndexChange,
    onSelect: handleSelect,
    onNavigateLeft: handleNavigateFilterTabLeft,
    onNavigateRight: handleNavigateFilterTabRight,
    onMoveUp: () => moveSelectedWorktreeByKeyboard(-1),
    onMoveDown: () => moveSelectedWorktreeByKeyboard(1),
    enabled: !isModalOpen,
    onSelectionChange: syncSelectionToStore,
  })

  // Handle approve from dialog (with updated plan content)
  // Cursor can't switch modes on a resumed session, so redirect to clear-context (new session)
  const isDialogCardCursor = planDialogCard?.session.backend === 'cursor'
  const handleDialogApprove = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        if (isDialogCardCursor) {
          handleClearContextApprovalBuild(planDialogCard, updatedPlan)
        } else {
          handlePlanApproval(planDialogCard, updatedPlan)
        }
      }
    },
    [
      planDialogCard,
      handlePlanApproval,
      handleClearContextApprovalBuild,
      isDialogCardCursor,
    ]
  )

  const handleDialogApproveYolo = useCallback(
    (updatedPlan: string) => {
      if (planDialogCard) {
        if (isDialogCardCursor) {
          handleClearContextApproval(planDialogCard, updatedPlan)
        } else {
          handlePlanApprovalYolo(planDialogCard, updatedPlan)
        }
      }
    },
    [
      planDialogCard,
      handlePlanApprovalYolo,
      handleClearContextApproval,
      isDialogCardCursor,
    ]
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

  // Listen for create-new-session event to handle CMD+T / picker shortcut
  useEffect(() => {
    const handleCreateNewSession = (e: Event) => {
      // Don't create if modal is already open
      if (selectedWorktreeModal) return

      // Use selected card, or fallback to first card
      const item =
        selectedIndex !== null ? flatCards[selectedIndex] : flatCards[0]
      if (!item) return

      e.stopImmediatePropagation()
      const intent =
        (e as CustomEvent<{ intent?: 'default' | 'picker' }>).detail?.intent ??
        'picker'

      useUIStore.getState().openNewSessionModeModal({
        worktreeId: item.worktreeId,
        worktreePath: item.worktreePath,
        origin: 'canvas',
        intent,
      })
    }

    window.addEventListener('create-new-session', handleCreateNewSession, {
      capture: true,
    })
    return () =>
      window.removeEventListener('create-new-session', handleCreateNewSession, {
        capture: true,
      })
  }, [selectedWorktreeModal, selectedIndex, flatCards])

  // Listen for open-session-modal event (fired by ChatWindow when creating new session inside modal,
  // or by UnreadBell to open a session on the project canvas)
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
        if (sessionId) {
          highlightedCardRef.current = { worktreeId, sessionId }
          useChatStore.getState().setActiveSession(worktreeId, sessionId)
        }
        openWorktreeModal(worktreeId, worktreePath)
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
  }, [selectedWorktreeModal, openWorktreeModal])

  // Periodically refresh git status for all worktrees while on the dashboard
  useEffect(() => {
    if (!isTauri() || !projectId || readyWorktrees.length === 0) return

    const refreshMs = getCanvasStatusRefreshMs(preferences?.git_poll_interval)
    const interval = setInterval(() => {
      if (document.hasFocus()) {
        fetchWorktreesStatus(projectId)
      }
    }, refreshMs)

    return () => clearInterval(interval)
  }, [projectId, readyWorktrees.length, preferences?.git_poll_interval])

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

  const activeFilterLabel =
    canvasFilterTabs.find(tab => tab.value === activeFilterTab)?.label ?? 'All'
  const hasAnyVisibleWorktrees = filterTabCounts.all > 0

  // Track global card index for refs
  let cardIndex = 0

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex-1 flex flex-col overflow-auto">
        {/* Header and filters - sticky together over content */}
        <div className="sticky top-0 z-10 bg-background/60 backdrop-blur-md">
          <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-2 sm:py-3 border-b border-border/30 sm:min-h-[61px]">
            <div className="flex flex-col shrink-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-lg font-semibold">
                  {project.name}
                </h2>
                <div className="hidden md:flex items-center gap-2">
                  <NewIssuesBadge
                    projectPath={project.path}
                    projectId={projectId}
                  />
                  <OpenPRsBadge
                    projectPath={project.path}
                    projectId={projectId}
                  />
                  <SecurityAlertsBadge
                    projectPath={project.path}
                    projectId={projectId}
                  />
                  <FailedRunsBadge projectPath={project.path} />
                </div>
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
                      onSelect={() => {
                        useProjectsStore.getState().selectProject(projectId)
                        useUIStore.getState().setNewWorktreeModalOpen(true)
                      }}
                    >
                      <Plus className="h-4 w-4" />
                      New Worktree
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      onSelect={() => createBaseSession.mutate(projectId)}
                    >
                      <Home className="h-4 w-4" />
                      {worktrees.find(isBaseSession)
                        ? 'Open Base Session'
                        : 'New Base Session'}
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      onSelect={() =>
                        useProjectsStore
                          .getState()
                          .openProjectSettings(projectId)
                      }
                    >
                      <Settings className="h-4 w-4" />
                      Project Settings
                    </DropdownMenuItem>

                    {mobileGitHubEnabled && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => {
                            useProjectsStore.getState().selectProject(projectId)
                            const {
                              setNewWorktreeModalDefaultTab,
                              setNewWorktreeModalOpen,
                            } = useUIStore.getState()
                            setNewWorktreeModalDefaultTab('issues')
                            setNewWorktreeModalOpen(true)
                          }}
                        >
                          <CircleDot className="h-4 w-4 text-green-600" />
                          {mobileIssueCount > 0
                            ? `${mobileIssueCount} Issues`
                            : 'Issues'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            useProjectsStore.getState().selectProject(projectId)
                            const {
                              setNewWorktreeModalDefaultTab,
                              setNewWorktreeModalOpen,
                            } = useUIStore.getState()
                            setNewWorktreeModalDefaultTab('prs')
                            setNewWorktreeModalOpen(true)
                          }}
                        >
                          <GitPullRequestArrow className="h-4 w-4 text-blue-600" />
                          {mobilePRCount > 0 ? `${mobilePRCount} PRs` : 'PRs'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            useUIStore
                              .getState()
                              .setWorkflowRunsModalOpen(true, project.path)
                          }
                        >
                          {mobileFailedWorkflowCount > 0 ? (
                            <AlertCircle className="h-4 w-4 text-red-600" />
                          ) : (
                            <Activity className="h-4 w-4" />
                          )}
                          {mobileFailedWorkflowCount > 0
                            ? `${mobileFailedWorkflowCount} Failed Workflows`
                            : mobileWorkflowRunCount > 0
                              ? `${mobileWorkflowRunCount} Workflows`
                              : 'Workflows'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            useProjectsStore.getState().selectProject(projectId)
                            const {
                              setNewWorktreeModalDefaultTab,
                              setNewWorktreeModalOpen,
                            } = useUIStore.getState()
                            setNewWorktreeModalDefaultTab('security')
                            setNewWorktreeModalOpen(true)
                          }}
                        >
                          <ShieldAlert className="h-4 w-4 text-orange-600" />
                          {mobileSecurityCount > 0
                            ? `${mobileSecurityCount} Security`
                            : 'Security'}
                        </DropdownMenuItem>
                      </>
                    )}

                    {canOpenLocally && (
                      <>
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
                      </>
                    )}

                    {!canOpenLocally && <DropdownMenuSeparator />}

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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      aria-label="Sort worktrees"
                    >
                      <ArrowUpDown className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-48">
                    <DropdownMenuLabel>Sort worktrees</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup
                      value={worktreeSortMode}
                      onValueChange={value =>
                        useProjectsStore
                          .getState()
                          .setProjectCanvasWorktreeSortMode(
                            projectId,
                            value as WorktreeSortMode
                          )
                      }
                    >
                      <DropdownMenuRadioItem value="created">
                        Creation date
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="last_activity">
                        Last activity
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="manual">
                        Manual
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                {/* Mobile: magnifier icon inline with badges */}
                {isMobile &&
                  (worktreeSections.length > 0 || searchQuery) &&
                  !isMobileSearchOpen && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative h-7 w-7 text-muted-foreground"
                      onClick={() => setIsMobileSearchOpen(true)}
                      aria-label="Open search"
                    >
                      <Search className="h-4 w-4" />
                      {searchQuery && (
                        <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-primary" />
                      )}
                    </Button>
                  )}
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
                {/* Desktop: inline search bar */}
                {!isMobile && (
                  <div className="flex justify-center">
                    <div className="relative w-full max-w-md">
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
                )}

                {/* Mobile: full-width search overlay */}
                {isMobile && isMobileSearchOpen && (
                  <div className="absolute inset-0 z-20 flex items-center gap-2 bg-background/95 backdrop-blur-md px-4">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        ref={searchInputRef}
                        placeholder="Search worktrees and sessions..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') {
                            setIsMobileSearchOpen(false)
                          }
                        }}
                        aria-label="Search worktrees and sessions"
                        name="worktree-search"
                        className="pl-9 bg-transparent border-border/30"
                      />
                    </div>
                    {searchQuery && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground"
                        onClick={() => setSearchQuery('')}
                        aria-label="Clear search"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground text-sm"
                      onClick={() => setIsMobileSearchOpen(false)}
                      aria-label="Close search"
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </>
            )}
            {/* OpenInButton always visible on desktop (grid column 3) */}
            {!isMobile && (
              <div className="flex items-center gap-2 shrink-0 justify-end col-start-3">
                <OpenInButton worktreePath={project.path} />
                <ScriptsButton
                  projectId={project.id}
                  worktreePath={project.path}
                  onRun={handlePackageScript}
                />
              </div>
            )}
          </div>

          <div className="border-b border-border/30 bg-background/80 px-4 py-2">
            <div
              role="tablist"
              aria-label="Worktree filters"
              className="flex gap-1 overflow-x-auto"
            >
              {canvasFilterTabs.map(tab => {
                const Icon = tab.icon
                const isActive = activeFilterTab === tab.value
                const isPinnedLabelTab = isLabelFilterTabItem(tab)
                const count = isPinnedLabelTab
                  ? tab.count
                  : filterTabCounts[tab.value]
                const settingsPane =
                  'settingsPane' in tab ? tab.settingsPane : undefined
                const settingsPlacement =
                  'settingsPlacement' in tab ? tab.settingsPlacement : undefined
                const badge = 'badge' in tab ? tab.badge : undefined
                if (settingsPane && settingsPlacement === 'inside') {
                  return (
                    <div
                      key={tab.value}
                      className={cn(
                        'inline-flex shrink-0 items-center overflow-hidden rounded-md border text-xs font-medium transition-colors',
                        isActive
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        className="inline-flex shrink-0 items-center gap-1.5 pl-3 py-1.5"
                        onClick={() => handleFilterTabChange(tab.value)}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span>{tab.label}</span>
                        {badge && (
                          <span
                            className={cn(
                              'rounded border px-1 py-0 text-[9px] uppercase leading-4 tracking-wide',
                              isActive
                                ? 'border-primary/30 text-primary'
                                : 'border-muted-foreground/20 text-muted-foreground'
                            )}
                          >
                            {badge}
                          </span>
                        )}
                        <span
                          className={cn(
                            'rounded-md px-1.5 py-0.5 text-[10px] leading-none',
                            isActive
                              ? 'bg-primary/15 text-primary'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          {count}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Configure ${tab.label}`}
                        title={`Configure ${tab.label}`}
                        className={cn(
                          'mx-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors',
                          isActive
                            ? 'text-primary hover:bg-primary/15'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        )}
                        onClick={() =>
                          useProjectsStore
                            .getState()
                            .openProjectSettings(projectId, settingsPane)
                        }
                      >
                        <Settings className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                }
                return (
                  <div key={tab.value} className="inline-flex shrink-0 gap-0.5">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                        isActive
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      )}
                      onClick={() => handleFilterTabChange(tab.value)}
                    >
                      <Icon
                        className="h-3.5 w-3.5"
                        style={
                          isPinnedLabelTab ? { color: tab.color } : undefined
                        }
                      />
                      <span>{tab.label}</span>
                      <span
                        className={cn(
                          'rounded-md px-1.5 py-0.5 text-[10px] leading-none',
                          isActive
                            ? 'bg-primary/15 text-primary'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {count}
                      </span>
                    </button>
                    {settingsPane && (
                      <button
                        type="button"
                        aria-label={`Configure ${tab.label}`}
                        title={`Configure ${tab.label}`}
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                        onClick={() =>
                          useProjectsStore
                            .getState()
                            .openProjectSettings(projectId, settingsPane)
                        }
                      >
                        <Settings className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Canvas View */}
        <div
          className={`flex-1 pb-16 ${worktreeSections.length === 0 && !searchQuery ? '' : 'pt-5 px-4'}`}
        >
          {worktreeSections.length === 0 ? (
            searchQuery ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                No {activeFilterLabel.toLowerCase()} worktrees or sessions match
                your search
              </div>
            ) : activeFilterTab === 'all' && !hasAnyVisibleWorktrees ? (
              <EmptyDashboardTabs
                projectId={projectId}
                projectPath={project?.path ?? null}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                No {activeFilterLabel.toLowerCase()} worktrees
              </div>
            )
          ) : (
            <div
              className="group/canvas-list flex flex-col gap-1"
              onDragOver={handleNativeCanvasDragOver}
              onDrop={handleNativeCanvasDrop}
              onDragEnd={handleNativeCanvasDragEnd}
            >
              {(() => {
                let shortcutNum = 0
                return worktreeSections.map(section => {
                  const currentIndex = cardIndex++
                  const isReorderDisabled =
                    !canvasReorderEnabled ||
                    reorderWorktrees.isPending ||
                    !canManuallyReorderWorktree(section.worktree)

                  if (section.isPending) {
                    return (
                      <SortableCanvasWorktreeSection
                        key={section.worktree.id}
                        section={section}
                        disabled={true}
                        isDragging={
                          canvasDragState.draggingId === section.worktree.id
                        }
                        closestEdge={
                          canvasDragState.targetId === section.worktree.id
                            ? canvasDragState.closestEdge
                            : null
                        }
                        projectId={projectId}
                      >
                        <WorktreeSetupCard
                          ref={el => {
                            cardRefs.current[currentIndex] = el
                          }}
                          worktree={section.worktree}
                          layout="list"
                          isSelected={selectedIndex === currentIndex}
                          onSelect={() =>
                            handleSelectedIndexChange(currentIndex)
                          }
                        />
                      </SortableCanvasWorktreeSection>
                    )
                  }
                  const thisShortcut =
                    ++shortcutNum <= 9 ? shortcutNum : undefined
                  return (
                    <SortableCanvasWorktreeSection
                      key={section.worktree.id}
                      section={section}
                      disabled={isReorderDisabled}
                      isDragging={
                        canvasDragState.draggingId === section.worktree.id
                      }
                      closestEdge={
                        canvasDragState.targetId === section.worktree.id
                          ? canvasDragState.closestEdge
                          : null
                      }
                      projectId={projectId}
                    >
                      <div
                        ref={el => {
                          cardRefs.current[currentIndex] = el
                        }}
                      >
                        <WorktreeSectionHeader
                          worktree={section.worktree}
                          projectId={projectId}
                          defaultBranch={project.default_branch}
                          openPRs={openPRs}
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
                          onDiffClick={(worktreePath, baseBranch, type) => {
                            setCanvasDiffRequest({
                              type,
                              worktreePath,
                              baseBranch,
                            })
                          }}
                          onSetLabels={
                            showWorktreeLabelContextMenu
                              ? () => openWorktreeLabelModal(section.worktree)
                              : undefined
                          }
                          onResolveConflicts={handleCanvasResolveConflicts}
                          disableTextSelection={disableWorktreeTextSelection}
                        />
                      </div>
                    </SortableCanvasWorktreeSection>
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
          disabled={planDialogCard?.isSending ?? false}
          approvalContext={planApprovalContext ?? undefined}
          onApprove={handleDialogApprove}
          onApproveYolo={handleDialogApproveYolo}
          onClearContextApprove={handleDialogClearContextApprove}
          onClearContextBuildApprove={handleDialogClearContextApproveBuild}
          onWorktreeBuildApprove={
            handleWorktreeApproval ? handleDialogWorktreeApprove : undefined
          }
          onWorktreeYoloApprove={
            handleWorktreeApprovalYolo
              ? handleDialogWorktreeApproveYolo
              : undefined
          }
        />
      ) : planDialogContent ? (
        <PlanDialog
          content={planDialogContent}
          isOpen={true}
          onClose={closePlanDialog}
          editable={true}
          disabled={planDialogCard?.isSending ?? false}
          approvalContext={planApprovalContext ?? undefined}
          onApprove={handleDialogApprove}
          onApproveYolo={handleDialogApproveYolo}
          onClearContextApprove={handleDialogClearContextApprove}
          onClearContextBuildApprove={handleDialogClearContextApproveBuild}
          onWorktreeBuildApprove={
            handleWorktreeApproval ? handleDialogWorktreeApprove : undefined
          }
          onWorktreeYoloApprove={
            handleWorktreeApprovalYolo
              ? handleDialogWorktreeApproveYolo
              : undefined
          }
        />
      ) : null}

      {/* Worktree Label Modal */}
      <LabelModal
        key={worktreeLabelTarget?.worktreeId ?? 'wt-label'}
        isOpen={worktreeLabelModalOpen}
        onClose={() => {
          setWorktreeLabelModalOpen(false)
          setWorktreeLabelTarget(null)
        }}
        sessionId={null}
        currentLabel={null}
        currentLabels={worktreeLabelTarget?.currentLabels ?? []}
        mode="multi"
        onApplyLabels={handleWorktreeLabelApply}
        onColorChange={handleLabelColorChange}
        onPinnedChange={handleLabelPinnedChange}
        onDeleteLabel={handleDeleteLabelRequest}
        extraLabels={allWorktreeLabels}
      />

      <AlertDialog
        open={!!labelDeleteTarget}
        onOpenChange={open => {
          if (!open) setLabelDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete label?</AlertDialogTitle>
            <AlertDialogDescription>
              Deleting <strong>{labelDeleteTarget?.label.name}</strong> will
              remove it from the label list
              {labelDeleteTarget?.assignedCount
                ? ` and from ${labelDeleteTarget.assignedCount} worktree${
                    labelDeleteTarget.assignedCount === 1 ? '' : 's'
                  }`
                : ''}
              . This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleConfirmDeleteLabel}
            >
              Delete label
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Session Chat Modal */}
      <SessionChatModal
        worktreeId={selectedWorktreeModal?.worktreeId ?? ''}
        worktreePath={selectedWorktreeModal?.worktreePath ?? ''}
        isOpen={!!selectedWorktreeModal}
        onClose={() => setSelectedWorktreeModal(null)}
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

      {/* Linked Projects modal (triggered from MagicModal on canvas) */}
      <Suspense fallback={null}>
        <LinkedProjectsModal
          open={linkedProjectsModalOpen}
          onOpenChange={handleLinkedProjectsModalChange}
          projectId={projectId}
        />
      </Suspense>
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
