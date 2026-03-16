import type {
  IndicatorStatus,
  IndicatorVariant,
} from '@/components/ui/status-indicator'
import {
  isAskUserQuestion,
  isExitPlanMode,
  type Session,
  type SessionDigest,
  type ExecutionMode,
  type ToolCall,
  type PermissionDenial,
  type LabelData,
} from '@/types/chat'
import { findPlanFilePath } from './tool-call-utils'

export type SessionStatus =
  | 'idle'
  | 'planning'
  | 'vibing'
  | 'yoloing'
  | 'waiting'
  | 'review'
  | 'permission'
  | 'completed'

export interface SessionCardData {
  session: Session
  status: SessionStatus
  executionMode: ExecutionMode
  isSending: boolean
  isWaiting: boolean
  hasExitPlanMode: boolean
  hasQuestion: boolean
  hasPermissionDenials: boolean
  permissionDenialCount: number
  planFilePath: string | null
  planContent: string | null
  pendingPlanMessageId: string | null
  hasRecap: boolean
  recapDigest: SessionDigest | null
  label: LabelData | null
}

export interface SessionCardProps {
  card: SessionCardData
  isSelected: boolean
  onSelect: () => void
  onArchive: () => void
  onDelete: () => void
  onPlanView: () => void
  onRecapView: () => void
  onApprove?: () => void
  onYolo?: () => void
  onClearContextApprove?: () => void
  onClearContextBuildApprove?: () => void
  onWorktreeBuildApprove?: () => void
  onWorktreeYoloApprove?: () => void
  onToggleLabel?: () => void
  onToggleReview?: () => void
  onRename?: (sessionId: string, newName: string) => void
  isRenaming?: boolean
  renameValue?: string
  onRenameValueChange?: (value: string) => void
  onRenameStart?: (sessionId: string, currentName: string) => void
  onRenameSubmit?: (sessionId: string) => void
  onRenameCancel?: () => void
}

export const statusConfig: Record<
  SessionStatus,
  {
    label: string
    indicatorStatus: IndicatorStatus
    indicatorVariant?: IndicatorVariant
  }
> = {
  idle: {
    label: 'Idle',
    indicatorStatus: 'idle',
  },
  planning: {
    label: 'Planning',
    indicatorStatus: 'running',
  },
  vibing: {
    label: 'Vibing',
    indicatorStatus: 'running',
  },
  yoloing: {
    label: 'Yoloing',
    indicatorStatus: 'running',
    indicatorVariant: 'destructive',
  },
  waiting: {
    label: 'Waiting',
    indicatorStatus: 'waiting',
  },
  review: {
    label: 'Review',
    indicatorStatus: 'review',
  },
  permission: {
    label: 'Permission',
    indicatorStatus: 'waiting',
  },
  completed: {
    label: 'Completed',
    indicatorStatus: 'completed',
  },
}

export interface ChatStoreState {
  sendingSessionIds: Record<string, boolean>
  executingModes: Record<string, ExecutionMode>
  executionModes: Record<string, ExecutionMode>
  activeToolCalls: Record<string, ToolCall[]>
  answeredQuestions: Record<string, Set<string>>
  waitingForInputSessionIds: Record<string, boolean>
  reviewingSessions: Record<string, boolean>
  pendingPermissionDenials: Record<string, PermissionDenial[]>
  sessionDigests: Record<string, SessionDigest>
  sessionLabels: Record<string, LabelData>
}

