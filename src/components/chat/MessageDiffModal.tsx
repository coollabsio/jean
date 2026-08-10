import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { createPatch } from 'diff'
import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import {
  PierreEditProvider,
  PIERRE_UNSAFE_CSS,
  pierreThemePair,
} from '@/components/ui/pierre-edit'
import {
  FileText,
  Columns2,
  Rows3,
  Loader2,
  ExternalLink,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getFilename } from '@/lib/path-utils'
import { getHunkLineStats } from '@/lib/diff-stats'
import { useTheme } from '@/hooks/use-theme'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePreferences } from '@/services/preferences'
import { invoke } from '@/lib/transport'
import { canOpenInEditor } from '@/lib/environment'

function DiffBlock({
  fileName,
  prevName,
  children,
}: {
  fileName: string
  prevName?: string
  children: ReactNode
}) {
  return (
    <div className="border border-border rounded overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted border-b border-border sticky top-0 z-10">
        <FileText className="h-[1em] w-[1em] shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-mono">{fileName}</span>
        {prevName && (
          <span className="text-muted-foreground truncate text-xs font-mono">
            ← {prevName}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

export interface EditTool {
  name: string
  input: {
    file_path: string
    old_string?: string
    new_string?: string
  }
}

/**
 * Replace the LAST occurrence of `search` with `replacement`.
 * Used for reverse-replaying edits: edits are undone newest-first, so the most
 * recently inserted text is the last occurrence. First-match `String.replace`
 * could revert the wrong instance when the inserted text is non-unique.
 */
function replaceLast(
  haystack: string,
  search: string,
  replacement: string
): string {
  const idx = haystack.lastIndexOf(search)
  if (idx === -1) return haystack
  return (
    haystack.slice(0, idx) + replacement + haystack.slice(idx + search.length)
  )
}

/**
 * Undo one Edit tool application while reverse-replaying history newest-first.
 *
 * Forward Edit replaces `oldStr` with `newStr`. Reverse:
 * - Non-empty `newStr`: replace the last occurrence of `newStr` with `oldStr`
 * - Empty `newStr` (content deleted): if the file is now empty, restore `oldStr`
 *   (the common "AI emptied the whole file" case). Partial deletions without a
 *   known index cannot be uniquely reversed and are left unchanged so the
 *   caller can fall back to a direct old→new patch.
 */
export function undoEdit(
  content: string,
  oldStr: string,
  newStr: string
): string {
  if (newStr === '') {
    // Whole-file (or remaining-content) deletion ends in an empty buffer.
    if (content === '' && oldStr !== '') {
      return oldStr
    }
    return content
  }
  if (content.includes(newStr)) {
    return replaceLast(content, newStr, oldStr)
  }
  return content
}

/**
 * Build a unified patch from Edit tool old/new strings when reverse-replay
 * from on-disk content cannot reconstruct the before/after states (e.g. empty
 * new_string partial deletes, or missing intermediate text).
 */
export function patchFromEdits(
  relativePath: string,
  edits: EditTool[]
): string | null {
  if (edits.length === 0) return null

  // Single edit: direct old → new is exact.
  if (edits.length === 1) {
    const only = edits[0]
    if (!only) return null
    const oldStr = only.input.old_string ?? ''
    const newStr = only.input.new_string ?? ''
    if (oldStr === newStr) return null
    return createPatch(relativePath, oldStr, newStr, '', '', { context: 3 })
  }

  // Multi-edit: reverse-apply on an empty after-state only works when the final
  // result is empty (all content removed). Otherwise show the last edit only —
  // better than a blank viewer.
  const last = edits[edits.length - 1]
  if (!last) return null
  const lastOld = last.input.old_string ?? ''
  const lastNew = last.input.new_string ?? ''
  if (lastOld !== lastNew) {
    return createPatch(relativePath, lastOld, lastNew, '', '', { context: 3 })
  }
  return null
}

type DiffStyle = 'split' | 'unified'

/** Stable default so omit/undefined doesn't allocate a new [] each render. */
const EMPTY_SUBSEQUENT_EDITS: EditTool[] = []

interface MessageDiffModalProps {
  isOpen: boolean
  onClose: () => void
  filePath: string
  edits: EditTool[]
  subsequentEdits?: EditTool[]
  worktreePath?: string
  /** Precomputed unified patch for backends (Codex) that report diffs directly. */
  patch?: string | null
}

export function MessageDiffModal({
  isOpen,
  onClose,
  filePath,
  edits,
  subsequentEdits = EMPTY_SUBSEQUENT_EDITS,
  worktreePath,
  patch,
}: MessageDiffModalProps) {
  const isMobile = useIsMobile()
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(() =>
    isMobile ? 'unified' : 'split'
  )
  const { theme } = useTheme()
  const { data: preferences } = usePreferences()

  const resolvedThemeType = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  const relativePath = useMemo(() => {
    if (worktreePath && filePath.startsWith(worktreePath + '/')) {
      return filePath.slice(worktreePath.length + 1)
    }
    return getFilename(filePath)
  }, [filePath, worktreePath])

  // ── Current change: final file → reverse this message's edits → full-file diff ──
  const { data: fileContent, isLoading: isLoadingFile } = useQuery({
    queryKey: ['file-content', filePath],
    queryFn: () => invoke<string>('read_file_content', { path: filePath }),
    enabled: isOpen && !patch,
    staleTime: 10_000,
  })

  const currentChangeFile = useMemo(() => {
    if (patch) {
      try {
        const patches = parsePatchFiles(patch)
        return patches[0]?.files[0] ?? null
      } catch {
        return null
      }
    }
    // Empty string is a valid file (AI emptied it). Only skip while loading /
    // before the query has resolved (undefined).
    if (fileContent === undefined) return null
    try {
      // Step 1: undo subsequent messages' edits → get file state right after THIS message
      let afterThis = fileContent
      for (const edit of [...subsequentEdits].reverse()) {
        const oldStr = edit.input.old_string ?? ''
        const newStr = edit.input.new_string ?? ''
        afterThis = undoEdit(afterThis, oldStr, newStr)
      }
      // Step 2: undo this message's edits → get file state before THIS message
      let beforeThis = afterThis
      for (const edit of [...edits].reverse()) {
        const oldStr = edit.input.old_string ?? ''
        const newStr = edit.input.new_string ?? ''
        beforeThis = undoEdit(beforeThis, oldStr, newStr)
      }

      let rawPatch: string | null = null
      if (beforeThis !== afterThis) {
        rawPatch = createPatch(relativePath, beforeThis, afterThis, '', '', {
          context: 3,
        })
      } else {
        // Reverse-replay produced no change (common when new_string is empty
        // but the file is not fully empty, or content drifted). Fall back to
        // a patch built from the Edit tool strings so the viewer is not blank.
        rawPatch = patchFromEdits(relativePath, edits)
      }

      if (!rawPatch) return null
      const patches = parsePatchFiles(rawPatch)
      return patches[0]?.files[0] ?? null
    } catch {
      return null
    }
  }, [fileContent, edits, subsequentEdits, relativePath, patch])

  const currentStats = useMemo(
    () =>
      currentChangeFile ? getHunkLineStats(currentChangeFile.hunks) : null,
    [currentChangeFile]
  )

  const currentChangeKey = useMemo(() => {
    if (!patch) return relativePath
    return `${relativePath}:${patch.length}:${patch.slice(0, 80)}:${patch.slice(-80)}`
  }, [patch, relativePath])

  const fileDiffOptions = useMemo(
    () => ({
      theme: pierreThemePair(
        preferences?.syntax_theme_dark,
        preferences?.syntax_theme_light
      ),
      themeType: resolvedThemeType,
      diffStyle,
      overflow: 'wrap' as const,
      enableLineSelection: false,
      disableFileHeader: true,
      unsafeCSS: PIERRE_UNSAFE_CSS,
    }),
    [
      resolvedThemeType,
      diffStyle,
      preferences?.syntax_theme_dark,
      preferences?.syntax_theme_light,
    ]
  )

  // No query invalidation: opens file in OS editor only (no app cache change)
  const openFileMutation = useMutation({
    mutationFn: () =>
      invoke('open_file_in_default_app', {
        path: filePath,
        editor: preferences?.editor,
      }),
  })

  const handleOpenExternal = useCallback(() => {
    const id = toast.loading('Opening in editor…')
    openFileMutation.mutate(undefined, {
      onSuccess: () => toast.success('Opened in editor', { id }),
      onError: err => {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`Failed to open: ${message}`, { id })
      },
    })
  }, [openFileMutation])

  const hasCurrentStats =
    currentStats && (currentStats.additions > 0 || currentStats.deletions > 0)

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent
        className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm overflow-hidden flex flex-col"
        style={{ fontSize: 'var(--ui-font-size)' }}
        showCloseButton={false}
      >
        <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-4 pb-3 pt-4 pr-24 sm:flex-row sm:items-center sm:border-0 sm:px-0 sm:pb-0 sm:pt-0 sm:pr-24">
          <DialogTitle className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
            <FileText className="h-4 w-4 shrink-0" />
            <span className="truncate">{getFilename(filePath)}</span>
            {hasCurrentStats && (
              <span className="shrink-0 font-mono text-sm font-semibold">
                <span className="text-green-500">
                  +{currentStats.additions}
                </span>
                <span className="mx-1 text-muted-foreground">/</span>
                <span className="text-red-500">-{currentStats.deletions}</span>
              </span>
            )}
          </DialogTitle>

          <div className="absolute right-4 top-4 flex items-center gap-1 sm:right-5">
            {!isMobile && canOpenInEditor() && (
              <button
                type="button"
                onClick={handleOpenExternal}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ExternalLink className="h-4 w-4" />
                <span className="sr-only">Open in Editor</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </div>

          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
            {/* Diff style toggle */}
            <div className="flex items-center rounded-lg bg-muted p-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setDiffStyle('split')}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                      diffStyle === 'split'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Columns2 className="h-3.5 w-3.5" />
                    Split
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
                      'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                      diffStyle === 'unified'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Rows3 className="h-3.5 w-3.5" />
                    Stacked
                  </button>
                </TooltipTrigger>
                <TooltipContent>Unified view</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        <DialogDescription className="sr-only">
          Changes made to {relativePath} in this message.
        </DialogDescription>

        <div className="min-h-0 flex-1 overflow-y-auto space-y-2 sm:mt-2">
          {isLoadingFile ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading diff…
            </div>
          ) : currentChangeFile ? (
            <DiffBlock fileName={relativePath}>
              <PierreEditProvider>
                <FileDiff
                  key={currentChangeKey}
                  fileDiff={currentChangeFile}
                  options={fileDiffOptions}
                  edit
                />
              </PierreEditProvider>
            </DiffBlock>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              No changes to display
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
