import { useCallback, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { chatQueryKeys } from '@/services/chat'
import { projectsQueryKeys } from '@/services/projects'
import { buildMcpConfigJson } from '@/services/mcp'
import { resolveBackend, supportsAdaptiveThinking } from '@/lib/model-utils'
import { applyYoloInvestigationFixDirective } from '@/lib/investigation-prompt'
import {
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_PR_PROMPT,
  DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT,
  DEFAULT_INVESTIGATE_ADVISORY_PROMPT,
  DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT,
  DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_SENTRY_ISSUE_PROMPT,
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  DEFAULT_MAGIC_PROMPT_MODES,
  resolveMagicPromptBackend,
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
import type { InvestigateOverride } from './useMagicCommands'

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
  defaultBackend: string
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
  createSession: {
    mutate: (
      args: { worktreeId: string; worktreePath: string },
      opts?: {
        onSuccess?: (session: { id: string }) => void
        onError?: (error: unknown) => void
      }
    ) => void
    mutateAsync: (args: {
      worktreeId: string
      worktreePath: string
    }) => Promise<Session>
  }
  resolveCustomProfile: (
    model: string,
    provider: string | null
  ) => { model: string; customProfileName: string | undefined }
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
  defaultBackend,
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

  const primeSessionSelection = useCallback(
    (
      sessionId: string,
      backend: Session['backend'],
      model: string,
      provider: string | null
    ) => {
      const now = Math.floor(Date.now() / 1000)

      queryClient.setQueryData(
        chatQueryKeys.session(sessionId),
        (old: Session | null | undefined) =>
          old
            ? {
                ...old,
                backend,
                selected_model: model,
                selected_provider: provider,
              }
            : {
                id: sessionId,
                name: '',
                order: 0,
                created_at: now,
                updated_at: now,
                messages: [],
                backend,
                selected_model: model,
                selected_provider: provider,
              }
      )
    },
    [queryClient]
  )

  const handleInvestigate = useCallback(
    async (
      type:
        | 'issue'
        | 'pr'
        | 'security-alert'
        | 'advisory'
        | 'linear-issue'
        | 'sentry-issue',
      override?: InvestigateOverride
    ) => {
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      const modelKey =
        type === 'issue'
          ? 'investigate_issue_model'
          : type === 'pr'
            ? 'investigate_pr_model'
            : type === 'security-alert'
              ? 'investigate_security_alert_model'
              : type === 'linear-issue'
                ? 'investigate_linear_issue_model'
                : type === 'sentry-issue'
                  ? 'investigate_sentry_issue_model'
                  : ('investigate_advisory_model' as const)
      const providerKey =
        type === 'issue'
          ? 'investigate_issue_provider'
          : type === 'pr'
            ? 'investigate_pr_provider'
            : type === 'security-alert'
              ? 'investigate_security_alert_provider'
              : type === 'linear-issue'
                ? 'investigate_linear_issue_provider'
                : type === 'sentry-issue'
                  ? 'investigate_sentry_issue_provider'
                  : ('investigate_advisory_provider' as const)
      const backendKey =
        type === 'issue'
          ? 'investigate_issue_backend'
          : type === 'pr'
            ? 'investigate_pr_backend'
            : type === 'security-alert'
              ? 'investigate_security_alert_backend'
              : type === 'linear-issue'
                ? 'investigate_linear_issue_backend'
                : type === 'sentry-issue'
                  ? 'investigate_sentry_issue_backend'
                  : ('investigate_advisory_backend' as const)
      const modeKey =
        type === 'issue'
          ? 'investigate_issue_mode'
          : type === 'pr'
            ? 'investigate_pr_mode'
            : type === 'security-alert'
              ? 'investigate_security_alert_mode'
              : type === 'linear-issue'
                ? 'investigate_linear_issue_mode'
                : type === 'sentry-issue'
                  ? 'investigate_sentry_issue_mode'
                  : ('investigate_advisory_mode' as const)
      const effortKey =
        type === 'issue'
          ? 'investigate_issue_effort'
          : type === 'pr'
            ? 'investigate_pr_effort'
            : type === 'security-alert'
              ? 'investigate_security_alert_effort'
              : type === 'linear-issue'
                ? 'investigate_linear_issue_effort'
                : type === 'sentry-issue'
                  ? 'investigate_sentry_issue_effort'
                  : ('investigate_advisory_effort' as const)
      const investigateMode =
        preferences?.magic_prompt_modes?.[modeKey] ??
        DEFAULT_MAGIC_PROMPT_MODES[modeKey]
      const investigateModel =
        override?.model ??
        preferences?.magic_prompt_models?.[modelKey] ??
        selectedModelRef.current
      const resolvedInvestigateProvider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        providerKey,
        preferences?.default_provider
      )
      const investigateProvider =
        override?.backend && override.backend !== 'claude'
          ? null
          : resolvedInvestigateProvider
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
        if ((contexts ?? []).length === 0) {
          toast.error('No issue context loaded for this worktree')
          return
        }
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
        if ((contexts ?? []).length === 0) {
          toast.error('No PR context loaded for this worktree')
          return
        }
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
          queryKey: [
            'investigate-contexts',
            'security-alert',
            activeWorktreeId,
          ],
          queryFn: () =>
            invoke<{ number: number; packageName: string; severity: string }[]>(
              'list_loaded_security_contexts',
              { sessionId: activeWorktreeId }
            ),
          staleTime: 0,
        })
        const refs = (contexts ?? [])
          .map(c => `#${c.number} ${c.packageName} (${c.severity})`)
          .join(', ')
        const word = (contexts ?? []).length === 1 ? 'alert' : 'alerts'
        const customPrompt =
          preferences?.magic_prompts?.investigate_security_alert
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
            queryKey: [
              'investigate-contexts',
              'linear-issue',
              activeWorktreeId,
            ],
            queryFn: () =>
              invoke<
                {
                  identifier: string
                  title: string
                  commentCount: number
                  projectName: string
                }[]
              >('list_loaded_linear_issue_contexts', {
                sessionId: activeWorktreeId,
                worktreeId: activeWorktreeId,
                projectId,
              }),
            staleTime: 0,
          }),
          invoke<{ identifier: string; title: string; content: string }[]>(
            'get_linear_issue_context_contents',
            {
              sessionId: activeWorktreeId,
              worktreeId: activeWorktreeId,
              projectId,
            }
          ),
        ])
        const refs = (contexts ?? []).map(c => c.identifier).join(', ')
        const word = (contexts ?? []).length === 1 ? 'issue' : 'issues'
        const linearContext = (contentItems ?? [])
          .map(c => c.content)
          .join('\n\n---\n\n')
        const customPrompt =
          preferences?.magic_prompts?.investigate_linear_issue
        const template =
          customPrompt && customPrompt.trim()
            ? customPrompt
            : DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT
        prompt = template
          .replace(/\{linearWord\}/g, word)
          .replace(/\{linearRefs\}/g, refs)
          .replace(/\{linearContext\}/g, linearContext)
      } else if (type === 'sentry-issue') {
        const contexts = await invoke<
          {
            id: string
            shortId: string
            title: string
            permalink: string
            content: string
          }[]
        >('get_sentry_issue_context_contents', {
          sessionId: activeWorktreeId,
          worktreeId: activeWorktreeId,
          projectId: worktreeProjectId ?? '',
        })
        if (contexts.length === 0) {
          toast.error('No Sentry issue context loaded for this worktree')
          return
        }
        const refs = contexts.map(context => context.shortId).join(', ')
        const word = contexts.length === 1 ? 'issue' : 'issues'
        const content = contexts
          .map(context => context.content)
          .join('\n\n---\n\n')
        const customPrompt =
          preferences?.magic_prompts?.investigate_sentry_issue
        const template =
          customPrompt && customPrompt.trim()
            ? customPrompt
            : DEFAULT_INVESTIGATE_SENTRY_ISSUE_PROMPT
        prompt = template
          .replace(/\{sentryWord\}/g, word)
          .replace(/\{sentryRefs\}/g, refs)
          .replace(/\{sentryContext\}/g, content)
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
        const refs = (contexts ?? [])
          .map(c => `${c.ghsaId} (${c.severity})`)
          .join(', ')
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

      // When magic-prompt mode is yolo, append an unconditional fix directive
      // and strip any anti-fix wording from the template/custom prompt.
      prompt = applyYoloInvestigationFixDirective(prompt, investigateMode)

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
      setExecutingMode(activeSessionId, investigateMode)

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

      const investigateBackend =
        override?.backend ??
        resolveMagicPromptBackend(
          preferences?.magic_prompt_backends,
          backendKey,
          defaultBackend
        ) ??
        resolveBackend(investigateModel)

      // Prefer Magic Prompt effort override; fall back to session effort only for
      // Claude adaptive thinking. Effort-based backends (Grok/Codex/Pi/OpenCode)
      // must not inherit Claude thinking levels like "think".
      const investigateEffort =
        (preferences?.magic_prompt_efforts?.[effortKey] as
          | EffortLevel
          | null
          | undefined) ??
        (investigateUseAdaptive ? selectedEffortLevelRef.current : undefined)
      const usesEffortBackend =
        investigateBackend === 'codex' ||
        investigateBackend === 'opencode' ||
        investigateBackend === 'pi' ||
        investigateBackend === 'grok' ||
        investigateBackend === 'kimi' ||
        investigateUseAdaptive
      const investigateThinkingLevel = usesEffortBackend
        ? undefined
        : selectedThinkingLevelRef.current

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
        const {
          setSelectedBackend: setZustandBackend,
          setSelectedModel: setZustandModel,
          setEffortLevel,
        } = useChatStore.getState()
        setZustandBackend(activeSessionId, investigateBackend)
        setZustandModel(activeSessionId, investigateModel)
        if (investigateEffort) {
          setEffortLevel(activeSessionId, investigateEffort)
        }
      }
      primeSessionSelection(
        activeSessionId,
        investigateBackend,
        investigateModel,
        investigateProvider
      )

      sendMessage.mutate(
        {
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message: prompt,
          model: investigateModel,
          executionMode: investigateMode,
          thinkingLevel: investigateThinkingLevel,
          effortLevel: investigateEffort,
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
      preferences?.magic_prompts?.investigate_sentry_issue,
      preferences?.default_provider,
      preferences?.parallel_execution_prompt_enabled,
      preferences?.magic_prompts?.parallel_execution,
      preferences?.magic_prompt_models,
      preferences?.magic_prompt_providers,
      preferences?.magic_prompt_backends,
      preferences?.magic_prompt_modes,
      preferences?.magic_prompt_efforts,
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
      defaultBackend,
      primeSessionSelection,
    ]
  )

  const handleInvestigateWorkflowRun = useCallback(
    async (detail: WorkflowRunDetail) => {
      const customPrompt = preferences?.magic_prompts?.investigate_workflow_run
      const template =
        customPrompt && customPrompt.trim()
          ? customPrompt
          : DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT

      const investigateModel =
        preferences?.magic_prompt_models?.investigate_workflow_run_model ??
        selectedModelRef.current
      const investigateMode =
        preferences?.magic_prompt_modes?.investigate_workflow_run_mode ??
        DEFAULT_MAGIC_PROMPT_MODES.investigate_workflow_run_mode
      const prompt = applyYoloInvestigationFixDirective(
        template
          .replace(/\{workflowName\}/g, detail.workflowName)
          .replace(/\{runUrl\}/g, detail.runUrl)
          .replace(/\{runId\}/g, detail.runId)
          .replace(/\{branch\}/g, detail.branch)
          .replace(/\{displayTitle\}/g, detail.displayTitle),
        investigateMode
      )
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

      const projectsForBackend = queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )
      const projectForBackend = projectsForBackend?.find(
        p => p.path === detail.projectPath
      )

      const investigateIsCustom = Boolean(
        investigateProvider && investigateProvider !== '__anthropic__'
      )
      const investigateUseAdaptive =
        !investigateIsCustom &&
        supportsAdaptiveThinking(investigateModel, cliVersion)

      const investigateBackend =
        resolveMagicPromptBackend(
          preferences?.magic_prompt_backends,
          'investigate_workflow_run_backend',
          projectForBackend?.default_backend ?? defaultBackend
        ) ?? resolveBackend(investigateModel)

      // Prefer Magic Prompt effort override (e.g. Medium for Grok). Never fall
      // through to Claude thinking levels for effort-based backends.
      const investigateEffort =
        (preferences?.magic_prompt_efforts?.investigate_workflow_run_effort as
          | EffortLevel
          | null
          | undefined) ??
        (investigateUseAdaptive ? selectedEffortLevelRef.current : undefined)
      const usesEffortBackend =
        investigateBackend === 'codex' ||
        investigateBackend === 'opencode' ||
        investigateBackend === 'pi' ||
        investigateBackend === 'grok' ||
        investigateBackend === 'kimi' ||
        investigateUseAdaptive
      const investigateThinkingLevel = usesEffortBackend
        ? undefined
        : selectedThinkingLevelRef.current

      const sendInvestigateMessage = (targetSessionId: string) => {
        const {
          addSendingSession,
          setLastSentMessage,
          setError,
          setSelectedModel,
          setSelectedProvider,
          setExecutingMode,
          setEffortLevel,
        } = useChatStore.getState()

        setLastSentMessage(targetSessionId, prompt)
        setError(targetSessionId, null)
        addSendingSession(targetSessionId)
        setSelectedModel(targetSessionId, investigateModel)
        setSelectedProvider(targetSessionId, investigateProvider)
        setExecutingMode(targetSessionId, investigateMode)
        if (investigateEffort) {
          setEffortLevel(targetSessionId, investigateEffort)
        }

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
          const {
            setSelectedBackend: setZustandBackend,
            setSelectedModel: setZustandModel,
          } = useChatStore.getState()
          setZustandBackend(targetSessionId, investigateBackend)
          setZustandModel(targetSessionId, investigateModel)
        }
        primeSessionSelection(
          targetSessionId,
          investigateBackend,
          investigateModel,
          investigateProvider
        )

        sendMessage.mutate(
          {
            sessionId: targetSessionId,
            worktreeId,
            worktreePath,
            message: prompt,
            model: investigateModel,
            executionMode: investigateMode,
            thinkingLevel: investigateThinkingLevel,
            effortLevel: investigateEffort,
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
            useChatStore
              .getState()
              .setSelectedBackend(session.id, investigateBackend)
            useChatStore
              .getState()
              .setSelectedModel(session.id, investigateModel)
            useChatStore
              .getState()
              .setSelectedProvider(session.id, investigateProvider)
            primeSessionSelection(
              session.id,
              investigateBackend,
              investigateModel,
              investigateProvider
            )
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
      preferences?.magic_prompt_backends,
      preferences?.magic_prompt_modes,
      preferences?.magic_prompt_efforts,
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
      defaultBackend,
      primeSessionSelection,
    ]
  )

  const handleReviewComments = useCallback(
    async (
      promptOrPrompts: string | string[],
      options?: { executionMode?: ExecutionMode }
    ) => {
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
        !isCustom && supportsAdaptiveThinking(reviewCommentsModel, cliVersion)
      const reviewCommentsBackend =
        resolveMagicPromptBackend(
          preferences?.magic_prompt_backends,
          'review_comments_backend',
          defaultBackend
        ) ?? resolveBackend(reviewCommentsModel)

      const prompts = Array.isArray(promptOrPrompts)
        ? promptOrPrompts.filter(prompt => prompt.trim().length > 0)
        : [promptOrPrompts].filter(prompt => prompt.trim().length > 0)
      if (prompts.length === 0) return

      const requestedExecutionMode =
        options?.executionMode ??
        preferences?.magic_prompt_modes?.review_comments_mode ??
        DEFAULT_MAGIC_PROMPT_MODES.review_comments_mode

      // Helper to send the message once we have a session ID
      const sendInSession = (sessionId: string, prompt: string) => {
        const {
          addSendingSession,
          setLastSentMessage,
          setError,
          setSelectedModel,
          setSelectedProvider,
          setExecutionMode,
          setExecutingMode,
          setSelectedBackend: setZustandBackend,
        } = useChatStore.getState()

        setLastSentMessage(sessionId, prompt)
        setError(sessionId, null)
        addSendingSession(sessionId)
        setSelectedModel(sessionId, reviewCommentsModel)
        setSelectedProvider(sessionId, reviewCommentsProvider)
        setExecutionMode(sessionId, requestedExecutionMode)
        setExecutingMode(sessionId, requestedExecutionMode)
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
                  selected_provider: reviewCommentsProvider,
                }
              : {
                  id: sessionId,
                  name: '',
                  order: 0,
                  created_at: Math.floor(Date.now() / 1000),
                  updated_at: Math.floor(Date.now() / 1000),
                  messages: [],
                  backend: reviewCommentsBackend,
                  selected_model: reviewCommentsModel,
                  selected_provider: reviewCommentsProvider,
                }
        )

        sendMessage.mutate(
          {
            sessionId,
            worktreeId,
            worktreePath,
            message: prompt,
            model: reviewCommentsModel,
            executionMode: requestedExecutionMode,
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

      // Create one session per selected review comment prompt. Use mutateAsync
      // instead of repeated mutate(..., { onSuccess }) calls because TanStack
      // Query only guarantees per-call callbacks for the latest consecutive
      // mutate observer, which can leave earlier/later sessions empty.
      const baseSessionId = useChatStore.getState().activeSessionIds[worktreeId]
      for (const prompt of prompts) {
        let session: Session
        try {
          session = await createSession.mutateAsync({
            worktreeId,
            worktreePath,
          })
        } catch (error) {
          console.error('[REVIEW-COMMENTS] Failed to create session:', error)
          continue
        }

        const { setActiveSession, copySessionSettings } =
          useChatStore.getState()
        if (baseSessionId) {
          copySessionSettings(baseSessionId, session.id)
        }
        useChatStore
          .getState()
          .setSelectedBackend(session.id, reviewCommentsBackend)
        useChatStore
          .getState()
          .setSelectedModel(session.id, reviewCommentsModel)
        useChatStore
          .getState()
          .setSelectedProvider(session.id, reviewCommentsProvider)
        primeSessionSelection(
          session.id,
          reviewCommentsBackend,
          reviewCommentsModel,
          reviewCommentsProvider
        )
        setActiveSession(worktreeId, session.id)
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(worktreeId),
        })
        sendInSession(session.id, prompt)
      }
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
      preferences?.magic_prompt_backends,
      preferences?.magic_prompt_modes,
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
      defaultBackend,
      primeSessionSelection,
    ]
  )

  return {
    handleInvestigate,
    handleInvestigateWorkflowRun,
    handleReviewComments,
  }
}