export function computeSessionCardData(
  session: Session,
  storeState: ChatStoreState
): SessionCardData {
  const {
    sendingSessionIds,
    executingModes,
    executionModes,
    activeToolCalls,
    answeredQuestions,
    waitingForInputSessionIds,
    reviewingSessions,
    pendingPermissionDenials,
    sessionDigests,
    sessionLabels,
  } = storeState

  const sessionSending = sendingSessionIds[session.id] ?? false
  const toolCalls = activeToolCalls[session.id] ?? []
  const answeredSet = answeredQuestions[session.id]

  // Check streaming tool calls for waiting state
  const hasStreamingQuestion = toolCalls.some(
    tc => isAskUserQuestion(tc) && !answeredSet?.has(tc.id)
  )
  const hasStreamingExitPlan = toolCalls.some(
    tc => isExitPlanMode(tc) && !answeredSet?.has(tc.id)
  )

  // Check persisted session state for waiting status
  let hasPendingQuestion = false
  let hasPendingExitPlan = false
  let planContent: string | null = null

  // Use persisted plan_file_path from session metadata (primary source)
  let planFilePath: string | null = session.plan_file_path ?? null
  // Use persisted pending_plan_message_id (primary source for Canvas view)
  let pendingPlanMessageId: string | null =
    session.pending_plan_message_id ?? null

  // Helper to extract inline plan from ExitPlanMode tool call
  const getInlinePlan = (tcs: typeof toolCalls): string | null => {
    const exitPlanTool = tcs.find(isExitPlanMode)
    if (!exitPlanTool) return null
    const input = exitPlanTool.input as { plan?: string } | undefined
    return input?.plan ?? null
  }

  // Use persisted waiting_for_input flag from session metadata
  const persistedWaitingForInput = session.waiting_for_input ?? false

  // Check if there are approved plan message IDs
  const approvedPlanIds = new Set(session.approved_plan_message_ids ?? [])

  if (!sessionSending) {
    const messages = session.messages

    // Try to find plan file path from messages if not in persisted state
    if (!planFilePath) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg?.tool_calls) {
          const path = findPlanFilePath(msg.tool_calls)
          if (path) {
            planFilePath = path
            break
          }
        }
      }
    }

    // Check the last assistant message for pending questions/plans
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'assistant' && msg.tool_calls) {
        // Check for unanswered questions
        hasPendingQuestion = msg.tool_calls.some(
          tc => isAskUserQuestion(tc) && !answeredSet?.has(tc.id)
        )
        // Check for unanswered ExitPlanMode (not approved)
        const hasExitPlan = msg.tool_calls.some(isExitPlanMode)
        if (hasExitPlan && !msg.plan_approved && !approvedPlanIds.has(msg.id)) {
          hasPendingExitPlan = true
          pendingPlanMessageId = msg.id
          // Check for inline plan content
          if (!planFilePath) {
            planContent = getInlinePlan(msg.tool_calls)
          }
        }
        break // Only check the last assistant message
      }
    }

    // Codex has no native plan approval flow — no fallback needed.
    // Codex plan completions go straight to "review" status.
  }

  // Also check for plan file/content in streaming tool calls
  if (toolCalls.length > 0) {
    const streamingPlanPath = findPlanFilePath(toolCalls)
    if (streamingPlanPath) {
      planFilePath = streamingPlanPath
    } else if (!planFilePath) {
      planContent = getInlinePlan(toolCalls)
    }
  }

  // Use persisted waiting state as fallback when messages aren't loaded
  const isExplicitlyWaiting = waitingForInputSessionIds[session.id] ?? false
  const isWaitingFromMessages =
    hasStreamingQuestion ||
    hasStreamingExitPlan ||
    hasPendingQuestion ||
    hasPendingExitPlan
  // When sessionSending is true, persisted waiting_for_input from TanStack Query
  // may be stale (not yet refetched after approval). Only use it as fallback when idle.
  const isWaiting = sessionSending
    ? isWaitingFromMessages || isExplicitlyWaiting
    : isWaitingFromMessages || isExplicitlyWaiting || persistedWaitingForInput

  // hasExitPlanMode should also consider persisted state
  // Use waiting_for_input_type to disambiguate when messages haven't loaded yet
  // For backwards compatibility: if type is not set, infer from pending_plan_message_id
  // - If pending_plan_message_id exists → it's a plan
  // - If waiting but no pending_plan_message_id → it's likely a question
  const inferredWaitingType =
    session.waiting_for_input_type ??
    (pendingPlanMessageId ? 'plan' : 'question')
  // When sessionSending is true, persisted waiting flags are stale (same as isWaiting above)
  const hasExitPlanMode = sessionSending
    ? hasStreamingExitPlan || hasPendingExitPlan
    : hasStreamingExitPlan ||
    hasPendingExitPlan ||
    (persistedWaitingForInput && inferredWaitingType === 'plan')
  const hasQuestion = sessionSending
    ? hasStreamingQuestion || hasPendingQuestion
    : hasStreamingQuestion ||
    hasPendingQuestion ||
    (persistedWaitingForInput && inferredWaitingType === 'question')

  // Check for pending permission denials
  const sessionDenials = pendingPermissionDenials[session.id] ?? []
  const persistedDenials = session.pending_permission_denials ?? []
  const hasPermissionDenials =
    sessionDenials.length > 0 || persistedDenials.length > 0
  const permissionDenialCount =
    sessionDenials.length > 0 ? sessionDenials.length : persistedDenials.length

  // Execution mode
  const executionMode = sessionSending
    ? (executingModes[session.id] ??
      executionModes[session.id] ??
      session.selected_execution_mode ??
      'plan')
    : (executionModes[session.id] ?? session.selected_execution_mode ?? 'plan')

  // Determine status
  // Priority: permission > waiting > sending (active) > review > restart recovery > completed > idle
  let status: SessionStatus = 'idle'
  if (hasPermissionDenials) {
    status = 'permission'
  } else if (isWaiting) {
    status = 'waiting'
  } else if (sessionSending && executionMode === 'plan') {
    status = 'planning'
  } else if (sessionSending && executionMode === 'build') {
    status = 'vibing'
  } else if (sessionSending && executionMode === 'yolo') {
    status = 'yoloing'
  } else if (reviewingSessions[session.id] || session.review_results) {
    status = 'review'
  } else if (
    !sessionSending &&
    (session.last_run_status === 'running' ||
      session.last_run_status === 'resumable')
  ) {
    // Session has a running/resumable process (detected on app restart)
    // Show actual execution mode from persisted run data
    const mode = session.last_run_execution_mode ?? 'plan'
    if (mode === 'plan') status = 'planning'
    else if (mode === 'build') status = 'vibing'
    else if (mode === 'yolo') status = 'yoloing'
  } else if (!sessionSending && session.last_run_status === 'completed') {
    status = 'completed'
  }

  // Check for session recap/digest
  // Zustand has priority (freshly generated), fall back to persisted digest
  const recapDigest = sessionDigests[session.id] ?? session.digest ?? null
  const hasRecap = recapDigest !== null

  // Label from Zustand store (populated from persisted data on load)
  const label = sessionLabels[session.id] ?? null

  return {
    session,
    status,
    executionMode: executionMode as ExecutionMode,
    isSending: sessionSending,
    isWaiting,
    hasExitPlanMode,
    hasQuestion,
    hasPermissionDenials,
    permissionDenialCount,
    planFilePath,
    planContent,
    pendingPlanMessageId,
    hasRecap,
    recapDigest,
    label,
  }
}

