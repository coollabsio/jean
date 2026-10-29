import { invoke } from '@/lib/transport'
import { queryClient } from '@/lib/query-client'
import {
  fetchPullRequestContext,
  githubQueryKeys,
  loadAdvisoryContext,
  loadDiscussionContext,
  loadIssueContext,
  loadPRContext,
  loadSecurityContext,
} from '@/services/github'
import { linearQueryKeys, loadLinearIssueContext } from '@/services/linear'
import { preferencesQueryKeys } from '@/services/preferences'
import { processBackgroundInvestigation } from '@/hooks/useBackgroundInvestigation'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { useCreateWorktree } from '@/services/projects'
import type { GitHubPullRequest } from '@/types/github'
import type { Session } from '@/types/chat'
import {
  DEFAULT_INVESTIGATE_ADVISORY_PROMPT,
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_PR_PROMPT,
  DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT,
  type AppPreferences,
} from '@/types/preferences'
import type { ContextMentionItem } from './hooks/useContextMentionData'

/** Load one context-menu item into a session's context. */
export async function loadContextMentionItem(
  sessionId: string,
  item: ContextMentionItem,
  worktreePath: string | undefined,
  projectId: string | null | undefined
): Promise<void> {
  if (item.type === 'issue' && item.issue && worktreePath) {
    await loadIssueContext(sessionId, item.issue.number, worktreePath)
  } else if (item.type === 'pr' && item.pr && worktreePath) {
    await loadPRContext(sessionId, item.pr.number, worktreePath)
  } else if (item.type === 'discussion' && item.discussion && worktreePath) {
    await loadDiscussionContext(sessionId, item.discussion.number, worktreePath)
  } else if (item.type === 'security' && item.securityAlert && worktreePath) {
    await loadSecurityContext(
      sessionId,
      item.securityAlert.number,
      worktreePath
    )
  } else if (item.type === 'advisory' && item.advisory && worktreePath) {
    await loadAdvisoryContext(sessionId, item.advisory.ghsaId, worktreePath)
  } else if (item.type === 'linear' && item.linearIssue && projectId) {
    await loadLinearIssueContext(sessionId, projectId, item.linearIssue.id)
  } else {
    throw new Error('Missing context information')
  }

  // Refresh in the background. Refetching every GitHub/Linear query can
  // take many seconds, and the investigate send must not wait for it.
  void queryClient.invalidateQueries({ queryKey: githubQueryKeys.all })
  void queryClient.invalidateQueries({ queryKey: linearQueryKeys.all })
}

/** Items that can start an investigation from the context links menu. */
export function isInvestigableContextItem(item: ContextMentionItem): boolean {
  return (
    item.type === 'issue' ||
    item.type === 'pr' ||
    item.type === 'security' ||
    item.type === 'advisory'
  )
}

/** Custom investigate prompts; empty values fall back to the defaults. */
export interface InvestigatePromptTemplates {
  issue?: string | null
  pr?: string | null
  securityAlert?: string | null
  advisory?: string | null
}

/** Investigate prompt for the selected items, one paragraph per item type. */
export function buildInvestigatePrompt(
  items: ContextMentionItem[],
  templates: InvestigatePromptTemplates
): string {
  const sections = [
    {
      refs: items.flatMap(item =>
        item.issue ? [`#${item.issue.number}`] : []
      ),
      template: templates.issue?.trim() || DEFAULT_INVESTIGATE_ISSUE_PROMPT,
      word: ['{issueWord}', 'issue', 'issues'],
      refsKey: '{issueRefs}',
    },
    {
      refs: items.flatMap(item => (item.pr ? [`#${item.pr.number}`] : [])),
      template: templates.pr?.trim() || DEFAULT_INVESTIGATE_PR_PROMPT,
      word: ['{prWord}', 'PR', 'PRs'],
      refsKey: '{prRefs}',
    },
    {
      refs: items.flatMap(({ securityAlert: alert }) =>
        alert
          ? [`#${alert.number} ${alert.packageName} (${alert.severity})`]
          : []
      ),
      template:
        templates.securityAlert?.trim() ||
        DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT,
      word: ['{alertWord}', 'alert', 'alerts'],
      refsKey: '{alertRefs}',
    },
    {
      refs: items.flatMap(({ advisory }) =>
        advisory ? [`${advisory.ghsaId} (${advisory.severity})`] : []
      ),
      template:
        templates.advisory?.trim() || DEFAULT_INVESTIGATE_ADVISORY_PROMPT,
      word: ['{advisoryWord}', 'advisory', 'advisories'],
      refsKey: '{advisoryRefs}',
    },
  ] as const
  return sections
    .filter(section => section.refs.length > 0)
    .map(({ refs, template, word: [wordKey, one, many], refsKey }) =>
      template
        .replaceAll(wordKey, refs.length === 1 ? one : many)
        .replaceAll(refsKey, refs.join(', '))
    )
    .join('\n\n')
}

