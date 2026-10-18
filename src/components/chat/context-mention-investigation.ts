import { invoke } from '@/lib/transport'
import { queryClient } from '@/lib/query-client'
import {
  githubQueryKeys,
  loadAdvisoryContext,
  loadIssueContext,
  loadPRContext,
  loadSecurityContext,
} from '@/services/github'
import { linearQueryKeys, loadLinearIssueContext } from '@/services/linear'
import { preferencesQueryKeys } from '@/services/preferences'
import { processBackgroundInvestigation } from '@/hooks/useBackgroundInvestigation'
import { useChatStore } from '@/store/chat-store'
import type { Session } from '@/types/chat'
import {
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_PR_PROMPT,
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

/** Investigate prompt for the selected issues and PRs, one paragraph each. */
export function buildInvestigatePrompt(
  items: ContextMentionItem[],
  issueTemplate: string | null | undefined,
  prTemplate: string | null | undefined
): string {
  const issues = items.flatMap(item => (item.issue ? [item.issue.number] : []))
  const prs = items.flatMap(item => (item.pr ? [item.pr.number] : []))
  const refs = (numbers: number[]) => numbers.map(n => `#${n}`).join(', ')
  const parts: string[] = []
  if (issues.length > 0) {
    parts.push(
      (issueTemplate?.trim() || DEFAULT_INVESTIGATE_ISSUE_PROMPT)
        .replace(/\{issueWord\}/g, issues.length === 1 ? 'issue' : 'issues')
        .replace(/\{issueRefs\}/g, refs(issues))
    )
  }
  if (prs.length > 0) {
    parts.push(
      (prTemplate?.trim() || DEFAULT_INVESTIGATE_PR_PROMPT)
        .replace(/\{prWord\}/g, prs.length === 1 ? 'PR' : 'PRs')
        .replace(/\{prRefs\}/g, refs(prs))
    )
  }
  return parts.join('\n\n')
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
  issueTemplate,
  prTemplate,
  openSession,
}: {
  items: ContextMentionItem[]
  worktreeId: string
  worktreePath: string
  projectId: string | null | undefined
  issueTemplate: string | null | undefined
  prTemplate: string | null | undefined
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
    items.some(item => item.issue) ? 'issue' : 'pr',
    queryClient.getQueryData<AppPreferences>(
      preferencesQueryKeys.preferences()
    ),
    null,
    queryClient,
    {
      sessionId: session.id,
      prompt: buildInvestigatePrompt(items, issueTemplate, prTemplate),
      openSession,
    }
  )
}
