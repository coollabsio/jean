import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  memo,
  useTransition,
} from 'react'
import {
  FileText,
  Loader2,
  AlertCircle,
  RefreshCw,
  Columns2,
  Rows3,
  GitBranch,
  GitCommitHorizontal,
  MessageSquarePlus,
  Play,
  Pencil,
  X,
  Search,
  Undo2,
  ChevronsUpDown,
  PanelLeft,
  Check,
} from 'lucide-react'
import {
  parsePatchFiles,
  type SelectedLineRange,
  type DiffLineAnnotation,
  type FileDiffMetadata,
} from '@pierre/diffs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/uuid'
import { getFilename } from '@/lib/path-utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import {
  getGitDiff,
  revertFile,
  triggerImmediateGitPoll,
} from '@/services/git-status'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { resolveMagicPromptProvider } from '@/types/preferences'
import type { CreateCommitResponse } from '@/types/projects'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'
import { useTheme } from '@/hooks/use-theme'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePreferences } from '@/services/preferences'
import { CommitsTabView } from './CommitsTabView'
import {
  MemoizedFileDiff,
  getStatusColor,
  type DiffComment,
} from './MemoizedFileDiff'
import type { GitDiff, DiffRequest } from '@/types/git-diff'

// PERFORMANCE: Stable empty array reference for files without comments
// This prevents unnecessary re-renders since the reference never changes
const EMPTY_ANNOTATIONS: DiffLineAnnotation<DiffComment>[] = []

// Re-export for consumers that imported from this file
export type { DiffComment, MemoizedFileDiffProps } from './MemoizedFileDiff'

/** Props for the isolated comment input bar */
interface CommentInputBarProps {
  activeFileName: string | null
  selectedRange: SelectedLineRange | null
  onAddComment: (comment: string) => void
  onCancel: () => void
}

/**
 * Isolated comment input component to prevent re-renders of the entire modal
 * when the user types in the input field
 */
const CommentInputBar = memo(function CommentInputBar({
  activeFileName,
  selectedRange,
  onAddComment,
  onCancel,
}: CommentInputBarProps) {
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when mounted
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  const handleSubmit = useCallback(() => {
    if (inputValue.trim()) {
      onAddComment(inputValue.trim())
      setInputValue('')
    }
  }, [inputValue, onAddComment])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && inputValue.trim()) {
        handleSubmit()
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    },
    [inputValue, handleSubmit, onCancel]
  )

  if (!selectedRange) return null

  return (
    <div className="flex items-center gap-2 px-3 h-10 bg-muted rounded-md border border-border">
      <MessageSquarePlus className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground shrink-0">
        {activeFileName ? getFilename(activeFileName) : ''}:
        {selectedRange.start}
        {selectedRange.end !== selectedRange.start && `-${selectedRange.end}`}
      </span>
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="What should I do with this code?"
        className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!inputValue.trim()}
        className="px-2 py-1 bg-black text-white dark:bg-yellow-500 dark:text-black hover:bg-black/80 dark:hover:bg-yellow-400 rounded text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Add
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="p-1 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
})

interface DiffStats {
  added: number
  removed: number
}

interface GitDiffModalProps {
  /** Diff request parameters, or null to close the modal */
  diffRequest: DiffRequest | null
  /** Callback when modal is closed */
  onClose: () => void
  /** Callback when user wants to add comments to input for editing */
  onAddToPrompt?: (reference: string) => void
  /** Callback when user wants to execute comments immediately */
  onExecutePrompt?: (reference: string) => void
  /** Uncommitted change stats (for switcher) */
  uncommittedStats?: DiffStats
  /** Branch diff stats (for switcher) */
  branchStats?: DiffStats
}

type DiffStyle = 'split' | 'unified'

/**
 * Modal dialog for viewing GitHub-style git diffs using @pierre/diffs
 */
