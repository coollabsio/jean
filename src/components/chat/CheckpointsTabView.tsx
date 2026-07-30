import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  History,
  Loader2,
  RotateCcw,
  Trash2,
  FileText,
  ChevronRight,
} from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  parsePatchFiles,
  type FileDiffMetadata,
  type SelectedLineRange,
} from '@pierre/diffs'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getFilename } from '@/lib/path-utils'
import { getFileLineStats } from '@/lib/diff-stats'
import { useTheme } from '@/hooks/use-theme'
import { usePreferences } from '@/services/preferences'
import { triggerImmediateGitPoll } from '@/services/git-status'
import {
  checkpointQueryKeys,
  deleteAiCheckpoint,
  getAiCheckpointDiff,
  listAiCheckpoints,
  restoreAiCheckpoint,
  restoreAiCheckpointFile,
} from '@/services/checkpoints'
import { MemoizedFileDiff, getStatusColor } from './MemoizedFileDiff'
import type { AiCheckpoint } from '@/types/checkpoints'
import type { GitDiff } from '@/types/git-diff'

const NOOP_LINE_SELECTED = (_range: SelectedLineRange | null) => {}
const NOOP_REMOVE_COMMENT = (_id: string) => {}
const EMPTY_ANNOTATIONS: never[] = []

function formatRelativeTime(unixSecs: number): string {
  const diff = Date.now() - unixSecs * 1000
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(unixSecs * 1000).toLocaleDateString()
}

function statusLabel(status: AiCheckpoint['status']): string {
  switch (status) {
    case 'open':
      return 'In progress'
    case 'finalized':
      return 'Ready'
    case 'restored':
      return 'Restored'
    default:
      return status
  }
}

interface FlatFile {
  key: string
  fileName: string
  fileDiff: FileDiffMetadata
  additions: number
  deletions: number
}

interface CheckpointsTabViewProps {
  worktreeId: string
  worktreePath: string
  diffStyle: 'split' | 'unified'
  /** Pre-select a checkpoint (e.g. from a message restore action). */
  initialCheckpointId?: string | null
}

/**
 * Browse AI change checkpoints for a worktree: view turn diffs, restore
 * individual files, or restore the entire project to a prior snapshot.
 */
