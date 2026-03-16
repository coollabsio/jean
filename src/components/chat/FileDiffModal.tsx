import { useState, useEffect, useMemo, useCallback } from 'react'
import { FileText, Loader2, AlertCircle, Columns2, Rows3 } from 'lucide-react'
import { FileDiff } from '@pierre/diffs/react'
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { getGitDiff } from '@/services/git-status'
import { useTheme } from '@/hooks/use-theme'
import { usePreferences } from '@/services/preferences'
import type { GitDiff } from '@/types/git-diff'
import { getFilename } from '@/lib/path-utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

interface FileDiffModalProps {
  /** Absolute path to the file to show diff for, or null to close */
  filePath: string | null
  /** Path to the worktree/repository */
  worktreePath: string
  /** Callback when modal is closed */
  onClose: () => void
}

type DiffStyle = 'split' | 'unified'

/** Get file status badge color */
function getStatusColor(type: string) {
  switch (type) {
    case 'new':
      return 'text-green-500'
    case 'deleted':
      return 'text-red-500'
    case 'rename-pure':
    case 'rename-changed':
      return 'text-yellow-500'
    default:
      return 'text-blue-500'
  }
}

/**
 * Simple modal for viewing git diff of a single file
 * Uses @pierre/diffs library for rendering
 */
export function FileDiffModal({
  filePath,
  worktreePath,
  onClose,
}: FileDiffModalProps) {
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('split')
  const { theme } = useTheme()
  const { data: preferences } = usePreferences()

  // Resolve theme to actual dark/light value
  const resolvedThemeType = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  // Load diff when filePath changes
  const loadDiff = useCallback(async () => {
    if (!filePath || !worktreePath) return

    setIsLoading(true)
    setError(null)

    try {
      const result = await getGitDiff(worktreePath, 'uncommitted')
      setDiff(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [filePath, worktreePath])

  useEffect(() => {
    if (filePath) {
      loadDiff()
    } else {
      // Reset state when modal closes
      setDiff(null)
      setError(null)
      setIsLoading(false)
    }
  }, [filePath, loadDiff])

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

  // Find the file matching the requested path
  const matchingFile = useMemo((): {
    fileDiff: FileDiffMetadata
    fileName: string
  } | null => {
    if (!filePath || parsedFiles.length === 0) return null

    // Extract relative path from absolute path by removing worktree prefix
    const relativePath = filePath.startsWith(worktreePath)
      ? filePath.slice(worktreePath.length + 1) // +1 for the trailing slash
      : filePath

    for (const patch of parsedFiles) {
      for (const file of patch.files) {
        const fileName = file.name || file.prevName || ''
        // Match by relative path or filename
        if (
          fileName === relativePath ||
          fileName === filePath ||
          fileName.endsWith(`/${relativePath}`) ||
          relativePath.endsWith(`/${fileName}`)
        ) {
          return { fileDiff: file, fileName }
        }
      }
    }

    return null
  }, [parsedFiles, filePath, worktreePath])

  // Calculate stats from hunks
  const stats = useMemo(() => {
    if (!matchingFile) return { additions: 0, deletions: 0 }
    let additions = 0
    let deletions = 0
    for (const hunk of matchingFile.fileDiff.hunks) {
      additions += hunk.additionCount
      deletions += hunk.deletionCount
    }
    return { additions, deletions }
  }, [matchingFile])

  // Memoize FileDiff options
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

  // Extract display filename
  const displayFilename = filePath ? getFilename(filePath) : 'File'

  return (
    <Dialog open={!!filePath} onOpenChange={open => !open && onClose()}>
      <DialogContent
        className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm overflow-hidden flex flex-col"
        style={{ fontSize: 'var(--ui-font-size)' }}
      >
        <DialogTitle className="flex items-center gap-2 shrink-0">
          <FileText
            className={cn(
              'h-4 w-4',
              matchingFile && getStatusColor(matchingFile.fileDiff.type)
            )}
          />
          <span className="truncate">{displayFilename}</span>
          {matchingFile && (
            <span className="text-muted-foreground font-normal text-xs ml-2">
              {stats.additions > 0 && (
                <span className="text-green-500">+{stats.additions}</span>
              )}
              {stats.deletions > 0 && (
                <span className="text-red-500 ml-1">-{stats.deletions}</span>
              )}
            </span>
          )}
          {/* View mode toggle */}
          <div className="flex items-center bg-muted rounded-lg p-1 ml-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setDiffStyle('split')}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    diffStyle === 'split'
                      ? 'bg-background shadow-sm text-foreground'
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
                    'flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    diffStyle === 'unified'
                      ? 'bg-background shadow-sm text-foreground'
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
        </DialogTitle>
        <DialogDescription className="sr-only">
          Shows git diff details for {displayFilename}, including additions,
          deletions, and view mode controls.
        </DialogDescription>

        {/* Content area */}
        <div className="flex-1 min-h-0 mt-2 overflow-y-auto">
          {/* Loading state */}
          {isLoading && (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading diff...
            </div>
          )}

          {/* Error state */}
          {error && !isLoading && (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-2 py-4 px-3 bg-destructive/10 text-destructive rounded-md">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span className="text-sm">{error}</span>
              </div>
            </div>
          )}

          {/* No changes state */}
          {diff && !matchingFile && !isLoading && !error && (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              No uncommitted changes for this file
            </div>
          )}

          {/* Diff content */}
          {matchingFile && !isLoading && (
            <div className="border border-border">
              {/* File header */}
              <div className="flex items-center gap-2 px-3 py-2 bg-muted border-b border-border sticky top-0 z-10">
                <FileText
                  className={cn(
                    'h-[1em] w-[1em] shrink-0',
                    getStatusColor(matchingFile.fileDiff.type)
                  )}
                />
                <span className="truncate text-sm">
                  {matchingFile.fileName}
                </span>
                {matchingFile.fileDiff.prevName &&
                  matchingFile.fileDiff.prevName !== matchingFile.fileName && (
                    <span className="text-muted-foreground truncate text-sm">
                      ← {matchingFile.fileDiff.prevName}
                    </span>
                  )}
              </div>
              {/* Diff render */}
              <FileDiff
                fileDiff={matchingFile.fileDiff}
                options={fileDiffOptions}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
