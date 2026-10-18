import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  History,
  Loader2,
  RotateCcw,
  Trash2,
  FileText,
  ChevronRight,
  ChevronLeft,
  ChevronsUpDown,
  X,
} from '@/components/icons/reicon'
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
import { useIsMobile } from '@/hooks/use-mobile'
import { usePreferences } from '@/services/preferences'
import { triggerImmediateGitPoll } from '@/services/git-status'
import {
  checkpointQueryKeys,
  deleteAiCheckpoint,
  getAiCheckpointDiff,
  listAiCheckpoints,
  restoreAiCheckpointFile,
} from '@/services/checkpoints'
import { MemoizedFileDiff, getStatusColor } from './MemoizedFileDiff'
import { CheckpointRestoreDialog } from './CheckpointRestoreDialog'
import type { AiCheckpoint } from '@/types/checkpoints'
import type { GitDiff } from '@/types/git-diff'

// eslint-disable-next-line @typescript-eslint/no-empty-function
const NOOP_LINE_SELECTED = (_range: SelectedLineRange | null) => {}
// eslint-disable-next-line @typescript-eslint/no-empty-function
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
  const isMobile = useIsMobile()
  const { data: preferences } = usePreferences()
  const [selectedId, setSelectedId] = useState<string | null>(
    initialCheckpointId ?? null
  )
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [restoreTarget, setRestoreTarget] = useState<AiCheckpoint | null>(null)
  const [restoringFile, setRestoringFile] = useState<string | null>(null)
  const [fileRestoreTarget, setFileRestoreTarget] = useState<string | null>(
    null
  )
  const [fileRestoring, setFileRestoring] = useState(false)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(
    Boolean(initialCheckpointId)
  )
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false)

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
      ? flattenedFiles[Math.min(selectedFileIndex, flattenedFiles.length - 1)]
      : null

  const openRestoreDialog = useCallback((checkpoint: AiCheckpoint) => {
    setRestoreTarget(checkpoint)
  }, [])

  const handleRestoreDialogOpenChange = useCallback((open: boolean) => {
    if (!open) setRestoreTarget(null)
  }, [])

  const handleRestored = useCallback(async () => {
    if (selected) await loadDiff(selected)
  }, [selected, loadDiff])

  const handleApproveFileRestore = useCallback(async () => {
    if (!selected || !fileRestoreTarget) return
    setFileRestoring(true)
    setRestoringFile(fileRestoreTarget)
    try {
      await restoreAiCheckpointFile(worktreeId, selected.id, fileRestoreTarget)
      toast.success(`Restored ${getFilename(fileRestoreTarget)}`)
      triggerImmediateGitPoll()
      await loadDiff(selected)
      setFileRestoreTarget(null)
    } catch (e) {
      toast.error(`Restore failed: ${e}`)
    } finally {
      setFileRestoring(false)
      setRestoringFile(null)
    }
  }, [selected, fileRestoreTarget, worktreeId, loadDiff])

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

  if (isMobile) {
    if (!mobileDetailOpen) {
      return (
        <div className="mt-2 flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-sm font-medium">
            <History className="h-4 w-4 text-muted-foreground" />
            AI Checkpoints
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {checkpoints.length}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
            {checkpoints.map(cp => {
              const fileCount = cp.filesChanged.length || undefined
              return (
                <button
                  key={cp.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(cp.id)
                    setMobileDetailOpen(true)
                    setMobileFilesOpen(false)
                  }}
                  className="flex min-h-16 w-full items-start gap-3 border-b border-border/50 px-4 py-3 text-left active:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm font-medium leading-snug">
                      {cp.userMessagePreview || 'Agent turn'}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span>{formatRelativeTime(cp.createdAt)}</span>
                      <span>·</span>
                      <span>{statusLabel(cp.status)}</span>
                      {fileCount != null && (
                        <span>
                          {fileCount} file{fileCount === 1 ? '' : 's'}
                        </span>
                      )}
                      {cp.totalAdditions > 0 && (
                        <span className="text-success">
                          +{cp.totalAdditions}
                        </span>
                      )}
                      {cp.totalDeletions > 0 && (
                        <span className="text-destructive">
                          -{cp.totalDeletions}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              )
            })}
          </div>
        </div>
      )
    }

    return (
      <>
        <div className="mt-2 flex min-h-0 flex-1 flex-col">
          {selected && (
            <div className="flex shrink-0 items-start gap-2 border-b border-border px-2 py-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0"
                onClick={() => setMobileDetailOpen(false)}
                aria-label="Back to checkpoints"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <div className="min-w-0 flex-1 py-1">
                <p className="line-clamp-2 text-sm font-medium">
                  {selected.userMessagePreview || 'Agent turn'}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatRelativeTime(selected.createdAt)} ·{' '}
                  {statusLabel(selected.status)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 shrink-0 gap-1.5 px-3"
                onClick={() => openRestoreDialog(selected)}
              >
                <RotateCcw className="h-4 w-4" />
                Restore
              </Button>
            </div>
          )}
          {diffLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading diff…
            </div>
          ) : diffError ? (
            <div className="flex flex-1 items-center justify-center p-4 text-sm text-destructive">
              {diffError}
            </div>
          ) : flattenedFiles.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <FileText className="h-7 w-7 opacity-40" />
              <p>No file changes in this checkpoint</p>
              {selected && (
                <Button
                  variant="ghost"
                  className="mt-2 text-destructive"
                  onClick={() => void handleDelete(selected)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete checkpoint
                </Button>
              )}
            </div>
          ) : (
            <div className="relative flex min-h-0 flex-1 flex-col">
              {selectedFile && (
                <button
                  type="button"
                  onClick={() => setMobileFilesOpen(value => !value)}
                  className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-sm"
                >
                  <FileText
                    className={cn(
                      'h-4 w-4 shrink-0',
                      getStatusColor(selectedFile.fileDiff.type)
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {selectedFile.fileName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {selectedFileIndex + 1}/{flattenedFiles.length}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              )}
              {mobileFilesOpen && (
                <div className="absolute inset-x-0 bottom-0 top-11 z-20 overflow-y-auto bg-background">
                  {flattenedFiles.map((file, index) => (
                    <button
                      key={file.key}
                      type="button"
                      onClick={() => {
                        setSelectedFileIndex(index)
                        setMobileFilesOpen(false)
                      }}
                      className={cn(
                        'flex min-h-12 w-full items-center gap-2 border-b border-border/50 px-3 text-left text-sm',
                        index === selectedFileIndex && 'bg-accent'
                      )}
                    >
                      <FileText
                        className={cn(
                          'h-4 w-4 shrink-0',
                          getStatusColor(file.fileDiff.type)
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {file.fileName}
                      </span>
                      <span className="text-success">+{file.additions}</span>
                      <span className="text-destructive">
                        -{file.deletions}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto px-1">
                {selectedFile && (
                  <MemoizedFileDiff
                    key={selectedFile.key}
                    fileDiff={selectedFile.fileDiff}
                    fileName={selectedFile.fileName}
                    rootPath={worktreePath}
                    resourceOwnerId={worktreeId}
                    annotations={EMPTY_ANNOTATIONS}
                    selectedLines={null}
                    themeType={resolvedThemeType}
                    syntaxThemeDark={
                      preferences?.syntax_theme_dark ?? 'vitesse-black'
                    }
                    syntaxThemeLight={
                      preferences?.syntax_theme_light ?? 'github-light'
                    }
                    diffStyle="unified"
                    enableLineSelection={false}
                    onLineSelected={NOOP_LINE_SELECTED}
                    onRemoveComment={NOOP_REMOVE_COMMENT}
                  />
                )}
              </div>
            </div>
          )}
        </div>
        <CheckpointRestoreDialog
          open={!!restoreTarget}
          worktreeId={worktreeId}
          checkpoint={restoreTarget}
          onOpenChange={handleRestoreDialogOpenChange}
          onRestored={() => void handleRestored()}
        />
      </>
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
                          {(cp.totalAdditions > 0 || cp.totalDeletions > 0) && (
                            <>
                              <span className="text-success">
                                +{cp.totalAdditions}
                              </span>
                              <span className="text-destructive">
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
                      onClick={() => openRestoreDialog(selected)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Restore turn
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Undo this turn&apos;s files; detects overlap with other
                    sessions
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
                              <span className="text-success">
                                +{file.additions}
                              </span>
                              <span className="mx-0.5">/</span>
                              <span className="text-destructive">
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
                              disabled={
                                fileRestoring || restoringFile === file.fileName
                              }
                              onClick={() =>
                                setFileRestoreTarget(file.fileName)
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
                            Restore this file from checkpoint (requires
                            approval)
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
                          rootPath={worktreePath}
                          resourceOwnerId={worktreeId}
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

      <CheckpointRestoreDialog
        open={!!restoreTarget}
        worktreeId={worktreeId}
        checkpoint={restoreTarget}
        onOpenChange={handleRestoreDialogOpenChange}
        onRestored={() => void handleRestored()}
      />

      <AlertDialog
        open={!!fileRestoreTarget}
        onOpenChange={open => {
          if (!open && !fileRestoring) setFileRestoreTarget(null)
        }}
      >
        <AlertDialogContent
          className={cn(
            'relative flex w-[calc(100vw-1rem)] max-w-none flex-col gap-3 p-4',
            'max-h-[min(92dvh,100%)]',
            'max-sm:top-auto max-sm:bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:left-1/2 max-sm:translate-x-[-50%] max-sm:translate-y-0 max-sm:rounded-xl',
            'sm:max-w-lg sm:p-6'
          )}
        >
          <button
            type="button"
            aria-label="Close"
            disabled={fileRestoring}
            onClick={() => {
              if (!fileRestoring) setFileRestoreTarget(null)
            }}
            className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 sm:right-4 sm:top-4"
          >
            <X className="h-4 w-4" />
          </button>
          <AlertDialogHeader className="pr-8 text-left">
            <AlertDialogTitle>Undo this file?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <div className="flex gap-2 rounded-md border border-warning/35 bg-warning/10 px-2.5 py-2 text-left text-xs leading-snug text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <p>
                    Restore can make mistakes — this overwrites the current
                    working-tree content for this path. Prefer a git commit
                    first if you may need the current version.
                  </p>
                </div>
                <p>
                  Revert{' '}
                  <span className="font-mono text-foreground">
                    {fileRestoreTarget
                      ? getFilename(fileRestoreTarget)
                      : 'this file'}
                  </span>{' '}
                  to how it looked before this agent turn.
                </p>
                {fileRestoreTarget && (
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {fileRestoreTarget}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row-reverse">
            <AlertDialogAction
              disabled={fileRestoring}
              className="m-0 w-full sm:w-auto"
              onClick={e => {
                e.preventDefault()
                void handleApproveFileRestore()
              }}
            >
              {fileRestoring ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Restoring…
                </>
              ) : (
                'Yes, undo this file'
              )}
            </AlertDialogAction>
            <AlertDialogCancel className="sr-only" disabled={fileRestoring}>
              Close
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
