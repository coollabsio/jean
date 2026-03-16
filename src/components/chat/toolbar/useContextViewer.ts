import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import type {
  AttachedSavedContext,
  LoadedIssueContext,
  LoadedPullRequestContext,
  LoadedSecurityAlertContext,
  LoadedAdvisoryContext,
} from '@/types/github'
import type { LoadedLinearIssueContext } from '@/types/linear'
import {
  getIssueContextContent,
  getPRContextContent,
  getSavedContextContent,
  getSecurityContextContent,
  getAdvisoryContextContent,
} from '@/services/github'
import type { ViewingContext } from '@/components/chat/toolbar/types'

interface LinearIssueContextContent {
  identifier: string
  title: string
  content: string
}

interface UseContextViewerArgs {
  activeSessionId: string | null | undefined
  activeWorktreePath: string | undefined
  worktreeId: string | null | undefined
  projectId: string | undefined
}

export function useContextViewer({
  activeSessionId,
  activeWorktreePath,
  worktreeId,
  projectId,
}: UseContextViewerArgs) {
  const [viewingContext, setViewingContext] = useState<ViewingContext | null>(null)

  const handleViewIssue = useCallback(
    async (ctx: LoadedIssueContext) => {
      if (!activeSessionId || !activeWorktreePath) return
      try {
        const content = await getIssueContextContent(
          activeSessionId,
          ctx.number,
          activeWorktreePath
        )
        setViewingContext({
          type: 'issue',
          number: ctx.number,
          title: ctx.title,
          content,
        })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [activeSessionId, activeWorktreePath]
  )

  const handleViewPR = useCallback(
    async (ctx: LoadedPullRequestContext) => {
      if (!activeSessionId || !activeWorktreePath) return
      try {
        const content = await getPRContextContent(
          activeSessionId,
          ctx.number,
          activeWorktreePath
        )
        setViewingContext({
          type: 'pr',
          number: ctx.number,
          title: ctx.title,
          content,
        })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [activeSessionId, activeWorktreePath]
  )

  const handleViewSavedContext = useCallback(
    async (ctx: AttachedSavedContext) => {
      if (!activeSessionId) return
      try {
        const content = await getSavedContextContent(activeSessionId, ctx.slug)
        setViewingContext({
          type: 'saved',
          slug: ctx.slug,
          title: ctx.name || ctx.slug,
          content,
        })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [activeSessionId]
  )

  const handleViewSecurityAlert = useCallback(
    async (ctx: LoadedSecurityAlertContext) => {
      if (!activeSessionId || !activeWorktreePath) return
      try {
        const content = await getSecurityContextContent(
          activeSessionId,
          ctx.number,
          activeWorktreePath
        )
        setViewingContext({
          type: 'security',
          number: ctx.number,
          title: `${ctx.packageName} — ${ctx.summary}`,
          content,
        })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [activeSessionId, activeWorktreePath]
  )

  const handleViewAdvisory = useCallback(
    async (ctx: LoadedAdvisoryContext) => {
      if (!activeSessionId || !activeWorktreePath) return
      try {
        const content = await getAdvisoryContextContent(
          activeSessionId,
          ctx.ghsaId,
          activeWorktreePath
        )
        setViewingContext({
          type: 'advisory',
          ghsaId: ctx.ghsaId,
          title: `${ctx.ghsaId} — ${ctx.summary}`,
          content,
        })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [activeSessionId, activeWorktreePath]
  )

  const handleViewLinear = useCallback(
    async (ctx: LoadedLinearIssueContext) => {
      if (!activeSessionId || !projectId) return
      try {
        const contents = await invoke<LinearIssueContextContent[]>(
          'get_linear_issue_context_contents',
          {
            sessionId: activeSessionId,
            worktreeId: worktreeId ?? undefined,
            projectId,
          }
        )
        const match = contents.find(c => c.identifier === ctx.identifier)
        setViewingContext({
          type: 'linear',
          identifier: ctx.identifier,
          title: `${ctx.identifier}: ${ctx.title}`,
          content: match?.content ?? '',
        })
      } catch (error) {
        toast.error(`Failed to load context: ${error}`)
      }
    },
    [activeSessionId, worktreeId, projectId]
  )

  return {
    viewingContext,
    setViewingContext,
    handleViewIssue,
    handleViewPR,
    handleViewSavedContext,
    handleViewSecurityAlert,
    handleViewAdvisory,
    handleViewLinear,
  }
}
