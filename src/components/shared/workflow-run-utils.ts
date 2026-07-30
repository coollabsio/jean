import type { Session } from '@/types/chat'
import type { WorkflowRun } from '@/types/github'

/** Cap persisted seen IDs so UI state cannot grow without bound. */
export const MAX_SEEN_FAILED_WORKFLOW_RUN_IDS = 500

export function isReusableWorkflowInvestigationSession(
  session: Session
): boolean {
  return (
    !session.archived_at &&
    !session.is_reviewing &&
    !session.name.startsWith('Code Review') &&
    (session.message_count === 0 || session.message_count == null)
  )
}

export function isFailedWorkflowRun(run: WorkflowRun): boolean {
  return run.conclusion === 'failure' || run.conclusion === 'startup_failure'
}

/**
 * Latest run per workflow name that failed.
 * Assumes `runs` are sorted newest-first (gh run list order).
 */
export function getLatestFailedWorkflowRuns(
  runs: WorkflowRun[]
): WorkflowRun[] {
  const seenWorkflows = new Set<string>()
  const latestFailed: WorkflowRun[] = []

  for (const run of runs) {
    if (seenWorkflows.has(run.workflowName)) continue
    seenWorkflows.add(run.workflowName)
    if (isFailedWorkflowRun(run)) {
      latestFailed.push(run)
    }
  }

  return latestFailed
}

/** Count latest failed runs that the user has not opened yet. */
export function countUnreadFailedWorkflowRuns(
  runs: WorkflowRun[],
  seenIds: Iterable<number>
): number {
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds)
  let count = 0
  for (const run of getLatestFailedWorkflowRuns(runs)) {
    if (!seen.has(run.databaseId)) count++
  }
  return count
}

/**
 * Merge newly seen failed-run IDs into the existing list, newest-first,
 * de-duplicated, and capped. Returns the same array reference when nothing
 * changes.
 */
export function mergeSeenFailedWorkflowRunIds(
  existing: number[],
  newlySeen: number[]
): number[] {
  if (newlySeen.length === 0) return existing

  const existingSet = new Set(existing)
  const uniqueNovel: number[] = []
  const novelSeen = new Set<number>()
  for (const id of newlySeen) {
    if (existingSet.has(id) || novelSeen.has(id)) continue
    novelSeen.add(id)
    uniqueNovel.push(id)
  }
  if (uniqueNovel.length === 0) return existing

  const next = [...uniqueNovel, ...existing]
  if (next.length > MAX_SEEN_FAILED_WORKFLOW_RUN_IDS) {
    return next.slice(0, MAX_SEEN_FAILED_WORKFLOW_RUN_IDS)
  }
  return next
}
