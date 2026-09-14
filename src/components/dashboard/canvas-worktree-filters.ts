import type { LucideIcon } from 'lucide-react'
import {
  Bot,
  CircleDot,
  GitBranch,
  GitPullRequestArrow,
  Home,
  ShieldAlert,
} from 'lucide-react'
import { getWorktreeLabels } from '@/lib/worktree-labels'
import { isBaseSession, type Worktree } from '@/types/projects'

export type CanvasPredefinedFilterTab =
  | 'all'
  | 'manual'
  | 'issues'
  | 'prs'
  | 'security'
  | 'auto_fix'
export type CanvasLabelFilterTab = `label:${string}`
export type CanvasFilterTab = CanvasPredefinedFilterTab | CanvasLabelFilterTab

export interface CanvasPredefinedFilterTabItem {
  value: CanvasPredefinedFilterTab
  label: string
  icon: LucideIcon
  settingsPane?: string
  settingsPlacement?: 'inside'
  badge?: string
}

export const CANVAS_FILTER_TABS: CanvasPredefinedFilterTabItem[] = [
  { value: 'all', label: 'All', icon: Home },
  { value: 'manual', label: 'Manual', icon: GitBranch },
  { value: 'issues', label: 'Issues', icon: CircleDot },
  { value: 'prs', label: 'PRs', icon: GitPullRequestArrow },
  { value: 'security', label: 'Security', icon: ShieldAlert },
  {
    value: 'auto_fix',
    label: 'Mr. Robot',
    icon: Bot,
    settingsPane: 'auto-fix',
    settingsPlacement: 'inside',
    badge: 'Beta',
  },
]

export function isLabelFilterTab(
  value: CanvasFilterTab
): value is CanvasLabelFilterTab {
  return value.startsWith('label:')
}

export function isAutoFixWorktree(worktree: Worktree): boolean {
  return worktree.origin === 'auto_fix'
}

export function isIssueWorktree(worktree: Worktree): boolean {
  return (
    worktree.issue_number != null || !!worktree.linear_issue_identifier?.trim()
  )
}

export function isPrWorktree(worktree: Worktree): boolean {
  return worktree.pr_number != null
}

export function isSecurityWorktree(worktree: Worktree): boolean {
  return (
    worktree.security_alert_number != null ||
    !!worktree.advisory_ghsa_id?.trim()
  )
}

export function isManualWorktree(worktree: Worktree): boolean {
  return (
    !isBaseSession(worktree) &&
    !isAutoFixWorktree(worktree) &&
    !isIssueWorktree(worktree) &&
    !isPrWorktree(worktree) &&
    !isSecurityWorktree(worktree)
  )
}

export function matchesCanvasFilterTab(
  worktree: Worktree,
  activeFilterTab: CanvasFilterTab
): boolean {
  if (isLabelFilterTab(activeFilterTab)) {
    const labelName = activeFilterTab.slice('label:'.length).toLowerCase()
    return getWorktreeLabels(worktree).some(
      label => label.name.toLowerCase() === labelName
    )
  }

  switch (activeFilterTab) {
    case 'all':
      return !isAutoFixWorktree(worktree)
    case 'manual':
      return isManualWorktree(worktree)
    case 'issues':
      return isIssueWorktree(worktree) && !isAutoFixWorktree(worktree)
    case 'prs':
      return isPrWorktree(worktree) && !isAutoFixWorktree(worktree)
    case 'security':
      return isSecurityWorktree(worktree) && !isAutoFixWorktree(worktree)
    case 'auto_fix':
      return isAutoFixWorktree(worktree)
  }
}

export function getCanvasFilterTabCount(
  worktrees: Worktree[],
  tab: CanvasPredefinedFilterTab
): number {
  return worktrees.filter(worktree => matchesCanvasFilterTab(worktree, tab))
    .length
}

export function matchesCanvasWorktreeSearch(
  worktree: Worktree,
  searchQuery: string
): boolean {
  const query = searchQuery.trim().toLowerCase()
  if (!query) return true

  return (
    worktree.name.toLowerCase().includes(query) ||
    worktree.branch.toLowerCase().includes(query) ||
    getWorktreeLabels(worktree).some(label =>
      label.name.toLowerCase().includes(query)
    ) ||
    (worktree.pr_number != null &&
      worktree.pr_number.toString().includes(query)) ||
    (worktree.issue_number != null &&
      worktree.issue_number.toString().includes(query)) ||
    (worktree.linear_issue_identifier ?? '').toLowerCase().includes(query) ||
    (worktree.security_alert_number != null &&
      worktree.security_alert_number.toString().includes(query)) ||
    (worktree.advisory_ghsa_id ?? '').toLowerCase().includes(query)
  )
}

export function shouldShowCanvasWorktreeSection(worktree: Worktree): boolean {
  return worktree.status !== 'deleting'
}