export function GitDiffModal({
  diffRequest,
  onClose,
  onAddToPrompt,
  onExecutePrompt,
  uncommittedStats,
  branchStats,
}: GitDiffModalProps) {
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [cachedBranchStats, setCachedBranchStats] = useState<DiffStats | null>(
    null
  )
  const [cachedUncommittedStats, setCachedUncommittedStats] =
    useState<DiffStats | null>(null)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(
    window.innerWidth < 768 ? 'unified' : 'split'
  )
  const [activeDiffType, setActiveDiffType] = useState<
    'uncommitted' | 'branch' | 'commits'
  >(diffRequest?.type ?? 'uncommitted')
  const dialogContentRef = useRef<HTMLDivElement>(null)
  const { theme } = useTheme()
  const isMobile = useIsMobile()
  const { data: preferences } = usePreferences()
  const gitDiffSelectedFiles = useUIStore(state => state.gitDiffSelectedFiles)

  // On mobile, show file sidebar as an overlay panel toggled by a button
  const [showMobileSidebar, setShowMobileSidebar] = useState(false)

  // Comment/selection state
  const [comments, setComments] = useState<DiffComment[]>([])
  const [selectedRange, setSelectedRange] = useState<SelectedLineRange | null>(
    null
  )
  const [activeFileName, setActiveFileName] = useState<string | null>(null)
  const [showCommentInput, setShowCommentInput] = useState(false)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Sidebar file selection state
  const [selectedFileIndex, setSelectedFileIndex] = useState<number>(0)
  const [fileFilter, setFileFilter] = useState('')
  const fileListRef = useRef<HTMLDivElement>(null)

  // Use transition for file switching to keep UI responsive during heavy diff rendering
  const [, startTransition] = useTransition()

  // Manual switching state for consistent visual feedback
  // (useTransition's isPending is too fast for small diffs)
  const [isSwitching, setIsSwitching] = useState(false)
  const switchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Revert file state
  const [revertTarget, setRevertTarget] = useState<{
    fileName: string
    fileStatus: string
  } | null>(null)
  const [isReverting, setIsReverting] = useState(false)

  // Resolve theme to actual dark/light value
  const resolvedThemeType = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      // Check system preference
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  const loadDiff = useCallback(
    async (request: DiffRequest, isRefresh = false) => {
      setIsLoading(true)
      setError(null)
      // Only clear diff on initial load, not on refresh
      if (!isRefresh) {
        setDiff(null)
      }

      try {
        const result = await getGitDiff(
          request.worktreePath,
          request.type,
          request.baseBranch
        )
        setDiff(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setIsLoading(false)
      }
    },
    []
  )

  // Commit selected (or all) files directly from the diff view
  const [isCommitting, setIsCommitting] = useState(false)
  const handleCommitFromDiff = useCallback(async () => {
    if (!diffRequest || isCommitting) return
    const { gitDiffSelectedFiles, clearGitDiffSelectedFiles } =
      useUIStore.getState()
    const specificFiles =
      gitDiffSelectedFiles.size > 0 ? Array.from(gitDiffSelectedFiles) : null

    setIsCommitting(true)
    const toastId = toast.loading(
      specificFiles
        ? `Committing ${specificFiles.length} file${specificFiles.length !== 1 ? 's' : ''}...`
        : 'Committing all changes...'
    )

    try {
      const result = await invoke<CreateCommitResponse>(
        'create_commit_with_ai',
        {
          worktreePath: diffRequest.worktreePath,
          customPrompt: preferences?.magic_prompts?.commit_message,
          push: false,
          model: preferences?.magic_prompt_models?.commit_message_model,
          customProfileName: resolveMagicPromptProvider(
            preferences?.magic_prompt_providers,
            'commit_message_provider',
            preferences?.default_provider
          ),
          reasoningEffort:
            preferences?.magic_prompt_efforts?.commit_message_effort ?? null,
          specificFiles,
        }
      )

      clearGitDiffSelectedFiles()
      triggerImmediateGitPoll()
      // Refresh the diff view to show remaining uncommitted files
      setSelectedFileIndex(0)
      loadDiff({ ...diffRequest, type: 'uncommitted' }, true)

      toast.success(result.message.split('\n')[0], { id: toastId })
    } catch (error) {
      toast.error(`Failed to commit: ${error}`, { id: toastId })
    } finally {
      setIsCommitting(false)
    }
  }, [diffRequest, isCommitting, preferences, loadDiff])

  // Cache backend stats per tab so they persist across tab switches
  useEffect(() => {
    if (!diff) return
    const stats: DiffStats = {
      added: diff.total_additions,
      removed: diff.total_deletions,
    }
    if (activeDiffType === 'branch') setCachedBranchStats(stats)
    else if (activeDiffType === 'uncommitted') setCachedUncommittedStats(stats)
  }, [diff, activeDiffType])

  /** Map @pierre/diffs file type back to backend git status */
  const diffTypeToStatus = useCallback((type: string): string => {
    switch (type) {
      case 'new':
        return 'added'
      case 'deleted':
        return 'deleted'
      case 'rename-pure':
      case 'rename-changed':
        return 'renamed'
      default:
        return 'modified'
    }
  }, [])

  const handleRevertFile = useCallback(async () => {
    if (!revertTarget || !diffRequest) return
    setIsReverting(true)
    try {
      await revertFile(
        diffRequest.worktreePath,
        revertTarget.fileName,
        revertTarget.fileStatus
      )
      // Refresh diff to reflect reverted file (revert only available in diff tabs)
      if (activeDiffType !== 'commits') {
        await loadDiff({ ...diffRequest, type: activeDiffType }, true)
      }
    } catch (err) {
      setError(
        `Failed to revert: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setIsReverting(false)
      setRevertTarget(null)
    }
  }, [revertTarget, diffRequest, activeDiffType, loadDiff])

  useEffect(() => {
    if (diffRequest) {
      setActiveDiffType(diffRequest.type)
      loadDiff(diffRequest)
      // Reset to first file when opening/reloading
      setSelectedFileIndex(0)
    } else {
      // Reset state when modal closes
      setDiff(null)
      setError(null)
      setIsLoading(false)
      // Also reset comment state
      setComments([])
      setSelectedRange(null)
      setActiveFileName(null)
      setShowCommentInput(false)
      setSelectedFileIndex(0)
      setFileFilter('')
      useUIStore.getState().clearGitDiffSelectedFiles()
      setIsSwitching(false)
      setShowMobileSidebar(false)
      setCachedBranchStats(null)
      setCachedUncommittedStats(null)
      if (switchTimeoutRef.current) {
        clearTimeout(switchTimeoutRef.current)
      }
    }
  }, [diffRequest, loadDiff])

  // Store line selection callbacks per file to maintain stable references
  const lineSelectedCallbacksRef = useRef<
    Map<string, (range: SelectedLineRange | null) => void>
  >(new Map())

  // Get or create a stable callback for a specific file
  const getLineSelectedCallback = useCallback((fileName: string) => {
    let callback = lineSelectedCallbacksRef.current.get(fileName)
    if (!callback) {
      callback = (range: SelectedLineRange | null) => {
        setSelectedRange(range)
        setActiveFileName(range ? fileName : null)
        if (range) {
          setShowCommentInput(true)
        }
      }
      lineSelectedCallbacksRef.current.set(fileName, callback)
    }
    return callback
  }, [])

  // Add a comment for the current selection (receives comment text from isolated input)
  const handleAddComment = useCallback(
    (commentText: string) => {
      if (!selectedRange || !activeFileName || !commentText) return

      const newComment: DiffComment = {
        id: generateId(),
        fileName: activeFileName,
        side: selectedRange.side ?? 'additions',
        startLine: Math.min(selectedRange.start, selectedRange.end),
        endLine: Math.max(selectedRange.start, selectedRange.end),
        comment: commentText,
      }

      setComments(prev => [...prev, newComment])
      setSelectedRange(null)
      setShowCommentInput(false)
    },
    [selectedRange, activeFileName]
  )

  // Remove a comment
  const handleRemoveComment = useCallback((commentId: string) => {
    setComments(prev => prev.filter(c => c.id !== commentId))
  }, [])

  // Cancel comment input
  const handleCancelComment = useCallback(() => {
    setShowCommentInput(false)
    setSelectedRange(null)
  }, [])

  // Format comments for sending
  const formatComments = useCallback(() => {
    return comments
      .map(c => {
        const lineRange =
          c.startLine === c.endLine
            ? `line ${c.startLine}`
            : `lines ${c.startLine}-${c.endLine}`
        return `In ${c.fileName} (${lineRange}, ${c.side === 'deletions' ? 'old code' : 'new code'}): "${c.comment}"`
      })
      .join('\n\n')
  }, [comments])

  // Add comments to input for editing
  const handleAddToPrompt = useCallback(() => {
    if (comments.length === 0 || !onAddToPrompt) return
    onAddToPrompt(formatComments())
    setComments([])
    onClose()
  }, [comments, onAddToPrompt, formatComments, onClose])

  // Execute comments immediately
  const handleExecutePrompt = useCallback(() => {
    if (comments.length === 0 || !onExecutePrompt) return
    onExecutePrompt(formatComments())
    setComments([])
    onClose()
  }, [comments, onExecutePrompt, formatComments, onClose])

  // PERFORMANCE: Pre-compute annotations map for stable references
  // This ensures that files without comment changes don't re-render
  const annotationsByFile = useMemo(() => {
    const map = new Map<string, DiffLineAnnotation<DiffComment>[]>()

    for (const comment of comments) {
      const existing = map.get(comment.fileName) ?? []
      const newAnnotations = Array.from(
        { length: comment.endLine - comment.startLine + 1 },
        (_, i) => ({
          side: comment.side,
          lineNumber: comment.startLine + i,
          metadata: comment,
        })
      )
      map.set(comment.fileName, [...existing, ...newAnnotations])
    }

    return map
  }, [comments])

  // Getter returns stable references from the map
  const getAnnotationsForFile = useCallback(
    (fileName: string): DiffLineAnnotation<DiffComment>[] =>
      annotationsByFile.get(fileName) ?? EMPTY_ANNOTATIONS,
    [annotationsByFile]
  )

  // Parse the raw patch into individual file diffs
  const parsedFiles = useMemo(() => {
    if (!diff?.raw_patch) return []
    try {
      return parsePatchFiles(diff.raw_patch)
    } catch (e) {
      console.error('Failed to parse patch:', e)
      return []
    }
  }, [diff?.raw_patch])

  // Flatten files into stable array for sidebar and selection
  // Pre-compute stats to avoid calculation during render
  // Also merge any files from the backend that the patch parser missed (e.g., deleted/binary files)
  const flattenedFiles = useMemo(() => {
    const fromPatch = parsedFiles.flatMap((patch, patchIndex) =>
      patch.files.map((fileDiff, fileIndex) => {
        // Pre-compute stats from hunks
        let additions = 0
        let deletions = 0
        for (const hunk of fileDiff.hunks) {
          additions += hunk.additionCount
          deletions += hunk.deletionCount
        }
        return {
          fileDiff,
          fileName: fileDiff.name || fileDiff.prevName || 'unknown',
          key: `${patchIndex}-${fileIndex}`,
          additions,
          deletions,
        }
      })
    )

    // Add files from backend that the patch parser missed (deleted, binary, etc.)
    if (diff?.files) {
      const parsedPaths = new Set(fromPatch.map(f => f.fileName))
      const statusToType: Record<string, string> = {
        deleted: 'deleted',
        added: 'new',
        renamed: 'rename-changed',
        modified: 'change',
      }
      for (const backendFile of diff.files) {
        if (!parsedPaths.has(backendFile.path)) {
          fromPatch.push({
            fileDiff: {
              name: backendFile.path,
              prevName: backendFile.old_path ?? undefined,
              type: (statusToType[backendFile.status] ??
                'change') as FileDiffMetadata['type'],
              hunks: [],
              splitLineCount: 0,
              unifiedLineCount: 0,
            } as FileDiffMetadata,
            fileName: backendFile.path,
            key: `backend-${backendFile.path}`,
            additions: backendFile.additions,
            deletions: backendFile.deletions,
          })
        }
      }
    }

    return fromPatch
  }, [parsedFiles, diff?.files])

  // Filter files by search pattern
  const filteredFiles = useMemo(() => {
    if (!fileFilter) return flattenedFiles
    const lower = fileFilter.toLowerCase()
    return flattenedFiles.filter(f => f.fileName.toLowerCase().includes(lower))
  }, [flattenedFiles, fileFilter])

  // Compute display names: show minimal disambiguating path for duplicate basenames
  const displayNameMap = useMemo(() => {
    const map = new Map<string, string>()
    // Group by basename
    const groups = new Map<string, typeof filteredFiles>()
    for (const file of filteredFiles) {
      const base = getFilename(file.fileName)
      const group = groups.get(base)
      if (group) group.push(file)
      else groups.set(base, [file])
    }
    for (const [base, group] of groups) {
      if (group.length === 1) {
        const onlyFile = group[0]
        if (onlyFile) {
          map.set(onlyFile.key, base)
        }
      } else {
        // Add parent segments until all names are unique
        const segments = group.map(f =>
          f.fileName.replace(/\\/g, '/').split('/')
        )
        let depth = 1
        while (depth < 10) {
          depth++
          const names = segments.map(s =>
            s.slice(Math.max(0, s.length - depth)).join('/')
          )
          if (new Set(names).size === names.length) {
            group.forEach((f, i) => {
              const name = names[i]
              if (!name) return
              const isPartial = name !== f.fileName.replace(/\\/g, '/')
              map.set(f.key, isPartial ? `\u2026/${name}` : name)
            })
            break
          }
        }
        // Fallback: full path
        const firstFile = group[0]
        if (firstFile && !map.has(firstFile.key)) {
          group.forEach(f => map.set(f.key, f.fileName))
        }
      }
    }
    return map
  }, [filteredFiles])

  // Get currently selected file
  const selectedFile =
    filteredFiles.length > 0 && selectedFileIndex < filteredFiles.length
      ? filteredFiles[selectedFileIndex]
      : null

  // Check if there are any files to display
  const hasFiles = flattenedFiles.length > 0

  // Handle file selection from sidebar
  // Use transition to keep sidebar responsive while diff renders
  const handleSelectFile = useCallback((index: number) => {
    // Clear any pending timeout
    if (switchTimeoutRef.current) {
      clearTimeout(switchTimeoutRef.current)
    }

    setSelectedRange(null)
    setShowCommentInput(false)
    setIsSwitching(true)
    setShowMobileSidebar(false)

    startTransition(() => {
      setSelectedFileIndex(index)
    })

    // Ensure minimum visible duration of 150ms for visual feedback
    switchTimeoutRef.current = setTimeout(() => {
      setIsSwitching(false)
    }, 150)
  }, [])

  // Keyboard navigation for file list
  useEffect(() => {
    if (!diffRequest || filteredFiles.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current)
        setSelectedRange(null)
        setShowCommentInput(false)
        setIsSwitching(true)
        startTransition(() => {
          setSelectedFileIndex(i => Math.min(i + 1, filteredFiles.length - 1))
        })
        switchTimeoutRef.current = setTimeout(() => setIsSwitching(false), 150)
      } else if (e.key === 'Backspace' && activeDiffType === 'uncommitted') {
        e.preventDefault()
        const file = filteredFiles[selectedFileIndex]
        if (file) {
          setRevertTarget({
            fileName: file.fileName,
            fileStatus: diffTypeToStatus(file.fileDiff.type),
          })
        }
      } else if (e.key === ' ' && activeDiffType === 'uncommitted') {
        e.preventDefault()
        const file = filteredFiles[selectedFileIndex]
        if (file) {
          useUIStore.getState().toggleGitDiffSelectedFile(file.fileName)
        }
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        if (switchTimeoutRef.current) clearTimeout(switchTimeoutRef.current)
        setSelectedRange(null)
        setShowCommentInput(false)
        setIsSwitching(true)
        startTransition(() => {
          setSelectedFileIndex(i => Math.max(i - 1, 0))
        })
        switchTimeoutRef.current = setTimeout(() => setIsSwitching(false), 150)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [
    diffRequest,
    filteredFiles,
    selectedFileIndex,
    activeDiffType,
    diffTypeToStatus,
  ])

  // Scroll selected file into view in sidebar
  useEffect(() => {
    const list = fileListRef.current
    if (!list) return

    const selectedItem = list.querySelector(
      `[data-index="${selectedFileIndex}"]`
    )
    selectedItem?.scrollIntoView({ block: 'nearest' })
  }, [selectedFileIndex])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (switchTimeoutRef.current) {
        clearTimeout(switchTimeoutRef.current)
      }
    }
  }, [])

  // Refresh diff view after a commit completes (for selective file commits)
  useEffect(() => {
    if (!diffRequest || activeDiffType !== 'uncommitted') return

    const handleCommitCompleted = () => {
      setSelectedFileIndex(0)
      loadDiff({ ...diffRequest, type: 'uncommitted' }, true)
    }

    window.addEventListener('git-commit-completed', handleCommitCompleted)
    return () =>
      window.removeEventListener('git-commit-completed', handleCommitCompleted)
  }, [diffRequest, activeDiffType, loadDiff])

  // Show switcher whenever both diff contexts are available, even when counts are zero.
  const hasUncommitted = uncommittedStats !== undefined
  const hasBranchDiff = branchStats !== undefined
  const showSwitcher = hasUncommitted && hasBranchDiff
  // Prefer cached stats (from loaded diff) over polling stats for consistency across tab switches
  const uncommittedAdded =
    cachedUncommittedStats?.added ?? uncommittedStats?.added ?? 0
  const uncommittedRemoved =
    cachedUncommittedStats?.removed ?? uncommittedStats?.removed ?? 0
  const branchAdded = cachedBranchStats?.added ?? branchStats?.added ?? 0
  const branchRemoved = cachedBranchStats?.removed ?? branchStats?.removed ?? 0

  // Handle switching between diff types
  const handleSwitchDiffType = useCallback(
    (type: 'uncommitted' | 'branch' | 'commits') => {
      if (!diffRequest || type === activeDiffType) return
      setActiveDiffType(type)
      setSelectedFileIndex(0)
      setFileFilter('')
      setSelectedRange(null)
      setShowCommentInput(false)
      useUIStore.getState().clearGitDiffSelectedFiles()
      // Commits tab manages its own data — only call loadDiff for diff tabs
      if (type !== 'commits') {
        loadDiff({ ...diffRequest, type }, false)
      }
    },
    [diffRequest, activeDiffType, loadDiff]
  )

  const title =
    activeDiffType === 'uncommitted'
      ? 'Uncommitted Changes'
      : `Changes vs ${diffRequest?.baseBranch ?? 'main'}`

  return (
    <>
      <Dialog open={!!diffRequest} onOpenChange={open => !open && onClose()}>
        <DialogContent
          ref={dialogContentRef}
          showCloseButton={false}
          className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm overflow-hidden flex flex-col"
          style={{ fontSize: 'var(--ui-font-size)' }}
          onOpenAutoFocus={e => {
            // Prevent Radix from focusing the first focusable element (a tooltip trigger button),
            // which would cause the tooltip to open immediately on modal open
            e.preventDefault()
            dialogContentRef.current?.focus()
          }}
          onKeyDown={e => {
            // Only stop Enter from propagating to canvas behind the modal
            // (which would open a worktree/session). Other keys must propagate
            // to reach the document-level keyboard navigation handler.
            if (e.key === 'Enter') e.stopPropagation()
          }}
          onEscapeKeyDown={e => {
            if (showCommentInput) {
              e.preventDefault()
              handleCancelComment()
            } else {
              e.preventDefault()
              onClose()
            }
          }}
        >
          <DialogTitle className="flex flex-wrap items-center gap-2 shrink-0 px-3 pt-3 sm:px-0 sm:pt-0">
            {showSwitcher ? (
              <div className="flex items-center bg-muted rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => handleSwitchDiffType('uncommitted')}
                  className={cn(
                    'flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    activeDiffType === 'uncommitted'
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Uncommitted</span>
                  <span className="text-green-500">+{uncommittedAdded}</span>
                  <span className="text-red-500">-{uncommittedRemoved}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSwitchDiffType('branch')}
                  className={cn(
                    'flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    activeDiffType === 'branch'
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <GitBranch className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Branch</span>
                  <span className="text-green-500">+{branchAdded}</span>
                  <span className="text-red-500">-{branchRemoved}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSwitchDiffType('commits')}
                  className={cn(
                    'flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    activeDiffType === 'commits'
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <GitCommitHorizontal className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Commits</span>
                </button>
              </div>
            ) : (
              <>
                <FileText className="h-4 w-4" />
                {title}
              </>
            )}
            <div className="flex items-center gap-2 sm:gap-3">
              {activeDiffType === 'uncommitted' &&
                gitDiffSelectedFiles.size > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {gitDiffSelectedFiles.size} file
                    {gitDiffSelectedFiles.size !== 1 ? 's' : ''} selected
                  </span>
                )}
              {/* View mode toggle */}
              <div className="flex items-center bg-muted rounded-lg p-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setDiffStyle('split')}
                      className={cn(
                        'flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-md text-xs font-medium transition-colors',
                        diffStyle === 'split'
                          ? 'bg-background shadow-sm text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Columns2 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Split</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Side-by-side view</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setDiffStyle('unified')}
                      className={cn(
                        'flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-md text-xs font-medium transition-colors',
                        diffStyle === 'unified'
                          ? 'bg-background shadow-sm text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Rows3 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Stacked</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Unified view</TooltipContent>
                </Tooltip>
              </div>
              {/* Execute and Edit buttons */}
              {comments.length > 0 && (onAddToPrompt || onExecutePrompt) && (
                <div className="flex items-center gap-1">
                  {onExecutePrompt && (
                    <button
                      type="button"
                      onClick={handleExecutePrompt}
                      className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 bg-black text-white dark:bg-yellow-500 dark:text-black hover:bg-black/80 dark:hover:bg-yellow-400 rounded-md text-xs font-medium transition-colors"
                    >
                      <Play className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Execute</span> (
                      {comments.length})
                    </button>
                  )}
                  {onAddToPrompt && (
                    <button
                      type="button"
                      onClick={handleAddToPrompt}
                      className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 bg-black text-white dark:bg-yellow-500 dark:text-black hover:bg-black/80 dark:hover:bg-yellow-400 rounded-md text-xs font-medium transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Add to prompt</span>
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {activeDiffType === 'uncommitted' &&
                diff &&
                filteredFiles.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        disabled={isCommitting}
                        onClick={handleCommitFromDiff}
                        className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md text-xs font-medium transition-colors"
                      >
                        {isCommitting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <GitCommitHorizontal className="h-3.5 w-3.5" />
                        )}
                        <span className="hidden sm:inline">
                          Commit
                          {gitDiffSelectedFiles.size > 0
                            ? ` (${gitDiffSelectedFiles.size})`
                            : ''}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {gitDiffSelectedFiles.size > 0
                        ? `Commit ${gitDiffSelectedFiles.size} selected file${gitDiffSelectedFiles.size !== 1 ? 's' : ''}`
                        : 'Commit all changes'}
                    </TooltipContent>
                  </Tooltip>
                )}
              {/* Mobile sidebar toggle */}
              {isMobile && hasFiles && activeDiffType !== 'commits' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 p-0"
                      onClick={() => setShowMobileSidebar(v => !v)}
                    >
                      <PanelLeft className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Toggle file list</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 p-0"
                    onClick={() => {
                      if (!diffRequest || activeDiffType === 'commits') return
                      loadDiff({ ...diffRequest, type: activeDiffType }, true)
                    }}
                    disabled={isLoading || activeDiffType === 'commits'}
                  >
                    <RefreshCw
                      className={cn('h-4 w-4', isLoading && 'animate-spin')}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh diff</TooltipContent>
              </Tooltip>
              <ModalCloseButton onClick={onClose} />
            </div>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review repository diffs, switch view modes, and add line comments.
          </DialogDescription>

          {/* Commits tab — separate component with its own data */}
          {activeDiffType === 'commits' && diffRequest && (
            <CommitsTabView
              worktreePath={diffRequest.worktreePath}
              baseBranch={diffRequest.baseBranch}
              diffStyle={diffStyle}
              onExecutePrompt={onExecutePrompt}
              onClose={onClose}
            />
          )}

          {/* Diff tabs body (Uncommitted / Branch) */}
          {activeDiffType !== 'commits' && (
            <>
              {/* Comment bar - above sidebar and main content */}
              {hasFiles && (
                <div className="mt-2 shrink-0">
                  {/* Hint when no selection */}
                  {!selectedRange && comments.length === 0 && (
                    <div className="flex items-center gap-2 px-3 h-10 text-muted-foreground">
                      <MessageSquarePlus className="h-4 w-4 shrink-0" />
                      <span className="text-sm">
                        Click on line numbers to select code and add comments
                      </span>
                    </div>
                  )}
                  {/* Comment input bar */}
                  {showCommentInput && (
                    <CommentInputBar
                      activeFileName={activeFileName}
                      selectedRange={selectedRange}
                      onAddComment={handleAddComment}
                      onCancel={handleCancelComment}
                    />
                  )}
                </div>
              )}

              {/* Empty state - centered across full modal */}
              {diff && !hasFiles && !isLoading && !error && (
                <div className="flex flex-1 items-center justify-center text-muted-foreground">
                  No changes to display
                </div>
              )}

              {/* Loading state - centered across full modal */}
              {isLoading && !hasFiles && (
                <div className="flex flex-1 items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  Loading diff...
                </div>
              )}

              {/* Error state - centered across full modal */}
              {error && !isLoading && (
                <div className="flex flex-1 items-center justify-center">
                  <div className="flex items-center gap-2 py-4 px-3 bg-destructive/10 text-destructive rounded-md">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="text-sm">{error}</span>
                  </div>
                </div>
              )}

              {/* Flex container fills remaining space - only render when we have files */}
              {hasFiles && (
                <div className="flex-1 min-h-0 mt-2 relative flex">
                  {/* Mobile: file selector overlay */}
                  {isMobile && showMobileSidebar && (
                    <div className="absolute inset-0 z-20 bg-background flex flex-col">
                      <div ref={fileListRef} className="flex-1 overflow-y-auto">
                        {flattenedFiles.length > 0 && (
                          <div className="sticky top-0 z-10 bg-background border-b border-border pb-2">
                            <div className="relative">
                              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-[1em] w-[1em] text-muted-foreground pointer-events-none" />
                              <input
                                type="text"
                                value={fileFilter}
                                onChange={e => {
                                  setFileFilter(e.target.value)
                                  setSelectedFileIndex(0)
                                }}
                                placeholder="Filter files..."
                                className="w-full bg-muted text-sm outline-none border border-border pl-7 pr-2 py-2.5 placeholder:text-muted-foreground focus:border-ring"
                              />
                            </div>
                          </div>
                        )}
                        <div>
                          {filteredFiles.map((file, index) => {
                            const isSelected = index === selectedFileIndex
                            const displayName =
                              displayNameMap.get(file.key) ??
                              getFilename(file.fileName)
                            const isCheckedForCommit =
                              activeDiffType === 'uncommitted' &&
                              gitDiffSelectedFiles.has(file.fileName)
                            return (
                              <button
                                key={file.key}
                                type="button"
                                data-index={index}
                                onClick={() => handleSelectFile(index)}
                                className={cn(
                                  'w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors',
                                  'hover:bg-muted/50',
                                  isSelected && 'bg-accent',
                                  isCheckedForCommit &&
                                    !isSelected &&
                                    'bg-primary/10'
                                )}
                              >
                                {activeDiffType === 'uncommitted' && (
                                  <div
                                    role="checkbox"
                                    aria-checked={isCheckedForCommit}
                                    onClick={e => {
                                      e.stopPropagation()
                                      useUIStore
                                        .getState()
                                        .toggleGitDiffSelectedFile(
                                          file.fileName
                                        )
                                    }}
                                    className={cn(
                                      'h-3.5 w-3.5 shrink-0 rounded-sm border flex items-center justify-center transition-colors cursor-pointer',
                                      isCheckedForCommit
                                        ? 'bg-primary border-primary text-primary-foreground'
                                        : 'border-muted-foreground/40 hover:border-muted-foreground'
                                    )}
                                  >
                                    {isCheckedForCommit && (
                                      <Check className="h-2.5 w-2.5" />
                                    )}
                                  </div>
                                )}
                                <FileText
                                  className={cn(
                                    'h-[1em] w-[1em] shrink-0',
                                    getStatusColor(file.fileDiff.type)
                                  )}
                                />
                                <span className="truncate flex-1 text-sm">
                                  {displayName}
                                </span>
                                <div className="flex items-center gap-1 shrink-0 text-xs">
                                  {file.additions > 0 && (
                                    <span className="text-green-500">
                                      +{file.additions}
                                    </span>
                                  )}
                                  {file.deletions > 0 && (
                                    <span className="text-red-500">
                                      -{file.deletions}
                                    </span>
                                  )}
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Mobile: file name bar + full-width diff */}
                  {isMobile && (
                    <div className="flex-1 min-w-0 flex flex-col">
                      {/* Current file indicator */}
                      {selectedFile && (
                        <button
                          type="button"
                          onClick={() => setShowMobileSidebar(v => !v)}
                          className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground border-b border-border shrink-0"
                        >
                          <FileText
                            className={cn(
                              'h-3.5 w-3.5 shrink-0',
                              getStatusColor(selectedFile.fileDiff.type)
                            )}
                          />
                          <span className="truncate">
                            {displayNameMap.get(selectedFile.key) ??
                              getFilename(selectedFile.fileName)}
                          </span>
                          <span className="text-muted-foreground/60">
                            {selectedFileIndex + 1}/{filteredFiles.length}
                          </span>
                          <ChevronsUpDown className="h-3 w-3 ml-auto shrink-0" />
                        </button>
                      )}
                      <div
                        ref={scrollContainerRef}
                        className={cn(
                          'flex-1 min-h-0 overflow-y-auto transition-opacity duration-150',
                          (isSwitching || isLoading) && 'opacity-60'
                        )}
                      >
                        {selectedFile ? (
                          <div className="px-1">
                            <MemoizedFileDiff
                              key={selectedFile.key}
                              fileDiff={selectedFile.fileDiff}
                              fileName={selectedFile.fileName}
                              annotations={getAnnotationsForFile(
                                selectedFile.fileName
                              )}
                              selectedLines={
                                activeFileName === selectedFile.fileName
                                  ? selectedRange
                                  : null
                              }
                              themeType={resolvedThemeType}
                              syntaxThemeDark={
                                preferences?.syntax_theme_dark ??
                                'vitesse-black'
                              }
                              syntaxThemeLight={
                                preferences?.syntax_theme_light ??
                                'github-light'
                              }
                              diffStyle={diffStyle}
                              onLineSelected={getLineSelectedCallback(
                                selectedFile.fileName
                              )}
                              onRemoveComment={handleRemoveComment}
                            />
                          </div>
                        ) : (
                          <div className="flex items-center justify-center h-full text-muted-foreground">
                            Select a file to view its diff
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Desktop: resizable sidebar + diff panels */}
                  {!isMobile && (
                    <ResizablePanelGroup
                      direction="horizontal"
                      className="flex-1 min-h-0"
                    >
                      {/* File sidebar */}
                      <ResizablePanel
                        defaultSize={25}
                        minSize={15}
                        maxSize={50}
                      >
                        <div
                          ref={fileListRef}
                          className={cn(
                            'h-full overflow-y-auto transition-opacity duration-150',
                            (isSwitching || isLoading) && 'opacity-60'
                          )}
                        >
                          {flattenedFiles.length > 0 && (
                            <div className="sticky top-0 z-10 bg-background border-b border-border pb-2">
                              <div className="relative">
                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-[1em] w-[1em] text-muted-foreground pointer-events-none" />
                                <input
                                  type="text"
                                  value={fileFilter}
                                  onChange={e => {
                                    setFileFilter(e.target.value)
                                    setSelectedFileIndex(0)
                                  }}
                                  placeholder="Filter files..."
                                  className="w-full bg-muted text-sm outline-none border border-border pl-7 pr-2 py-2.5 placeholder:text-muted-foreground focus:border-ring"
                                />
                              </div>
                            </div>
                          )}
                          <div>
                            {filteredFiles.map((file, index) => {
                              const isSelected = index === selectedFileIndex
                              const displayName =
                                displayNameMap.get(file.key) ??
                                getFilename(file.fileName)

                              const isCheckedForCommit =
                                activeDiffType === 'uncommitted' &&
                                gitDiffSelectedFiles.has(file.fileName)

                              const fileButton = (
                                <button
                                  type="button"
                                  data-index={index}
                                  onClick={() => handleSelectFile(index)}
                                  className={cn(
                                    'w-full flex items-center gap-2 px-3 py-2 text-left transition-colors',
                                    'hover:bg-muted/50',
                                    isSelected && 'bg-accent',
                                    isCheckedForCommit &&
                                      !isSelected &&
                                      'bg-primary/10'
                                  )}
                                >
                                  {activeDiffType === 'uncommitted' && (
                                    <div
                                      role="checkbox"
                                      aria-checked={isCheckedForCommit}
                                      onClick={e => {
                                        e.stopPropagation()
                                        useUIStore
                                          .getState()
                                          .toggleGitDiffSelectedFile(
                                            file.fileName
                                          )
                                      }}
                                      className={cn(
                                        'h-3.5 w-3.5 shrink-0 rounded-sm border flex items-center justify-center transition-colors cursor-pointer',
                                        isCheckedForCommit
                                          ? 'bg-primary border-primary text-primary-foreground'
                                          : 'border-muted-foreground/40 hover:border-muted-foreground'
                                      )}
                                    >
                                      {isCheckedForCommit && (
                                        <Check className="h-2.5 w-2.5" />
                                      )}
                                    </div>
                                  )}
                                  <FileText
                                    className={cn(
                                      'h-[1em] w-[1em] shrink-0',
                                      getStatusColor(file.fileDiff.type)
                                    )}
                                  />
                                  <span className="truncate flex-1">
                                    {displayName}
                                  </span>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {file.additions > 0 && (
                                      <span className="text-green-500">
                                        +{file.additions}
                                      </span>
                                    )}
                                    {file.deletions > 0 && (
                                      <span className="text-red-500">
                                        -{file.deletions}
                                      </span>
                                    )}
                                  </div>
                                </button>
                              )

                              return activeDiffType === 'uncommitted' ? (
                                <ContextMenu key={file.key}>
                                  <Tooltip>
                                    <ContextMenuTrigger asChild>
                                      <TooltipTrigger asChild>
                                        {fileButton}
                                      </TooltipTrigger>
                                    </ContextMenuTrigger>
                                    <TooltipContent>
                                      {file.fileName}
                                    </TooltipContent>
                                  </Tooltip>
                                  <ContextMenuContent className="w-48">
                                    <ContextMenuItem
                                      variant="destructive"
                                      onSelect={() =>
                                        setRevertTarget({
                                          fileName: file.fileName,
                                          fileStatus: diffTypeToStatus(
                                            file.fileDiff.type
                                          ),
                                        })
                                      }
                                    >
                                      <Undo2 className="mr-2 h-4 w-4" />
                                      Revert File
                                    </ContextMenuItem>
                                  </ContextMenuContent>
                                </ContextMenu>
                              ) : (
                                <Tooltip key={file.key}>
                                  <TooltipTrigger asChild>
                                    {fileButton}
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {file.fileName}
                                  </TooltipContent>
                                </Tooltip>
                              )
                            })}
                          </div>
                        </div>
                      </ResizablePanel>

                      <ResizableHandle />

                      {/* Main content area */}
                      <ResizablePanel defaultSize={75} minSize={50}>
                        <div
                          ref={scrollContainerRef}
                          className={cn(
                            'h-full min-w-0 overflow-y-auto transition-opacity duration-150',
                            (isSwitching || isLoading) && 'opacity-60'
                          )}
                        >
                          {selectedFile ? (
                            <div className="px-2">
                              <MemoizedFileDiff
                                key={selectedFile.key}
                                fileDiff={selectedFile.fileDiff}
                                fileName={selectedFile.fileName}
                                annotations={getAnnotationsForFile(
                                  selectedFile.fileName
                                )}
                                selectedLines={
                                  activeFileName === selectedFile.fileName
                                    ? selectedRange
                                    : null
                                }
                                themeType={resolvedThemeType}
                                syntaxThemeDark={
                                  preferences?.syntax_theme_dark ??
                                  'vitesse-black'
                                }
                                syntaxThemeLight={
                                  preferences?.syntax_theme_light ??
                                  'github-light'
                                }
                                diffStyle={diffStyle}
                                onLineSelected={getLineSelectedCallback(
                                  selectedFile.fileName
                                )}
                                onRemoveComment={handleRemoveComment}
                              />
                            </div>
                          ) : (
                            <div className="flex items-center justify-center h-full text-muted-foreground">
                              Select a file to view its diff
                            </div>
                          )}
                        </div>
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  )}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!revertTarget}
        onOpenChange={open => !open && setRevertTarget(null)}
      >
        <AlertDialogContent
          onKeyDown={e => e.stopPropagation()}
          onOpenAutoFocus={e => {
            e.preventDefault()
            // Focus the Revert button instead of Cancel
            const container = e.target as HTMLElement | null
            const action = container?.querySelector<HTMLButtonElement>(
              '[data-revert-action]'
            )
            action?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Revert file?</AlertDialogTitle>
            <AlertDialogDescription>
              This will discard all changes to{' '}
              <span className="font-mono font-semibold">
                {revertTarget?.fileName}
              </span>
              . This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isReverting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-revert-action
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={isReverting}
              onClick={handleRevertFile}
            >
              {isReverting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Reverting...
                </>
              ) : (
                'Revert'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
