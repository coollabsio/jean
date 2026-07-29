import type { WorktreeStatus } from '@/types/projects'

export type WorktreeCategory =
  | 'needs_brain'
  | 'ai_running'
  | 'monitoring'
  | 'standby'
  | 'calm'

export const WORKTREE_CATEGORY_ORDER: WorktreeCategory[] = [
  'needs_brain',
  'ai_running',
  'monitoring',
  'standby',
  'calm',
]

interface WorktreeCategorySignals {
  isBase: boolean
  worktreeStatus?: WorktreeStatus
  standbyReason?: string
  standbyUntil?: number
  hasHumanAttention: boolean
  hasAiActivity: boolean
  hasPullRequest: boolean
  ciOverallStatus?: string
  previewStatus?: string
  now: number
}

export function isActiveStandby({
  reason,
  until,
  now,
}: {
  reason?: string
  until?: number
  now: number
}): boolean {
  return !!reason?.trim() && !!until && until > now
}

export function classifyWorktreeCategory({
  isBase,
  worktreeStatus,
  standbyReason,
  standbyUntil,
  hasHumanAttention,
  hasAiActivity,
  hasPullRequest,
  ciOverallStatus,
  previewStatus,
  now,
}: WorktreeCategorySignals): WorktreeCategory {
  if (
    ciOverallStatus === 'BUILDING' ||
    ciOverallStatus === 'QUEUED' ||
    previewStatus === 'STALE'
  ) {
    return 'monitoring'
  }

  if (hasHumanAttention) return 'needs_brain'
  if (hasAiActivity) return 'ai_running'
  if (worktreeStatus === 'pending') return 'monitoring'

  if (
    isActiveStandby({
      reason: standbyReason,
      until: standbyUntil,
      now,
    })
  ) {
    return 'standby'
  }

  if (worktreeStatus === 'error') return 'needs_brain'

  if (ciOverallStatus === 'FAILURE' || previewStatus === 'DOWN') {
    return 'needs_brain'
  }

  if (hasPullRequest && (!ciOverallStatus || ciOverallStatus === 'UNKNOWN')) {
    return 'monitoring'
  }

  if (hasPullRequest || isBase) return 'calm'
  return 'needs_brain'
}

export function groupWorktreesByCategory<T>(
  entries: { item: T; category: WorktreeCategory }[]
): { category: WorktreeCategory; items: T[] }[] {
  return WORKTREE_CATEGORY_ORDER.map(category => ({
    category,
    items: entries
      .filter(entry => entry.category === category)
      .map(entry => entry.item),
  }))
}
