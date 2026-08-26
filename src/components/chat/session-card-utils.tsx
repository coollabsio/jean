import type {
  IndicatorShape,
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
  type CodexPermissionRequest,
  type OpenCodePermissionRequest,
  type CodexCommandApprovalRequest,
  type CodexUserInputRequest,
  type CodexMcpElicitationRequest,
  type CodexDynamicToolCallRequest,
} from '@/types/chat'
import {
  buildNativeResumeArgs,
  getNativeTerminalResumeLaunch,
  isNativeTerminalBackend,
} from '@/lib/native-cli-session'
import {
  bareCommandForBackend,
  preferResolvedCliCommand,
} from '@/services/cli-binary'
import { findPlanFilePath, resolvePlanContent } from './tool-call-utils'

/**
 * Lossless session status for canvas/sidebar/tabs/summaries.
 * Priority is applied in computeSessionCardData — do not collapse
 * actionable states before rendering.
 */
export type SessionStatus =
  | 'idle'
  | 'planning'
  | 'vibing'
  | 'yoloing'
  | 'reviewing'
  | 'waiting'
  | 'plan_approval'
  | 'input_required'
  | 'review'
  | 'paused'
  | 'permission'
  | 'command_approval'
  | 'mcp_input'
  | 'tool_approval'
  | 'scheduled'
  | 'review'
  | 'completed'
  | 'cancelled'
  | 'crashed'

/**
 * User-settable status overrides. Automatic live states (running, waiting for
 * input, permissions, …) still win while active; the override applies once the
 * session is idle/terminal so users can pin review/completed/cancelled/idle.
 */
export type ManualSessionStatus =
  | 'idle'
  | 'review'
  | 'paused'
  | 'completed'
  | 'cancelled'

export const MANUAL_SESSION_STATUSES: readonly ManualSessionStatus[] = [
  'idle',
  'review',
  'paused',
  'completed',
  'cancelled',
] as const

export function isManualSessionStatus(
  value: string | null | undefined
): value is ManualSessionStatus {
  return (
    value === 'idle' ||
    value === 'review' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'cancelled'
  )
}

/** Statuses that require user action before the session can continue. */
export const ACTIONABLE_WAITING_STATUSES: readonly SessionStatus[] = [
  'waiting',
  'plan_approval',
  'input_required',
  'permission',
  'command_approval',
  'mcp_input',
  'tool_approval',
] as const

/** Live/automatic statuses that a manual override must not hide. */
export const AUTOMATIC_PRIORITY_STATUSES: readonly SessionStatus[] = [
  ...ACTIONABLE_WAITING_STATUSES,
  'planning',
  'vibing',
  'yoloing',
  'reviewing',
  'scheduled',
  'crashed',
] as const

export function isActionableWaitingStatus(status: SessionStatus): boolean {
  return (ACTIONABLE_WAITING_STATUSES as readonly string[]).includes(status)
}

export function isAutomaticPriorityStatus(status: SessionStatus): boolean {
  return (AUTOMATIC_PRIORITY_STATUSES as readonly string[]).includes(status)
}

