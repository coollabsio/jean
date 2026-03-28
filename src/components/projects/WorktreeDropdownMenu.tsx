import {
  Activity,
  Archive,
  AlertCircle,
  CircleDot,
  Code,
  FileJson,
  FolderOpen,
  GitBranch,
  GitPullRequestArrow,
  MoreHorizontal,
  Play,
  Plus,
  Settings,
  ShieldAlert,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import type { Worktree } from '@/types/projects'
import { getEditorLabel, getTerminalLabel } from '@/types/preferences'
import { ghCliQueryKeys } from '@/services/gh-cli'
import {
  useDependabotAlerts,
  useGitHubIssues,
  useGitHubPRs,
  useRepositoryAdvisories,
  useWorkflowRuns,
} from '@/services/github'
import { isNativeApp } from '@/lib/environment'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import type { GhAuthStatus } from '@/types/gh-cli'
import { useWorktreeMenuActions } from './useWorktreeMenuActions'

interface WorktreeDropdownMenuProps {
  worktree: Worktree
  projectId: string
  projectPath: string
  uncommittedAdded?: number
  uncommittedRemoved?: number
  branchDiffAdded?: number
  branchDiffRemoved?: number
  onUncommittedDiffClick?: () => void
  onBranchDiffClick?: () => void
}

const BADGE_STALE_TIME = 5 * 60 * 1000

export function WorktreeDropdownMenu({
  worktree,
  projectId,
  projectPath,
  uncommittedAdded = 0,
  uncommittedRemoved = 0,
  branchDiffAdded = 0,
  branchDiffRemoved = 0,
  onUncommittedDiffClick,
  onBranchDiffClick,
}: WorktreeDropdownMenuProps) {
  const queryClient = useQueryClient()
  const {
    showDeleteConfirm,
    setShowDeleteConfirm,
    isBase,
    hasMessages,
    runScripts,
    preferences,
    handleRun,
    handleRunCommand,
    handleOpenInFinder,
    handleOpenInTerminal,
    handleOpenInEditor,
    handleArchiveOrClose,
    handleDelete,
    handleOpenJeanConfig,
    handleGenerateRecap,
  } = useWorktreeMenuActions({ worktree, projectId })
  const authData = queryClient.getQueryData<GhAuthStatus>(ghCliQueryKeys.auth())
  const isGitHubAuthenticated = authData?.authenticated ?? false
  const { data: issueResult } = useGitHubIssues(projectPath, 'open', {
    enabled: isGitHubAuthenticated,
    staleTime: BADGE_STALE_TIME,
  })
  const { data: prs } = useGitHubPRs(projectPath, 'open', {
    enabled: isGitHubAuthenticated,
    staleTime: BADGE_STALE_TIME,
  })
  const { data: alerts } = useDependabotAlerts(projectPath, 'open', {
    enabled: isGitHubAuthenticated,
    staleTime: BADGE_STALE_TIME,
  })
  const { data: advisories } = useRepositoryAdvisories(projectPath, undefined, {
    enabled: isGitHubAuthenticated,
    staleTime: BADGE_STALE_TIME,
  })
  const { data: workflowRuns } = useWorkflowRuns(projectPath, undefined, {
    enabled: isGitHubAuthenticated,
    staleTime: BADGE_STALE_TIME,
  })
  const issueCount = issueResult?.totalCount ?? 0
  const prCount = prs?.length ?? 0
  const securityCount =
    (alerts?.length ?? 0) +
    (advisories?.filter(a => a.state === 'draft' || a.state === 'triage')
      .length ?? 0)
  const workflowRunCount = workflowRuns?.runs.length ?? 0
  const failedWorkflowCount = workflowRuns?.failedCount ?? 0
  const isMobile = useIsMobile()
  const hasDiff = uncommittedAdded > 0 || uncommittedRemoved > 0
  const hasBranchDiff = branchDiffAdded > 0 || branchDiffRemoved > 0
  const hasGitHubStatusItems =
    (isMobile && (issueCount > 0 || prCount > 0)) ||
    securityCount > 0 ||
    workflowRunCount > 0 ||
    (isMobile && (hasDiff || hasBranchDiff))

  const handleOpenIssues = useCallback(() => {
    useProjectsStore.getState().selectProject(projectId)
    const { setNewWorktreeModalDefaultTab, setNewWorktreeModalOpen } =
      useUIStore.getState()
    setNewWorktreeModalDefaultTab('issues')
    setNewWorktreeModalOpen(true)
  }, [projectId])

  const handleOpenPRs = useCallback(() => {
    useProjectsStore.getState().selectProject(projectId)
    const { setNewWorktreeModalDefaultTab, setNewWorktreeModalOpen } =
      useUIStore.getState()
    setNewWorktreeModalDefaultTab('prs')
    setNewWorktreeModalOpen(true)
  }, [projectId])

  const handleOpenSecurity = useCallback(() => {
    useProjectsStore.getState().selectProject(projectId)
    const { setNewWorktreeModalDefaultTab, setNewWorktreeModalOpen } =
      useUIStore.getState()
    setNewWorktreeModalDefaultTab('security')
    setNewWorktreeModalOpen(true)
  }, [projectId])

  const handleOpenWorkflowRuns = useCallback(() => {
    useUIStore.getState().setWorkflowRunsModalOpen(true, projectPath)
  }, [projectPath])

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={e => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem
            onClick={() =>
              window.dispatchEvent(new CustomEvent('create-new-session'))
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            New Session
          </DropdownMenuItem>

          {isNativeApp() && runScripts.length === 1 && (
            <DropdownMenuItem onClick={handleRun}>
              <Play className="mr-2 h-4 w-4" />
              Run
            </DropdownMenuItem>
          )}
          {isNativeApp() && runScripts.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Play className="mr-4 h-4 w-4" />
                Run
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {runScripts.map((cmd, i) => (
                  <DropdownMenuItem
                    key={i}
                    onSelect={() => handleRunCommand(cmd)}
                    className="font-mono text-xs"
                  >
                    {cmd}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <DropdownMenuItem onClick={handleOpenJeanConfig}>
            <FileJson className="mr-2 h-4 w-4" />
            Edit jean.json
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() =>
              useProjectsStore.getState().openProjectSettings(projectId)
            }
          >
            <Settings className="mr-2 h-4 w-4" />
            Project Settings
          </DropdownMenuItem>

          {hasMessages && (
            <DropdownMenuItem onClick={handleGenerateRecap}>
              <Sparkles className="mr-2 h-4 w-4" />
              Generate Recap
            </DropdownMenuItem>
          )}

          {hasGitHubStatusItems && <DropdownMenuSeparator />}

          {isMobile && hasDiff && (
            <DropdownMenuItem onClick={onUncommittedDiffClick}>
              <GitBranch className="mr-2 h-4 w-4" />
              <span>Git</span>
              <span className="ml-auto text-xs">
                <span className="text-green-500">+{uncommittedAdded}</span>{' '}
                <span className="text-red-500">-{uncommittedRemoved}</span>
              </span>
            </DropdownMenuItem>
          )}

          {isMobile && hasBranchDiff && (
            <DropdownMenuItem onClick={onBranchDiffClick}>
              <GitBranch className="mr-2 h-4 w-4" />
              <span>Branch diff</span>
              <span className="ml-auto text-xs">
                <span className="text-green-500">+{branchDiffAdded}</span>
                {' / '}
                <span className="text-red-500">-{branchDiffRemoved}</span>
              </span>
            </DropdownMenuItem>
          )}

          {isMobile && issueCount > 0 && (
            <DropdownMenuItem onClick={handleOpenIssues}>
              <CircleDot className="mr-2 h-4 w-4 text-green-600" />
              {issueCount} Open Issue{issueCount === 1 ? '' : 's'}
            </DropdownMenuItem>
          )}

          {isMobile && prCount > 0 && (
            <DropdownMenuItem onClick={handleOpenPRs}>
              <GitPullRequestArrow className="mr-2 h-4 w-4 text-blue-600" />
              {prCount} Open PR{prCount === 1 ? '' : 's'}
            </DropdownMenuItem>
          )}

          {securityCount > 0 && (
            <DropdownMenuItem onClick={handleOpenSecurity}>
              <ShieldAlert className="mr-2 h-4 w-4 text-orange-600" />
              {securityCount} Security Alert{securityCount === 1 ? '' : 's'}
            </DropdownMenuItem>
          )}

          {workflowRunCount > 0 && (
            <DropdownMenuItem onClick={handleOpenWorkflowRuns}>
              {failedWorkflowCount > 0 ? (
                <AlertCircle className="mr-2 h-4 w-4 text-red-600" />
              ) : (
                <Activity className="mr-2 h-4 w-4" />
              )}
              {failedWorkflowCount > 0
                ? `${failedWorkflowCount} Failed Workflow Run${failedWorkflowCount === 1 ? '' : 's'}`
                : 'Workflow Runs'}
            </DropdownMenuItem>
          )}

          {isNativeApp() && <DropdownMenuSeparator />}

          {isNativeApp() && (
            <DropdownMenuItem onClick={handleOpenInEditor}>
              <Code className="mr-2 h-4 w-4" />
              Open in {getEditorLabel(preferences?.editor)}
            </DropdownMenuItem>
          )}

          {isNativeApp() && (
            <DropdownMenuItem onClick={handleOpenInFinder}>
              <FolderOpen className="mr-2 h-4 w-4" />
              Open in Finder
            </DropdownMenuItem>
          )}

          {isNativeApp() && (
            <DropdownMenuItem onClick={handleOpenInTerminal}>
              <Terminal className="mr-2 h-4 w-4" />
              Open in {getTerminalLabel(preferences?.terminal)}
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={handleArchiveOrClose}>
            {isBase ? (
              <>
                <X className="mr-2 h-4 w-4" />
                Close Session
              </>
            ) : (
              <>
                <Archive className="mr-2 h-4 w-4" />
                Archive Worktree
              </>
            )}
          </DropdownMenuItem>

          {!isBase && (
            <DropdownMenuItem onClick={() => setShowDeleteConfirm(true)}>
              <Trash2 className="mr-2 h-4 w-4 text-destructive" />
              Delete Worktree
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              handleDelete()
              setShowDeleteConfirm(false)
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Worktree</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the worktree, its branch, and all
              associated sessions. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              autoFocus
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
              <kbd className="ml-1.5 text-xs opacity-70">↵</kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
