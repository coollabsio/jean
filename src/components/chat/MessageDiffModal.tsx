import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { createPatch } from 'diff'
import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
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

type DiffStyle = 'split' | 'unified'

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
  subsequentEdits = [],
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
    if (!fileContent) return null
    try {
      // Step 1: undo subsequent messages' edits → get file state right after THIS message
      let afterThis = fileContent
      for (const edit of [...subsequentEdits].reverse()) {
        const oldStr = edit.input.old_string ?? ''
        const newStr = edit.input.new_string ?? ''
        if (newStr && afterThis.includes(newStr)) {
          afterThis = replaceLast(afterThis, newStr, oldStr)
        }
      }
      // Step 2: undo this message's edits → get file state before THIS message
      let beforeThis = afterThis
      for (const edit of [...edits].reverse()) {
        const oldStr = edit.input.old_string ?? ''
        const newStr = edit.input.new_string ?? ''
        if (newStr && beforeThis.includes(newStr)) {
          beforeThis = replaceLast(beforeThis, newStr, oldStr)
        }
      }
      const patch = createPatch(relativePath, beforeThis, afterThis, '', '', {
        context: 3,
      })
      const patches = parsePatchFiles(patch)
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
      theme: {
        dark: preferences?.syntax_theme_dark ?? 'vitesse-black',
        light: preferences?.syntax_theme_light ?? 'github-light',
      },
      themeType: resolvedThemeType,
      diffStyle,
      overflow: 'wrap' as const,
      enableLineSelection: false,
      disableFileHeader: true,
      unsafeCSS: `
        pre { font-family: var(--font-family-mono) !important; font-size: calc(var(--ui-font-size) * 0.85) !important; line-height: var(--ui-line-height) !important; }
        * { user-select: text !important; -webkit-user-select: text !important; cursor: text !important; }
      `,
    }),
    [
      resolvedThemeType,
      diffStyle,
      preferences?.syntax_theme_dark,
      preferences?.syntax_theme_light,
    ]
  )

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
        <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-4 pb-3 pt-4 pr-12 sm:flex-row sm:items-center sm:border-0 sm:px-0 sm:pb-0 sm:pt-0 sm:pr-10">
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

          <button
            type="button"
            onClick={onClose}
            className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:right-5"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </button>

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

            {canOpenInEditor() && (
              <button
                type="button"
                onClick={handleOpenExternal}
                className="ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ExternalLink className="h-4 w-4" />
                <span className="hidden sm:inline">Open in Editor</span>
              </button>
            )}
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
              <FileDiff
                key={currentChangeKey}
                fileDiff={currentChangeFile}
                options={fileDiffOptions}
              />
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
