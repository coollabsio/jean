import type {
  DependabotAlert,
  GitHubIssue,
  GitHubPullRequest,
  RepositoryAdvisory,
} from '@/types/github'
import type { LinearIssue } from '@/types/linear'
import type { SentryIssue } from '@/types/sentry'

export type NewSessionTabId =
  | 'quick'
  | 'issues'
  | 'prs'
  | 'security'
  | 'branches'
  | 'linear'
  | 'pipeline'
  | 'sentry'

export type NewSessionSource =
  | { type: 'issue'; item: GitHubIssue }
  | { type: 'pr'; item: GitHubPullRequest }
  | { type: 'stack-pr'; item: GitHubPullRequest }
  | { type: 'security'; item: DependabotAlert }
  | { type: 'advisory'; item: RepositoryAdvisory }
  | { type: 'branch'; branch: string }
  | { type: 'base' }
  | { type: 'linear'; item: LinearIssue }
  | { type: 'sentry'; item: SentryIssue }

export interface NewSessionSourceContext {
  type: NewSessionSource['type']
  kind: string
  label: string
}

export function describeNewSessionSource(
  source: NewSessionSource
): NewSessionSourceContext {
  switch (source.type) {
    case 'issue':
      return {
        type: source.type,
        kind: `GitHub issue #${source.item.number}`,
        label: source.item.title,
      }
    case 'pr':
      return {
        type: source.type,
        kind: `Pull request #${source.item.number}`,
        label: source.item.title,
      }
    case 'stack-pr':
      return {
        type: source.type,
        kind: `Stack on PR #${source.item.number}`,
        label: source.item.title,
      }
    case 'security':
      return {
        type: source.type,
        kind: `Security alert #${source.item.number}`,
        label: source.item.summary,
      }
    case 'advisory':
      return {
        type: source.type,
        kind: source.item.ghsaId,
        label: source.item.summary,
      }
    case 'branch':
      return {
        type: source.type,
        kind: 'Existing branch',
        label: source.branch,
      }
    case 'base':
      return {
        type: source.type,
        kind: 'Project folder',
        label: 'Work directly on the base checkout',
      }
    case 'linear':
      return {
        type: source.type,
        kind: source.item.identifier,
        label: source.item.title,
      }
    case 'sentry':
      return {
        type: source.type,
        kind: source.item.shortId,
        label: source.item.title,
      }
  }
}

export function sourceContextOwnsBranch(
  source: NewSessionSource | NewSessionSourceContext | null
): boolean {
  return (
    source?.type === 'pr' ||
    source?.type === 'stack-pr' ||
    source?.type === 'branch' ||
    source?.type === 'base'
  )
}

export function getNewSessionSubmitLabel(
  source: Pick<NewSessionSource, 'type'> | null
): string {
  switch (source?.type) {
    case 'pr':
      return 'Check out PR & start'
    case 'stack-pr':
      return 'Create stacked worktree'
    case 'branch':
      return 'Open branch in worktree'
    case 'base':
      return 'Start in project folder'
    default:
      return 'Create worktree & start'
  }
}

export function getNewSessionContextDescription(
  source: Pick<NewSessionSource, 'type'> | null
): string | null {
  switch (source?.type) {
    case 'issue':
      return 'The agent receives the issue title, description, labels and discussion.'
    case 'pr':
    case 'stack-pr':
      return 'The agent receives the PR description, comments, reviews and branch details.'
    case 'security':
    case 'advisory':
      return 'The agent receives the advisory, dependency and remediation details.'
    case 'linear':
      return 'The agent receives the Linear description, status and labels.'
    case 'sentry':
      return 'The agent receives the error details, stack trace and event metadata.'
    case 'branch':
      return 'Jean checks out this existing branch without creating a new one.'
    case 'base':
      return 'No isolated worktree is created for this session.'
    default:
      return null
  }
}

export function getNewSessionDialogSizeClass(
  activeTab: NewSessionTabId
): string {
  return activeTab === 'quick'
    ? 'sm:!w-[760px] sm:!max-w-[calc(100vw-2rem)] sm:!h-auto sm:!max-h-[calc(100vh-2rem)]'
    : 'sm:!w-[90vw] sm:!max-w-[90vw] sm:!h-[85vh] sm:!max-h-[85vh]'
}
