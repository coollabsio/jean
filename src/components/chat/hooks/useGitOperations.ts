import { useCallback, useState, type RefObject } from 'react'
import { invoke, listen } from '@/lib/transport'
import { openExternal } from '@/lib/platform'
import { dismissibleToast } from '@/lib/dismissible-toast'
import { toastActionLabel } from '@/lib/toast-action-label'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { generateId } from '@/lib/uuid'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { chatQueryKeys, refreshWorktreeSessionsCaches } from '@/services/chat'
import { startCommitJob } from '@/services/commit-jobs'
import { buildMcpConfigJson } from '@/services/mcp'
import { saveWorktreePr, projectsQueryKeys } from '@/services/projects'
import {
  gitPush,
  triggerImmediateGitPoll,
  triggerImmediateRemotePoll,
  fetchWorktreesStatus,
  performGitPull,
} from '@/services/git-status'
import { prStatusQueryKeys } from '@/services/pr-status'
import type { PrStatusEvent } from '@/types/pr-status'
import { isBaseSession } from '@/types/projects'
import type {
  CreatePrResponse,
  DetectPrResponse,
  RevertCommitResponse,
  ReviewJob,
  StartReviewJobResponse,
  MergeWorktreeResponse,
  MergeConflictsResponse,
  MergePrResponse,
  MergeType,
  Worktree,
  Project,
} from '@/types/projects'
import type {
  EffortLevel,
  McpServerInfo,
  Session,
  ThinkingLevel,
} from '@/types/chat'
import {
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  DEFAULT_FINAL_REVIEW_PROMPT,
  DEFAULT_RESOLVE_CONFLICTS_PROMPT,
  DEFAULT_MAGIC_PROMPT_MODES,
  resolveMagicPromptBackend,
  resolveMagicPromptProvider,
  type CliBackend,
  type AppPreferences,
  type MagicCodeReviewConfig,
} from '@/types/preferences'
import type { InvestigateOverride } from './useMagicCommands'
import {
  resolveCodeReviewConfigs,
  startCodeReviewsSequentially,
} from '@/lib/code-review-configs'
import { resolveDefaultModelForBackend } from '@/lib/session-defaults'

interface SessionMutation<T> {
  mutate: (args: T) => void
}

interface SendMessageMutation {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutate: (args: any, opts?: any) => void
}

interface SessionSettingArgs {
  sessionId: string
  worktreeId: string
  worktreePath: string
}

interface TriggerCodeRabbitPrReviewResponse {
  pr_number: number
  pr_url: string
  comment_body: string
}

interface UseGitOperationsParams {
  activeWorktreeId: string | null | undefined
  activeSessionId: string | null | undefined
  activeWorktreePath: string | null | undefined
  worktree: Worktree | null | undefined
  project: Project | null | undefined
  queryClient: QueryClient
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  preferences: AppPreferences | undefined
  setSessionModel: SessionMutation<SessionSettingArgs & { model: string }>
  setSessionBackend: SessionMutation<SessionSettingArgs & { backend: string }>
  setSessionProvider: SessionMutation<
    SessionSettingArgs & { provider: string | null }
  >
  sendMessage: SendMessageMutation
  selectedThinkingLevelRef: RefObject<ThinkingLevel>
  selectedEffortLevelRef: RefObject<EffortLevel>
  mcpServersDataRef: RefObject<McpServerInfo[] | undefined>
  enabledMcpServersRef: RefObject<string[]>
}

interface UseGitOperationsReturn {
  /** Creates commit with AI-generated message (no push) */
  handleCommit: () => Promise<void>
  /** Creates commit with AI-generated message and pushes to remote */
  handleCommitAndPush: (remote?: string) => Promise<void>
  /** Pulls changes from remote */
  handlePull: (remote?: string) => Promise<void>
  /** Pushes commits to remote */
  handlePush: (remote?: string) => Promise<void>
  /** Reverts the latest local commit */
  handleRevertLastCommit: () => Promise<void>
  /** Creates PR with AI-generated title and description */
  handleOpenPr: () => Promise<void>
  /** Runs AI code review. */
  handleReview: () => Promise<void>
  /** Starts an audit-only final review in a new session. */
  handleFinalReview: () => Promise<void>
  /** Runs CodeRabbit CLI code review. */
  handleCodeRabbitReview: () => Promise<void>
  /** Triggers CodeRabbit by commenting on the open PR. */
  handleCodeRabbitPrReview: () => Promise<void>
  /** Validates and shows merge options dialog */
  handleMerge: () => Promise<void>
  /** Merges open PR on GitHub then archives/deletes worktree */
  handleMergePr: () => Promise<void>
  /** Detects existing merge conflicts and opens resolution session */
  handleResolveConflicts: (override?: InvestigateOverride) => Promise<void>
  /** Fetches base branch and merges to create local conflict state for PR conflict resolution */
  handleResolvePrConflicts: (override?: InvestigateOverride) => Promise<void>
  /** Executes the actual merge with specified type */
  executeMerge: (mergeType: MergeType) => Promise<void>
  /** Whether merge dialog is open */
  showMergeDialog: boolean
  /** Setter for merge dialog visibility */
  setShowMergeDialog: React.Dispatch<React.SetStateAction<boolean>>
  /** Worktree data for pending merge */
  pendingMergeWorktree: Worktree | null
}

/**
 * Extracts git operation handlers from ChatWindow.
 * Provides handlers for commit, PR, review, and merge operations.
 */