/** Investigation settings (model, mode) follow the first item type. */
function investigationType(items: ContextMentionItem[]) {
  if (items.some(item => item.issue)) return 'issue'
  if (items.some(item => item.pr)) return 'pr'
  if (items.some(item => item.securityAlert)) return 'security-alert'
  return 'advisory'
}

/**
 * Create a new session in the worktree, load every item into its context,
 * and queue one investigation that covers all of them.
 */
export async function investigateInNewSession({
  items,
  worktreeId,
  worktreePath,
  projectId,
  templates,
  openSession,
}: {
  items: ContextMentionItem[]
  worktreeId: string
  worktreePath: string
  projectId: string | null | undefined
  templates: InvestigatePromptTemplates
  openSession: boolean
}): Promise<void> {
  const session = await invoke<Session>('create_session', {
    worktreeId,
    worktreePath,
  })
  await Promise.all(
    items.map(item =>
      loadContextMentionItem(session.id, item, worktreePath, projectId)
    )
  )
  useChatStore.getState().registerWorktreePath(worktreeId, worktreePath)
  await processBackgroundInvestigation(
    worktreeId,
    investigationType(items),
    queryClient.getQueryData<AppPreferences>(
      preferencesQueryKeys.preferences()
    ),
    null,
    queryClient,
    {
      sessionId: session.id,
      prompt: buildInvestigatePrompt(items, templates),
      openSession,
    }
  )
}

export type InvestigationBatch =
  | { kind: 'session'; items: ContextMentionItem[] }
  | { kind: 'pr-worktree'; pr: GitHubPullRequest }

/**
 * Split checked items into investigations. A PR is investigated on its own
 * branch, so each PR gets a new worktree. Other items share one new session
 * in the current worktree, or (separate) get one new session each.
 */
export function planInvestigationBatches(
  items: ContextMentionItem[],
  separate: boolean
): InvestigationBatch[] {
  const sessionItems = items.filter(item => !item.pr)
  const sessionGroups =
    separate || sessionItems.length === 0
      ? sessionItems.map(item => [item])
      : [sessionItems]
  return [
    ...sessionGroups.map(group => ({
      kind: 'session' as const,
      items: group,
    })),
    ...items.flatMap(({ pr }) =>
      pr ? [{ kind: 'pr-worktree' as const, pr }] : []
    ),
  ]
}

/** Create a new worktree on the PR branch and auto-investigate the PR there. */
export async function investigatePRInNewWorktree({
  pr,
  projectId,
  projectPath,
  createWorktree,
  background,
}: {
  pr: GitHubPullRequest
  projectId: string
  projectPath: string
  createWorktree: ReturnType<typeof useCreateWorktree>['mutateAsync']
  background: boolean
}): Promise<void> {
  const prContext = await fetchPullRequestContext(projectPath, pr)
  if (background) useUIStore.getState().incrementPendingBackgroundCreations()
  const worktree = await createWorktree({ projectId, prContext, background })
  useUIStore.getState().markWorktreeForAutoInvestigatePR(worktree.id)
}
