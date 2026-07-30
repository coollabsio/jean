import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import type { WorkflowRun } from '@/types/github'
import {
  countUnreadFailedWorkflowRuns,
  getLatestFailedWorkflowRuns,
  isFailedWorkflowRun,
  isReusableWorkflowInvestigationSession,
  mergeSeenFailedWorkflowRunIds,
  MAX_SEEN_FAILED_WORKFLOW_RUN_IDS,
} from './workflow-run-utils'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Session 1',
    order: 0,
    created_at: 0,
    updated_at: 0,
    messages: [],
    message_count: 0,
    ...overrides,
  }
}

function run(
  overrides: Partial<WorkflowRun> &
    Pick<WorkflowRun, 'databaseId' | 'workflowName'>
): WorkflowRun {
  return {
    name: 'job',
    displayTitle: `run ${overrides.databaseId}`,
    status: 'completed',
    conclusion: 'failure',
    event: 'push',
    headBranch: 'main',
    createdAt: '2025-01-01T00:00:00Z',
    url: `https://example.com/${overrides.databaseId}`,
    ...overrides,
  }
}

describe('isReusableWorkflowInvestigationSession', () => {
  it('does not reuse an active code review session', () => {
    expect(
      isReusableWorkflowInvestigationSession(
        session({ name: 'Code Review', is_reviewing: true })
      )
    ).toBe(false)
  })

  it('does not reuse an idle code review session', () => {
    expect(
      isReusableWorkflowInvestigationSession(
        session({ name: 'Code Review · Codex · gpt-5.6-sol' })
      )
    ).toBe(false)
  })

  it('reuses an unarchived empty chat session', () => {
    expect(isReusableWorkflowInvestigationSession(session())).toBe(true)
  })

  it('does not reuse non-empty or archived chat sessions', () => {
    expect(
      isReusableWorkflowInvestigationSession(session({ message_count: 1 }))
    ).toBe(false)
    expect(
      isReusableWorkflowInvestigationSession(session({ archived_at: 1 }))
    ).toBe(false)
  })
})

describe('failed workflow unread helpers', () => {
  it('detects failure conclusions', () => {
    expect(
      isFailedWorkflowRun(run({ databaseId: 1, workflowName: 'CI' }))
    ).toBe(true)
    expect(
      isFailedWorkflowRun(
        run({
          databaseId: 2,
          workflowName: 'CI',
          conclusion: 'startup_failure',
        })
      )
    ).toBe(true)
    expect(
      isFailedWorkflowRun(
        run({ databaseId: 3, workflowName: 'CI', conclusion: 'success' })
      )
    ).toBe(false)
  })

  it('takes only the latest run per workflow when counting failures', () => {
    const runs = [
      run({ databaseId: 4, workflowName: 'CI', conclusion: 'success' }),
      run({ databaseId: 3, workflowName: 'Deploy', conclusion: 'failure' }),
      run({ databaseId: 2, workflowName: 'CI', conclusion: 'failure' }),
      run({ databaseId: 1, workflowName: 'Deploy', conclusion: 'failure' }),
    ]

    expect(getLatestFailedWorkflowRuns(runs).map(r => r.databaseId)).toEqual([
      3,
    ])
    expect(countUnreadFailedWorkflowRuns(runs, [])).toBe(1)
  })

  it('excludes seen failed run IDs from the unread count', () => {
    const runs = [
      run({ databaseId: 3, workflowName: 'CI' }),
      run({ databaseId: 2, workflowName: 'Deploy' }),
      run({ databaseId: 1, workflowName: 'Lint', conclusion: 'success' }),
    ]

    expect(countUnreadFailedWorkflowRuns(runs, [])).toBe(2)
    expect(countUnreadFailedWorkflowRuns(runs, [3])).toBe(1)
    expect(countUnreadFailedWorkflowRuns(runs, new Set([3, 2]))).toBe(0)
  })

  it('merges and caps seen IDs newest-first without duplicates', () => {
    expect(mergeSeenFailedWorkflowRunIds([2, 3], [3, 1])).toEqual([1, 2, 3])

    const existingRef = [2, 3]
    expect(mergeSeenFailedWorkflowRunIds(existingRef, [2, 3])).toBe(existingRef)
    expect(mergeSeenFailedWorkflowRunIds(existingRef, [])).toBe(existingRef)

    const existing = Array.from(
      { length: MAX_SEEN_FAILED_WORKFLOW_RUN_IDS },
      (_, i) => i + 1
    )
    const merged = mergeSeenFailedWorkflowRunIds(existing, [999_001])
    expect(merged).toHaveLength(MAX_SEEN_FAILED_WORKFLOW_RUN_IDS)
    expect(merged[0]).toBe(999_001)
    expect(merged).not.toContain(MAX_SEEN_FAILED_WORKFLOW_RUN_IDS)
  })
})
