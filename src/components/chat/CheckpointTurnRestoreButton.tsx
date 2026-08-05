import { memo, useCallback, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  checkpointQueryKeys,
  listAiCheckpoints,
} from '@/services/checkpoints'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { AiCheckpoint } from '@/types/checkpoints'
import type { ChatMessage, ToolCall } from '@/types/chat'
import { CheckpointRestoreDialog } from './CheckpointRestoreDialog'

/** Tools that change project files (used to decide when to show restore). */
function isFileEditTool(toolCall: ToolCall): boolean {
  const name = toolCall.name
  if (
    name === 'FileChange' ||
    name === 'Write' ||
    name === 'MultiEdit' ||
    name === 'NotebookEdit' ||
    name === 'Delete' ||
    name === 'create_file' ||
    name === 'edit_file' ||
    name === 'delete_file' ||
    name === 'search_replace' ||
    name === 'apply_patch'
  ) {
    return true
  }
  if (name !== 'Edit') return false
  const input = toolCall.input
  return (
    typeof input === 'object' &&
    input !== null &&
    'file_path' in input &&
    typeof (input as Record<string, unknown>).file_path === 'string'
  )
}

export function messageHasFileEdits(
  toolCalls: ToolCall[] | undefined
): boolean {
  return (toolCalls ?? []).some(isFileEditTool)
}

/** True when any assistant reply after this user message (until next user) edited files. */
export function turnHasFileEdits(
  messages: ChatMessage[] | undefined,
  userMessageIndex: number
): boolean {
  if (!messages || userMessageIndex < 0) return false
  for (let i = userMessageIndex + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.role === 'user') break
    if (msg.role === 'assistant' && messageHasFileEdits(msg.tool_calls)) {
      return true
    }
  }
  return false
}

/**
 * True when this user prompt's agent turn is complete enough to restore.
 * Mid-flight turns (session still sending and no later user message) hide
 * Restore — rolling back while the agent is still writing does not make sense.
 */
export function isUserTurnFinished(
  messages: ChatMessage[] | undefined,
  userMessageIndex: number,
  isSending: boolean
): boolean {
  if (!messages || userMessageIndex < 0) return false
  for (let i = userMessageIndex + 1; i < messages.length; i++) {
    if (messages[i]?.role === 'user') return true
  }
  // Open / last turn: finished only when the session is no longer sending.
  return !isSending
}

interface CheckpointTurnRestoreButtonProps {
  /** User message id that started the agent turn (checkpoint.userMessageId). */
  userMessageId: string
  /** Optional explicit worktree; falls back to modal / active worktree. */
  worktreeId?: string | null
  /**
   * When true, show even if checkpoint.filesChanged is empty (e.g. tool-call
   * based detection for a finished turn). Defaults to requiring checkpoint
   * file stats or hasFileEdits. Callers should only pass true after the turn
   * has finished — mid-stream restores are not offered.
   */
  hasFileEdits?: boolean
  className?: string
  /** Icon-only button styling variant for user bubble vs edited-files row. */
  variant?: 'userBubble' | 'inline'
}

/**
 * Restore icon for a user prompt's agent turn. Resolves the checkpoint by
 * userMessageId and opens the hybrid restore dialog.
 */
export const CheckpointTurnRestoreButton = memo(
  function CheckpointTurnRestoreButton({
    userMessageId,
    worktreeId: worktreeIdProp,
    hasFileEdits = false,
    className,
    variant = 'userBubble',
  }: CheckpointTurnRestoreButtonProps) {
    const activeWorktreeId = useChatStore(s => s.activeWorktreeId)
    const sessionChatModalWorktreeId = useUIStore(
      s => s.sessionChatModalWorktreeId
    )
    const sessionChatModalOpen = useUIStore(s => s.sessionChatModalOpen)
    const worktreeId =
      worktreeIdProp ??
      (sessionChatModalOpen ? sessionChatModalWorktreeId : null) ??
      activeWorktreeId

    const [dialogOpen, setDialogOpen] = useState(false)

    const { data: checkpoints = [], isFetched } = useQuery({
      queryKey: checkpointQueryKeys.worktree(worktreeId ?? ''),
      queryFn: () => {
        if (!worktreeId) {
          throw new Error('worktreeId is required to list AI checkpoints')
        }
        return listAiCheckpoints(worktreeId)
      },
      enabled: !!worktreeId,
      staleTime: 10_000,
    })

    const checkpoint: AiCheckpoint | null = useMemo(() => {
      if (!worktreeId) return null
      return (
        checkpoints.find(c => c.userMessageId === userMessageId) ?? null
      )
    }, [checkpoints, userMessageId, worktreeId])

    // Show as soon as we know the turn edited files (or checkpoint lists files).
    // Do not wait for checkpoint metadata — mobile users still need a tappable control.
    const shouldShow = useMemo(() => {
      if (!worktreeId) return false
      if (hasFileEdits) return true
      if (checkpoint && (checkpoint.filesChanged?.length ?? 0) > 0) return true
      return false
    }, [worktreeId, hasFileEdits, checkpoint])

    const openDialog = useCallback(() => {
      if (!worktreeId) {
        toast.error('No worktree available for restore')
        return
      }
      if (!checkpoint) {
        if (!isFetched) {
          toast.message('Loading checkpoints…')
          return
        }
        toast.error(
          'No checkpoint found for this prompt. Restores need a snapshot taken when the turn started.'
        )
        return
      }
      setDialogOpen(true)
    }, [worktreeId, checkpoint, isFetched])

    if (!shouldShow || !worktreeId) return null

    // Shared look for under-prompt and edited-files row (icon + label).
    // Fine pointers: slightly muted until hover; touch: always readable.
    const buttonClass = cn(
      'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] cursor-pointer transition-colors',
      'text-muted-foreground/80 hover:bg-muted/50 hover:text-foreground',
      'focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      variant === 'userBubble' &&
        '[@media(pointer:fine)]:text-muted-foreground/0 [@media(pointer:fine)]:group-hover:text-muted-foreground/70',
      className
    )

    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Restore files from before this prompt"
              onClick={openDialog}
              className={buttonClass}
            >
              <RotateCcw className="h-3.5 w-3.5 shrink-0" />
              <span>Restore</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Restore worktree to before this prompt (requires approval)
          </TooltipContent>
        </Tooltip>
        {checkpoint && (
          <CheckpointRestoreDialog
            open={dialogOpen}
            worktreeId={worktreeId}
            checkpoint={checkpoint}
            onOpenChange={setDialogOpen}
          />
        )}
      </>
    )
  }
)
