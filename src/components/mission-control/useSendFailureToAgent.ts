/**
 * "Corriger avec Jean" — hand a Jenkins failure to the agent in one click.
 *
 * Mirrors the upstream "investigate workflow run" flow (`WorkflowRunsModal`):
 * reuse an empty session (or create one), send the prompt, open the worktree on
 * it. The difference is that the failing log and test names are ALREADY
 * extracted (`get_jenkins_failure_report`), so the prompt carries the evidence
 * instead of asking the agent to go fetch it — there is no Jenkins CLI.
 *
 * Model / execution mode / provider follow the user's `investigate_workflow_run`
 * magic-prompt settings, so both CI investigations behave the same.
 */

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import {
  chatQueryKeys,
  useCreateSession,
  useSendMessage,
} from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import {
  DEFAULT_MAGIC_PROMPT_MODES,
  resolveMagicPromptProvider,
} from '@/types/preferences'
import { resolveBackend } from '@/lib/model-utils'
import type { WorktreeSessions } from '@/types/chat'
import type { JenkinsFailureReport } from '@/types/jenkins'
import type { Project, Worktree } from '@/types/projects'
import { selectRecoverySessionId } from '@/components/jenkins/automatic-recovery'

/** Log lines kept in the prompt — enough for a stack trace, not a whole build. */
const PROMPT_LOG_LINES = 80

/**
 * Build the agent prompt from a failure report.
 *
 * Exported for tests: the prompt IS the feature, so its content is asserted
 * rather than eyeballed.
 */
export function buildFailurePrompt(
  report: JenkinsFailureReport,
  context: { branch: string; prId: string }
): string {
  const where = [
    report.stage && `Stage en échec : ${report.stage}`,
    report.downstreamJob &&
      `Job Jenkins : ${report.downstreamJob} #${report.downstreamNumber}`,
    `PR #${context.prId} · branche \`${context.branch}\``,
    report.consoleUrl && `Console : ${report.consoleUrl}`,
  ]
    .filter(Boolean)
    .join('\n- ')

  const tests = report.failedTests.length
    ? [
        '',
        `<failing-tests count="${report.failedTestCount}">`,
        ...report.failedTests.map(t =>
          [
            `- ${t.className === t.name ? t.name : `${t.className} :: ${t.name}`}`,
            t.message && `  ${t.message.split('\n').join('\n  ')}`,
          ]
            .filter(Boolean)
            .join('\n')
        ),
        '</failing-tests>',
      ].join('\n')
    : ''

  const log = report.logExcerpt
    ? [
        '',
        '<jenkins-log>',
        report.logExcerpt.split('\n').slice(-PROMPT_LOG_LINES).join('\n'),
        '</jenkins-log>',
      ].join('\n')
    : ''

  return `<task>

Le pipeline Jenkins de cette PR est en échec. Corrige la cause.

</task>


<context>

- ${where}
</context>
${tests}${log}

<instructions>

1. Analyse le log et les tests en échec ci-dessus — ils viennent du build Jenkins, tu n'as rien à récupérer.
2. Localise la cause dans le code du worktree courant.
3. Si c'est un vrai bug ou une erreur de compilation : corrige-le, puis lance les tests pertinents.
4. Si les tests passent, crée un commit clair et pousse-le sur la branche courante afin de relancer la CI.
5. N'utilise jamais force-push et ne pousse jamais sur main/master. Si la branche distante a avancé de manière incompatible, arrête-toi et explique le blocage.
6. Si c'est un test instable (flaky) ou un problème d'infra CI : dis-le explicitement et propose la fiabilisation, ne bricole pas le test pour le faire passer et ne crée pas de commit vide.

</instructions>`
}

/**
 * Returns a callback that sends a Jenkins failure to the agent for a worktree.
 * Resolves an empty session (or creates one) before sending, then navigates.
 */
export function useSendFailureToAgent() {
  const queryClient = useQueryClient()
  const createSession = useCreateSession()
  const sendMessage = useSendMessage()
  const { data: preferences } = usePreferences()

  return useCallback(
    async (params: {
      project: Project
      worktree: Worktree
      prId: string
      report: JenkinsFailureReport
      navigate?: boolean
      reuseMostRecent?: boolean
    }) => {
      const {
        project,
        worktree,
        prId,
        report,
        navigate = true,
        reuseMostRecent = false,
      } = params
      const prompt = buildFailurePrompt(report, {
        branch: worktree.branch,
        prId,
      })

      const model =
        preferences?.magic_prompt_models?.investigate_workflow_run_model ??
        'claude-opus-4-8[1m]'
      const executionMode =
        preferences?.magic_prompt_modes?.investigate_workflow_run_mode ??
        DEFAULT_MAGIC_PROMPT_MODES.investigate_workflow_run_mode
      const provider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        'investigate_workflow_run_provider',
        preferences?.default_provider
      )
      // A non-Anthropic provider routes through a saved CLI profile.
      const customProfileName =
        provider && provider !== '__anthropic__'
          ? preferences?.custom_cli_profiles?.find(p => p.name === provider)
              ?.name
          : undefined

      const send = (sessionId: string) => {
        const {
          setActiveWorktree,
          setActiveSession,
          setLastSentMessage,
          setError,
          addSendingSession,
        } = useChatStore.getState()

        setActiveSession(worktree.id, sessionId)
        setLastSentMessage(sessionId, prompt)
        setError(sessionId, null)
        addSendingSession(sessionId)

        sendMessage.mutate({
          sessionId,
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          message: prompt,
          model,
          executionMode,
          backend: resolveBackend(model),
          customProfileName,
          aiLanguage: preferences?.ai_language,
        })

        if (navigate) {
          // Navigate last: the message is already in flight, so the chat opens
          // with the run started (and Mission Control closes on the way).
          useUIStore.getState().setMissionControlOpen(false)
          useProjectsStore.getState().selectProject(project.id)
          useProjectsStore.getState().expandProject(project.id)
          useProjectsStore.getState().selectWorktree(worktree.id)
          setActiveWorktree(worktree.id, worktree.path)
        }
      }

      try {
        const existing = await queryClient
          .fetchQuery({
            queryKey: chatQueryKeys.sessions(worktree.id),
            queryFn: () =>
              invoke<WorktreeSessions>('get_sessions', {
                worktreeId: worktree.id,
                worktreePath: worktree.path,
              }),
            staleTime: 1000 * 5,
          })
          .catch(() => null)

        if (reuseMostRecent) {
          const activeId = useChatStore.getState().getActiveSession(worktree.id)
          const targetId = selectRecoverySessionId(
            activeId,
            (existing?.sessions ?? []).map(session => ({
              id: session.id,
              updatedAt: session.updated_at,
              archived: Boolean(session.archived_at),
            }))
          )
          if (targetId) {
            send(targetId)
            return
          }
        }

        // Manual action keeps its historical behavior: reuse a blank session.
        const empty = existing?.sessions?.find(
          s => !s.archived_at && !s.message_count
        )
        if (empty) {
          send(empty.id)
          return
        }

        createSession.mutate(
          { worktreeId: worktree.id, worktreePath: worktree.path },
          {
            onSuccess: session => send(session.id),
            onError: error => {
              logger.error('Jenkins failure → agent: session creation failed', {
                error,
              })
              toast.error(`Impossible de créer une session : ${error}`)
            },
          }
        )
      } catch (error) {
        logger.error('Jenkins failure → agent failed', { error })
        toast.error(`Impossible d'envoyer l'échec à l'agent : ${error}`)
      }
    },
    [queryClient, createSession, sendMessage, preferences]
  )
}