export function getResumeCommand(session: Session): string | null {
  if (session.backend === 'claude' && session.claude_session_id) {
    return `claude --resume ${session.claude_session_id}`
  }
  if (session.backend === 'codex' && session.codex_thread_id) {
    return `codex resume ${session.codex_thread_id}`
  }
  if (session.backend === 'opencode' && session.opencode_session_id) {
    return `opencode -s ${session.opencode_session_id}`
  }
  return null
}

// --- Status grouping ---

export interface StatusGroup {
  key: 'inProgress' | 'waiting' | 'review' | 'idle'
  title: string
  cards: SessionCardData[]
}

const STATUS_GROUP_ORDER: {
  key: StatusGroup['key']
  title: string
  statuses: SessionStatus[]
}[] = [
    { key: 'idle', title: 'Idle', statuses: ['idle'] },
    { key: 'review', title: 'Review', statuses: ['review', 'completed'] },
    { key: 'waiting', title: 'Waiting', statuses: ['waiting', 'permission'] },
    {
      key: 'inProgress',
      title: 'In Progress',
      statuses: ['planning', 'vibing', 'yoloing'],
    },
  ]

/** Group cards by status. Returns only non-empty groups.
 * - inProgress group: reversed so newest appears first
 * - review group: sorted by created_at (oldest first) */
export function groupCardsByStatus(cards: SessionCardData[]): StatusGroup[] {
  return STATUS_GROUP_ORDER.map(({ key, title, statuses }) => {
    let filteredCards = cards.filter(c => statuses.includes(c.status))
    // Reverse inProgress group so newest (most recently started) is first
    if (key === 'inProgress') {
      filteredCards = [...filteredCards].reverse()
    }
    // Sort review group by created_at (oldest first)
    if (key === 'review') {
      filteredCards = [...filteredCards].sort(
        (a, b) => a.session.created_at - b.session.created_at
      )
    }
    return { key, title, cards: filteredCards }
  }).filter(g => g.cards.length > 0)
}

/** Flatten grouped cards back into a single array (for keyboard nav indices). */
export function flattenGroups(groups: StatusGroup[]): SessionCardData[] {
  return groups.flatMap(g => g.cards)
}
