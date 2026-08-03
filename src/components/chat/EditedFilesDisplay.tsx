import { memo, useMemo, useState } from 'react'
import { diffLines } from 'diff'
import type { ToolCall, ChatMessage } from '@/types/chat'
import { Badge } from '@/components/ui/badge'
import { getFilename } from '@/lib/path-utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { MessageDiffModal } from './MessageDiffModal'
import type { EditTool } from './MessageDiffModal'

function isEditTool(
  toolCall: ToolCall
): toolCall is ToolCall & { input: EditTool['input'] } {
  return (
    toolCall.name === 'Edit' &&
    typeof toolCall.input === 'object' &&
    toolCall.input !== null &&
    'file_path' in toolCall.input &&
    typeof (toolCall.input as Record<string, unknown>).file_path === 'string'
  )
}

interface CodexFileChange {
  path: string
  diff?: string
}

function getCodexFileChanges(toolCall: ToolCall): CodexFileChange[] {
  if (toolCall.name !== 'FileChange') return []
  const input = toolCall.input
  if (!Array.isArray(input)) return []
  return input.filter(
    (change): change is CodexFileChange =>
      typeof change === 'object' &&
      change !== null &&
      typeof (change as Record<string, unknown>).path === 'string'
  )
}

function computeEditStats(
  oldStr: string | undefined,
  newStr: string | undefined
): { additions: number; deletions: number } {
  const changes = diffLines(oldStr ?? '', newStr ?? '')
  let additions = 0
  let deletions = 0
  for (const part of changes) {
    const count = part.count ?? 0
    if (part.added) additions += count
    else if (part.removed) deletions += count
  }
  return { additions, deletions }
}

function computeUnifiedDiffStats(diff: string | undefined): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const line of (diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

function codexDiffToPatch(
  filePath: string,
  diff: string | undefined
): string | null {
  if (!diff) return null
  if (diff.startsWith('diff --git ') || diff.startsWith('--- ')) return diff
  return `Index: ${filePath}\n===================================================================\n--- ${filePath}\n+++ ${filePath}\n${diff}`
}

interface EditedFilesDisplayProps {
  toolCalls: ToolCall[] | undefined
  worktreePath?: string
  /**
   * Stable accessor for the full session message list. Used to compute
   * "subsequent edits" lazily when the user opens a diff. Passing a stable
   * function (rather than the `messages` array itself) keeps the memoized
   * row from re-rendering whenever the session's message array identity
   * changes — avoiding a per-row render cascade while scrolling.
   */
  getMessages?: () => ChatMessage[]
  messageIndex?: number
}

export const EditedFilesDisplay = memo(function EditedFilesDisplay({
  toolCalls,
  worktreePath,
  getMessages,
  messageIndex,
}: EditedFilesDisplayProps) {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)

  const editTools = useMemo(
    () => (toolCalls ?? []).filter(isEditTool),
    [toolCalls]
  )

  const codexChanges = useMemo(
    () => (toolCalls ?? []).flatMap(getCodexFileChanges),
    [toolCalls]
  )

  const uniqueFilePaths = useMemo(
    () =>
      Array.from(
        new Set([
          ...editTools.map(t => t.input.file_path),
          ...codexChanges.map(change => change.path),
        ])
      ),
    [editTools, codexChanges]
  )

  const fileStats = useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>()
    const addStats = (
      filePath: string,
      delta: { additions: number; deletions: number }
    ) => {
      const prev = map.get(filePath) ?? { additions: 0, deletions: 0 }
      map.set(filePath, {
        additions: prev.additions + delta.additions,
        deletions: prev.deletions + delta.deletions,
      })
    }

    for (const tool of editTools) {
      addStats(
        tool.input.file_path,
        computeEditStats(tool.input.old_string, tool.input.new_string)
      )
    }
    for (const change of codexChanges) {
      addStats(change.path, computeUnifiedDiffStats(change.diff))
    }
    return map
  }, [editTools, codexChanges])

  const selectedEdits = useMemo(
    () =>
      selectedFilePath
        ? editTools.filter(t => t.input.file_path === selectedFilePath)
        : [],
    [editTools, selectedFilePath]
  )

  const selectedCodexPatch = useMemo(() => {
    if (!selectedFilePath) return null
    const patches = codexChanges.flatMap(change => {
      if (change.path !== selectedFilePath) return []
      const patch = codexDiffToPatch(change.path, change.diff)
      return patch ? [patch] : []
    })
    return patches.length > 0 ? patches.join('\n') : null
  }, [codexChanges, selectedFilePath])

  // All Edit tool calls on selectedFilePath from messages AFTER this one.
  // Computed lazily — only once the user opens a diff — by pulling the
  // current message list through the stable `getMessages` accessor.
  const subsequentEdits = useMemo(() => {
    if (!selectedFilePath || !getMessages || messageIndex == null) return []
    return getMessages()
      .slice(messageIndex + 1)
      .flatMap(msg =>
        (msg.tool_calls ?? []).flatMap(tc =>
          isEditTool(tc) && tc.input.file_path === selectedFilePath ? [tc] : []
        )
      )
  }, [selectedFilePath, getMessages, messageIndex])

  if (uniqueFilePaths.length === 0) return null

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/70">
        <span>
          Edited {uniqueFilePaths.length} file
          {uniqueFilePaths.length === 1 ? '' : 's'}:
        </span>

        {uniqueFilePaths.map(filePath => {
          const stats = fileStats.get(filePath)
          return (
            <Tooltip key={filePath}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setSelectedFilePath(filePath)}
                  aria-label={`View changes to ${getFilename(filePath)}`}
                  className="inline-flex min-w-0 max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Badge
                    variant="outline"
                    className="max-w-[calc(100vw-4rem)] cursor-pointer gap-1.5 sm:max-w-none"
                  >
                    <span className="min-w-0 truncate">
                      {getFilename(filePath)}
                    </span>
                    {stats && (stats.additions > 0 || stats.deletions > 0) && (
                      <span className="flex shrink-0 items-center font-mono text-xs opacity-80">
                        <span className="text-green-500">
                          +{stats.additions}
                        </span>
                        <span className="text-muted-foreground mx-0.5">/</span>
                        <span className="text-red-500">-{stats.deletions}</span>
                      </span>
                    )}
                  </Badge>
                </button>
              </TooltipTrigger>
              <TooltipContent>{filePath}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      {selectedFilePath && (
        <MessageDiffModal
          isOpen={true}
          onClose={() => setSelectedFilePath(null)}
          filePath={selectedFilePath}
          edits={selectedEdits}
          subsequentEdits={subsequentEdits}
          worktreePath={worktreePath}
          patch={selectedCodexPatch}
        />
      )}
    </div>
  )
})
