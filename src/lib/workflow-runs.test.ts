import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearSeenFailedWorkflowRuns,
  countVisibleLatestFailedRuns,
  getLatestFailedRunsByWorkflow,
  getSeenFailedWorkflowRunIds,
  getWorkflowRunsSeenKey,
  isFailedWorkflowRun,
  markFailedWorkflowRunsSeen,
} from './workflow-runs'
import type { WorkflowRun } from '@/types/github'

function makeRun(
  databaseId: number,
  workflowName: string,
  conclusion: WorkflowRun['conclusion']
): WorkflowRun {
  return {
    databaseId,
    name: workflowName,
    displayTitle: `Run ${databaseId}`,
    status: 'completed',
    conclusion,
    event: 'push',
    headBranch: 'main',
    createdAt: '2026-01-01T00:00:00Z',
    url: `https://github.com/acme/app/actions/runs/${databaseId}`,
    workflowName,
  }
}

function mockLocalStorage() {
  const values = new Map<string, string>()

  vi.mocked(window.localStorage.getItem).mockImplementation(
    key => values.get(key) ?? null
  )
  vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => {
    values.set(key, value)
  })
  vi.mocked(window.localStorage.removeItem).mockImplementation(key => {
    values.delete(key)
  })
  vi.mocked(window.localStorage.clear).mockImplementation(() => {
    values.clear()
  })
}

describe('workflow run helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLocalStorage()
  })

  it('detects failed workflow runs', () => {
    expect(isFailedWorkflowRun(makeRun(1, 'CI', 'failure'))).toBe(true)
    expect(isFailedWorkflowRun(makeRun(2, 'CI', 'startup_failure'))).toBe(true)
    expect(isFailedWorkflowRun(makeRun(3, 'CI', 'success'))).toBe(false)
  })

  it('returns only latest failed runs by workflow', () => {
    const runs = [
      makeRun(4, 'CI', 'success'),
      makeRun(3, 'Deploy', 'failure'),
      makeRun(2, 'CI', 'failure'),
      makeRun(1, 'Deploy', 'success'),
    ]

    expect(
      getLatestFailedRunsByWorkflow(runs).map(run => run.databaseId)
    ).toEqual([3])
  })

  it('does not count seen latest failures as visible', () => {
    const runs = [
      makeRun(3, 'CI', 'failure'),
      makeRun(2, 'Deploy', 'startup_failure'),
      makeRun(1, 'CI', 'success'),
    ]

    expect(countVisibleLatestFailedRuns(runs, new Set([3]))).toBe(1)
  })

  it('persists seen failed run ids by project and branch', () => {
    const mainKey = getWorkflowRunsSeenKey('/repo', 'main')
    const allKey = getWorkflowRunsSeenKey('/repo')

    markFailedWorkflowRunsSeen(mainKey, [1, 2, 2])
    markFailedWorkflowRunsSeen(allKey, [3])

    expect([...getSeenFailedWorkflowRunIds(mainKey)]).toEqual([1, 2])
    expect([...getSeenFailedWorkflowRunIds(allKey)]).toEqual([3])

    clearSeenFailedWorkflowRuns(mainKey)

    expect([...getSeenFailedWorkflowRunIds(mainKey)]).toEqual([])
    expect([...getSeenFailedWorkflowRunIds(allKey)]).toEqual([3])
  })
})
