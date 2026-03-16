import { useCallback, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import {
  chatQueryKeys,
} from '@/services/chat'
import { projectsQueryKeys } from '@/services/projects'
import { buildMcpConfigJson } from '@/services/mcp'
import { resolveBackend, supportsAdaptiveThinking } from '@/lib/model-utils'
import {
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_PR_PROMPT,
  DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT,
  DEFAULT_INVESTIGATE_ADVISORY_PROMPT,
  DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT,
  DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT,
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  resolveMagicPromptProvider,
} from '@/types/preferences'
import type { Project, Worktree } from '@/types/projects'
import type {
  ThinkingLevel,
  EffortLevel,
  ExecutionMode,
  Session,
  McpServerInfo,
} from '@/types/chat'
import type { AppPreferences } from '@/types/preferences'

// Re-export for the caller
export interface WorkflowRunDetail {
  workflowName: string
  runUrl: string
  runId: string
  branch: string
  displayTitle: string
  projectPath?: string | null
}


interface UseInvestigateHandlersParams {
  activeSessionId: string | null | undefined
  activeWorktreeId: string | null | undefined
  activeWorktreePath: string | null | undefined
  inputRef: RefObject<HTMLTextAreaElement | null>
  preferences: AppPreferences | undefined
  selectedModelRef: RefObject<string>
  selectedThinkingLevelRef: RefObject<ThinkingLevel>
  selectedEffortLevelRef: RefObject<EffortLevel>
  executionModeRef: RefObject<ExecutionMode>
  mcpServersDataRef: RefObject<McpServerInfo[] | undefined>
  enabledMcpServersRef: RefObject<string[]>
  activeWorktreeIdRef: RefObject<string | null | undefined>
  activeWorktreePathRef: RefObject<string | null | undefined>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMessage: { mutate: (args: any, opts?: any) => void }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSessionProvider: { mutate: (args: any) => void }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSessionBackend: { mutate: (args: any) => void }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSessionModel: { mutate: (args: any) => void }
  createSession: { mutate: (args: { worktreeId: string; worktreePath: string }, opts?: { onSuccess?: (session: { id: string }) => void; onError?: (error: unknown) => void }) => void }
  resolveCustomProfile: (model: string, provider: string | null) => { model: string; customProfileName: string | undefined }
  cliVersion: string | null
  worktreeProjectId: string | null | undefined
}

/**
 * Handles investigate issue/PR and investigate workflow run operations.
 * These are large async callbacks that build prompts from loaded contexts
 * and send investigation messages.
 */
export function useInvestigateHandlers({
  activeSessionId,
  activeWorktreeId,
  activeWorktreePath,
  inputRef,
  preferences,
  selectedModelRef,
  selectedThinkingLevelRef,
  selectedEffortLevelRef,
  executionModeRef,
  mcpServersDataRef,
  enabledMcpServersRef,
  activeWorktreeIdRef,
  activeWorktreePathRef,
  sendMessage,
  setSessionProvider,
  setSessionBackend,
  setSessionModel,
  createSession,
  resolveCustomProfile,
  cliVersion,
  worktreeProjectId,
}: UseInvestigateHandlersParams) {
  const queryClient = useQueryClient()

  const handleInvestigate = useCallback(
    async (type: 'issue' | 'pr' | 'security-alert' | 'advisory' | 'linear-issue') => {
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      const modelKey =
        type === 'issue' ? 'investigate_issue_model'
          : type === 'pr' ? 'investigate_pr_model'
          : type === 'security-alert' ? 'investigate_security_alert_model'
          : type === 'linear-issue' ? 'investigate_linear_issue_model'
          : 'investigate_advisory_model' as const
      const providerKey =
        type === 'issue' ? 'investigate_issue_provider'
          : type === 'pr' ? 'investigate_pr_provider'
          : type === 'security-alert' ? 'investigate_security_alert_provider'
          : type === 'linear-issue' ? 'investigate_linear_issue_provider'
          : 'investigate_advisory_provider' as const
      const investigateModel =
        preferences?.magic_prompt_models?.[modelKey] ?? selectedModelRef.current
      const investigateProvider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        providerKey,
        preferences?.default_provider
      )
      const { customProfileName: resolvedInvestigateProfile } =
        resolveCustomProfile(investigateModel, investigateProvider)

      let prompt: string

      if (type === 'issue') {
        const contexts = await queryClient.fetchQuery({
          queryKey: ['investigate-contexts', 'issue', activeWorktreeId],
          queryFn: () =>
            invoke<{ number: number }[]>('list_loaded_issue_contexts', {
              sessionId: activeWorktreeId,
            }),
          staleTime: 0,
        })
        const refs = (contexts ?? []).map(c => `#${c.number}`).join(', ')
        const word = (contexts ?? []).length === 1 ? 'issue' : 'issues'
        const customPrompt = preferences?.magic_prompts?.investigate_issue
        const template =
          customPrompt && customPrompt.trim()
            ? customPrompt
            : DEFAULT_INVESTIGATE_ISSUE_PROMPT
        prompt = template
          .replace(/\{issueWord\}/g, word)
          .replace(/\{issueRefs\}/g, refs)
      } else if (type === 'pr') {
        const contexts = await queryClient.fetchQuery({
          queryKey: ['investigate-contexts', 'pr', activeWorktreeId],
          queryFn: () =>
            invoke<{ number: number }[]>('list_loaded_pr_contexts', {
              sessionId: activeWorktreeId,
            }),
          staleTime: 0,
        })
        const refs = (contexts ?? []).map(c => `#${c.number}`).join(', ')
        const word = (contexts ?? []).length === 1 ? 'PR' : 'PRs'
        const customPrompt = preferences?.magic_prompts?.investigate_pr
        const template =
          customPrompt && customPrompt.trim()
            ? customPrompt
            : DEFAULT_INVESTIGATE_PR_PROMPT
        prompt = template
          .replace(/\{prWord\}/g, word)
          .replace(/\{prRefs\}/g, refs)
      } else if (type === 'security-alert') {
        const contexts = await queryClient.fetchQuery({
          queryKey: ['investigate-contexts', 'security-alert', activeWorktreeId],
          queryFn: () =>
            invoke<{ number: number; packageName: string; severity: string }[]>(
              'list_loaded_security_contexts',
              { sessionId: activeWorktreeId }
            ),
          staleTime: 0,
        })
        const refs = (contexts ?? []).map(c => `#${c.number} ${c.packageName} (${c.severity})`).join(', ')
        const word = (contexts ?? []).length === 1 ? 'alert' : 'alerts'
        const customPrompt = preferences?.magic_prompts?.investigate_security_alert
        const template =
          customPrompt && customPrompt.trim()
            ? customPrompt
            : DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT
        prompt = template
          .replace(/\{alertWord\}/g, word)
          .replace(/\{alertRefs\}/g, refs)
      } else if (type === 'linear-issue') {
        const projectId = worktreeProjectId ?? ''
        const [contexts, contentItems] = await Promise.all([
          queryClient.fetchQuery({
            queryKey: ['investigate-contexts', 'linear-issue', activeWorktreeId],
            queryFn: () =>
              invoke<{ identifier: string; title: string; commentCount: number; projectName: string }[]>(
                'list_loaded_linear_issue_contexts',
                { sessionId: activeWorktreeId, worktreeId: activeWorktreeId, projectId }
              ),
            staleTime: 0,
          }),
          invoke<{ identifier: string; title: string; content: string }[]>(
            'get_linear_issue_context_contents',
            { sessionId: activeWorktreeId, worktreeId: activeWorktreeId, projectId }
          ),
        ])
        const refs = (contexts ?? []).map(c => c.identifier).join(', ')
        const word = (contexts ?? []).length === 1 ? 'issue' : 'issues'
        const linearContext = (contentItems ?? []).map(c => c.content).join('\n\n---\n\n')
        const customPrompt = preferences?.magic_prompts?.investigate_linear_issue
        const template =
          customPrompt && customPrompt.trim()
            ? customPrompt
            : DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT
        prompt = template
          .replace(/\{linearWord\}/g, word)
          .replace(/\{linearRefs\}/g, refs)
          .replace(/\{linearContext\}/g, linearContext)
      } else {
        const contexts = await queryClient.fetchQuery({
          queryKey: ['investigate-contexts', 'advisory', activeWorktreeId],
          queryFn: () =>
            invoke<{ ghsaId: string; severity: string; summary: string }[]>(
              'list_loaded_advisory_contexts',
              { sessionId: activeWorktreeId }
            ),
          staleTime: 0,
        })
        const refs = (contexts ?? []).map(c => `${c.ghsaId} (${c.severity})`).join(', ')
        const word = (contexts ?? []).length === 1 ? 'advisory' : 'advisories'
        const customPrompt = preferences?.magic_prompts?.investigate_advisory
        const template =
          customPrompt && customPrompt.trim()
            ? customPrompt
            : DEFAULT_INVESTIGATE_ADVISORY_PROMPT
        prompt = template
          .replace(/\{advisoryWord\}/g, word)
          .replace(/\{advisoryRefs\}/g, refs)
      }

      const {
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setSelectedProvider,
        setExecutingMode,
      } = useChatStore.getState()

      setLastSentMessage(activeSessionId, prompt)
      setError(activeSessionId, null)
      addSendingSession(activeSessionId)
      setSelectedModel(activeSessionId, investigateModel)
      setSelectedProvider(activeSessionId, investigateProvider)
      setExecutingMode(activeSessionId, executionModeRef.current)

      setSessionProvider.mutate({
        sessionId: activeSessionId,
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        provider: investigateProvider,
      })

      const investigateIsCustom = Boolean(
        investigateProvider && investigateProvider !== '__anthropic__'
      )
      const investigateUseAdaptive =
        !investigateIsCustom &&
        supportsAdaptiveThinking(investigateModel, cliVersion)

      const investigateBackend = resolveBackend(investigateModel)

      setSessionBackend.mutate({
        sessionId: activeSessionId,
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        backend: investigateBackend,
      })
      setSessionModel.mutate({
        sessionId: activeSessionId,
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        model: investigateModel,
      })

      {
        const { setSelectedBackend: setZustandBackend, setSelectedModel: setZustandModel } =
          useChatStore.getState()
        setZustandBackend(activeSessionId, investigateBackend)
        setZustandModel(activeSessionId, investigateModel)
      }
      queryClient.setQueryData(
        chatQueryKeys.session(activeSessionId),
        (old: Session | null | undefined) =>
          old
            ? {
                ...old,
                backend: investigateBackend,
                selected_model: investigateModel,
              }
            : old
      )

      sendMessage.mutate(
        {
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message: prompt,
          model: investigateModel,
          executionMode: executionModeRef.current,
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: investigateUseAdaptive
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: buildMcpConfigJson(
            mcpServersDataRef.current ?? [],
            enabledMcpServersRef.current,
            investigateBackend
          ),
          customProfileName: resolvedInvestigateProfile,
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
          backend: investigateBackend,
        },
        { onSettled: () => inputRef.current?.focus() }
      )
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      sendMessage,
      queryClient,
      preferences?.magic_prompts?.investigate_issue,
      preferences?.magic_prompts?.investigate_pr,
      preferences?.magic_prompts?.investigate_security_alert,
      preferences?.magic_prompts?.investigate_advisory,
      preferences?.magic_prompts?.investigate_linear_issue,
      preferences?.default_provider,
      preferences?.parallel_execution_prompt_enabled,
      preferences?.magic_prompts?.parallel_execution,
      preferences?.magic_prompt_models,
      preferences?.magic_prompt_providers,
      preferences?.chrome_enabled,
      preferences?.ai_language,
      setSessionProvider,
      setSessionBackend,
      setSessionModel,
      resolveCustomProfile,
      cliVersion,
      inputRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      executionModeRef,
      mcpServersDataRef,
      enabledMcpServersRef,
      worktreeProjectId,
    ]
  )

  const handleInvestigateWorkflowRun = useCallback(
    async (detail: WorkflowRunDetail) => {
      const customPrompt = preferences?.magic_prompts?.investigate_workflow_run
      const template =
        customPrompt && customPrompt.trim()
          ? customPrompt
          : DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT

      const prompt = template
        .replace(/\{workflowName\}/g, detail.workflowName)
        .replace(/\{runUrl\}/g, detail.runUrl)
        .replace(/\{runId\}/g, detail.runId)
        .replace(/\{branch\}/g, detail.branch)
        .replace(/\{displayTitle\}/g, detail.displayTitle)

      const investigateModel =
        preferences?.magic_prompt_models?.investigate_workflow_run_model ??
        selectedModelRef.current
      const investigateProvider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        'investigate_workflow_run_provider',
        preferences?.default_provider
      )
      const { customProfileName: resolvedInvestigateProfile } =
        resolveCustomProfile(investigateModel, investigateProvider)

      // Find the right worktree for this branch
      let targetWorktreeId: string | null = null
      let targetWorktreePath: string | null = null

      if (detail.projectPath) {
        const projects = await queryClient.fetchQuery({
          queryKey: projectsQueryKeys.list(),
          queryFn: () => invoke<Project[]>('list_projects'),
          staleTime: 1000 * 60,
        })
        const project = projects?.find(p => p.path === detail.projectPath)

        if (project) {
          let worktrees: Worktree[] = []
          try {
            worktrees = await queryClient.fetchQuery({
              queryKey: projectsQueryKeys.worktrees(project.id),
              queryFn: () =>
                invoke<Worktree[]>('list_worktrees', {
                  projectId: project.id,
                }),
              staleTime: 1000 * 60,
            })
          } catch (err) {
            console.error('[INVESTIGATE-WF] Failed to fetch worktrees:', err)
          }

          const isUsable = (w: Worktree) => !w.status || w.status === 'ready'

          if (worktrees.length > 0) {
            const matching = worktrees.find(
              w => w.branch === detail.branch && isUsable(w)
            )
            if (matching) {
              targetWorktreeId = matching.id
              targetWorktreePath = matching.path
            } else {
              const base = worktrees.find(w => isUsable(w))
              if (base) {
                targetWorktreeId = base.id
                targetWorktreePath = base.path
              }
            }
          }

          if (!targetWorktreeId) {
            try {
              const baseSession = await invoke<Worktree>(
                'create_base_session',
                { projectId: project.id }
              )
              queryClient.invalidateQueries({
                queryKey: projectsQueryKeys.worktrees(project.id),
              })
              targetWorktreeId = baseSession.id
              targetWorktreePath = baseSession.path
            } catch (error) {
              console.error(
                '[INVESTIGATE-WF] Failed to create base session:',
                error
              )
              toast.error(`Failed to open base session: ${error}`)
              return
            }
          }
        }
      }

      // Final fallback: use active worktree
      if (!targetWorktreeId || !targetWorktreePath) {
        targetWorktreeId = activeWorktreeIdRef.current ?? null
        targetWorktreePath = activeWorktreePathRef.current ?? null
      }

      if (!targetWorktreeId || !targetWorktreePath) {
        console.error('[INVESTIGATE-WF] No worktree found at all, aborting')
        toast.error('No worktree found for this branch')
        return
      }

      const worktreeId = targetWorktreeId
      const worktreePath = targetWorktreePath

      const investigateIsCustom = Boolean(
        investigateProvider && investigateProvider !== '__anthropic__'
      )
      const investigateUseAdaptive =
        !investigateIsCustom &&
        supportsAdaptiveThinking(investigateModel, cliVersion)

      const investigateBackend = resolveBackend(investigateModel)

      const sendInvestigateMessage = (targetSessionId: string) => {
        const {
          addSendingSession,
          setLastSentMessage,
          setError,
          setSelectedModel,
          setSelectedProvider,
          setExecutingMode,
        } = useChatStore.getState()

        setLastSentMessage(targetSessionId, prompt)
        setError(targetSessionId, null)
        addSendingSession(targetSessionId)
        setSelectedModel(targetSessionId, investigateModel)
        setSelectedProvider(targetSessionId, investigateProvider)
        setExecutingMode(targetSessionId, executionModeRef.current)

        setSessionBackend.mutate({
          sessionId: targetSessionId,
          worktreeId,
          worktreePath,
          backend: investigateBackend,
        })
        setSessionModel.mutate({
          sessionId: targetSessionId,
          worktreeId,
          worktreePath,
          model: investigateModel,
        })
        setSessionProvider.mutate({
          sessionId: targetSessionId,
          worktreeId,
          worktreePath,
          provider: investigateProvider,
        })
        {
          const { setSelectedBackend: setZustandBackend, setSelectedModel: setZustandModel } =
            useChatStore.getState()
          setZustandBackend(targetSessionId, investigateBackend)
          setZustandModel(targetSessionId, investigateModel)
        }
        queryClient.setQueryData(
          chatQueryKeys.session(targetSessionId),
          (old: Session | null | undefined) =>
            old
              ? {
                  ...old,
                  backend: investigateBackend,
                  selected_model: investigateModel,
                }
              : old
        )

        sendMessage.mutate(
          {
            sessionId: targetSessionId,
            worktreeId,
            worktreePath,
            message: prompt,
            model: investigateModel,
            executionMode: executionModeRef.current,
            thinkingLevel: selectedThinkingLevelRef.current,
            effortLevel: investigateUseAdaptive
              ? selectedEffortLevelRef.current
              : undefined,
            mcpConfig: buildMcpConfigJson(
              mcpServersDataRef.current ?? [],
              enabledMcpServersRef.current,
              investigateBackend
            ),
            customProfileName: resolvedInvestigateProfile,
            parallelExecutionPrompt:
              preferences?.parallel_execution_prompt_enabled
                ? (preferences.magic_prompts?.parallel_execution ??
                  DEFAULT_PARALLEL_EXECUTION_PROMPT)
                : undefined,
            chromeEnabled: preferences?.chrome_enabled ?? false,
            aiLanguage: preferences?.ai_language,
            backend: investigateBackend,
          },
          { onSettled: () => inputRef.current?.focus() }
        )
      }

      // Switch to the target worktree, create a new session, then send the prompt
      const { setActiveWorktree, setActiveSession } = useChatStore.getState()
      const { selectWorktree, expandProject } = useProjectsStore.getState()
      setActiveWorktree(worktreeId, worktreePath)
      selectWorktree(worktreeId)

      const projects = queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )
      const project = projects?.find(p => p.path === detail.projectPath)
      if (project) expandProject(project.id)

      createSession.mutate(
        { worktreeId, worktreePath },
        {
          onSuccess: session => {
            setActiveSession(worktreeId, session.id)
            sendInvestigateMessage(session.id)
          },
          onError: error => {
            console.error('[INVESTIGATE-WF] Failed to create session:', error)
            toast.error(`Failed to create session: ${error}`)
          },
        }
      )
    },
    [
      sendMessage,
      createSession,
      queryClient,
      preferences?.magic_prompts?.investigate_workflow_run,
      preferences?.magic_prompt_models?.investigate_workflow_run_model,
      preferences?.default_provider,
      preferences?.parallel_execution_prompt_enabled,
      preferences?.magic_prompts?.parallel_execution,
      preferences?.magic_prompt_providers,
      preferences?.chrome_enabled,
      preferences?.ai_language,
      setSessionProvider,
      setSessionBackend,
      setSessionModel,
      resolveCustomProfile,
      cliVersion,
      inputRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      executionModeRef,
      mcpServersDataRef,
      enabledMcpServersRef,
    ]
  )

  const handleReviewComments = useCallback(
    async (prompt: string) => {
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!worktreeId || !worktreePath) return

      const reviewCommentsModel =
        preferences?.magic_prompt_models?.review_comments_model ??
        selectedModelRef.current
      const reviewCommentsProvider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        'review_comments_provider',
        preferences?.default_provider
      )
      const { customProfileName: resolvedProfile } = resolveCustomProfile(
        reviewCommentsModel,
        reviewCommentsProvider
      )

      const isCustom = Boolean(
        reviewCommentsProvider && reviewCommentsProvider !== '__anthropic__'
      )
      const useAdaptive =
        !isCustom &&
        supportsAdaptiveThinking(reviewCommentsModel, cliVersion)
      const reviewCommentsBackend = resolveBackend(reviewCommentsModel)

      // Helper to send the message once we have a session ID
      const sendInSession = (sessionId: string) => {
        const {
          addSendingSession,
          setLastSentMessage,
          setError,
          setSelectedModel,
          setSelectedProvider,
          setExecutingMode,
          setSelectedBackend: setZustandBackend,
        } = useChatStore.getState()

        setLastSentMessage(sessionId, prompt)
        setError(sessionId, null)
        addSendingSession(sessionId)
        setSelectedModel(sessionId, reviewCommentsModel)
        setSelectedProvider(sessionId, reviewCommentsProvider)
        setExecutingMode(sessionId, executionModeRef.current)
        setZustandBackend(sessionId, reviewCommentsBackend)

        useChatStore.getState().setSelectedModel(sessionId, reviewCommentsModel)

        setSessionProvider.mutate({
          sessionId,
          worktreeId,
          worktreePath,
          provider: reviewCommentsProvider,
        })
        setSessionBackend.mutate({
          sessionId,
          worktreeId,
          worktreePath,
          backend: reviewCommentsBackend,
        })
        setSessionModel.mutate({
          sessionId,
          worktreeId,
          worktreePath,
          model: reviewCommentsModel,
        })

        queryClient.setQueryData(
          chatQueryKeys.session(sessionId),
          (old: Session | null | undefined) =>
            old
              ? {
                  ...old,
                  backend: reviewCommentsBackend,
                  selected_model: reviewCommentsModel,
                }
              : old
        )

        sendMessage.mutate(
          {
            sessionId,
            worktreeId,
            worktreePath,
            message: prompt,
            model: reviewCommentsModel,
            executionMode: executionModeRef.current,
            thinkingLevel: selectedThinkingLevelRef.current,
            effortLevel: useAdaptive
              ? selectedEffortLevelRef.current
              : undefined,
            mcpConfig: buildMcpConfigJson(
              mcpServersDataRef.current ?? [],
              enabledMcpServersRef.current,
              reviewCommentsBackend
            ),
            customProfileName: resolvedProfile,
            parallelExecutionPrompt:
              preferences?.parallel_execution_prompt_enabled
                ? (preferences.magic_prompts?.parallel_execution ??
                  DEFAULT_PARALLEL_EXECUTION_PROMPT)
                : undefined,
            chromeEnabled: preferences?.chrome_enabled ?? false,
            aiLanguage: preferences?.ai_language,
            backend: reviewCommentsBackend,
          },
          { onSettled: () => inputRef.current?.focus() }
        )
      }

      // Create a new session for review comments
      createSession.mutate(
        { worktreeId, worktreePath },
        {
          onSuccess: session => {
            const { setActiveSession, copySessionSettings, activeSessionIds } =
              useChatStore.getState()
            const currentSessionId = activeSessionIds[worktreeId]
            if (currentSessionId) {
              copySessionSettings(currentSessionId, session.id)
            }
            setActiveSession(worktreeId, session.id)
            queryClient.invalidateQueries({
              queryKey: chatQueryKeys.sessions(worktreeId),
            })
            sendInSession(session.id)
          },
          onError: error => {
            console.error('[REVIEW-COMMENTS] Failed to create session:', error)
          },
        }
      )
    },
    [
      sendMessage,
      createSession,
      queryClient,
      preferences?.default_provider,
      preferences?.parallel_execution_prompt_enabled,
      preferences?.magic_prompts?.parallel_execution,
      preferences?.magic_prompt_models?.review_comments_model,
      preferences?.magic_prompt_providers,
      preferences?.chrome_enabled,
      preferences?.ai_language,
      setSessionProvider,
      setSessionBackend,
      setSessionModel,
      resolveCustomProfile,
      cliVersion,
      inputRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      executionModeRef,
      mcpServersDataRef,
      enabledMcpServersRef,
    ]
  )

  return { handleInvestigate, handleInvestigateWorkflowRun, handleReviewComments }
}