export function CheckpointsTabView({
  worktreeId,
  worktreePath,
  diffStyle,
  initialCheckpointId,
}: CheckpointsTabViewProps) {
  const queryClient = useQueryClient()
  const { theme } = useTheme()
  const { data: preferences } = usePreferences()
  const [selectedId, setSelectedId] = useState<string | null>(
    initialCheckpointId ?? null
  )
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [restoreAllTarget, setRestoreAllTarget] = useState<AiCheckpoint | null>(
    null
  )
  const [restoring, setRestoring] = useState(false)
  const [restoringFile, setRestoringFile] = useState<string | null>(null)

  const resolvedThemeType = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  const {
    data: checkpoints = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: checkpointQueryKeys.worktree(worktreeId),
    queryFn: () => listAiCheckpoints(worktreeId),
    staleTime: 5_000,
  })

  useEffect(() => {
    if (checkpoints.length === 0) {
      setSelectedId(null)
      return
    }
    if (selectedId && checkpoints.some(c => c.id === selectedId)) return
    if (
      initialCheckpointId &&
      checkpoints.some(c => c.id === initialCheckpointId)
    ) {
      setSelectedId(initialCheckpointId)
      return
    }
    setSelectedId(checkpoints[0]?.id ?? null)
  }, [checkpoints, selectedId, initialCheckpointId])

  const selected = useMemo(
    () => checkpoints.find(c => c.id === selectedId) ?? null,
    [checkpoints, selectedId]
  )

  const loadDiff = useCallback(
    async (checkpoint: AiCheckpoint) => {
      setDiffLoading(true)
      setDiffError(null)
      setSelectedFileIndex(0)
      try {
        const scope =
          checkpoint.status === 'open' || !checkpoint.endCommit
            ? 'current'
            : 'turn'
        const result = await getAiCheckpointDiff(
          worktreeId,
          checkpoint.id,
          scope
        )
        setDiff(result)
      } catch (e) {
        setDiff(null)
        setDiffError(String(e))
      } finally {
        setDiffLoading(false)
      }
    },
    [worktreeId]
  )

  useEffect(() => {
    if (selected) {
      void loadDiff(selected)
    } else {
      setDiff(null)
    }
  }, [selected, loadDiff])

  const flattenedFiles: FlatFile[] = useMemo(() => {
    if (!diff?.raw_patch) return []
    try {
      const parsed = parsePatchFiles(diff.raw_patch)
      return parsed.flatMap((patch, patchIndex) =>
        patch.files.map((fileDiff, fileIndex) => {
          const fileName = fileDiff.name || fileDiff.prevName || 'unknown'
          const { additions, deletions } = getFileLineStats(
            fileDiff,
            diff.files
          )
          return {
            key: `${patchIndex}-${fileIndex}`,
            fileName,
            fileDiff,
            additions,
            deletions,
          }
        })
      )
    } catch {
      return []
    }
  }, [diff])

  const selectedFile =
    flattenedFiles.length > 0
      ? flattenedFiles[
          Math.min(selectedFileIndex, flattenedFiles.length - 1)
        ]
      : null

  const handleRestoreAll = useCallback(async () => {
    if (!restoreAllTarget) return
    setRestoring(true)
    try {
      await restoreAiCheckpoint(worktreeId, restoreAllTarget.id)
      toast.success('Project restored to checkpoint')
      triggerImmediateGitPoll()
      await queryClient.invalidateQueries({
        queryKey: checkpointQueryKeys.worktree(worktreeId),
      })
      await loadDiff(restoreAllTarget)
    } catch (e) {
      toast.error(`Restore failed: ${e}`)
    } finally {
      setRestoring(false)
      setRestoreAllTarget(null)
    }
  }, [restoreAllTarget, worktreeId, queryClient, loadDiff])

  const handleRestoreFile = useCallback(
    async (filePath: string) => {
      if (!selected) return
      setRestoringFile(filePath)
      try {
        await restoreAiCheckpointFile(worktreeId, selected.id, filePath)
        toast.success(`Restored ${getFilename(filePath)}`)
        triggerImmediateGitPoll()
        await loadDiff(selected)
      } catch (e) {
        toast.error(`Restore failed: ${e}`)
      } finally {
        setRestoringFile(null)
      }
    },
    [selected, worktreeId, loadDiff]
  )

  const handleDelete = useCallback(
    async (checkpoint: AiCheckpoint) => {
      try {
        await deleteAiCheckpoint(worktreeId, checkpoint.id)
        toast.success('Checkpoint deleted')
        if (selectedId === checkpoint.id) setSelectedId(null)
        await queryClient.invalidateQueries({
          queryKey: checkpointQueryKeys.worktree(worktreeId),
        })
      } catch (e) {
        toast.error(`Delete failed: ${e}`)
      }
    },
    [worktreeId, selectedId, queryClient]
  )

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading checkpoints…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-5 w-5 text-destructive" />
        <span>Failed to load checkpoints</span>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  if (checkpoints.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
        <History className="h-8 w-8 opacity-40" />
        <p className="font-medium text-foreground">No AI checkpoints yet</p>
        <p className="max-w-sm text-xs">
          Jean automatically snapshots this worktree before each agent turn so
          you can review AI changes and restore any previous state.
        </p>
      </div>
    )
  }

  return (
    <>
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 min-h-0 mt-2"
      >
        <ResizablePanel defaultSize={28} minSize={18} maxSize={45}>
          <div className="flex h-full flex-col border-r border-border">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              <History className="h-3.5 w-3.5" />
              AI Checkpoints
              <span className="ml-auto tabular-nums">{checkpoints.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {checkpoints.map(cp => {
                const isActive = cp.id === selectedId
                const fileCount =
                  cp.filesChanged.length > 0
                    ? cp.filesChanged.length
                    : undefined
                return (
                  <button
                    key={cp.id}
                    type="button"
                    onClick={() => setSelectedId(cp.id)}
                    className={cn(
                      'flex w-full flex-col gap-1 border-b border-border/50 px-3 py-2.5 text-left transition-colors',
                      isActive ? 'bg-accent/60' : 'hover:bg-muted/50'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <ChevronRight
                        className={cn(
                          'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                          isActive && 'rotate-90 text-foreground'
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-xs font-medium leading-snug">
                          {cp.userMessagePreview || 'Agent turn'}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                          <span>{formatRelativeTime(cp.createdAt)}</span>
                          <span className="opacity-50">·</span>
                          <span>{statusLabel(cp.status)}</span>
                          {fileCount != null && (
                            <>
                              <span className="opacity-50">·</span>
                              <span>
                                {fileCount} file{fileCount === 1 ? '' : 's'}
                              </span>
                            </>
                          )}
                          {(cp.totalAdditions > 0 ||
                            cp.totalDeletions > 0) && (
                            <>
                              <span className="text-green-500">
                                +{cp.totalAdditions}
                              </span>
                              <span className="text-red-500">
                                -{cp.totalDeletions}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={72} minSize={40}>
          <div className="flex h-full min-h-0 flex-col">
            {selected && (
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">
                    {selected.userMessagePreview || 'Agent turn'}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Snapshot {selected.startCommit.slice(0, 7)}
                    {selected.endCommit
                      ? ` → ${selected.endCommit.slice(0, 7)}`
                      : ' → working tree'}
                    {' · '}
                    {worktreePath.split('/').pop()}
                  </p>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => setRestoreAllTarget(selected)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Restore all
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Reset the entire worktree to this checkpoint
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground"
                      onClick={() => void handleDelete(selected)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete checkpoint</TooltipContent>
                </Tooltip>
              </div>
            )}

            {diffLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading diff…
              </div>
            ) : diffError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <AlertCircle className="h-5 w-5 text-destructive" />
                {diffError}
              </div>
            ) : flattenedFiles.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-6 w-6 opacity-40" />
                No file changes in this checkpoint
              </div>
            ) : (
              <ResizablePanelGroup
                direction="horizontal"
                className="min-h-0 flex-1"
              >
                <ResizablePanel defaultSize={30} minSize={18} maxSize={50}>
                  <div className="h-full overflow-y-auto border-r border-border">
                    {flattenedFiles.map((file, idx) => (
                      <div
                        key={file.key}
                        className={cn(
                          'flex items-center gap-1 border-b border-border/40 px-2 py-1.5 text-xs',
                          idx === selectedFileIndex
                            ? 'bg-accent/50'
                            : 'hover:bg-muted/40'
                        )}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left font-mono"
                          onClick={() => setSelectedFileIndex(idx)}
                        >
                          <FileText
                            className={cn(
                              'mr-1.5 inline h-3 w-3',
                              getStatusColor(file.fileDiff.type)
                            )}
                          />
                          {getFilename(file.fileName)}
                          {(file.additions > 0 || file.deletions > 0) && (
                            <span className="ml-1.5 font-sans text-[10px] text-muted-foreground">
                              <span className="text-green-500">
                                +{file.additions}
                              </span>
                              <span className="mx-0.5">/</span>
                              <span className="text-red-500">
                                -{file.deletions}
                              </span>
                            </span>
                          )}
                        </button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                              disabled={restoringFile === file.fileName}
                              onClick={() =>
                                void handleRestoreFile(file.fileName)
                              }
                              aria-label={`Restore ${file.fileName}`}
                            >
                              {restoringFile === file.fileName ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3 w-3" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            Restore this file from checkpoint
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    ))}
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={70} minSize={40}>
                  <div className="h-full min-w-0 overflow-y-auto">
                    {selectedFile ? (
                      <div className="px-2">
                        <MemoizedFileDiff
                          key={selectedFile.key}
                          fileDiff={selectedFile.fileDiff}
                          fileName={selectedFile.fileName}
                          annotations={EMPTY_ANNOTATIONS}
                          selectedLines={null}
                          themeType={resolvedThemeType}
                          syntaxThemeDark={
                            preferences?.syntax_theme_dark ?? 'vitesse-black'
                          }
                          syntaxThemeLight={
                            preferences?.syntax_theme_light ?? 'github-light'
                          }
                          diffStyle={diffStyle}
                          enableLineSelection={false}
                          onLineSelected={NOOP_LINE_SELECTED}
                          onRemoveComment={NOOP_REMOVE_COMMENT}
                        />
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        Select a file
                      </div>
                    )}
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <AlertDialog
        open={!!restoreAllTarget}
        onOpenChange={open => !open && setRestoreAllTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore entire project?</AlertDialogTitle>
            <AlertDialogDescription>
              This resets the worktree to the state before this AI turn. All
              later uncommitted changes will be lost (including files created
              after the checkpoint).
              {restoreAllTarget?.userMessagePreview && (
                <span className="mt-2 block font-medium text-foreground">
                  “{restoreAllTarget.userMessagePreview}”
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={e => {
                e.preventDefault()
                void handleRestoreAll()
              }}
              disabled={restoring}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {restoring ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Restoring…
                </>
              ) : (
                'Restore all'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