export interface SessionCardData {
  session: Session
  status: SessionStatus
  /** Automatic status before any manual override is applied. */
  automaticStatus: SessionStatus
  /** Active manual override, if any. */
  statusOverride: ManualSessionStatus | null
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
  /** @deprecated Prefer onSetStatusOverride for full manual status control. */
  onToggleReview?: () => void
  onSetStatusOverride?: (status: ManualSessionStatus | null) => void
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
    indicatorShape?: IndicatorShape
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
    indicatorShape: 'diamond',
  },
  plan_approval: {
    label: 'Plan approval required',
    indicatorStatus: 'plan_approval',
    indicatorShape: 'square',
  },
  input_required: {
    label: 'Input required',
    indicatorStatus: 'input_required',
    indicatorShape: 'diamond',
  },
  paused: {
    label: 'Paused',
    // Reuse the gray "idle" indicator color.
    indicatorStatus: 'idle',
  },
  permission: {
    label: 'Permission required',
    indicatorStatus: 'permission',
    indicatorShape: 'square',
  },
  command_approval: {
    label: 'Command approval required',
    indicatorStatus: 'permission',
    indicatorShape: 'square',
  },
  mcp_input: {
    label: 'MCP input required',
    indicatorStatus: 'input_required',
    indicatorShape: 'diamond',
  },
  tool_approval: {
    label: 'Tool approval required',
    indicatorStatus: 'permission',
    indicatorShape: 'square',
  },
  scheduled: {
    label: 'Scheduled',
    indicatorStatus: 'scheduled',
    indicatorShape: 'diamond',
  },
  review: {
    label: 'Review ready',
    indicatorStatus: 'review',
  },
  completed: {
    label: 'Completed',
    indicatorStatus: 'completed',
  },
  cancelled: {
    label: 'Cancelled',
    indicatorStatus: 'cancelled',
    indicatorShape: 'ring',
  },
  crashed: {
    label: 'Crashed',
    indicatorStatus: 'crashed',
    indicatorShape: 'square',
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
  /** Manual status overrides (idle/review/completed/cancelled). */
  sessionStatusOverrides: Record<string, ManualSessionStatus>
  pendingPermissionDenials: Record<string, PermissionDenial[]>
  pendingCodexPermissionRequests: Record<string, CodexPermissionRequest[]>
  pendingOpencodePermissionRequests: Record<string, OpenCodePermissionRequest[]>
  pendingCodexCommandApprovalRequests: Record<
    string,
    CodexCommandApprovalRequest[]
  >
  pendingCodexUserInputRequests: Record<string, CodexUserInputRequest[]>
  pendingCodexMcpElicitationRequests: Record<
    string,
    CodexMcpElicitationRequest[]
  >
  pendingCodexDynamicToolCallRequests: Record<
    string,
    CodexDynamicToolCallRequest[]
  >
  sessionLabels: Record<string, LabelData>
}

/**
 * Resolve the effective manual override from store + session persistence.
 * `status_override` is preferred; legacy `is_reviewing` maps to `'review'`.
 */
