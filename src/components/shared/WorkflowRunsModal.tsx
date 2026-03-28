import {
  useCallback,
  useMemo,
  useState,
  useRef,
  useEffect,
  forwardRef,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  XCircle,
  Clock,
  MinusCircle,
  Loader2,
  Wand2,
  RefreshCw,
} from 'lucide-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useUIStore } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useWorkflowRuns, githubQueryKeys } from '@/services/github'
import { projectsQueryKeys } from '@/services/projects'
import {
  useCreateSession,
  useSendMessage,
  useSetSessionBackend,
  useSetSessionModel,
  useSetSessionProvider,
  chatQueryKeys,
} from '@/services/chat'
import type { WorktreeSessions } from '@/types/chat'
import { usePreferences } from '@/services/preferences'
import { openExternal } from '@/lib/platform'
import { ScrollArea } from '@/components/ui/scroll-area'
import { resolveBackend } from '@/lib/model-utils'
import {
  DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT,
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  resolveMagicPromptProvider,
} from '@/types/preferences'
import type { WorkflowRun } from '@/types/github'
import type { Project, Worktree } from '@/types/projects'

function timeAgo(dateString: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateString).getTime()) / 1000
  )
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function isFailedRun(run: WorkflowRun): boolean {
  return run.conclusion === 'failure' || run.conclusion === 'startup_failure'
}

/** Extract the numeric run ID from a GitHub Actions URL */
function extractRunId(url: string): string {
  const match = url.match(/\/runs\/(\d+)/)
  return match?.[1] ?? ''
}

function RunStatusIcon({ run }: { run: WorkflowRun }) {
  if (run.status === 'in_progress' || run.status === 'queued') {
    return <Clock className="h-4 w-4 shrink-0 text-yellow-500" />
  }
  switch (run.conclusion) {
    case 'success':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
    case 'failure':
    case 'startup_failure':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />
    case 'cancelled':
    case 'skipped':
      return <MinusCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
    default:
      return <MinusCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
  }
}

interface WorkflowGroup {
  workflowName: string
  totalCount: number
  failedCount: number
  latestStatus: 'success' | 'failure' | 'pending'
}

const SidebarItem = forwardRef<
  HTMLButtonElement,
  {
    label: string
    count: number
    latestStatus: 'success' | 'failure' | 'pending'
    isSelected: boolean
    isFocused: boolean
    onClick: () => void
  }
