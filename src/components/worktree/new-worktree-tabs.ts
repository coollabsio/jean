import {
  Zap,
  CircleDot,
  GitPullRequest,
  Shield,
  GitBranch,
  Sentry,
  MessagesSquare,
} from '@/components/icons/reicon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type { LucideIcon } from '@/components/icons/reicon'

export type TabId =
  | 'quick'
  | 'issues'
  | 'prs'
  | 'security'
  | 'branches'
  | 'linear'
  | 'sentry'
  | 'discussions'

export interface Tab {
  id: TabId
  label: string
  key: string
  icon: LucideIcon
}

/** New Session tabs in display order; `key` is the ⌘/Ctrl+digit shortcut. */
export const TABS: Tab[] = [
  { id: 'quick', label: 'Actions', key: '1', icon: Zap },
  { id: 'issues', label: 'Issues', key: '2', icon: CircleDot },
  { id: 'prs', label: 'PRs', key: '3', icon: GitPullRequest },
  { id: 'discussions', label: 'Discussions', key: '4', icon: MessagesSquare },
  { id: 'security', label: 'Security', key: '5', icon: Shield },
  { id: 'branches', label: 'Branches', key: '6', icon: GitBranch },
  { id: 'linear', label: 'Linear', key: '7', icon: LinearIcon },
  { id: 'sentry', label: 'Sentry', key: '8', icon: Sentry },
]

/** Tabs that only exist for GitHub projects (hidden for GitLab). */
export const GITHUB_ONLY_TABS: ReadonlySet<TabId> = new Set([
  'security',
  'discussions',
])
