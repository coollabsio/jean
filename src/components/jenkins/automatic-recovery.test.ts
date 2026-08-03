// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  derivePrReadiness,
  nextRecoveryAction,
  selectRecoverySessionId,
  type JenkinsRecoveryRecord,
} from './automatic-recovery'

const empty: JenkinsRecoveryRecord = {
  lastHandledBuild: null,
  cycleCount: 0,
  sessionId: null,
  lastAutomatedCommit: null,
}

describe('nextRecoveryAction', () => {
  it('uses the first completed failure as a startup baseline', () => {
    expect(nextRecoveryAction(empty, 41, 'FAILURE', true)).toEqual({
      kind: 'baseline',
      record: { ...empty, lastHandledBuild: 41 },
    })
  })

  it('starts recovery for a new failure observed after startup', () => {
    expect(nextRecoveryAction(empty, 42, 'FAILURE', false)).toEqual({
      kind: 'recover',
      record: { ...empty, lastHandledBuild: 42, cycleCount: 1 },
    })
  })

  it('ignores a duplicate build', () => {
    const record = { ...empty, lastHandledBuild: 42, cycleCount: 1 }
    expect(nextRecoveryAction(record, 42, 'FAILURE', false)).toEqual({
      kind: 'none',
      record,
    })
  })

  it('requires intervention after three automatic cycles', () => {
    const record = { ...empty, lastHandledBuild: 42, cycleCount: 3 }
    expect(nextRecoveryAction(record, 43, 'FAILURE', false)).toEqual({
      kind: 'intervention',
      record: { ...record, lastHandledBuild: 43 },
    })
  })

  it('resets the cycle after success', () => {
    const record = { ...empty, lastHandledBuild: 42, cycleCount: 2 }
    expect(nextRecoveryAction(record, 43, 'SUCCESS', false)).toEqual({
      kind: 'success',
      record: { ...record, lastHandledBuild: 43, cycleCount: 0 },
    })
  })
})

describe('derivePrReadiness', () => {
  it('is testable only when CI succeeds and preview serves the head', () => {
    expect(derivePrReadiness('SUCCESS', 'UP_TO_DATE')).toBe('TESTABLE')
    expect(derivePrReadiness('SUCCESS', 'STALE')).toBe('PREVIEW_STALE')
    expect(derivePrReadiness('SUCCESS', 'DOWN')).toBe('PREVIEW_PENDING')
    expect(derivePrReadiness('BUILDING', 'UP_TO_DATE')).toBe('BUILDING')
    expect(derivePrReadiness('FAILURE', 'UP_TO_DATE')).toBe('FAILURE')
  })
})

describe('selectRecoverySessionId', () => {
  const sessions = [
    { id: 'old', updatedAt: 10, archived: false },
    { id: 'recent', updatedAt: 30, archived: false },
    { id: 'archived', updatedAt: 40, archived: true },
  ]

  it('prefers the active non-archived session', () => {
    expect(selectRecoverySessionId('old', sessions)).toBe('old')
  })

  it('falls back to the most recent non-archived session', () => {
    expect(selectRecoverySessionId('missing', sessions)).toBe('recent')
  })
})
