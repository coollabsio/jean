import type {
  IndicatorStatus,
  IndicatorVariant,
} from '@/components/ui/status-indicator'
import {
  isAskUserQuestion,
  isPlanToolCall,
  type Session,
  type ExecutionMode,
  type ToolCall,
  type ContentBlock,
  type PermissionDenial,
  type LabelData,
} from '@/types/chat'
import {
  buildNativeResumeArgs,
  getNativeTerminalResumeLaunch,
  isNativeTerminalBackend,
} from '@/lib/native-cli-session'
import { findPlanFilePath, resolvePlanContent } from './tool-call-utils'

export type SessionStatus =
  | 'idle'
  | 'planning'
  | 'vibing'
  | 'yoloing'
  | 'reviewing'
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
  label: LabelData | null
}

export interface SessionCardProps {
  card: SessionCardData
  isSelected: boolean
  onSelect: () => void
  onArchive: () => void
  onDelete: () => void
  onPlanView: () => void
  onApprove?: () => void
  onYolo?: () => void
  onClearContextApprove?: () => void
  onClearContextBuildApprove?: () => void
  onWorktreeBuildApprove?: () => void
  onWorktreeYoloApprove?: () => void
  onToggleLabel?: () => void
  onToggleReview?: () => void
  onReconnect?: () => void
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
  reviewing: {
    label: 'Reviewing',
    indicatorStatus: 'running',
    indicatorVariant: 'loading',
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
  /**
   * Lazy accessor for a session's live streaming text. Streaming text changes
   * every animation frame during a run; exposing it as a getter instead of
   * subscribed maps keeps card recomputation off the per-frame hot path —
   * cards re-read it whenever any subscribed field (tool calls, sending
   * state, …) changes.
   */
  getStreamingText: (sessionId: string) => {
    content: string
    blocks: ContentBlock[]
  }
  answeredQuestions: Record<string, Set<string>>
  waitingForInputSessionIds: Record<string, boolean>
  reviewingSessions: Record<string, boolean>
  pendingPermissionDenials: Record<string, PermissionDenial[]>
  sessionLabels: Record<string, LabelData>
}

export function sessionCanBeWaiting(session: Session): boolean {
  return (
    !session.last_run_status ||
    session.last_run_status === 'running' ||
    session.last_run_status === 'resumable' ||
    (session.last_run_status === 'completed' &&
      (session.waiting_for_input_type === 'plan' ||
        session.waiting_for_input_type === 'question'))
  )
}

function hasLegacyPendingPlanWaiting(session: Session): boolean {
  if (
    session.last_run_status !== 'completed' ||
    session.waiting_for_input_type !== 'plan' ||
    !session.pending_plan_message_id
  ) {
    return false
  }

  return !new Set(session.approved_plan_message_ids ?? []).has(
    session.pending_plan_message_id
  )
}

export function getEffectiveSessionWaiting(
  session: Session,
  storeState: Pick<
    ChatStoreState,
    'waitingForInputSessionIds' | 'reviewingSessions'
  >
): boolean {
  const canBeWaiting = sessionCanBeWaiting(session)
  if (!canBeWaiting) return false
  if (session.waiting_for_input ?? false) return true
  if (hasLegacyPendingPlanWaiting(session)) return true
  const isInReviewState =
    storeState.reviewingSessions[session.id] || !!session.review_results
  if (isInReviewState) return false
  return storeState.waitingForInputSessionIds[session.id] ?? false
}

/** Backend-created Code Review tabs have no chat transcript (background job). */
export function isDedicatedEmptyCodeReviewSession(
  session: Session | null | undefined
): boolean {
  return (
    !!session &&
    session.name.startsWith('Code Review') &&
    session.messages.length === 0
  )
}

export function shouldShowCodeReviewLoadingPanel({
  session,
  isSessionReviewing,
  hasReviewResults,
}: {
  session: Session | null | undefined
  isSessionReviewing: boolean
  hasReviewResults: boolean
}): boolean {
  if (!session || !isSessionReviewing || hasReviewResults) return false
  return isDedicatedEmptyCodeReviewSession(session)
}

/**
 * When true, ChatWindow replaces the chat surface with ReviewResultsPanel.
 * Desktop: any open review panel. Mobile: only dedicated empty Code Review
 * sessions (empty left chat + loading split is useless there).
 */
export function shouldShowReviewFullWidth({
  hasReviewPanel,
  reviewSidebarVisible,
  isMobile,
  session,
}: {
  hasReviewPanel: boolean
  reviewSidebarVisible: boolean
  isMobile: boolean
  session: Session | null | undefined
}): boolean {
  if (!hasReviewPanel || !reviewSidebarVisible) return false
  if (!isMobile) return true
  return isDedicatedEmptyCodeReviewSession(session)
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
    getStreamingText,
    answeredQuestions,
    waitingForInputSessionIds,
    reviewingSessions,
    pendingPermissionDenials,
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
    tc => isPlanToolCall(tc) && !answeredSet?.has(tc.id)
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

  // Helper to extract inline plan from any plan tool call
  const getInlinePlan = (tcs: typeof toolCalls): string | null => {
    const streaming = getStreamingText(session.id)
    return resolvePlanContent({
      toolCalls: tcs,
      messageContent: streaming.content,
      contentBlocks: streaming.blocks,
    }).content
  }

  // Mirrors `canBeWaiting` filter in prefetchSessions (src/services/chat.ts).
  // A session's waiting flag is only meaningful while the run is active, resumable,
  // or parked after a plan approval. Otherwise (e.g. completed non-plan run) the
  // flag is stale and must not be trusted — either in persisted state or Zustand.
  const runCanBeWaiting = sessionCanBeWaiting(session)

  // Use persisted waiting_for_input flag from session metadata
  const persistedWaitingForInput =
    runCanBeWaiting &&
    ((session.waiting_for_input ?? false) ||
      hasLegacyPendingPlanWaiting(session))

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
        // Check for unanswered plan approval
        const hasExitPlan = msg.tool_calls.some(isPlanToolCall)
        if (hasExitPlan && !msg.plan_approved && !approvedPlanIds.has(msg.id)) {
          hasPendingExitPlan = true
          pendingPlanMessageId = msg.id
          // Check for inline plan content
          if (!planFilePath) {
            planContent = resolvePlanContent({
              toolCalls: msg.tool_calls,
              messageContent: msg.content,
              contentBlocks: msg.content_blocks,
            }).content
          }
        }
        break // Only check the last assistant message
      }
    }
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

  // Stale Zustand flag must not pin status to "waiting" when the backend has
  // already moved the session into review. Backend `waiting_for_input` still
  // flows through `persistedWaitingForInput` below, so genuine waiting wins.
  const isExplicitlyWaiting = getEffectiveSessionWaiting(session, {
    waitingForInputSessionIds,
    reviewingSessions,
  })
  const hasActionableStreamingPlan = hasStreamingExitPlan && !sessionSending
  const isWaitingFromMessages =
    runCanBeWaiting &&
    (hasStreamingQuestion ||
      hasActionableStreamingPlan ||
      hasPendingQuestion ||
      hasPendingExitPlan)
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
  } else if (
    session.name.startsWith('Code Review') &&
    session.is_reviewing &&
    !session.review_results
  ) {
    status = 'reviewing'
  } else if (
    session.is_reviewing ||
    reviewingSessions[session.id] ||
    session.review_results
  ) {
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
  if (session.backend === 'cursor' && session.cursor_chat_id) {
    return `cursor-agent --resume ${session.cursor_chat_id}`
  }
  if (session.backend === 'pi' && session.pi_session_id) {
    return `pi --session ${session.pi_session_id}`
  }
  if (session.backend === 'grok' && session.grok_session_id) {
    return `grok --resume ${session.grok_session_id}`
  }
  if (session.backend === 'kimi' && session.kimi_session_id) {
    return `kimi --session ${session.kimi_session_id}`
  }
  return null
}