>(({ label, count, latestStatus, isSelected, isFocused, onClick }, ref) => {
  const countBg =
    latestStatus === 'success'
      ? 'bg-green-500/10 text-green-600 dark:text-green-400'
      : latestStatus === 'failure'
        ? 'bg-red-500/10 text-red-500'
        : 'bg-muted text-muted-foreground'

  return (
    <button
      ref={ref}
      onClick={onClick}
      className={`w-full text-left rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-accent ${isSelected || isFocused ? 'bg-accent font-medium' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate">{label}</span>
        <div className="flex items-center gap-1 shrink-0">
          <span
            className={`rounded px-1 py-0.5 text-[10px] font-medium ${countBg}`}
          >
            {count}
          </span>
        </div>
      </div>
    </button>
  )
})
SidebarItem.displayName = 'SidebarItem'

export function WorkflowRunsModal() {
  const queryClient = useQueryClient()
  const createSession = useCreateSession()
  const sendMessage = useSendMessage()
  const setSessionBackend = useSetSessionBackend()
  const setSessionModel = useSetSessionModel()
  const setSessionProvider = useSetSessionProvider()
  const { data: preferences } = usePreferences()

  const workflowRunsModalOpen = useUIStore(state => state.workflowRunsModalOpen)
  const workflowRunsModalProjectPath = useUIStore(
    state => state.workflowRunsModalProjectPath
  )
  const workflowRunsModalBranch = useUIStore(
    state => state.workflowRunsModalBranch
  )
  const setWorkflowRunsModalOpen = useUIStore(
    state => state.setWorkflowRunsModalOpen
  )

  const {
    data: result,
    isLoading,
    isFetching,
  } = useWorkflowRuns(
    workflowRunsModalOpen ? workflowRunsModalProjectPath : null,
    workflowRunsModalBranch ?? undefined
  )

  const handleRefresh = useCallback(() => {
    if (workflowRunsModalProjectPath) {
      queryClient.invalidateQueries({
        queryKey: githubQueryKeys.workflowRuns(
          workflowRunsModalProjectPath,
          workflowRunsModalBranch ?? undefined
        ),
      })
    }
  }, [queryClient, workflowRunsModalProjectPath, workflowRunsModalBranch])

  const runs = useMemo(() => result?.runs ?? [], [result?.runs])
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [focusedPane, setFocusedPane] = useState<'sidebar' | 'list'>('sidebar')
  const [sidebarFocusedIndex, setSidebarFocusedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const sidebarItemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const groups = useMemo(() => {
    const groupMap = new Map<string, WorkflowGroup>()
    for (const run of runs) {
      const existing = groupMap.get(run.workflowName)
      if (existing) {
        existing.totalCount++
        if (isFailedRun(run)) existing.failedCount++
      } else {
        // First occurrence per workflow = latest (runs are sorted by date)
        const status: WorkflowGroup['latestStatus'] =
          run.status === 'in_progress' || run.status === 'queued'
            ? 'pending'
            : isFailedRun(run)
              ? 'failure'
              : run.conclusion === 'success'
                ? 'success'
                : 'pending'
        groupMap.set(run.workflowName, {
          workflowName: run.workflowName,
          totalCount: 1,
          failedCount: isFailedRun(run) ? 1 : 0,
          latestStatus: status,
        })
      }
    }
    return Array.from(groupMap.values()).sort((a, b) =>
      a.workflowName.localeCompare(b.workflowName)
    )
  }, [runs])

  const displayedRuns = useMemo(() => {
    if (!selectedWorkflow) return runs
    return runs.filter(run => run.workflowName === selectedWorkflow)
  }, [runs, selectedWorkflow])

  // Reset focus when modal opens or runs change
  useEffect(() => {
    if (workflowRunsModalOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedWorkflow(null)

      setFocusedIndex(0)

      setFocusedPane('sidebar')

      setSidebarFocusedIndex(0)
      requestAnimationFrame(() => sidebarRef.current?.focus())
    }
  }, [workflowRunsModalOpen, runs.length])

  // Reset focus when filter changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedIndex(0)
  }, [selectedWorkflow])

  // Scroll focused items into view
  useEffect(() => {
    itemRefs.current[focusedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  useEffect(() => {
    sidebarItemRefs.current[sidebarFocusedIndex]?.scrollIntoView({
      block: 'nearest',
    })
  }, [sidebarFocusedIndex])

  const title = useMemo(() => {
    if (workflowRunsModalBranch) {
      return `Workflow Runs — ${workflowRunsModalBranch}`
    }
    return 'Workflow Runs'
  }, [workflowRunsModalBranch])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setWorkflowRunsModalOpen(open)
    },
    [setWorkflowRunsModalOpen]
  )

  const handleRunClick = useCallback((url: string) => {
    openExternal(url)
  }, [])

  const handleInvestigate = useCallback(
    async (run: WorkflowRun) => {
      const projectPath = workflowRunsModalProjectPath

      // Close modal immediately
      setWorkflowRunsModalOpen(false)

      // Build the investigate prompt
      const customPrompt = preferences?.magic_prompts?.investigate_workflow_run
      const template =
        customPrompt && customPrompt.trim()
          ? customPrompt
          : DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT

      const runId = extractRunId(run.url)
      const prompt = template
        .replace(/\{workflowName\}/g, run.workflowName)
        .replace(/\{runUrl\}/g, run.url)
        .replace(/\{runId\}/g, runId)
        .replace(/\{branch\}/g, run.headBranch)
        .replace(/\{displayTitle\}/g, run.displayTitle)

      // Fall back to the user's currently-selected model (like useInvestigateHandlers does)
      const storeState = useChatStore.getState()
      const currentActiveSessionId =
        storeState.activeSessionIds[storeState.activeWorktreeId ?? ''] ?? ''
      const currentModel =
        storeState.selectedModels[currentActiveSessionId] ?? 'sonnet'
      const investigateModel =
        preferences?.magic_prompt_models?.investigate_workflow_run_model ??
        currentModel
      const investigateProvider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        'investigate_workflow_run_provider',
        preferences?.default_provider
      )
      const investigateBackend = resolveBackend(investigateModel)
      const investigateCustomProfile =
        investigateProvider && investigateProvider !== '__anthropic__'
          ? preferences?.custom_cli_profiles?.find(
              p => p.name === investigateProvider
            )?.name
          : undefined

      // --- Find/create the target worktree ---
      let targetWorktreeId: string | null = null
      let targetWorktreePath: string | null = null

      if (projectPath) {
        const projects = await queryClient.fetchQuery({
          queryKey: projectsQueryKeys.list(),
          queryFn: () => invoke<Project[]>('list_projects'),
          staleTime: 1000 * 60,
        })
        const project = projects?.find(p => p.path === projectPath)

        if (project) {
          let worktrees: Worktree[] = []
          try {
            worktrees = await queryClient.fetchQuery({
              queryKey: projectsQueryKeys.worktrees(project.id),
              queryFn: () =>
                invoke<Worktree[]>('list_worktrees', {
                  projectId: project.id,
                }),
              staleTime: 1000 * 60,
            })
          } catch (err) {
            console.error('[WF-MODAL] Failed to fetch worktrees:', err)
          }

          const isUsable = (w: Worktree) => !w.status || w.status === 'ready'

          if (worktrees.length > 0) {
            const matching = worktrees.find(
              w => w.branch === run.headBranch && isUsable(w)
            )
            if (matching) {
              targetWorktreeId = matching.id
              targetWorktreePath = matching.path
            } else {
              const base = worktrees.find(w => isUsable(w))
              if (base) {
                targetWorktreeId = base.id
                targetWorktreePath = base.path
              }
            }
          }

          // No usable worktrees — create the base session
          if (!targetWorktreeId) {
            try {
              const baseSession = await invoke<Worktree>(
                'create_base_session',
                { projectId: project.id }
              )
              queryClient.invalidateQueries({
                queryKey: projectsQueryKeys.worktrees(project.id),
              })
              targetWorktreeId = baseSession.id
              targetWorktreePath = baseSession.path
            } catch (error) {
              console.error('[WF-MODAL] Failed to create base session:', error)
              toast.error(`Failed to open base session: ${error}`)
              return
            }
          }

          // Expand project in sidebar
          useProjectsStore.getState().expandProject(project.id)
        }
      }

      // Final fallback: use active worktree
      if (!targetWorktreeId || !targetWorktreePath) {
        targetWorktreeId = useChatStore.getState().activeWorktreeId
        targetWorktreePath = useChatStore.getState().activeWorktreePath
      }

      if (!targetWorktreeId || !targetWorktreePath) {
        toast.error('No worktree found for this branch')
        return
      }

      const worktreeId = targetWorktreeId
      const worktreePath = targetWorktreePath

      // Check if we're currently on the project canvas (no active worktree path)
      const { activeWorktreePath, setActiveWorktree, setActiveSession } =
        useChatStore.getState()
      const { selectWorktree } = useProjectsStore.getState()
      const isOnProjectCanvas = !activeWorktreePath

      if (isOnProjectCanvas) {
        // Stay on project canvas — just select worktree in sidebar
        selectWorktree(worktreeId)
      } else {
        // Already inside a worktree — navigate to target worktree
        setActiveWorktree(worktreeId, worktreePath)
        selectWorktree(worktreeId)
      }

      const sendInvestigateToSession = (sessionId: string) => {
        setActiveSession(worktreeId, sessionId)

        const {
          addSendingSession,
          setLastSentMessage,
          setError,
          setSelectedModel,
          setSelectedProvider,
          setSelectedBackend,
          setExecutionMode,
          setExecutingMode,
        } = useChatStore.getState()

        setLastSentMessage(sessionId, prompt)
        setError(sessionId, null)
        addSendingSession(sessionId)
        setSelectedModel(sessionId, investigateModel)
        setSelectedProvider(sessionId, investigateProvider)
        setSelectedBackend(sessionId, investigateBackend)
        setExecutionMode(sessionId, 'yolo')
        setExecutingMode(sessionId, 'yolo')

        // Persist model/backend/provider to session on disk
        setSessionBackend.mutate({
          sessionId,
          worktreeId,
          worktreePath,
          backend: investigateBackend,
        })
        setSessionModel.mutate({
          sessionId,
          worktreeId,
          worktreePath,
          model: investigateModel,
        })
        setSessionProvider.mutate({
          sessionId,
          worktreeId,
          worktreePath,
          provider: investigateProvider,
        })

        sendMessage.mutate({
          sessionId,
          worktreeId,
          worktreePath,
          message: prompt,
          model: investigateModel,
          executionMode: 'yolo',
          thinkingLevel: 'think',
          backend: investigateBackend,
          customProfileName: investigateCustomProfile,
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
        })

        // Open the session chat modal
        if (isOnProjectCanvas) {
          // On project canvas — let ProjectCanvasView auto-open the session modal overlay
          useUIStore
            .getState()
            .markWorktreeForAutoOpenSession(worktreeId, sessionId)
        } else {
          // Inside a worktree — dispatch event for ProjectCanvasView to handle
          window.dispatchEvent(
            new CustomEvent('open-session-modal', {
              detail: { sessionId },
            })
          )
        }
      }

      // Check if worktree already has an empty session we can reuse
      let existingSessions: WorktreeSessions | null = null
      try {
        existingSessions = await queryClient.fetchQuery({
          queryKey: chatQueryKeys.sessions(worktreeId),
          queryFn: () =>
            invoke<WorktreeSessions>('get_sessions', {
              worktreeId,
              worktreePath,
            }),
          staleTime: 1000 * 5,
        })
      } catch {
        // Ignore — we'll create a new session below
      }

      const emptySession = existingSessions?.sessions.find(
        s =>
          !s.archived_at && (s.message_count === 0 || s.message_count == null)
      )

      if (emptySession) {
        sendInvestigateToSession(emptySession.id)
      } else {
        createSession.mutate(
          { worktreeId, worktreePath },
          {
            onSuccess: session => {
              sendInvestigateToSession(session.id)
            },
            onError: error => {
              console.error('[WF-MODAL] Failed to create session:', error)
              toast.error(`Failed to create session: ${error}`)
            },
          }
        )
      }
    },
    [
      workflowRunsModalProjectPath,
      setWorkflowRunsModalOpen,
      queryClient,
      createSession,
      sendMessage,
      setSessionBackend,
      setSessionModel,
      setSessionProvider,
      preferences,
    ]
  )

  // Sidebar items: "All" + each group
  const sidebarItems = useMemo(() => {
    return [null, ...groups.map(g => g.workflowName)] as (string | null)[]
  }, [groups])

  const handleSidebarSelect = useCallback(
    (index: number) => {
      setSelectedWorkflow(sidebarItems[index] ?? null)
      setSidebarFocusedIndex(index)
    },
    [sidebarItems]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'r') {
        e.preventDefault()
        handleRefresh()
        return
      }
      if (focusedPane === 'sidebar') {
        switch (e.key) {
          case 'ArrowDown':
          case 'j': {
            e.preventDefault()
            const next = Math.min(
              sidebarFocusedIndex + 1,
              sidebarItems.length - 1
            )
            handleSidebarSelect(next)
            break
          }
          case 'ArrowUp':
          case 'k': {
            e.preventDefault()
            const prev = Math.max(sidebarFocusedIndex - 1, 0)
            handleSidebarSelect(prev)
            break
          }
          case 'ArrowRight':
          case 'l':
            e.preventDefault()
            setFocusedPane('list')
            setFocusedIndex(0)
            break
        }
      } else {
        switch (e.key) {
          case 'ArrowDown':
          case 'j':
            e.preventDefault()
            setFocusedIndex(i => Math.min(i + 1, displayedRuns.length - 1))
            break
          case 'ArrowUp':
          case 'k':
            e.preventDefault()
            setFocusedIndex(i => Math.max(i - 1, 0))
            break
          case 'ArrowLeft':
          case 'h':
            e.preventDefault()
            setFocusedPane('sidebar')
            break
          case 'Enter': {
            e.preventDefault()
            const run = displayedRuns[focusedIndex]
            if (run) handleRunClick(run.url)
            break
          }
          case 'm': {
            e.preventDefault()
            const run = displayedRuns[focusedIndex]
            if (run && isFailedRun(run)) handleInvestigate(run)
            break
          }
        }
      }
    },
    [
      focusedPane,
      sidebarItems,
      sidebarFocusedIndex,
      handleSidebarSelect,
      displayedRuns,
      focusedIndex,
      handleRunClick,
      handleInvestigate,
      handleRefresh,
    ]
  )

  return (
    <Dialog open={workflowRunsModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-[80vh] sm:max-w-5xl overflow-hidden flex flex-col"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>{title}</DialogTitle>
            <div className="ml-auto flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 p-0"
                    onClick={handleRefresh}
                    disabled={isFetching}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh</TooltipContent>
              </Tooltip>
              <ModalCloseButton onClick={() => handleOpenChange(false)} />
            </div>
          </div>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : runs.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No workflow runs found
          </div>
        ) : (
          <div
            ref={sidebarRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="flex min-h-0 flex-1 gap-4 outline-none"
          >
            {/* Sidebar */}
            <ScrollArea className="w-80 shrink-0">
              <div className="space-y-0.5 pr-3">
                {sidebarItems.map((workflowName, idx) => {
                  const group = workflowName
                    ? groups.find(g => g.workflowName === workflowName)
                    : null
                  return (
                    <SidebarItem
                      key={workflowName ?? '__all__'}
                      ref={el => {
                        sidebarItemRefs.current[idx] = el
                      }}
                      label={workflowName ?? 'All'}
                      count={group ? group.totalCount : runs.length}
                      latestStatus={
                        group
                          ? group.latestStatus
                          : (result?.failedCount ?? 0) > 0
                            ? 'failure'
                            : runs.length > 0
                              ? 'success'
                              : 'pending'
                      }
                      isSelected={selectedWorkflow === workflowName}
                      isFocused={
                        focusedPane === 'sidebar' && sidebarFocusedIndex === idx
                      }
                      onClick={() => {
                        setSelectedWorkflow(workflowName)
                        setSidebarFocusedIndex(idx)
                      }}
                    />
                  )
                })}
              </div>
            </ScrollArea>

            {/* Run list */}
            <div
              ref={listRef}
              className="flex-1 min-w-0 overflow-y-auto outline-none"
            >
              <div className="space-y-1 pb-2">
                {displayedRuns.map((run, index) => (
                  <div
                    key={run.databaseId}
                    ref={el => {
                      itemRefs.current[index] = el
                    }}
                    className={`group relative flex cursor-pointer items-center rounded-md px-2 py-2 transition-colors hover:bg-accent ${focusedPane === 'list' && index === focusedIndex ? 'bg-accent' : ''}`}
                    onClick={() => handleRunClick(run.url)}
                    onMouseEnter={() => {
                      setFocusedIndex(index)
                      setFocusedPane('list')
                    }}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <RunStatusIcon run={run} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">
                            {run.workflowName}
                          </span>
                          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                            {run.headBranch}
                          </span>
                          {isFailedRun(run) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={e => {
                                    e.stopPropagation()
                                    handleInvestigate(run)
                                  }}
                                  className="shrink-0 inline-flex items-center gap-0.5 rounded bg-black px-1 py-0.5 text-[10px] text-white transition-colors hover:bg-black/80 dark:bg-yellow-500/20 dark:text-yellow-400 dark:hover:bg-yellow-500/30 dark:hover:text-yellow-300"
                                >
                                  <Wand2 className="h-3 w-3" />
                                  <span>M</span>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                Investigate this failure
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="truncate">{run.displayTitle}</span>
                          <span className="shrink-0">·</span>
                          <span className="shrink-0">
                            {timeAgo(run.createdAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default WorkflowRunsModal