export function resolveSessionStatusOverride(
  session: Session,
  storeState: Pick<
    ChatStoreState,
    'sessionStatusOverrides' | 'reviewingSessions'
  >
): ManualSessionStatus | null {
  const fromStore = storeState.sessionStatusOverrides[session.id]
  if (isManualSessionStatus(fromStore)) return fromStore

  if (isManualSessionStatus(session.status_override)) {
    return session.status_override
  }

  // Legacy: is_reviewing / reviewingSessions without an explicit override
  if (
    storeState.reviewingSessions[session.id] ||
    session.is_reviewing ||
    session.review_results
  ) {
    // review_results alone still means "review ready" via automatic path;
    // only treat reviewing flags as a manual override when no override field.
    if (storeState.reviewingSessions[session.id] || session.is_reviewing) {
      return 'review'
    }
  }

  return null
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

function hasPendingEntries<T>(
  storeEntries: T[] | undefined,
  sessionEntries: T[] | undefined
): boolean {
  return (storeEntries?.length ?? 0) > 0 || (sessionEntries?.length ?? 0) > 0
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
    sessionStatusOverrides,
    pendingPermissionDenials,
    pendingCodexPermissionRequests,
    pendingOpencodePermissionRequests,
    pendingCodexCommandApprovalRequests,
    pendingCodexUserInputRequests,
    pendingCodexMcpElicitationRequests,
    pendingCodexDynamicToolCallRequests,
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

  // Check for pending permission denials (Claude-style)
  const sessionDenials = pendingPermissionDenials[session.id] ?? []
  const persistedDenials = session.pending_permission_denials ?? []
  const hasPermissionDenials =
    sessionDenials.length > 0 || persistedDenials.length > 0
  const permissionDenialCount =
    sessionDenials.length > 0 ? sessionDenials.length : persistedDenials.length

  // Codex / OpenCode pending approval/input queues (store first, then session persistence)
  const hasCodexPermission =
    hasPendingEntries(
      pendingCodexPermissionRequests[session.id],
      session.pending_codex_permission_requests
    ) ||
    hasPendingEntries(
      pendingOpencodePermissionRequests[session.id],
      session.pending_opencode_permission_requests
    )
  const hasCodexCommandApproval = hasPendingEntries(
    pendingCodexCommandApprovalRequests[session.id],
    session.pending_codex_command_approval_requests
  )
  const hasCodexUserInput = hasPendingEntries(
    pendingCodexUserInputRequests[session.id],
    session.pending_codex_user_input_requests
  )
  const hasCodexMcpInput = hasPendingEntries(
    pendingCodexMcpElicitationRequests[session.id],
    session.pending_codex_mcp_elicitation_requests
  )
  const hasCodexToolApproval = hasPendingEntries(
    pendingCodexDynamicToolCallRequests[session.id],
    session.pending_codex_dynamic_tool_call_requests
  )

  const hasScheduledWakeup = !!session.scheduled_wakeup

  // Execution mode
  const executionMode = sessionSending
    ? (executingModes[session.id] ??
      executionModes[session.id] ??
      session.selected_execution_mode ??
      'plan')
    : (executionModes[session.id] ?? session.selected_execution_mode ?? 'plan')

  // Determine status — lossless priority matrix (actionable first, then active,
  // then terminal run outcomes). Never collapse cancelled/crashed into idle.
  // Priority:
  //   permission > command_approval > tool_approval > mcp_input >
  //   input_required > plan_approval > waiting >
  //   sending modes > reviewing > review >
  //   restart recovery (running/resumable) > scheduled >
  //   cancelled > crashed > completed > idle
  //
  // Plan/question flags can be true while still streaming (hasExitPlanMode from
  // live tool calls). Only promote them to actionable statuses once the session
  // is actually waiting — otherwise keep the active planning/vibing status.
  let status: SessionStatus = 'idle'
  if (hasPermissionDenials || hasCodexPermission) {
    status = 'permission'
  } else if (hasCodexCommandApproval) {
    status = 'command_approval'
  } else if (hasCodexToolApproval) {
    status = 'tool_approval'
  } else if (hasCodexMcpInput) {
    status = 'mcp_input'
  } else if (hasCodexUserInput || (isWaiting && hasQuestion)) {
    // Questions win over plan approval when both are present (UI hides Approve
    // while a question is open).
    status = 'input_required'
  } else if (isWaiting && hasExitPlanMode) {
    status = 'plan_approval'
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
  } else if (!sessionSending && hasScheduledWakeup) {
    status = 'scheduled'
  } else if (!sessionSending && session.last_run_status === 'cancelled') {
    status = 'cancelled'
  } else if (!sessionSending && session.last_run_status === 'crashed') {
    status = 'crashed'
  } else if (!sessionSending && session.last_run_status === 'completed') {
    status = 'completed'
  }

  const automaticStatus = status
  const statusOverride = resolveSessionStatusOverride(session, {
    sessionStatusOverrides: sessionStatusOverrides ?? {},
    reviewingSessions,
  })
  // Manual override sits next to automatic status: live/actionable automatic
  // states still win; otherwise the user-pinned override is displayed.
  if (statusOverride && !isAutomaticPriorityStatus(automaticStatus)) {
    status = statusOverride
  }

  // Label from Zustand store (populated from persisted data on load)
  const label = sessionLabels[session.id] ?? null

  return {
    session,
    status,
    automaticStatus,
    statusOverride,
    executionMode: executionMode as ExecutionMode,
    isSending: sessionSending,
    isWaiting:
      isWaiting ||
      hasPermissionDenials ||
      hasCodexPermission ||
      hasCodexCommandApproval ||
      hasCodexUserInput ||
      hasCodexMcpInput ||
      hasCodexToolApproval,
    hasExitPlanMode,
    hasQuestion: hasQuestion || hasCodexUserInput,
    hasPermissionDenials: hasPermissionDenials || hasCodexPermission,
    permissionDenialCount:
      permissionDenialCount ||
      (hasCodexPermission
        ? (pendingCodexPermissionRequests[session.id]?.length ??
          session.pending_codex_permission_requests?.length ??
          0)
        : 0),
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
  if (session.backend === 'antigravity' && session.antigravity_session_id) {
    return `agy --conversation ${session.antigravity_session_id}`
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
  if (session.backend === 'antigravity') return session.antigravity_session_id ?? null
  return null
}

/**
 * Resolve the command + args needed to relaunch a native CLI session's terminal
 * resuming the same backend conversation. Prefers the persisted resolved binary
 * path (`terminal_command`) over the bare backend name.
 *
 * Pass `resolvedCommand` (from `check_*_cli_installed`) so Jean-managed installs
 * that are not on PATH launch correctly when opening/reconnecting native
 * terminal sessions.
 */
export function getResumeArgs(
  session: Session,
  options?: { resolvedCommand?: string | null }
): { command: string; args: string[] } | null {
  const resolved = options?.resolvedCommand
  const cmd = session.terminal_command || ''
  const nativeLaunch = getNativeTerminalResumeLaunch(session)
  if (nativeLaunch) {
    return {
      command: preferResolvedCliCommand(
        nativeLaunch.command,
        bareCommandForBackend(session.backend),
        resolved
      ),
      args: nativeLaunch.args,
    }
  }
  const nativeSessionId = getResumeSessionId(session)
  if (isNativeTerminalBackend(session.backend) && nativeSessionId) {
    return {
      command: preferResolvedCliCommand(cmd, session.backend, resolved),
      args: buildNativeResumeArgs(
        session.backend,
        nativeSessionId,
        session.terminal_command_args ?? []
      ),
    }
  }
  if (session.backend === 'cursor' && session.cursor_chat_id) {
    return {
      command: preferResolvedCliCommand(cmd, 'cursor-agent', resolved),
      args: ['--resume', session.cursor_chat_id],
    }
  }
  if (session.backend === 'pi' && session.pi_session_id) {
    return {
      command: preferResolvedCliCommand(cmd, 'pi', resolved),
      args: ['--session', session.pi_session_id],
    }
  }
  if (session.backend === 'grok' && session.grok_session_id) {
    return {
      command: preferResolvedCliCommand(cmd, 'grok', resolved),
      args: ['--resume', session.grok_session_id],
    }
  }
  if (session.backend === 'kimi' && session.kimi_session_id) {
    return {
      command: preferResolvedCliCommand(cmd, 'kimi', resolved),
      args: ['--session', session.kimi_session_id],
    }
  }
  if (session.backend === 'antigravity' && session.antigravity_session_id) {
    return {
      command: preferResolvedCliCommand(cmd, 'agy', resolved),
      args: ['--conversation', session.antigravity_session_id],
    }
  }
  return null
}

export function buildNativeClientSessionInput(
  session: Session,
  worktreeId: string,
  worktreePath: string,
  options?: { resolvedCommand?: string | null }
) {
  const launch = getResumeArgs(session, options)
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
  key: 'inProgress' | 'waiting' | 'review' | 'paused' | 'idle'
  title: string
  /** Representative status for group header icon/color. */
  indicatorStatus: SessionStatus
  cards: SessionCardData[]
}

const STATUS_GROUP_ORDER: {
  key: StatusGroup['key']
  title: string
  indicatorStatus: SessionStatus
  statuses: SessionStatus[]
}[] = [
  {
    key: 'waiting',
    title: 'Waiting',
    indicatorStatus: 'waiting',
    statuses: [...ACTIONABLE_WAITING_STATUSES],
  },
  {
    key: 'inProgress',
    title: 'In Progress',
    indicatorStatus: 'vibing',
    statuses: ['planning', 'vibing', 'yoloing', 'reviewing', 'scheduled'],
  },
  {
    key: 'review',
    title: 'Review',
    indicatorStatus: 'review',
    // Keep completed distinct from review-ready within the group via statusConfig labels
    statuses: ['review', 'completed', 'cancelled', 'crashed'],
  },
  {
    key: 'paused',
    title: 'Paused',
    indicatorStatus: 'paused',
    statuses: ['paused'],
  },
  { key: 'idle', title: 'Idle', indicatorStatus: 'idle', statuses: ['idle'] },
]

/** Group cards by status. Returns only non-empty groups.
 * - inProgress group: reversed so newest appears first
 * - review group: sorted by created_at (oldest first) */
export function groupCardsByStatus(cards: SessionCardData[]): StatusGroup[] {
  return STATUS_GROUP_ORDER.map(({ key, title, indicatorStatus, statuses }) => {
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
    return { key, title, indicatorStatus, cards: filteredCards }
  }).filter(g => g.cards.length > 0)
}

/** Flatten grouped cards back into a single array (for keyboard nav indices). */
export function flattenGroups(groups: StatusGroup[]): SessionCardData[] {
  return groups.flatMap(g => g.cards)
}
