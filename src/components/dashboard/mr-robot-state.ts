import type { AutoFixStatus, Worktree } from '@/types/projects'
import {
  isActionableWaitingStatus,
  type SessionCardData,
} from '@/components/chat/session-card-utils'

export interface RobotWorktreeState {
  label: string
  action: string
  active: boolean
  needsAttention: boolean
  card?: SessionCardData
}

export function getRobotWorktreeState(
  worktree: Worktree,
  cards: SessionCardData[]
): RobotWorktreeState {
  if (worktree.status === 'pending') {
    return {
      label: 'Creating worktree',
      action: 'Open worktree',
      active: true,
      needsAttention: false,
    }
  }
  const active = cards.some(card =>
    ['planning', 'scheduled', 'vibing', 'yoloing', 'reviewing'].includes(
      card.status
    )
  )
  const waiting = cards.find(card => isActionableWaitingStatus(card.status))
  if (waiting) {
    return {
      label:
        waiting.status === 'plan_approval'
          ? 'Awaiting approval'
          : 'Needs input',
      action:
        waiting.status === 'plan_approval' ? 'Review plan' : 'Open session',
      active,
      needsAttention: true,
      card: waiting,
    }
  }
  const running = cards.find(card =>
    ['planning', 'scheduled', 'vibing', 'yoloing', 'reviewing'].includes(
      card.status
    )
  )
  if (running) {
    return {
      label:
        running.status === 'planning'
          ? 'Planning'
          : running.status === 'scheduled'
            ? 'Queued'
            : 'Building',
      action: 'Open session',
      active: true,
      needsAttention: false,
      card: running,
    }
  }
  const failed = cards.find(card => card.status === 'crashed')
  if (worktree.status === 'error' || failed) {
    return {
      label: 'Needs attention',
      action: 'Open details',
      active: false,
      needsAttention: true,
      card: failed,
    }
  }
  if (worktree.pr_url) {
    return {
      label:
        worktree.cached_pr_status === 'MERGED'
          ? 'PR merged'
          : worktree.cached_pr_status === 'CLOSED'
            ? 'PR closed'
            : 'PR ready',
      action: 'Open PR',
      active: false,
      needsAttention: false,
    }
  }
  const review = cards.find(
    card => card.status === 'review' || card.status === 'completed'
  )
  if (review) {
    return {
      label: 'Ready for review',
      action: 'Review result',
      active: false,
      needsAttention: false,
      card: review,
    }
  }
  return {
    label: cards.length ? 'Idle' : 'Waiting for planning',
    action: 'Open worktree',
    active: false,
    needsAttention: false,
    card: cards[0],
  }
}

export function getRobotStatus(
  enabled: boolean,
  status: AutoFixStatus | undefined,
  states: RobotWorktreeState[],
  now: number
): string {
  if (!enabled) return 'Off'
  if (
    status?.lastError ||
    status?.failedIssues.length ||
    states.some(state => state.needsAttention)
  )
    return 'Needs attention'
  if (status?.rateLimitedUntil && status.rateLimitedUntil > now)
    return 'Rate limited'
  if (status?.scanning) return 'Scanning'
  if (states.some(state => state.label === 'Planning')) return 'Planning'
  if (states.some(state => state.active) || status?.startingIssues.length)
    return 'Working'
  if (status?.activeNow === false) return 'Outside active hours'
  return status ? 'Idle' : 'Loading status'
}

export function formatRobotTime(
  timestamp: number | null | undefined,
  now: number
): string {
  if (timestamp == null) return 'Not yet'
  const seconds = timestamp - now
  if (Math.abs(seconds) < 60)
    return seconds > 0 ? 'in less than a minute' : 'just now'
  const minutes = Math.ceil(Math.abs(seconds) / 60)
  const value =
    minutes < 60 ? `${minutes} min` : `${Math.ceil(minutes / 60)} hr`
  return seconds > 0 ? `in ${value}` : `${value} ago`
}
