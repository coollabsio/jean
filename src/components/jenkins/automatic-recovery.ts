export interface JenkinsRecoveryRecord {
  lastHandledBuild: number | null
  cycleCount: number
  sessionId: string | null
  lastAutomatedCommit: string | null
}

export type JenkinsRecoveryAction =
  | 'none'
  | 'baseline'
  | 'recover'
  | 'success'
  | 'intervention'

export function nextRecoveryAction(
  record: JenkinsRecoveryRecord,
  buildNumber: number,
  status: string,
  isStartupBaseline: boolean
): { kind: JenkinsRecoveryAction; record: JenkinsRecoveryRecord } {
  if (record.lastHandledBuild === buildNumber) return { kind: 'none', record }

  if (isStartupBaseline) {
    return {
      kind: 'baseline',
      record: { ...record, lastHandledBuild: buildNumber },
    }
  }

  if (status === 'SUCCESS') {
    return {
      kind: 'success',
      record: { ...record, lastHandledBuild: buildNumber, cycleCount: 0 },
    }
  }

  if (status !== 'FAILURE') return { kind: 'none', record }

  if (record.cycleCount >= 3) {
    return {
      kind: 'intervention',
      record: { ...record, lastHandledBuild: buildNumber },
    }
  }

  return {
    kind: 'recover',
    record: {
      ...record,
      lastHandledBuild: buildNumber,
      cycleCount: record.cycleCount + 1,
    },
  }
}

export type PrReadiness =
  | 'BUILDING'
  | 'FAILURE'
  | 'PREVIEW_PENDING'
  | 'PREVIEW_STALE'
  | 'TESTABLE'
  | 'UNKNOWN'

export function derivePrReadiness(
  overallStatus: string,
  previewFreshness: string | null | undefined
): PrReadiness {
  if (overallStatus === 'FAILURE') return 'FAILURE'
  if (overallStatus === 'BUILDING' || overallStatus === 'QUEUED') {
    return 'BUILDING'
  }
  if (overallStatus !== 'SUCCESS') return 'UNKNOWN'
  if (previewFreshness === 'UP_TO_DATE') return 'TESTABLE'
  if (previewFreshness === 'STALE') return 'PREVIEW_STALE'
  return 'PREVIEW_PENDING'
}

export function selectRecoverySessionId(
  activeSessionId: string | null | undefined,
  sessions: { id: string; updatedAt: number; archived: boolean }[]
): string | null {
  const active = sessions.find(
    session => session.id === activeSessionId && !session.archived
  )
  if (active) return active.id

  return (
    sessions
      .filter(session => !session.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null
  )
}
