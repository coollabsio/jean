import { useState, useMemo, useCallback, memo, useTransition } from 'react'
import { FileText, Loader2, MessageSquarePlus, X } from 'lucide-react'
import { FileDiff } from '@pierre/diffs/react'
import type {
  SelectedLineRange,
  DiffLineAnnotation,
  FileDiffMetadata,
} from '@pierre/diffs'
import { cn } from '@/lib/utils'
import type { SyntaxTheme } from '@/types/preferences'

/** A comment attached to a line range in a diff */
export interface DiffComment {
  id: string
  fileName: string
  side: 'deletions' | 'additions'
  startLine: number
  endLine: number
  comment: string
}

/** Props for the memoized FileDiff wrapper */
export interface MemoizedFileDiffProps {
  fileDiff: FileDiffMetadata
  fileName: string
  annotations: DiffLineAnnotation<DiffComment>[]
  selectedLines: SelectedLineRange | null
  themeType: 'dark' | 'light'
  syntaxThemeDark: SyntaxTheme
  syntaxThemeLight: SyntaxTheme
  diffStyle: 'split' | 'unified'
  enableLineSelection?: boolean
  onLineSelected: (range: SelectedLineRange | null) => void
  onRemoveComment: (id: string) => void
}

/** Get file status badge color */
export function getStatusColor(type: string) {
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

/** Memoized FileDiff wrapper to prevent unnecessary re-renders */
export const MemoizedFileDiff = memo(
  function MemoizedFileDiff({
    fileDiff,
    fileName,
    annotations,
    selectedLines,
    themeType,
    syntaxThemeDark,
    syntaxThemeLight,
    diffStyle,
    enableLineSelection: enableLineSelectionProp = true,
    onLineSelected,
    onRemoveComment,
  }: MemoizedFileDiffProps) {
    const [forceShow, setForceShow] = useState(false)
    const [isLoadingDiff, startLoadingDiff] = useTransition()

    // Memoize options to keep reference stable
    const options = useMemo(
      () => ({
        theme: {
          dark: syntaxThemeDark,
          light: syntaxThemeLight,
        },
        themeType,
        diffStyle,
        overflow: 'wrap' as const,
        enableLineSelection: enableLineSelectionProp,
        onLineSelected,
        disableFileHeader: true, // We render file info in sidebar
        unsafeCSS: `
      pre { font-family: var(--font-family-mono) !important; font-size: calc(var(--ui-font-size) * 0.85) !important; line-height: var(--ui-line-height) !important; }
      * { user-select: text !important; -webkit-user-select: text !important; cursor: text !important; }
    `,
      }),
      [
        themeType,
        syntaxThemeDark,
        syntaxThemeLight,
        diffStyle,
        enableLineSelectionProp,
        onLineSelected,
      ]
    )

    const renderAnnotation = useCallback(
      (annotation: DiffLineAnnotation<DiffComment>) => (
        <div className="flex items-center gap-2 px-2 py-1 bg-primary/10 border-l-2 border-primary text-xs">
          <MessageSquarePlus className="h-3 w-3 text-primary shrink-0" />
          <span className="text-foreground">
            {annotation.metadata?.comment}
          </span>
          <button
            type="button"
            onClick={() =>
              annotation.metadata && onRemoveComment(annotation.metadata.id)
            }
            className="ml-auto p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ),
      [onRemoveComment]
    )

    // Calculate stats from hunks for the header
    const stats = useMemo(() => {
      let additions = 0
      let deletions = 0
      for (const hunk of fileDiff.hunks) {
        additions += hunk.additionCount
        deletions += hunk.deletionCount
      }
      return { additions, deletions }
    }, [fileDiff.hunks])

    return (
      <div className="border border-border">
        {/* File header - shows full path and rename info */}
        <div className="flex items-center gap-2 px-3 py-2 bg-muted border-b border-border sticky top-0 z-10">
          <FileText
            className={cn(
              'h-[1em] w-[1em] shrink-0',
              getStatusColor(fileDiff.type)
            )}
          />
          <span className="truncate">{fileName}</span>
          {fileDiff.prevName && fileDiff.prevName !== fileName && (
            <span className="text-muted-foreground truncate">
              ← {fileDiff.prevName}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {stats.additions > 0 && (
              <span className="text-green-500">+{stats.additions}</span>
            )}
            {stats.deletions > 0 && (
              <span className="text-red-500">-{stats.deletions}</span>
            )}
          </div>
        </div>
        {/* Diff content */}
        {fileDiff.hunks.length === 0 ||
        fileDiff.hunks.every(h => h.hunkContent.length === 0) ? (
          <div className="px-4 py-8 text-center text-muted-foreground text-sm">
            {fileDiff.type === 'deleted'
              ? 'This file was deleted'
              : fileDiff.type === 'new'
                ? 'Empty file added'
                : 'Empty file'}
          </div>
        ) : stats.additions + stats.deletions > 1500 && !forceShow ? (
          <div className="px-4 py-8 flex flex-col items-center gap-3 text-muted-foreground text-sm">
            {isLoadingDiff ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Rendering diff...</span>
              </>
            ) : (
              <>
                <span>
                  Large diff —{' '}
                  {(stats.additions + stats.deletions).toLocaleString()} lines
                  changed
                </span>
                <button
                  type="button"
                  onClick={() => startLoadingDiff(() => setForceShow(true))}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-muted hover:bg-accent transition-colors"
                >
                  Show diff
                </button>
              </>
            )}
          </div>
        ) : (
          <FileDiff
            fileDiff={fileDiff}
            lineAnnotations={annotations}
            selectedLines={selectedLines}
            options={options}
            renderAnnotation={renderAnnotation}
          />
        )}
      </div>
    )
  },
  (prevProps, nextProps) => {
    // Custom comparison to prevent unnecessary re-renders
    if (prevProps.selectedLines !== nextProps.selectedLines) {
      // If both are null, treat as equal (don't trigger re-render)
      if (
        prevProps.selectedLines === null &&
        nextProps.selectedLines === null
      ) {
        // Same - don't trigger re-render based on this
      } else {
        return false // Props changed, re-render
      }
    }

    // For other props, use strict equality
    return (
      prevProps.fileDiff === nextProps.fileDiff &&
      prevProps.fileName === nextProps.fileName &&
      prevProps.annotations === nextProps.annotations &&
      prevProps.themeType === nextProps.themeType &&
      prevProps.syntaxThemeDark === nextProps.syntaxThemeDark &&
      prevProps.syntaxThemeLight === nextProps.syntaxThemeLight &&
      prevProps.diffStyle === nextProps.diffStyle &&
      prevProps.onLineSelected === nextProps.onLineSelected &&
      prevProps.onRemoveComment === nextProps.onRemoveComment
    )
  }
)
