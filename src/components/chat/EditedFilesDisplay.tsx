import { memo, useMemo, useState } from 'react'
import { diffLines } from 'diff'
import { useQuery } from '@tanstack/react-query'
import type { ToolCall, ChatMessage } from '@/types/chat'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ChevronRight } from '@/components/icons/reicon'
import { getFilename, joinPaths, normalizePath } from '@/lib/path-utils'
import { checkpointQueryKeys, listAiCheckpoints } from '@/services/checkpoints'
import type { AiCheckpoint } from '@/types/checkpoints'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { MessageDiffModal } from './MessageDiffModal'
import type { CheckpointFileDiff, EditTool } from './MessageDiffModal'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Normalize Claude file-changing tool calls into old/new string edits.
 * - Edit: one replacement
 * - MultiEdit: one entry per inner edit
 * - Write: whole file content (kept as name 'Write'; prior content unknown)
 * - NotebookEdit: new cell source
 * Failed/denied tool calls (`is_error`) changed nothing and are skipped.
 */
export function getClaudeFileEdits(toolCall: ToolCall): EditTool[] {
  if (toolCall.is_error === true) return []
  const input = asRecord(toolCall.input)
  if (!input) return []

  switch (toolCall.name) {
    case 'Edit': {
      const filePath = asString(input.file_path)
      if (!filePath) return []
      return [
        {
          name: 'Edit',
          input: {
            file_path: filePath,
            old_string: asString(input.old_string),
            new_string: asString(input.new_string),
            ...(input.replace_all === true && { replace_all: true }),
          },
        },
      ]
    }
    case 'MultiEdit': {
      const filePath = asString(input.file_path)
      if (!filePath || !Array.isArray(input.edits)) return []
      return input.edits.flatMap(edit => {
        const e = asRecord(edit)
        if (!e) return []
        return [
          {
            name: 'Edit',
            input: {
              file_path: filePath,
              old_string: asString(e.old_string),
              new_string: asString(e.new_string),
              ...(e.replace_all === true && { replace_all: true }),
            },
          },
        ]
      })
    }
    case 'Write': {
      const filePath = asString(input.file_path)
      if (!filePath) return []
      return [
        {
          name: 'Write',
          input: {
            file_path: filePath,
            old_string: '',
            new_string: asString(input.content) ?? '',
          },
        },
      ]
    }
    case 'NotebookEdit': {
      const filePath = asString(input.notebook_path)
      if (!filePath) return []
      return [
        {
          name: 'NotebookEdit',
          input: {
            file_path: filePath,
            old_string: '',
            new_string: asString(input.new_source) ?? '',
          },
        },
      ]
    }
    default:
      return []
  }
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

interface CheckpointFile {
  /** Absolute path, comparable with tool-call paths. */
  filePath: string
  /** Path relative to the checkpoint's worktree. */
  path: string
  additions: number
  deletions: number
}

/**
 * Files the turn's git checkpoint changed that no file tool call covers
 * (e.g. edits made through Bash).
 */
export function getUncoveredCheckpointFiles(
  checkpoint: AiCheckpoint | undefined,
  toolFilePaths: string[]
): CheckpointFile[] {
  if (!checkpoint) return []
  const covered = new Set(toolFilePaths.map(normalizePath))
  return checkpoint.filesChanged.flatMap(file => {
    const filePath = joinPaths(checkpoint.worktreePath, file.path)
    if (
      covered.has(normalizePath(filePath)) ||
      covered.has(normalizePath(file.path))
    ) {
      return []
    }
    return [
      {
        filePath,
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
      },
    ]
  })
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
  /** Remote Jean server that owns the files; undefined for the active backend. */
  serverId?: string
  worktreeId?: string
  /**
   * User message that started the turn, set only on the display that closes
   * a finished turn. Adds files the turn changed without a file tool call
   * (e.g. via Bash), from the turn's checkpoint in `worktreeId`.
   */
  turnUserMessageId?: string
}

export const EditedFilesDisplay = memo(function EditedFilesDisplay({
  toolCalls,
  worktreePath,
  getMessages,
  messageIndex,
  serverId,
  worktreeId,
  turnUserMessageId,
}: EditedFilesDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)

  const editTools = useMemo(
    () => (toolCalls ?? []).flatMap(getClaudeFileEdits),
    [toolCalls]
  )

  const codexChanges = useMemo(
    () => (toolCalls ?? []).flatMap(getCodexFileChanges),
    [toolCalls]
  )

  const toolFilePaths = useMemo(
    () =>
      Array.from(
        new Set([
          ...editTools.map(t => t.input.file_path),
          ...codexChanges.map(change => change.path),
        ])
      ),
    [editTools, codexChanges]
  )

  const { data: checkpoint } = useQuery({
    queryKey: checkpointQueryKeys.worktree(worktreeId ?? ''),
    queryFn: () => {
      if (!worktreeId) throw new Error('worktreeId is required')
      return listAiCheckpoints(worktreeId)
    },
    enabled: !!worktreeId && !!turnUserMessageId,
    staleTime: 10_000,
    select: checkpoints =>
      checkpoints.find(c => c.userMessageId === turnUserMessageId),
    // The backend finalizes the checkpoint when the run ends; poll until then.
    refetchInterval: query =>
      query.state.data?.some(
        c => c.userMessageId === turnUserMessageId && c.status === 'open'
      )
        ? 2000
        : false,
  })

  const checkpointFiles = useMemo(
    () => getUncoveredCheckpointFiles(checkpoint, toolFilePaths),
    [checkpoint, toolFilePaths]
  )

  const uniqueFilePaths = useMemo(
    () => [...toolFilePaths, ...checkpointFiles.map(file => file.filePath)],
    [toolFilePaths, checkpointFiles]
  )

  // Stats are only shown in the expanded content, so skip the per-edit
  // line diffing until the user expands the list.
  const fileStats = useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>()
    if (!isExpanded) return map
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
    for (const file of checkpointFiles) {
      addStats(file.filePath, file)
    }
    return map
  }, [editTools, codexChanges, checkpointFiles, isExpanded])

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

  const selectedCheckpointDiff = useMemo((): CheckpointFileDiff | undefined => {
    const file = checkpointFiles.find(f => f.filePath === selectedFilePath)
    if (!file || !checkpoint || !worktreeId) return undefined
    return { worktreeId, checkpointId: checkpoint.id, path: file.path }
  }, [checkpointFiles, checkpoint, worktreeId, selectedFilePath])

  // All Edit tool calls on selectedFilePath from messages AFTER this one.
  // Computed lazily — only once the user opens a diff — by pulling the
  // current message list through the stable `getMessages` accessor.
  const subsequentEdits = useMemo(() => {
    if (!selectedFilePath || !getMessages || messageIndex == null) return []
    return getMessages()
      .slice(messageIndex + 1)
      .flatMap(msg =>
        (msg.tool_calls ?? [])
          .flatMap(getClaudeFileEdits)
          .filter(edit => edit.input.file_path === selectedFilePath)
      )
  }, [selectedFilePath, getMessages, messageIndex])

  // Edits on selectedFilePath from messages BEFORE this one — lets the diff
  // recover the prior content when this message overwrote the file (Write).
  const previousEdits = useMemo(() => {
    if (!selectedFilePath || !getMessages || messageIndex == null) return []
    return getMessages()
      .slice(0, messageIndex)
      .flatMap(msg =>
        (msg.tool_calls ?? [])
          .flatMap(getClaudeFileEdits)
          .filter(edit => edit.input.file_path === selectedFilePath)
      )
  }, [selectedFilePath, getMessages, messageIndex])

  if (uniqueFilePaths.length === 0) return null

  return (
    <Collapsible
      className="mt-2 space-y-1.5"
      open={isExpanded}
      onOpenChange={setIsExpanded}
    >
      <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground/70 hover:bg-muted/50 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 transition-transform duration-200',
            isExpanded && 'rotate-90'
          )}
        />
        <span>
          Edited {uniqueFilePaths.length} file
          {uniqueFilePaths.length === 1 ? '' : 's'}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="flex flex-wrap items-center gap-1.5 pl-1.5 text-xs text-muted-foreground/70">
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
                      {stats &&
                        (stats.additions > 0 || stats.deletions > 0) && (
                          <span className="flex shrink-0 items-center font-mono text-xs opacity-80">
                            <span className="text-success">
                              +{stats.additions}
                            </span>
                            <span className="text-muted-foreground mx-0.5">
                              /
                            </span>
                            <span className="text-destructive">
                              -{stats.deletions}
                            </span>
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
      </CollapsibleContent>

      {selectedFilePath && (
        <MessageDiffModal
          isOpen={true}
          onClose={() => setSelectedFilePath(null)}
          filePath={selectedFilePath}
          edits={selectedEdits}
          subsequentEdits={subsequentEdits}
          previousEdits={previousEdits}
          worktreePath={worktreePath}
          patch={selectedCodexPatch}
          checkpointDiff={selectedCheckpointDiff}
          serverId={serverId}
        />
      )}
    </Collapsible>
  )
})
