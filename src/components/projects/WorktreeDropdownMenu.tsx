import {
  Activity,
  Archive,
  AlertCircle,
  CircleDot,
  Code,
  FolderOpen,
  GitBranch,
  GitPullRequestArrow,
  Globe,
  MoreHorizontal,
  Play,
  Plus,
  Settings,
  ShieldAlert,
  Star,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useMemo } from 'react'
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
import { ghCliQueryKeys, useGhCliAuth } from '@/services/gh-cli'
import {
  useDependabotAlerts,
  useGitHubIssues,
  useGitHubPRs,
  useRepositoryAdvisories,
  useWorkflowRuns,
} from '@/services/github'
import {
  canOpenInEditor,
  canOpenNativeApps,
  isNativeApp,
} from '@/lib/environment'
import { cn } from '@/lib/utils'
import { usePatchPreferences } from '@/services/preferences'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { countUnreadFailedWorkflowRuns } from '@/components/shared/workflow-run-utils'
import type { GhAuthStatus } from '@/types/gh-cli'
import type { PackageScript } from '@/services/projects'
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
  onToggleTerminal?: () => void
  onToggleBrowser?: () => void
  packageScripts?: PackageScript[]
  onRunPackageScript?: (script: PackageScript) => void
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
  onToggleTerminal,
  onToggleBrowser,
  packageScripts = [],
  onRunPackageScript,
}: WorktreeDropdownMenuProps) {
  const queryClient = useQueryClient()
  const {
    showDeleteConfirm,
    setShowDeleteConfirm,
    isBase,
    runScripts,
    preferences,
    handleRun,
    handleRunCommand,
    handleOpenInFinder,
    handleOpenInTerminal,
    handleOpenInEditor,
    handleArchiveOrClose,
    handleDelete,
  } = useWorktreeMenuActions({ worktree, projectId })
  const isMobile = useIsMobile()
  const patchPreferences = usePatchPreferences()
  const favoriteKeys = preferences?.favorite_package_scripts ?? []
  const favoritePrefix = `${projectId}:`
  const favoriteScriptNames = new Set(
    favoriteKeys.flatMap(key =>
      key.startsWith(favoritePrefix) ? [key.slice(favoritePrefix.length)] : []
    )
  )
  const sortedPackageScripts = [...packageScripts].sort(
    (a, b) =>
      Number(favoriteScriptNames.has(b.name)) -
      Number(favoriteScriptNames.has(a.name))
  )
  const showPackageScripts = !isNativeApp() && !isMobile

  const togglePackageScriptFavorite = (scriptName: string) => {
    const key = `${projectId}:${scriptName}`
    patchPreferences.mutate({
      favorite_package_scripts: favoriteKeys.includes(key)
        ? favoriteKeys.filter(favorite => favorite !== key)
        : [...favoriteKeys, key],
    })
  }
  // On native desktop the auth query runs in App.tsx; on web/mobile access it doesn't.
  // Trigger it here on mobile so counts populate without depending on cache.
  useGhCliAuth({ enabled: isMobile })
  const authData = queryClient.getQueryData<GhAuthStatus>(ghCliQueryKeys.auth())
  const isGitHubAuthenticated = authData?.authenticated ?? false
  const { data: issueResult } = useGitHubIssues(projectPath, 'open', {
    enabled: isGitHubAuthenticated || projectId.includes(':'),
    staleTime: BADGE_STALE_TIME,
    ownerId: projectId,
  })
  const { data: prs } = useGitHubPRs(projectPath, 'open', {
    enabled: isGitHubAuthenticated || projectId.includes(':'),
    staleTime: BADGE_STALE_TIME,
    ownerId: projectId,
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
  const seenFailedWorkflowRunIds = useUIStore(
    state => state.seenFailedWorkflowRunIds
  )
  const issueCount = issueResult?.totalCount ?? 0
  const prCount = prs?.length ?? 0
  const securityCount =
    (alerts?.length ?? 0) +
    (advisories?.filter(a => a.state === 'draft' || a.state === 'triage')
      .length ?? 0)
  const workflowRunCount = workflowRuns?.runs?.length ?? 0
  const failedWorkflowCount = useMemo(
    () =>
      countUnreadFailedWorkflowRuns(
        workflowRuns?.runs ?? [],
        seenFailedWorkflowRunIds
      ),
    [workflowRuns?.runs, seenFailedWorkflowRunIds]
  )
  const hasDiff = uncommittedAdded > 0 || uncommittedRemoved > 0
  const hasBranchDiff = branchDiffAdded > 0 || branchDiffRemoved > 0
  const showMobileGitHubItems = isMobile

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
            aria-label="Actions"
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

          {!isMobile && runScripts.length === 1 && (
            <DropdownMenuItem onClick={handleRun}>
              <Play className="mr-2 h-4 w-4" />
              Run
            </DropdownMenuItem>
          )}
          {!isMobile && runScripts.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Play className="mr-4 h-4 w-4" />
                Run
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {runScripts.map(cmd => (
                  <DropdownMenuItem
                    key={cmd}
                    onSelect={() => handleRunCommand(cmd)}
                    className="font-mono text-xs"
                  >
                    {cmd}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {!isMobile && onToggleTerminal && (
            <DropdownMenuItem onClick={onToggleTerminal}>
              <Terminal className="mr-2 h-4 w-4" />
              Terminal
            </DropdownMenuItem>
          )}

          {onToggleBrowser && (
            <DropdownMenuItem onClick={onToggleBrowser}>
              <Globe className="mr-2 h-4 w-4" />
              Browser
            </DropdownMenuItem>
          )}

          {showPackageScripts &&
            packageScripts.length > 0 &&
            onRunPackageScript && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Play className="mr-4 h-4 w-4" />
                  Scripts
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 min-w-48 overflow-y-auto">
                  {sortedPackageScripts.map(script => (
                    <DropdownMenuItem
                      key={script.name}
                      onSelect={() => onRunPackageScript(script)}
                    >
                      <Play className="h-3.5 w-3.5" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {script.name}
                      </span>
                      <button
                        type="button"
                        className="-my-1 -mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`${favoriteScriptNames.has(script.name) ? 'Unfavorite' : 'Favorite'} ${script.name}`}
                        aria-pressed={favoriteScriptNames.has(script.name)}
                        onPointerDown={event => {
                          event.preventDefault()
                          event.stopPropagation()
                          togglePackageScriptFavorite(script.name)
                        }}
                        onClick={event => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (event.detail === 0) {
                            togglePackageScriptFavorite(script.name)
                          }
                        }}
                      >
                        <Star
                          className={cn(
                            'h-3.5 w-3.5',
                            favoriteScriptNames.has(script.name) &&
                              'fill-yellow-500 text-yellow-500'
                          )}
                        />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

          <DropdownMenuItem
            onClick={() =>
              useProjectsStore.getState().openProjectSettings(projectId)
            }
          >
            <Settings className="mr-2 h-4 w-4" />
            Project Settings
          </DropdownMenuItem>

          <DropdownMenuSeparator />

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

          <DropdownMenuItem onClick={handleOpenIssues}>
            <CircleDot className="mr-2 h-4 w-4 text-green-600" />
            {issueCount > 0 ? `${issueCount} Issues` : 'Issues'}
          </DropdownMenuItem>

          <DropdownMenuItem onClick={handleOpenPRs}>
            <GitPullRequestArrow className="mr-2 h-4 w-4 text-blue-600" />
            {prCount > 0 ? `${prCount} Pull Requests` : 'Pull Requests'}
          </DropdownMenuItem>

          <DropdownMenuItem onClick={handleOpenWorkflowRuns}>
            {failedWorkflowCount > 0 ? (
              <AlertCircle className="mr-2 h-4 w-4 text-red-600" />
            ) : (
              <Activity className="mr-2 h-4 w-4" />
            )}
            {failedWorkflowCount > 0
              ? `${failedWorkflowCount} Failed Workflows`
              : workflowRunCount > 0
                ? `${workflowRunCount} Workflows`
                : 'Workflows'}
          </DropdownMenuItem>

          {(showMobileGitHubItems || securityCount > 0) && (
            <DropdownMenuItem onClick={handleOpenSecurity}>
              <ShieldAlert className="mr-2 h-4 w-4 text-orange-600" />
              {securityCount > 0 ? `${securityCount} Security` : 'Security'}
            </DropdownMenuItem>
          )}

          {(canOpenInEditor() || canOpenNativeApps()) && (
            <DropdownMenuSeparator />
          )}

          {canOpenInEditor() && (
            <DropdownMenuItem onClick={handleOpenInEditor}>
              <Code className="mr-2 h-4 w-4" />
              Open in {getEditorLabel(preferences?.editor)}
            </DropdownMenuItem>
          )}

          {canOpenNativeApps() && (
            <DropdownMenuItem onClick={handleOpenInFinder}>
              <FolderOpen className="mr-2 h-4 w-4" />
              Open in Finder
            </DropdownMenuItem>
          )}

          {canOpenNativeApps() && (
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
              className="bg-destructive text-white hover:bg-destructive/90"
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