export function useGitOperations({
  activeWorktreeId,
  activeSessionId,
  activeWorktreePath,
  worktree,
  project,
  queryClient,
  inputRef,
  preferences,
  setSessionModel,
  setSessionBackend,
  setSessionProvider,
  sendMessage,
  selectedThinkingLevelRef,
  selectedEffortLevelRef,
  mcpServersDataRef,
  enabledMcpServersRef,
}: UseGitOperationsParams): UseGitOperationsReturn {
  // Merge dialog state
  const [showMergeDialog, setShowMergeDialog] = useState(false)
  const [pendingMergeWorktree, setPendingMergeWorktree] =
    useState<Worktree | null>(null)

  const applyResolveConflictSessionSelection = useCallback(
    (
      sessionId: string,
      worktreeId: string,
      worktreePath: string,
      override?: InvestigateOverride
    ) => {
      const defaultBackend = (project?.default_backend ??
        preferences?.default_backend ??
        'claude') as CliBackend
      const resolvedProvider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        'resolve_conflicts_provider',
        preferences?.default_provider
      )
      const backend = (override?.backend ??
        resolveMagicPromptBackend(
          preferences?.magic_prompt_backends,
          'resolve_conflicts_backend',
          defaultBackend
        ) ??
        defaultBackend) as CliBackend
      const model =
        override?.model ??
        preferences?.magic_prompt_models?.resolve_conflicts_model ??
        (backend === 'codex'
          ? (preferences?.selected_codex_model ?? 'gpt-5.6-sol')
          : backend === 'opencode'
            ? (preferences?.selected_opencode_model ?? 'opencode/gpt-5.6-sol')
            : backend === 'cursor'
              ? (preferences?.selected_cursor_model ?? 'cursor/auto')
              : (preferences?.selected_model ?? 'sonnet'))
      const provider =
        override?.backend && override.backend !== 'claude'
          ? null
          : resolvedProvider

      useChatStore.getState().setSelectedBackend(sessionId, backend)
      useChatStore.getState().setSelectedModel(sessionId, model)
      useChatStore.getState().setSelectedProvider(sessionId, provider)

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
                created_at: Math.floor(Date.now() / 1000),
                updated_at: Math.floor(Date.now() / 1000),
                messages: [],
                backend,
                selected_model: model,
                selected_provider: provider,
              }
      )

      // Persist to backend so model survives cache invalidations
      setSessionBackend.mutate({
        sessionId,
        worktreeId,
        worktreePath,
        backend,
      })
      setSessionModel.mutate({
        sessionId,
        worktreeId,
        worktreePath,
        model,
      })
      setSessionProvider.mutate({
        sessionId,
        worktreeId,
        worktreePath,
        provider,
      })
    },
    [
      preferences,
      project?.default_backend,
      queryClient,
      setSessionBackend,
      setSessionModel,
      setSessionProvider,
    ]
  )

  // Handle Commit - creates commit with AI-generated message (no push)

  const sendConflictResolutionPrompt = useCallback(
    ({
      session,
      worktreeId,
      worktreePath,
      prompt,
      backend,
      model,
      provider,
      executionMode,
    }: {
      session: Session
      worktreeId: string
      worktreePath: string
      prompt: string
      backend: CliBackend
      model: string
      provider: string | null
      executionMode: 'plan' | 'yolo'
    }) => {
      const store = useChatStore.getState()
      store.setLastSentMessage(session.id, prompt)
      store.setError(session.id, null)
      store.setExecutionMode(session.id, executionMode)
      store.setExecutingMode(session.id, executionMode)
      store.clearInputDraft(session.id)

      const isCustomProvider = Boolean(provider && provider !== '__anthropic__')
      const customProfileName = isCustomProvider ? provider : undefined
      const usesEffortLevel =
        backend === 'codex' || backend === 'opencode' || backend === 'pi'

      sendMessage.mutate(
        {
          sessionId: session.id,
          worktreeId,
          worktreePath,
          message: prompt,
          model,
          executionMode,
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: usesEffortLevel
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: buildMcpConfigJson(
            mcpServersDataRef.current ?? [],
            enabledMcpServersRef.current,
            backend
          ),
          customProfileName,
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
          backend: backend !== 'claude' ? backend : undefined,
        },
        { onSettled: () => inputRef.current?.focus() }
      )
    },
    [
      enabledMcpServersRef,
      inputRef,
      mcpServersDataRef,
      preferences?.ai_language,
      preferences?.chrome_enabled,
      preferences?.magic_prompts?.parallel_execution,
      preferences?.parallel_execution_prompt_enabled,
      selectedEffortLevelRef,
      selectedThinkingLevelRef,
      sendMessage,
    ]
  )

  const resolveConflictSessionSelection = useCallback(
    (override?: InvestigateOverride) => {
      const defaultBackend = (project?.default_backend ??
        preferences?.default_backend ??
        'claude') as CliBackend
      const resolvedProvider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        'resolve_conflicts_provider',
        preferences?.default_provider
      )
      const backend = (override?.backend ??
        resolveMagicPromptBackend(
          preferences?.magic_prompt_backends,
          'resolve_conflicts_backend',
          defaultBackend
        ) ??
        defaultBackend) as CliBackend
      const executionMode =
        preferences?.magic_prompt_modes?.resolve_conflicts_mode ??
        DEFAULT_MAGIC_PROMPT_MODES.resolve_conflicts_mode
      const model =
        override?.model ??
        preferences?.magic_prompt_models?.resolve_conflicts_model ??
        (backend === 'codex'
          ? (preferences?.selected_codex_model ?? 'gpt-5.6-sol')
          : backend === 'opencode'
            ? (preferences?.selected_opencode_model ?? 'opencode/gpt-5.6-sol')
            : backend === 'cursor'
              ? (preferences?.selected_cursor_model ?? 'cursor/auto')
              : (preferences?.selected_model ?? 'sonnet'))
      const provider =
        override?.backend && override.backend !== 'claude'
          ? null
          : resolvedProvider

      return { backend, model, provider, executionMode }
    },
    [project?.default_backend, preferences]
  )

  const handleFinalReview = useCallback(async () => {
    if (!activeWorktreeId || !activeWorktreePath) return

    const defaultBackend = (project?.default_backend ??
      preferences?.default_backend ??
      'claude') as CliBackend
    const backend = (resolveMagicPromptBackend(
      preferences?.magic_prompt_backends,
      'final_review_backend',
      defaultBackend
    ) ?? defaultBackend) as CliBackend
    const model =
      preferences?.magic_prompt_models?.final_review_model ??
      resolveDefaultModelForBackend(backend, preferences)
    const provider =
      backend === 'claude'
        ? resolveMagicPromptProvider(
            preferences?.magic_prompt_providers,
            'final_review_provider',
            preferences?.default_provider
          )
        : null
    const executionMode =
      preferences?.magic_prompt_modes?.final_review_mode ??
      DEFAULT_MAGIC_PROMPT_MODES.final_review_mode
    const prompt =
      preferences?.magic_prompts?.final_review ?? DEFAULT_FINAL_REVIEW_PROMPT

    try {
      const session = await invoke<Session>('create_session', {
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        name: 'Final review',
        backend,
      })
      const store = useChatStore.getState()

      store.setSelectedBackend(session.id, backend)
      store.setSelectedModel(session.id, model)
      store.setSelectedProvider(session.id, provider)
      store.setActiveSession(activeWorktreeId, session.id)
      store.setExecutionMode(session.id, executionMode)
      store.setExecutingMode(session.id, executionMode)
      store.setLastSentMessage(session.id, prompt)
      store.setError(session.id, null)
      store.clearInputDraft(session.id)

      setSessionBackend.mutate({
        sessionId: session.id,
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        backend,
      })
      setSessionModel.mutate({
        sessionId: session.id,
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        model,
      })
      setSessionProvider.mutate({
        sessionId: session.id,
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        provider,
      })
      await invoke('update_session_state', {
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        sessionId: session.id,
        selectedExecutionMode: executionMode,
      })

      sendMessage.mutate(
        {
          sessionId: session.id,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message: prompt,
          model,
          executionMode,
          effortLevel:
            preferences?.magic_prompt_efforts?.final_review_effort ?? undefined,
          mcpConfig: buildMcpConfigJson(
            mcpServersDataRef.current ?? [],
            enabledMcpServersRef.current,
            backend
          ),
          customProfileName:
            provider && provider !== '__anthropic__' ? provider : undefined,
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
          backend: backend !== 'claude' ? backend : undefined,
        },
        { onSettled: () => inputRef.current?.focus() }
      )

      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(activeWorktreeId),
      })
    } catch (error) {
      toast.error(`Failed to start final review: ${error}`)
    }
  }, [
    activeWorktreeId,
    activeWorktreePath,
    enabledMcpServersRef,
    inputRef,
    mcpServersDataRef,
    preferences,
    project?.default_backend,
    queryClient,
    sendMessage,
    setSessionBackend,
    setSessionModel,
    setSessionProvider,
  ])

  const handleCommit = useCallback(async () => {
    if (!activeWorktreePath || !activeWorktreeId) return

    const { setWorktreeLoading, clearWorktreeLoading } = useChatStore.getState()
    const { gitDiffSelectedFiles, clearGitDiffSelectedFiles } =
      useUIStore.getState()
    const specificFiles =
      gitDiffSelectedFiles.size > 0 ? Array.from(gitDiffSelectedFiles) : null

    setWorktreeLoading(activeWorktreeId, 'commit')
    const prefix =
      project?.name && worktree?.name
        ? `${project.name}/${worktree.name}`
        : (worktree?.name ?? '')
    const opToast = dismissibleToast.loading(`Creating commit on ${prefix}...`)

    try {
      await startCommitJob(
        {
          worktreePath: activeWorktreePath,
          customPrompt: preferences?.magic_prompts?.commit_message,
          push: false,
          model: preferences?.magic_prompt_models?.commit_message_model,
          customProfileName: resolveMagicPromptProvider(
            preferences?.magic_prompt_providers,
            'commit_message_provider',
            preferences?.default_provider
          ),
          reasoningEffort:
            preferences?.magic_prompt_efforts?.commit_message_effort ?? null,
          specificFiles,
        },
        job => {
          clearWorktreeLoading(activeWorktreeId)
          if (job.status === 'failed' || !job.response) {
            opToast.error(`${prefix}: Failed to commit: ${job.error}`)
            return
          }

          clearGitDiffSelectedFiles()
          triggerImmediateGitPoll()
          window.dispatchEvent(new CustomEvent('git-commit-completed'))
          opToast.success(`${prefix}: ${job.response.message.split('\n')[0]}`)
        }
      )
    } catch (error) {
      clearWorktreeLoading(activeWorktreeId)
      opToast.error(`${prefix}: Failed to commit: ${error}`)
    }
  }, [
    activeWorktreeId,
    activeWorktreePath,
    project?.name,
    worktree?.name,
    preferences?.magic_prompts?.commit_message,
    preferences?.magic_prompt_models?.commit_message_model,
    preferences?.magic_prompt_providers,
    preferences?.default_provider,
    preferences?.magic_prompt_efforts?.commit_message_effort,
  ])

  // Handle Commit & Push - creates commit with AI-generated message and pushes
  const handleCommitAndPush = useCallback(
    async (remote?: string) => {
      if (!activeWorktreePath || !activeWorktreeId) return

      const { setWorktreeLoading, clearWorktreeLoading } =
        useChatStore.getState()
      const { gitDiffSelectedFiles, clearGitDiffSelectedFiles } =
        useUIStore.getState()
      const specificFiles =
        gitDiffSelectedFiles.size > 0 ? Array.from(gitDiffSelectedFiles) : null

      setWorktreeLoading(activeWorktreeId, 'commit')
      const prefix =
        project?.name && worktree?.name
          ? `${project.name}/${worktree.name}`
          : (worktree?.name ?? '')
      const opToast = dismissibleToast.loading(
        `Committing and pushing on ${prefix}...`
      )

      try {
        await startCommitJob(
          {
            worktreePath: activeWorktreePath,
            customPrompt: preferences?.magic_prompts?.commit_message,
            push: true,
            remote: remote ?? null,
            prNumber: worktree?.pr_number ?? null,
            model: preferences?.magic_prompt_models?.commit_message_model,
            customProfileName: resolveMagicPromptProvider(
              preferences?.magic_prompt_providers,
              'commit_message_provider',
              preferences?.default_provider
            ),
            reasoningEffort:
              preferences?.magic_prompt_efforts?.commit_message_effort ?? null,
            specificFiles,
          },
          job => {
            clearWorktreeLoading(activeWorktreeId)
            if (job.status === 'failed' || !job.response) {
              opToast.error(`${prefix}: Failed: ${job.error}`)
              return
            }

            clearGitDiffSelectedFiles()
            triggerImmediateGitPoll()
            window.dispatchEvent(new CustomEvent('git-commit-completed'))

            const result = job.response
            if (result.push_permission_denied) {
              opToast.error(
                `${prefix}: No permission to push to PR #${worktree?.pr_number}. Create a separate PR instead.`,
                {
                  action: {
                    label: toastActionLabel('Open PR'),
                    onClick: () =>
                      window.dispatchEvent(
                        new CustomEvent('magic-command', {
                          detail: { command: 'open-pr' },
                        })
                      ),
                  },
                }
              )
            } else if (result.push_fell_back) {
              opToast.warning(
                `${prefix}: Could not push to PR branch, pushed to new branch instead`
              )
            } else if (result.commit_hash) {
              opToast.success(`${prefix}: ${result.message.split('\n')[0]}`)
            } else {
              opToast.success(`${prefix}: Pushed to remote`)
            }
          }
        )
      } catch (error) {
        clearWorktreeLoading(activeWorktreeId)
        opToast.error(`${prefix}: Failed: ${error}`)
      }
    },
    [
      activeWorktreeId,
      activeWorktreePath,
      project?.name,
      worktree?.name,
      worktree?.pr_number,
      preferences?.magic_prompts?.commit_message,
      preferences?.magic_prompt_models?.commit_message_model,
      preferences?.magic_prompt_providers,
      preferences?.default_provider,
      preferences?.magic_prompt_efforts?.commit_message_effort,
    ]
  )

  // Handle Pull - pulls changes from remote
  const handlePull = useCallback(
    async (remote?: string) => {
      if (!activeWorktreePath || !activeWorktreeId) return

      await performGitPull({
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        baseBranch: project?.default_branch ?? 'main',
        branchLabel: worktree?.branch,
        remote,
        onMergeConflict: () => {
          window.dispatchEvent(
            new CustomEvent('magic-command', {
              detail: { command: 'resolve-conflicts' },
            })
          )
        },
      })
    },
    [
      activeWorktreeId,
      activeWorktreePath,
      worktree?.branch,
      project?.default_branch,
    ]
  )

  // Handle Push - pushes commits to remote
  const handlePush = useCallback(
    async (remote?: string) => {
      if (!activeWorktreePath || !activeWorktreeId) return

      const { setWorktreeLoading, clearWorktreeLoading } =
        useChatStore.getState()
      setWorktreeLoading(activeWorktreeId, 'commit')
      const branch = worktree?.branch ?? ''
      const opToast = dismissibleToast.loading(`Pushing ${branch}...`)

      try {
        const result = await gitPush(
          activeWorktreePath,
          worktree?.pr_number,
          remote
        )
        triggerImmediateGitPoll()
        if (result.permissionDenied) {
          opToast.error(
            `No permission to push to PR #${worktree?.pr_number}. Create a separate PR instead.`,
            {
              action: {
                label: toastActionLabel('Open PR'),
                onClick: () =>
                  window.dispatchEvent(
                    new CustomEvent('magic-command', {
                      detail: { command: 'open-pr' },
                    })
                  ),
              },
            }
          )
        } else if (result.fellBack) {
          opToast.warning(
            'Could not push to PR branch, pushed to new branch instead'
          )
        } else {
          opToast.success('Changes pushed')
        }
      } catch (error) {
        opToast.error(`Push failed: ${error}`)
      } finally {
        clearWorktreeLoading(activeWorktreeId)
      }
    },
    [
      activeWorktreeId,
      activeWorktreePath,
      worktree?.branch,
      worktree?.pr_number,
    ]
  )

  const handleRevertLastCommit = useCallback(async () => {
    if (!activeWorktreePath || !activeWorktreeId) return

    const { setWorktreeLoading, clearWorktreeLoading } = useChatStore.getState()
    setWorktreeLoading(activeWorktreeId, 'commit')
    const revertToast = dismissibleToast.loading('Reverting last commit...')
    try {
      const result = await invoke<RevertCommitResponse>(
        'revert_last_local_commit',
        { worktreePath: activeWorktreePath }
      )
      triggerImmediateGitPoll()
      if (worktree?.project_id) fetchWorktreesStatus(worktree.project_id)
      revertToast.success(`Reverted: ${result.commit_message}`)
    } catch (error) {
      revertToast.error(`Failed to revert: ${error}`)
    } finally {
      clearWorktreeLoading(activeWorktreeId)
    }
  }, [activeWorktreeId, activeWorktreePath, worktree?.project_id])

  // Handle Open PR - creates PR with AI-generated title and description in background
  const handleOpenPr = useCallback(async () => {
    if (!activeWorktreeId || !activeWorktreePath || !worktree) return

    const { setWorktreeLoading, clearWorktreeLoading } = useChatStore.getState()
    setWorktreeLoading(activeWorktreeId, 'pr')
    const branch = worktree?.branch ?? ''
    let cancellationRequested = false
    const toastId = toast.loading(`Creating PR for ${branch}...`, {
      cancel: {
        label: 'Cancel',
        onClick: async () => {
          cancellationRequested = true
          toast.info('Cancelling PR creation...', { id: toastId })
          await invoke<boolean>('cancel_create_pr_with_ai_content', {
            worktreePath: activeWorktreePath,
          })
        },
      },
    })

    try {
      const result = await invoke<CreatePrResponse>(
        'create_pr_with_ai_content',
        {
          worktreePath: activeWorktreePath,
          sessionId: activeSessionId,
          customPrompt: preferences?.magic_prompts?.pr_content,
          model: preferences?.magic_prompt_models?.pr_content_model,
          customProfileName: resolveMagicPromptProvider(
            preferences?.magic_prompt_providers,
            'pr_content_provider',
            preferences?.default_provider
          ),
          reasoningEffort:
            preferences?.magic_prompt_efforts?.pr_content_effort ?? null,
        }
      )

      if (!result.existing) {
        // Save PR info to worktree (backend already saved for existing PRs)
        await saveWorktreePr(activeWorktreeId, result.pr_number, result.pr_url)
      }

      // Invalidate worktree queries to refresh PR status in toolbar
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(worktree.project_id),
      })
      queryClient.invalidateQueries({
        queryKey: [...projectsQueryKeys.all, 'worktree', activeWorktreeId],
      })

      toast.success(
        result.existing
          ? `PR linked: ${result.title}`
          : `PR created: ${result.title}`,
        {
          id: toastId,
          action: {
            label: toastActionLabel('Open'),
            onClick: () => openExternal(result.pr_url),
          },
        }
      )
    } catch (error) {
      const message = String(error)
      if (cancellationRequested || message.includes('PR creation cancelled')) {
        toast.info('PR creation cancelled', { id: toastId })
      } else {
        toast.error(`Failed to create PR: ${error}`, { id: toastId })
      }
    } finally {
      clearWorktreeLoading(activeWorktreeId)
    }
  }, [
    activeWorktreeId,
    activeSessionId,
    activeWorktreePath,
    worktree,
    queryClient,
    preferences?.magic_prompts?.pr_content,
    preferences?.magic_prompt_models?.pr_content_model,
    preferences?.magic_prompt_providers,
    preferences?.default_provider,
    preferences?.magic_prompt_efforts?.pr_content_effort,
  ])

  // Handle Review - runs AI code review in background
  // If existingSessionId is provided, stores results on that session (in-place review from ChatWindow)
  // Creates a new session and stores review results in it
  const runReview = useCallback(
    async (
      source: 'ai' | 'coderabbit-cli' | 'coderabbit-pr',
      reviewConfig?: MagicCodeReviewConfig,
      reviewSessionId?: string
    ) => {
      if (!activeWorktreeId || !activeWorktreePath) return

      const { setWorktreeLoading, clearWorktreeLoading } =
        useChatStore.getState()
      setWorktreeLoading(activeWorktreeId, 'review')
      const branch = worktree?.branch ?? ''
      const projectName = project?.name ?? 'project'
      const worktreeName = worktree?.name ?? branch
      const reviewTarget = `${projectName}/${worktreeName}`
      if (source === 'coderabbit-pr') {
        const toastId = toast.loading(
          `Triggering CodeRabbit review for ${reviewTarget}...`
        )

        try {
          if (!worktree?.pr_number) {
            throw new Error('Open or link a PR in Jean first')
          }

          const result = await invoke<TriggerCodeRabbitPrReviewResponse>(
            'trigger_coderabbit_pr_review',
            {
              worktreeId: activeWorktreeId,
              worktreePath: activeWorktreePath,
              prNumber: worktree.pr_number,
            }
          )

          if (worktree?.project_id) {
            queryClient.invalidateQueries({
              queryKey: projectsQueryKeys.worktrees(worktree.project_id),
            })
            queryClient.invalidateQueries({
              queryKey: [
                ...projectsQueryKeys.all,
                'worktree',
                activeWorktreeId,
              ],
            })
          }

          toast.success(
            `CodeRabbit review triggered on PR #${result.pr_number}`,
            {
              id: toastId,
              action: result.pr_url
                ? {
                    label: toastActionLabel('Open'),
                    onClick: () => openExternal(result.pr_url),
                  }
                : undefined,
            }
          )
        } catch (error) {
          toast.error(`Failed to trigger CodeRabbit review: ${error}`, {
            id: toastId,
          })
        } finally {
          clearWorktreeLoading(activeWorktreeId)
        }
        return
      }

      const reviewRunId = generateId()
      const reviewLabel =
        source === 'coderabbit-cli' ? 'CodeRabbit CLI review' : 'Review'
      const toastId = toast.loading(
        `Starting ${reviewLabel} for ${reviewTarget}...`
      )

      // Fire-and-forget: detect and link PR if not already linked
      if (!worktree?.pr_number) {
        invoke<DetectPrResponse | null>('detect_and_link_pr', {
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
        })
          .then(result => {
            if (result && worktree?.project_id) {
              queryClient.invalidateQueries({
                queryKey: projectsQueryKeys.worktrees(worktree.project_id),
              })
              queryClient.invalidateQueries({
                queryKey: [
                  ...projectsQueryKeys.all,
                  'worktree',
                  activeWorktreeId,
                ],
              })
            }
          })
          .catch(() => {
            /* noop - PR detection is best-effort */
          })
      }

      try {
        const { job } = await invoke<StartReviewJobResponse>(
          'start_review_job',
          {
            worktreeId: activeWorktreeId,
            worktreePath: activeWorktreePath,
            source,
            backend:
              reviewConfig?.backend ??
              resolveMagicPromptBackend(
                preferences?.magic_prompt_backends,
                'code_review_backend',
                preferences?.default_backend
              ),
            customPrompt: preferences?.magic_prompts?.code_review,
            model:
              reviewConfig?.model ??
              preferences?.magic_prompt_models?.code_review_model,
            customProfileName: resolveMagicPromptProvider(
              preferences?.magic_prompt_providers,
              'code_review_provider',
              preferences?.default_provider
            ),
            reasoningEffort:
              reviewConfig?.reasoning_effort ??
              preferences?.magic_prompt_efforts?.code_review_effort ??
              null,
            reviewRunId,
            reviewType: source === 'coderabbit-cli' ? 'all' : null,
            sessionId: reviewSessionId,
          }
        )

        if (job.sessionId) {
          const { setActiveSession, clearActiveWorktree } =
            useChatStore.getState()
          setActiveSession(activeWorktreeId, job.sessionId)
          useProjectsStore.getState().selectWorktree(activeWorktreeId)
          clearActiveWorktree()
          useUIStore
            .getState()
            .markWorktreeForAutoOpenSession(activeWorktreeId, job.sessionId)
          queryClient.invalidateQueries({
            queryKey: chatQueryKeys.sessions(activeWorktreeId),
          })
        }

        // Sonner ignores `duration` for loading toasts — dismiss explicitly.
        toast.loading(
          `${reviewLabel} running for ${projectName}/${worktreeName}...`,
          {
            id: toastId,
            cancel: {
              label: 'Cancel',
              onClick: () => {
                invoke<boolean>('cancel_review_job', { jobId: job.id }).catch(
                  error => {
                    toast.error(`Failed to cancel review: ${error}`, {
                      id: toastId,
                    })
                  }
                )
              },
            },
          }
        )
        const autoDismissTimer = window.setTimeout(() => {
          toast.dismiss(toastId)
        }, 5000)

        let unlistenReviewJob: (() => void) | null = null
        let handledTerminalReviewJob = false
        const handleTerminalReviewJob = (reviewJob: ReviewJob) => {
          if (reviewJob.id !== job.id) return
          if (reviewJob.status === 'running') return
          if (handledTerminalReviewJob) return

          handledTerminalReviewJob = true
          window.clearTimeout(autoDismissTimer)
          unlistenReviewJob?.()
          if (reviewJob.status === 'completed') {
            const completedSessionId = reviewJob.sessionId
            void refreshWorktreeSessionsCaches(
              queryClient,
              activeWorktreeId,
              activeWorktreePath
            ).finally(() => {
              queryClient.invalidateQueries({
                queryKey: chatQueryKeys.sessions(activeWorktreeId),
              })
              queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
            })
            toast.dismiss(toastId)
            toast.success(
              `${reviewLabel} done on ${projectName}/${worktreeName} (${reviewJob.findingCount ?? 0} findings)`,
              {
                action: completedSessionId
                  ? {
                      label: toastActionLabel('Open'),
                      onClick: () => {
                        const { setActiveSession, clearActiveWorktree } =
                          useChatStore.getState()
                        useProjectsStore
                          .getState()
                          .selectWorktree(activeWorktreeId)
                        clearActiveWorktree()
                        setActiveSession(activeWorktreeId, completedSessionId)
                        useUIStore
                          .getState()
                          .markWorktreeForAutoOpenSession(
                            activeWorktreeId,
                            completedSessionId
                          )
                      },
                    }
                  : undefined,
              }
            )
          } else if (reviewJob.status === 'cancelled') {
            toast.dismiss(toastId)
            toast.info(`Review cancelled for ${reviewTarget}`)
          } else {
            toast.dismiss(toastId)
            toast.error(`Review failed: ${reviewJob.error ?? 'Unknown error'}`)
          }
        }

        unlistenReviewJob = await listen<ReviewJob>(
          'review-job:updated',
          event => handleTerminalReviewJob(event.payload)
        )
        if (handledTerminalReviewJob) {
          unlistenReviewJob()
        } else {
          const currentJob = await invoke<ReviewJob | null>('get_review_job', {
            jobId: job.id,
          }).catch(() => null)
          if (currentJob) handleTerminalReviewJob(currentJob)
        }
        return job.sessionId
      } catch (error) {
        toast.error(`Failed to start review: ${error}`, { id: toastId })
      } finally {
        clearWorktreeLoading(activeWorktreeId)
      }
    },
    [
      activeWorktreeId,
      activeWorktreePath,
      worktree,
      project?.name,
      queryClient,
      preferences?.magic_prompts?.code_review,
      preferences?.magic_prompt_models?.code_review_model,
      preferences?.magic_code_review_configs,
      preferences?.magic_prompt_backends,
      preferences?.default_backend,
      preferences?.magic_prompt_providers,
      preferences?.default_provider,
      preferences?.magic_prompt_efforts?.code_review_effort,
    ]
  )

  const handleReview = useCallback(async () => {
    const configs = resolveCodeReviewConfigs({
      configured: preferences?.magic_code_review_configs,
      fallbackBackend:
        resolveMagicPromptBackend(
          preferences?.magic_prompt_backends,
          'code_review_backend',
          preferences?.default_backend
        ) ?? 'claude',
      fallbackModel:
        preferences?.magic_prompt_models?.code_review_model ?? 'sonnet',
    })
    let reviewSessionId: string | undefined
    await startCodeReviewsSequentially(configs, async config => {
      reviewSessionId =
        (await runReview('ai', config, reviewSessionId)) ?? reviewSessionId
    })
  }, [preferences, runReview])

  const handleCodeRabbitReview = useCallback(async () => {
    await runReview('coderabbit-cli')
  }, [runReview])

  const handleCodeRabbitPrReview = useCallback(async () => {
    await runReview('coderabbit-pr')
  }, [runReview])

  // Handle Merge - validates and shows merge options dialog
  const handleMerge = useCallback(async () => {
    if (!activeWorktreeId) return

    // Fetch worktree data fresh if not available in cache
    let worktreeData = worktree
    if (!worktreeData) {
      try {
        worktreeData = await invoke<Worktree>('get_worktree', {
          worktreeId: activeWorktreeId,
        })
      } catch {
        toast.error('Failed to get worktree data')
        return
      }
    }

    // Validate: not a base session
    if (isBaseSession(worktreeData)) {
      toast.error('Cannot merge base branch into itself')
      return
    }

    // Validate: no open PR
    if (worktreeData.pr_url) {
      toast.error(
        'Cannot merge locally while a PR is open. Close or merge the PR on GitHub first.'
      )
      return
    }

    // Store worktree data and show dialog
    setPendingMergeWorktree(worktreeData)
    setShowMergeDialog(true)
  }, [activeWorktreeId, worktree])

  // Handle Merge PR - merges open PR on GitHub then archives/deletes worktree
  const handleMergePr = useCallback(async () => {
    if (!activeWorktreeId || !worktree) return
    if (!worktree.pr_number) {
      toast.error('No PR open for this worktree')
      return
    }

    const mergePrToastId = toast.loading('Merging PR...')
    try {
      const result = await invoke<MergePrResponse>('merge_github_pr', {
        worktreePath: worktree.path,
      })
      toast.success(result.message, { id: mergePrToastId })

      // Archive or delete the worktree (same as auto-archive on merge)
      const shouldDelete = preferences?.removal_behavior === 'delete'
      const action = shouldDelete ? 'Deleting' : 'Archiving'
      const cleanupToastId = toast.loading(`${action} worktree...`)
      try {
        await invoke(shouldDelete ? 'delete_worktree' : 'archive_worktree', {
          worktreeId: activeWorktreeId,
        })
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(worktree.project_id),
        })
        triggerImmediateGitPoll()
        if (worktree.project_id) fetchWorktreesStatus(worktree.project_id)
        const pastAction = shouldDelete ? 'Deleted' : 'Archived'
        toast.success(`${pastAction} "${worktree.name}"`, {
          id: cleanupToastId,
        })
      } catch (cleanupError) {
        toast.error(
          `Failed to ${action.toLowerCase()} worktree: ${cleanupError}`,
          { id: cleanupToastId }
        )
      }
    } catch (error) {
      toast.error(`Failed to merge PR: ${error}`, { id: mergePrToastId })
    }
  }, [activeWorktreeId, worktree, preferences?.removal_behavior, queryClient])

  // Handle Resolve Conflicts - detects existing merge conflicts and opens resolution session
  const handleResolveConflicts = useCallback(
    async (override?: InvestigateOverride) => {
      if (!activeWorktreeId || !worktree) return

      const toastId = toast.loading('Checking for merge conflicts...')

      try {
        const result = await invoke<MergeConflictsResponse>(
          'get_merge_conflicts',
          { worktreeId: activeWorktreeId }
        )

        if (!result.has_conflicts && (worktree.pr_number || worktree.pr_url)) {
          const prResult = await invoke<MergeConflictsResponse>(
            'fetch_and_merge_base',
            { worktreeId: activeWorktreeId }
          )

          if (!prResult.has_conflicts) {
            toast.success('No conflicts — base branch merged cleanly', {
              id: toastId,
            })
            triggerImmediateGitPoll()
            triggerImmediateRemotePoll()
            return
          }

          toast.warning(
            `Found conflicts in ${prResult.conflicts.length} file(s)`,
            {
              id: toastId,
              description: 'Opening conflict resolution session...',
            }
          )

          const { setActiveSession, copySessionSettings, activeSessionIds } =
            useChatStore.getState()
          const currentSessionId = activeSessionIds[activeWorktreeId]

          const newSession = await invoke<Session>('create_session', {
            worktreeId: activeWorktreeId,
            worktreePath: worktree.path,
            name: 'PR: resolve conflicts',
          })

          if (currentSessionId)
            copySessionSettings(currentSessionId, newSession.id)
          const conflictSelection = resolveConflictSessionSelection(override)
          applyResolveConflictSessionSelection(
            newSession.id,
            activeWorktreeId,
            worktree.path,
            override
          )

          setActiveSession(activeWorktreeId, newSession.id)

          const conflictFiles = prResult.conflicts.join('\n- ')
          const diffSection = prResult.conflict_diff
            ? `\n\nHere is the diff showing the conflict details:\n\n\`\`\`diff\n${prResult.conflict_diff}\n\`\`\``
            : ''
          const baseBranch = project?.default_branch || 'main'
          const resolveInstructions =
            preferences?.magic_prompts?.resolve_conflicts ??
            DEFAULT_RESOLVE_CONFLICTS_PROMPT

          const conflictPrompt = `I merged \`origin/${baseBranch}\` into this branch to resolve PR conflicts, but there are merge conflicts.

Conflicts in these files:
- ${conflictFiles}${diffSection}

${resolveInstructions}`

          sendConflictResolutionPrompt({
            session: newSession,
            worktreeId: activeWorktreeId,
            worktreePath: worktree.path,
            prompt: conflictPrompt,
            ...conflictSelection,
          })

          queryClient.invalidateQueries({
            queryKey: chatQueryKeys.sessions(activeWorktreeId),
          })

          setTimeout(() => {
            inputRef.current?.focus()
          }, 100)
          return
        }

        if (!result.has_conflicts) {
          toast.info('No merge conflicts detected', { id: toastId })
          return
        }

        toast.warning(`Found conflicts in ${result.conflicts.length} file(s)`, {
          id: toastId,
          description: 'Opening conflict resolution session...',
        })

        const { setActiveSession, copySessionSettings, activeSessionIds } =
          useChatStore.getState()
        const currentSessionId = activeSessionIds[activeWorktreeId]

        // Create a NEW session tab for conflict resolution
        const newSession = await invoke<Session>('create_session', {
          worktreeId: activeWorktreeId,
          worktreePath: worktree.path,
          name: 'Resolve conflicts',
        })

        // Inherit model/mode/thinking settings from current session
        if (currentSessionId)
          copySessionSettings(currentSessionId, newSession.id)
        const conflictSelection = resolveConflictSessionSelection(override)
        applyResolveConflictSessionSelection(
          newSession.id,
          activeWorktreeId,
          worktree.path,
          override
        )

        // Set the new session as active
        setActiveSession(activeWorktreeId, newSession.id)

        // Build conflict resolution prompt with diff details
        const conflictFiles = result.conflicts.join('\n- ')
        const diffSection = result.conflict_diff
          ? `\n\nHere is the diff showing the conflict details:\n\n\`\`\`diff\n${result.conflict_diff}\n\`\`\``
          : ''

        const resolveInstructions =
          preferences?.magic_prompts?.resolve_conflicts ??
          DEFAULT_RESOLVE_CONFLICTS_PROMPT

        const conflictPrompt = `I have merge conflicts that need to be resolved.

Conflicts in these files:
- ${conflictFiles}${diffSection}

${resolveInstructions}`

        sendConflictResolutionPrompt({
          session: newSession,
          worktreeId: activeWorktreeId,
          worktreePath: worktree.path,
          prompt: conflictPrompt,
          ...conflictSelection,
        })

        // Invalidate queries to refresh session list in tab bar
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(activeWorktreeId),
        })

        // Focus input after a short delay to allow UI to update
        setTimeout(() => {
          inputRef.current?.focus()
        }, 100)
      } catch (error) {
        toast.error(`Failed to check conflicts: ${error}`, { id: toastId })
      }
    },
    [
      activeWorktreeId,
      worktree,
      project,
      preferences,
      queryClient,
      inputRef,
      applyResolveConflictSessionSelection,
      resolveConflictSessionSelection,
      sendConflictResolutionPrompt,
    ]
  )

  // Handle PR Conflicts - fetches base branch, merges locally to create conflict state
  const handleResolvePrConflicts = useCallback(
    async (override?: InvestigateOverride) => {
      if (!activeWorktreeId || !worktree) return

      const toastId = toast.loading(
        'Fetching base branch and checking for conflicts...'
      )

      try {
        const result = await invoke<MergeConflictsResponse>(
          'fetch_and_merge_base',
          { worktreeId: activeWorktreeId }
        )

        if (!result.has_conflicts) {
          toast.success('No conflicts — base branch merged cleanly', {
            id: toastId,
          })
          triggerImmediateGitPoll()

          // Optimistically clear "Conflicts" button by updating cached PR status
          const cached = queryClient.getQueryData<PrStatusEvent>(
            prStatusQueryKeys.worktree(activeWorktreeId)
          )
          if (cached) {
            queryClient.setQueryData(
              prStatusQueryKeys.worktree(activeWorktreeId),
              { ...cached, mergeable: 'mergeable' }
            )
          }
          triggerImmediateRemotePoll()
          return
        }

        toast.warning(`Found conflicts in ${result.conflicts.length} file(s)`, {
          id: toastId,
          description: 'Opening conflict resolution session...',
        })

        const { setActiveSession, copySessionSettings, activeSessionIds } =
          useChatStore.getState()
        const currentSessionId = activeSessionIds[activeWorktreeId]

        // Create a NEW session tab for conflict resolution
        const newSession = await invoke<Session>('create_session', {
          worktreeId: activeWorktreeId,
          worktreePath: worktree.path,
          name: 'PR: resolve conflicts',
        })

        // Inherit model/mode/thinking settings from current session
        if (currentSessionId)
          copySessionSettings(currentSessionId, newSession.id)
        const conflictSelection = resolveConflictSessionSelection(override)
        applyResolveConflictSessionSelection(
          newSession.id,
          activeWorktreeId,
          worktree.path,
          override
        )

        // Set the new session as active
        setActiveSession(activeWorktreeId, newSession.id)

        // Build conflict resolution prompt with diff details
        const conflictFiles = result.conflicts.join('\n- ')
        const diffSection = result.conflict_diff
          ? `\n\nHere is the diff showing the conflict details:\n\n\`\`\`diff\n${result.conflict_diff}\n\`\`\``
          : ''

        const baseBranch = project?.default_branch || 'main'
        const resolveInstructions =
          preferences?.magic_prompts?.resolve_conflicts ??
          DEFAULT_RESOLVE_CONFLICTS_PROMPT

        const conflictPrompt = `I merged \`origin/${baseBranch}\` into this branch to resolve PR conflicts, but there are merge conflicts.

Conflicts in these files:
- ${conflictFiles}${diffSection}

${resolveInstructions}`

        sendConflictResolutionPrompt({
          session: newSession,
          worktreeId: activeWorktreeId,
          worktreePath: worktree.path,
          prompt: conflictPrompt,
          ...conflictSelection,
        })

        // Invalidate queries to refresh session list in tab bar
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(activeWorktreeId),
        })

        // Focus input after a short delay to allow UI to update
        setTimeout(() => {
          inputRef.current?.focus()
        }, 100)
      } catch (error) {
        toast.error(`Failed to merge base branch: ${error}`, { id: toastId })
      }
    },
    [
      activeWorktreeId,
      worktree,
      project,
      preferences,
      queryClient,
      inputRef,
      applyResolveConflictSessionSelection,
      resolveConflictSessionSelection,
      sendConflictResolutionPrompt,
    ]
  )

  // Execute merge with merge type option
  const executeMerge = useCallback(
    async (mergeType: MergeType) => {
      const worktreeData = pendingMergeWorktree
      if (!worktreeData || !activeWorktreeId) return

      // Close dialog
      setShowMergeDialog(false)
      setPendingMergeWorktree(null)

      const { setWorktreeLoading, clearWorktreeLoading } =
        useChatStore.getState()
      setWorktreeLoading(activeWorktreeId, 'merge')
      const toastId = toast.loading('Checking for uncommitted changes...')
      const featureBranch = worktreeData.branch
      const projectId = worktreeData.project_id

      try {
        // Pre-check: Run fresh git status check for uncommitted changes
        const hasUncommitted = await invoke<boolean>(
          'has_uncommitted_changes',
          {
            worktreeId: activeWorktreeId,
          }
        )

        if (hasUncommitted) {
          toast.loading('Auto-committing changes before merge...', {
            id: toastId,
          })
          // Small delay to show the auto-commit message before it changes to merging
          await new Promise(resolve => setTimeout(resolve, 500))
        }

        const toastMessage = {
          merge: 'Merging to base branch...',
          squash: 'Squashing and merging to base branch...',
          rebase: 'Rebasing and merging to base branch...',
        }[mergeType]
        toast.loading(toastMessage, { id: toastId })

        const result = await invoke<MergeWorktreeResponse>(
          'merge_worktree_to_base',
          {
            worktreeId: activeWorktreeId,
            mergeType,
          }
        )

        if (result.success) {
          // Worktree was deleted - invalidate queries to refresh project tree
          if (projectId) {
            queryClient.invalidateQueries({
              queryKey: projectsQueryKeys.worktrees(projectId),
            })
          }

          // Only clear active worktree if it's the one we just merged
          const { activeWorktreeId: currentActiveId, clearActiveWorktree } =
            useChatStore.getState()
          if (currentActiveId === worktreeData.id) {
            const { selectWorktree } = useProjectsStore.getState()
            clearActiveWorktree()
            selectWorktree(null)
          }

          toast.success(
            `Merged successfully! Commit: ${result.commit_hash?.slice(0, 7)}`,
            {
              id: toastId,
            }
          )
        } else if (result.conflicts && result.conflicts.length > 0) {
          // Conflicts detected - stay on worktree and create new tab for conflict resolution
          // Strategy: merge base INTO feature branch to resolve conflicts on the worktree
          toast.warning(
            `Merge conflicts in ${result.conflicts.length} file(s)`,
            {
              id: toastId,
              description: 'Opening conflict resolution session...',
            }
          )

          const { setActiveSession, copySessionSettings, activeSessionIds } =
            useChatStore.getState()
          const currentSessionId = activeSessionIds[activeWorktreeId]

          // Create a NEW session tab on the CURRENT worktree for conflict resolution
          const newSession = await invoke<Session>('create_session', {
            worktreeId: activeWorktreeId,
            worktreePath: worktreeData.path,
            name: 'Merge: resolve conflicts',
          })

          // Inherit model/mode/thinking settings from current session
          if (currentSessionId)
            copySessionSettings(currentSessionId, newSession.id)
          const conflictSelection = resolveConflictSessionSelection()
          applyResolveConflictSessionSelection(
            newSession.id,
            activeWorktreeId,
            worktreeData.path
          )

          // Set the new session as active
          setActiveSession(activeWorktreeId, newSession.id)

          // Build conflict resolution prompt with diff details
          const conflictFiles = result.conflicts.join('\n- ')
          const diffSection = result.conflict_diff
            ? `\n\nHere is the diff showing the conflict details:\n\n\`\`\`diff\n${result.conflict_diff}\n\`\`\``
            : ''

          // Get base branch name from the project
          const baseBranch = project?.default_branch || 'main'

          const resolveInstructions =
            preferences?.magic_prompts?.resolve_conflicts ??
            DEFAULT_RESOLVE_CONFLICTS_PROMPT

          const conflictPrompt = `I tried to merge this branch (\`${featureBranch}\`) into \`${baseBranch}\`, but there are merge conflicts.

To resolve this, please merge \`${baseBranch}\` INTO this branch by running:
\`\`\`
git merge ${baseBranch}
\`\`\`

Then resolve the conflicts in these files:
- ${conflictFiles}${diffSection}

${resolveInstructions}`

          sendConflictResolutionPrompt({
            session: newSession,
            worktreeId: activeWorktreeId,
            worktreePath: worktreeData.path,
            prompt: conflictPrompt,
            ...conflictSelection,
          })

          // Invalidate queries to refresh session list in tab bar
          queryClient.invalidateQueries({
            queryKey: chatQueryKeys.sessions(activeWorktreeId),
          })

          // Focus input after a short delay to allow UI to update
          setTimeout(() => {
            inputRef.current?.focus()
          }, 100)
        }
      } catch (error) {
        toast.error(String(error), { id: toastId })
      } finally {
        clearWorktreeLoading(activeWorktreeId)
      }
    },
    [
      activeWorktreeId,
      pendingMergeWorktree,
      preferences,
      project,
      queryClient,
      inputRef,
      applyResolveConflictSessionSelection,
      resolveConflictSessionSelection,
      sendConflictResolutionPrompt,
    ]
  )

  return {
    handleCommit,
    handleCommitAndPush,
    handlePull,
    handlePush,
    handleRevertLastCommit,
    handleOpenPr,
    handleReview,
    handleFinalReview,
    handleCodeRabbitReview,
    handleCodeRabbitPrReview,
    handleMerge,
    handleMergePr,
    handleResolveConflicts,
    handleResolvePrConflicts,
    executeMerge,
    showMergeDialog,
    setShowMergeDialog,
    pendingMergeWorktree,
  }
}