export function getResumeSessionId(session: Session): string | null {
  if (session.backend === 'claude') return session.claude_session_id ?? null
  if (session.backend === 'codex') return session.codex_thread_id ?? null
  if (session.backend === 'opencode') return session.opencode_session_id ?? null
  if (session.backend === 'cursor') return session.cursor_chat_id ?? null
  if (session.backend === 'pi') return session.pi_session_id ?? null
  if (session.backend === 'grok') return session.grok_session_id ?? null
  if (session.backend === 'kimi') return session.kimi_session_id ?? null
  return null
}

/**
 * Resolve the command + args needed to relaunch a native CLI session's terminal
 * resuming the same backend conversation. Prefers the persisted resolved binary
 * path (`terminal_command`) over the bare backend name.
 */
export function getResumeArgs(
  session: Session
): { command: string; args: string[] } | null {
  const cmd = session.terminal_command || ''
  const nativeLaunch = getNativeTerminalResumeLaunch(session)
  if (nativeLaunch) return nativeLaunch
  const nativeSessionId = getResumeSessionId(session)
  if (isNativeTerminalBackend(session.backend) && nativeSessionId) {
    return {
      command: cmd || session.backend,
      args: buildNativeResumeArgs(
        session.backend,
        nativeSessionId,
        session.terminal_command_args ?? []
      ),
    }
  }
  if (session.backend === 'cursor' && session.cursor_chat_id) {
    return {
      command: cmd || 'cursor-agent',
      args: ['--resume', session.cursor_chat_id],
    }
  }
  if (session.backend === 'pi' && session.pi_session_id) {
    return {
      command: cmd || 'pi',
      args: ['--session', session.pi_session_id],
    }
  }
  if (session.backend === 'grok' && session.grok_session_id) {
    return {
      command: cmd || 'grok',
      args: ['--resume', session.grok_session_id],
    }
  }
  if (session.backend === 'kimi' && session.kimi_session_id) {
    return {
      command: cmd || 'kimi',
      args: ['--session', session.kimi_session_id],
    }
  }
  return null
}

export function buildNativeClientSessionInput(
  session: Session,
  worktreeId: string,
  worktreePath: string
) {
  const launch = getResumeArgs(session)
  const nativeSessionId = getResumeSessionId(session)
  if (!launch || !nativeSessionId || !session.backend) return null

  const name = `${session.name} (Native)`
  return {
    worktreeId,
    worktreePath,
    name,
    backend: session.backend,
    primarySurface: 'terminal' as const,
    terminalCommand: launch.command,
    terminalCommandArgs: launch.args,
    terminalLabel: name,
    nativeSessionId,
  }
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
  { key: 'waiting', title: 'Waiting', statuses: ['waiting', 'permission'] },
  {
    key: 'inProgress',
    title: 'In Progress',
    statuses: ['planning', 'vibing', 'yoloing', 'reviewing'],
  },
  { key: 'review', title: 'Review', statuses: ['review', 'completed'] },
  { key: 'idle', title: 'Idle', statuses: ['idle'] },
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
