import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { useAllSessions } from '@/services/chat'
import { useWorktrees } from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { Worktree } from '@/types/projects'

export type ContextLinkType =
  | 'issue'
  | 'pr'
  | 'security'
  | 'advisory'
  | 'linear'

export interface ContextLinkRef {
  type: ContextLinkType
  /** Issue/PR/alert number, GHSA ID, or Linear identifier */
  id: number | string
}

/** An existing worktree (and optionally a session in it) that uses an item */
export interface ContextLinkMatch {
  worktreeId: string
  worktreeName: string
  worktreePath: string
  sessionId?: string
  sessionName?: string
}

interface ContextLinkUsageResponse {
  issues: Record<string, string[]>
  prs: Record<string, string[]>
  security: Record<string, string[]>
  advisories: Record<string, string[]>
  linear: Record<string, string[]>
}

const usageField: Record<ContextLinkType, keyof ContextLinkUsageResponse> = {
  issue: 'issues',
  pr: 'prs',
  security: 'security',
  advisory: 'advisories',
  linear: 'linear',
}

function worktreeLinkId(
  worktree: Worktree,
  type: ContextLinkType
): number | string | undefined {
  switch (type) {
    case 'issue':
      return worktree.issue_number
    case 'pr':
      return worktree.pr_number
    case 'security':
      return worktree.security_alert_number
    case 'advisory':
      return worktree.advisory_ghsa_id
    case 'linear':
      return worktree.linear_issue_identifier
  }
}

function normalizeId(id: number | string): string {
  return String(id).toLowerCase()
}

export const contextLinkUsageQueryKey = ['context-link-usage'] as const

/**
 * Find existing worktrees/sessions of a project that already use an issue,
 * PR, security alert, advisory, or Linear issue. Sources: the worktree link
 * fields (worktrees created from an item) and the shared context references
 * (contexts loaded into a session or worktree). Stale IDs are ignored.
 */
export function useContextLinkUsage({
  enabled,
  projectId,
  projectPath,
  currentSessionId,
}: {
  enabled: boolean
  projectId: string | null
  projectPath: string | null
  /** Ignore this session and its worktree-level link (the caller's own) */
  currentSessionId?: string
}) {
  const active = enabled && Boolean(projectId || projectPath)
  const { data: usage } = useQuery({
    queryKey: [...contextLinkUsageQueryKey, projectPath, projectId],
    queryFn: () =>
      invoke<ContextLinkUsageResponse>('get_context_link_usage', {
        projectPath,
        projectId,
      }),
    enabled: active,
    staleTime: 0,
  })
  const { data: worktrees } = useWorktrees(projectId, {
    enabled: active && Boolean(projectId),
  })
  const { data: allSessions } = useAllSessions(active)

  const index = useMemo(() => {
    const worktreeById = new Map<string, ContextLinkMatch>()
    const sessionById = new Map<string, ContextLinkMatch>()
    const projectWorktrees = (worktrees ?? []).filter(
      wt =>
        !wt.archived_at && wt.status !== 'pending' && wt.status !== 'deleting'
    )
    for (const wt of projectWorktrees) {
      worktreeById.set(wt.id, {
        worktreeId: wt.id,
        worktreeName: wt.name,
        worktreePath: wt.path,
      })
    }
    for (const entry of allSessions?.entries ?? []) {
      const worktree = worktreeById.get(entry.worktree_id)
      if (!worktree || entry.project_id !== projectId) continue
      for (const session of entry.sessions) {
        if (session.archived_at) continue
        sessionById.set(session.id, {
          ...worktree,
          sessionId: session.id,
          sessionName: session.name,
        })
      }
    }
    return { projectWorktrees, worktreeById, sessionById }
  }, [allSessions, projectId, worktrees])

  const getMatches = useCallback(
    (ref: ContextLinkRef): ContextLinkMatch[] => {
      const id = normalizeId(ref.id)
      // One match per worktree; prefer a match that names a session
      const byWorktree = new Map<string, ContextLinkMatch>()
      const add = (match: ContextLinkMatch | undefined) => {
        if (!match) return
        const existing = byWorktree.get(match.worktreeId)
        if (!existing || (!existing.sessionId && match.sessionId)) {
          byWorktree.set(match.worktreeId, match)
        }
      }
      for (const wt of index.projectWorktrees) {
        const linkId = worktreeLinkId(wt, ref.type)
        if (linkId != null && normalizeId(linkId) === id) {
          add(index.worktreeById.get(wt.id))
        }
      }
      const refs = usage?.[usageField[ref.type]] ?? {}
      for (const [key, ids] of Object.entries(refs)) {
        if (normalizeId(key) !== id) continue
        for (const refId of ids) {
          add(index.sessionById.get(refId) ?? index.worktreeById.get(refId))
        }
      }
      const currentWorktreeId = currentSessionId
        ? index.sessionById.get(currentSessionId)?.worktreeId
        : undefined
      return Array.from(byWorktree.values()).filter(match =>
        match.sessionId
          ? match.sessionId !== currentSessionId
          : match.worktreeId !== currentWorktreeId
      )
    },
    [currentSessionId, index, usage]
  )

  return { getMatches }
}

export function contextLinkMatchLabel(match: ContextLinkMatch): string {
  return match.sessionName
    ? `${match.worktreeName} › ${match.sessionName}`
    : match.worktreeName
}

/** Open the worktree/session of a match, keeping the current presentation */
export function openContextLinkMatch(match: ContextLinkMatch): void {
  const projects = useProjectsStore.getState()
  const chat = useChatStore.getState()
  projects.selectWorktree(match.worktreeId)
  chat.registerWorktreePath(match.worktreeId, match.worktreePath)
  if (match.sessionId) {
    chat.setActiveSession(match.worktreeId, match.sessionId)
  }

  if (useUIStore.getState().sessionChatModalOpen || !chat.activeWorktreePath) {
    window.dispatchEvent(
      new CustomEvent('open-worktree-modal', {
        detail: {
          worktreeId: match.worktreeId,
          worktreePath: match.worktreePath,
        },
      })
    )
    return
  }
  chat.setActiveWorktree(match.worktreeId, match.worktreePath)
}
