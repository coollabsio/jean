import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, Eye, Maximize2, Terminal, Play } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { GitStatusBadges } from '@/components/ui/git-status-badges'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useSession } from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import { useWorktree, useProjects, useRunScript } from '@/services/projects'
import {
  useGitStatus,
  gitPull,
  gitPush,
  fetchWorktreesStatus,
  triggerImmediateGitPoll,
} from '@/services/git-status'
import { isBaseSession } from '@/types/projects'
import { isServerApp } from '@/lib/environment'
import { notify } from '@/lib/notifications'
import { toast } from 'sonner'
import { GitDiffModal } from './GitDiffModal'
import type { DiffRequest } from '@/types/git-diff'
import { ChatWindow } from './ChatWindow'
import { ModalTerminalDrawer } from './ModalTerminalDrawer'
import { OpenInButton } from '@/components/open-in/OpenInButton'

interface SessionChatModalProps {
  sessionId: string | null
  worktreeId: string
  worktreePath: string
  isOpen: boolean
  onClose: () => void
  onOpenFullView: () => void
}

export function SessionChatModal({
  sessionId,
  worktreeId,
  worktreePath,
  isOpen,
  onClose,
  onOpenFullView,
}: SessionChatModalProps) {
  const { data: session } = useSession(sessionId, worktreeId, worktreePath)
  const { data: preferences } = usePreferences()
  const { data: runScript } = useRunScript(worktreePath)
  const canvasOnlyMode = preferences?.canvas_only_mode ?? false

  // Git status for header badges
  const { data: worktree } = useWorktree(worktreeId)
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null
  const isBase = worktree ? isBaseSession(worktree) : false
  const { data: gitStatus } = useGitStatus(worktreeId)
  const behindCount =
    gitStatus?.behind_count ?? worktree?.cached_behind_count ?? 0
  const unpushedCount =
    gitStatus?.unpushed_count ?? worktree?.cached_unpushed_count ?? 0
  const uncommittedAdded =
    gitStatus?.uncommitted_added ?? worktree?.cached_uncommitted_added ?? 0
  const uncommittedRemoved =
    gitStatus?.uncommitted_removed ?? worktree?.cached_uncommitted_removed ?? 0
  const branchDiffAdded =
    gitStatus?.branch_diff_added ?? worktree?.cached_branch_diff_added ?? 0
  const branchDiffRemoved =
    gitStatus?.branch_diff_removed ?? worktree?.cached_branch_diff_removed ?? 0
  const defaultBranch = project?.default_branch ?? 'main'

  const [diffRequest, setDiffRequest] = useState<DiffRequest | null>(null)

  const hasSetActiveRef = useRef<string | null>(null)

  // Set active session synchronously before paint (useLayoutEffect) to avoid
  // ChatWindow inside the modal seeing a stale session on first render.
  // NOTE: We don't set activeWorktree - we pass it as props to ChatWindow instead
  // This prevents navigation away from WorktreeDashboard when opening modals
  useLayoutEffect(() => {
    if (isOpen && sessionId && hasSetActiveRef.current !== sessionId) {
      const { setActiveSession } = useChatStore.getState()
      // Only set the session, not the worktree (worktree is passed as props)
      setActiveSession(worktreeId, sessionId)
      hasSetActiveRef.current = sessionId
    }
  }, [isOpen, sessionId, worktreeId])

  // Reset refs when modal closes (isOpen→false without handleClose, e.g. parent state reset)
  useEffect(() => {
    if (!isOpen) {
      hasSetActiveRef.current = null
    }
  }, [isOpen])

  // Keep the modal's session as activeSessionIds[worktreeId] on close
  // so the canvas highlights the last-viewed session.
  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  const handleOpenFullView = useCallback(() => {
    onOpenFullView()
  }, [onOpenFullView])

  const handlePull = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const { setWorktreeLoading, clearWorktreeLoading } =
        useChatStore.getState()
      setWorktreeLoading(worktreeId, 'pull')
      const toastId = toast.loading('Pulling changes...')
      try {
        await gitPull(worktreePath, defaultBranch)
        triggerImmediateGitPoll()
        if (project) fetchWorktreesStatus(project.id)
        toast.success('Changes pulled', { id: toastId })
      } catch (error) {
        toast.error(`Pull failed: ${error}`, { id: toastId })
      } finally {
        clearWorktreeLoading(worktreeId)
      }
    },
    [worktreeId, worktreePath, defaultBranch, project]
  )

  const handlePush = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const toastId = toast.loading('Pushing changes...')
      try {
        await gitPush(worktreePath, worktree?.pr_number)
        triggerImmediateGitPoll()
        if (project) fetchWorktreesStatus(project.id)
        toast.success('Changes pushed', { id: toastId })
      } catch (error) {
        toast.error(`Push failed: ${error}`, { id: toastId })
      }
    },
    [worktreePath, worktree?.pr_number, project]
  )

  const handleUncommittedDiffClick = useCallback(() => {
    setDiffRequest({
      type: 'uncommitted',
      worktreePath,
      baseBranch: defaultBranch,
    })
  }, [worktreePath, defaultBranch])

  const handleBranchDiffClick = useCallback(() => {
    setDiffRequest({
      type: 'branch',
      worktreePath,
      baseBranch: defaultBranch,
    })
  }, [worktreePath, defaultBranch])

  const handleRun = useCallback(() => {
    if (!runScript) {
      notify('No run script configured in jean.json', undefined, {
        type: 'error',
      })
      return
    }
    useTerminalStore.getState().startRun(worktreeId, runScript)
    useTerminalStore.getState().setModalTerminalOpen(worktreeId, true)
  }, [worktreeId, runScript])

  if (!sessionId) return null

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && handleClose()}>
      <DialogContent
        key={sessionId}
        className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[calc(100vw-48px)] sm:!h-[calc(100vh-48px)] sm:!max-w-[calc(100vw-48px)] sm:!rounded-lg flex flex-col p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0 border-b px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 sm:hidden"
                onClick={handleClose}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <DialogTitle className="text-sm font-medium">
                {session?.name ?? 'Session'}
              </DialogTitle>
              <GitStatusBadges
                behindCount={behindCount}
                unpushedCount={unpushedCount}
                diffAdded={uncommittedAdded}
                diffRemoved={uncommittedRemoved}
                branchDiffAdded={isBase ? 0 : branchDiffAdded}
                branchDiffRemoved={isBase ? 0 : branchDiffRemoved}
                onPull={handlePull}
                onPush={handlePush}
                onDiffClick={handleUncommittedDiffClick}
                onBranchDiffClick={handleBranchDiffClick}
              />
            </div>
            <div className="flex items-center gap-1">
              {isServerApp() && (
                <>
                  <OpenInButton worktreePath={worktreePath} branch={worktree?.branch} />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          const { reviewResults, toggleReviewSidebar } = useChatStore.getState()
                          // Check both Zustand store and session data for review results
                          const hasReviewResults = sessionId && (reviewResults[sessionId] || session?.review_results)
                          if (hasReviewResults) {
                            // If results exist in Zustand, open sidebar; otherwise restore from session data first
                            if (!reviewResults[sessionId] && session?.review_results) {
                              useChatStore.getState().setReviewResults(sessionId, session.review_results)
                            }
                            toggleReviewSidebar()
                          } else {
                            window.dispatchEvent(
                              new CustomEvent('magic-command', { detail: { command: 'review', sessionId } })
                            )
                          }
                        }}
                      >
                        <Eye className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Review</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          useTerminalStore
                            .getState()
                            .toggleModalTerminal(worktreeId)
                        }}
                      >
                        <Terminal className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Terminal</TooltipContent>
                  </Tooltip>
                  {runScript && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={handleRun}
                        >
                          <Play className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Run</TooltipContent>
                    </Tooltip>
                  )}
                </>
              )}
              {!canvasOnlyMode && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={handleOpenFullView}
                >
                  <Maximize2 className="mr-1 h-3 w-3" />
                  Open Full View
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          {/* Key forces ChatWindow remount when sessionId changes, ensuring fresh state */}
          {/* Pass worktreeId/worktreePath as props to avoid setting global store state */}
          <ChatWindow
            key={sessionId}
            isModal
            worktreeId={worktreeId}
            worktreePath={worktreePath}
          />
        </div>

        {/* Terminal side drawer */}
        {isServerApp() && (
          <ModalTerminalDrawer
            worktreeId={worktreeId}
            worktreePath={worktreePath}
          />
        )}
        {diffRequest && (
          <GitDiffModal
            diffRequest={diffRequest}
            onClose={() => setDiffRequest(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
