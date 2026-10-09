import {
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUpToLine,
  BookmarkPlus,
  Bug,
  CircleDot,
  Eye,
  FileText,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  ListChecks,
  Link2,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Undo2,
} from '@/components/icons/reicon'

/*
 * Shared magic menu definition. Used by MagicModal (desktop + mobile grid) and
 * the chat toolbar MobileToolbarMenu, so the item lists cannot drift apart.
 */

export type MagicOption =
  | 'save-context'
  | 'load-context'
  | 'inject-session'
  | 'linked-projects'
  | 'fork-session'
  | 'check-github-issues'
  | 'commit'
  | 'commit-and-push'
  | 'commit-in-session'
  | 'comment-and-close-issue'
  | 'pull'
  | 'push'
  | 'sync'
  | 'open-pr'
  | 'link-pr'
  | 'update-pr'
  | 'review'
  | 'merge'
  | 'resolve-conflicts'
  | 'release-notes'
  | 'pre-release-review'
  | 'investigate-issue'
  | 'investigate-pr'
  | 'investigate-advisory'
  | 'merge-pr'
  | 'review-comments'
  | 'revert-last-commit'

/** Options shown as menu items (load-context is only reachable via events). */
export type MagicMenuOption = Exclude<MagicOption, 'load-context'>

export interface MagicOptionItem {
  id: MagicMenuOption
  label: string
  icon: typeof GitCommitHorizontal
  key: string
}

export interface MagicSection {
  header: string
  options: MagicOptionItem[]
}

export interface MagicColumns {
  left: MagicSection[]
  right: MagicSection[]
  all: MagicSection[]
}

export interface MagicOptionAvailability {
  hasOpenPr: boolean
  hasIssueContexts: boolean
  hasSentryContexts: boolean
  hasPrContexts: boolean
  hasAdvisoryContexts: boolean
}

/** Whether an option is unavailable because required context is missing. */
export function isMagicOptionUnavailable(
  option: MagicOption,
  {
    hasOpenPr,
    hasIssueContexts,
    hasSentryContexts,
    hasPrContexts,
    hasAdvisoryContexts,
  }: MagicOptionAvailability
): boolean {
  switch (option) {
    case 'comment-and-close-issue':
      return !hasIssueContexts
    case 'investigate-issue':
      return !hasIssueContexts && !hasSentryContexts
    case 'investigate-pr':
      return !hasPrContexts
    case 'investigate-advisory':
      return !hasAdvisoryContexts
    case 'review-comments':
    case 'merge-pr':
      return !hasOpenPr
    default:
      return false
  }
}

export function buildMagicColumns(hasOpenPr: boolean): MagicColumns {
  const left: MagicSection[] = [
    {
      header: 'Context',
      options: [
        {
          id: 'save-context',
          label: 'Save Context',
          icon: BookmarkPlus,
          key: 'S',
        },
        {
          id: 'inject-session',
          label: 'Inject Context',
          icon: MessageSquare,
          key: 'J',
        },
        {
          id: 'linked-projects',
          label: 'Linked Projects',
          icon: Link2,
          key: 'K',
        },
        {
          id: 'fork-session',
          label: 'Fork Session',
          icon: GitBranchPlus,
          key: 'W',
        },
        {
          id: 'check-github-issues',
          label: 'Check GitHub Issues',
          icon: Bug,
          key: 'Q',
        },
      ],
    },
    {
      header: 'Commit',
      options: [
        { id: 'commit', label: 'Commit', icon: GitCommitHorizontal, key: 'C' },
        {
          id: 'commit-and-push',
          label: 'Commit & Push',
          icon: GitCommitHorizontal,
          key: 'P',
        },
        {
          id: 'commit-in-session',
          label: 'Commit in Session',
          icon: GitCommitHorizontal,
          key: 'L',
        },
        {
          id: 'comment-and-close-issue',
          label: 'Comment & Close Issue',
          icon: GitCommitHorizontal,
          key: 'H',
        },
        {
          id: 'revert-last-commit',
          label: 'Revert Commit',
          icon: Undo2,
          key: 'Z',
        },
      ],
    },
    {
      header: 'Sync',
      options: [
        { id: 'sync', label: 'Sync', icon: ArrowDownUp, key: 'T' },
        { id: 'pull', label: 'Pull', icon: ArrowDownToLine, key: 'D' },
        { id: 'push', label: 'Push', icon: ArrowUpToLine, key: 'U' },
      ],
    },
  ]

  const right: MagicSection[] = [
    {
      header: 'Pull Request',
      options: [
        {
          id: 'open-pr',
          label: hasOpenPr ? 'Open' : 'Create',
          icon: GitPullRequest,
          key: 'O',
        },
        {
          id: 'link-pr',
          label: 'Link PR',
          icon: Link2,
          key: 'B',
        },
        { id: 'review', label: 'Review', icon: Eye, key: 'R' },
        {
          id: 'review-comments',
          label: 'PR Comments',
          icon: MessageSquare,
          key: 'V',
        },
        { id: 'merge-pr', label: 'Merge', icon: GitMerge, key: 'N' },
      ],
    },
    {
      header: 'Release',
      options: [
        {
          id: 'release-notes',
          label: 'Generate Release Notes',
          icon: FileText,
          key: 'G',
        },
        {
          id: 'pre-release-review',
          label: 'Pre-release Review',
          icon: ListChecks,
          key: 'X',
        },
        {
          id: 'update-pr',
          label: 'Generate PR Description',
          icon: RefreshCw,
          key: 'E',
        },
      ],
    },
    {
      header: 'Investigate',
      options: [
        { id: 'investigate-issue', label: 'Issue', icon: CircleDot, key: 'I' },
        {
          id: 'investigate-pr',
          label: 'PR',
          icon: GitPullRequestArrow,
          key: 'A',
        },
        {
          id: 'investigate-advisory',
          label: 'Advisory',
          icon: ShieldAlert,
          key: 'Y',
        },
      ],
    },
    {
      header: 'Branch',
      options: [
        { id: 'merge', label: 'Merge to Base', icon: GitMerge, key: 'M' },
        {
          id: 'resolve-conflicts',
          label: 'Resolve Conflicts',
          icon: GitMerge,
          key: 'F',
        },
      ],
    },
  ]

  return { left, right, all: [...left, ...right] }
}
