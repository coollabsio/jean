import type { Session } from '@/types/chat'

export const FINISHED_UNREAD_STATUSES = ['completed', 'cancelled', 'crashed']

/** True when the session has a mid-turn approval/input queue pending. */
export function hasPendingSessionApproval(session: Session): boolean {
  return (
    (session.pending_codex_command_approval_requests?.length ?? 0) > 0 ||
    (session.pending_codex_permission_requests?.length ?? 0) > 0 ||
    (session.pending_codex_user_input_requests?.length ?? 0) > 0 ||
    (session.pending_codex_mcp_elicitation_requests?.length ?? 0) > 0 ||
    (session.pending_codex_dynamic_tool_call_requests?.length ?? 0) > 0 ||
    (session.pending_permission_denials?.length ?? 0) > 0
  )
}

/** Check if a session counts as "unread" — has unseen activity */
export function isUnreadSession(session: Session): boolean {
  if (session.archived_at) return false

  const hasFinishedRun =
    session.last_run_status &&
    FINISHED_UNREAD_STATUSES.includes(session.last_run_status)
  // Mid-turn Codex approvals set waiting_for_input, but also count pending
  // queues so reconnect/remote clients still surface them (issue #626).
  const isWaiting =
    session.waiting_for_input || hasPendingSessionApproval(session)
  const isReviewing = session.is_reviewing
  const hasReviewResults = !!session.review_results

  if (!hasFinishedRun && !isWaiting && !isReviewing && !hasReviewResults)
    return false

  if (!session.last_opened_at) return true
  return session.last_opened_at < session.updated_at
}
