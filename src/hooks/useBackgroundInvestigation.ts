import { useEffect, useRef, useState } from 'react'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { usePreferences } from '@/services/preferences'
import { chatQueryKeys } from '@/services/chat'
import { resolveBackend, supportsAdaptiveThinking } from '@/lib/model-utils'
import { applyYoloInvestigationFixDirective } from '@/lib/investigation-prompt'
import {
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_PR_PROMPT,
  DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT,
  DEFAULT_INVESTIGATE_ADVISORY_PROMPT,
  DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_SENTRY_ISSUE_PROMPT,
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  DEFAULT_MAGIC_PROMPT_MODES,
  resolveMagicPromptProvider,
} from '@/types/preferences'
import { logger } from '@/lib/logger'
import { useQueryClient } from '@tanstack/react-query'
import { projectsQueryKeys } from '@/services/projects'
import type { Worktree } from '@/types/projects'

type InvestigationType =
  | 'issue'
  | 'pr'
  | 'security-alert'
  | 'advisory'
  | 'linear-issue'
  | 'sentry-issue'

/**
 * Headless hook for starting investigations on auto-investigate worktrees.
 *
 * Owns the entire auto-investigate path for both CMD+Click background creates
 * and foreground creates that open a session modal. Always queues the prompt
 * through `start_background_investigation` so remote/web clients (where the
 * frontend queue processor does not drain) still start investigations even when
 * the worktree becomes active or opens in a modal.
 *
 * Must be mounted at App level alongside useQueueProcessor.
 */
export function useBackgroundInvestigation(): void {
  const { data: preferences } = usePreferences()
  const queryClient = useQueryClient()
  const processingRef = useRef<Set<string>>(new Set())
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  // Ref for unstable preferences dependency; keeps effect deps stable.
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences

  // Subscribe to auto-investigate flags — re-run effect when they change
  const hasAutoInvestigate = useUIStore(
    state =>
      state.autoInvestigateWorktreeIds.size > 0 ||
      state.autoInvestigatePRWorktreeIds.size > 0 ||
      state.autoInvestigateSecurityAlertWorktreeIds.size > 0 ||
      state.autoInvestigateAdvisoryWorktreeIds.size > 0 ||
      state.autoInvestigateLinearIssueWorktreeIds.size > 0 ||
      state.autoInvestigateSentryIssueWorktreeIds.size > 0
  )

  // Re-trigger effect when new worktree paths are registered.
  // Without this, the effect runs when the flag is set (before the worktree is ready),
  // skips because worktreePaths[id] is undefined, and never re-runs.
  const worktreePathCount = useChatStore(
    state => Object.keys(state.worktreePaths).length
  )

  useEffect(() => {
    if (!hasAutoInvestigate) return

    const {
      autoInvestigateWorktreeIds,
      autoInvestigatePRWorktreeIds,
      autoInvestigateSecurityAlertWorktreeIds,
      autoInvestigateAdvisoryWorktreeIds,
      autoInvestigateLinearIssueWorktreeIds,
      autoInvestigateSentryIssueWorktreeIds,
    } = useUIStore.getState()

    const { worktreePaths } = useChatStore.getState()

    const isWorktreeReady = (worktreeId: string): boolean => {
      const cached = queryClient.getQueryData<Worktree>([
        ...projectsQueryKeys.all,
        'worktree',
        worktreeId,
      ])
      return cached?.status === 'ready'
    }

    // Collect all worktree IDs that need background investigation
    const candidates: { worktreeId: string; type: InvestigationType }[] = []
    let skippedNotReady = 0

    // Always handle auto-investigate headlessly — do not skip active or
    // auto-opening worktrees. ChatWindow used to own those cases, but remote
    // Jean clients can open the worktree without reliably sending the prompt.
    const checkCandidate = (worktreeId: string): boolean => {
      if (!worktreePaths[worktreeId]) return false
      if (!isWorktreeReady(worktreeId)) {
        skippedNotReady++
        return false
      }
      if (processingRef.current.has(worktreeId)) return false
      return true
    }

    const sources: { ids: Set<string>; type: InvestigationType }[] = [
      { ids: autoInvestigateWorktreeIds, type: 'issue' },
      { ids: autoInvestigatePRWorktreeIds, type: 'pr' },
      { ids: autoInvestigateSecurityAlertWorktreeIds, type: 'security-alert' },
      { ids: autoInvestigateAdvisoryWorktreeIds, type: 'advisory' },
      { ids: autoInvestigateLinearIssueWorktreeIds, type: 'linear-issue' },
      { ids: autoInvestigateSentryIssueWorktreeIds, type: 'sentry-issue' },
    ]

    const queuedWorktreeIds = new Set<string>()
    for (const { ids, type } of sources) {
      for (const worktreeId of ids) {
        if (queuedWorktreeIds.has(worktreeId) || !checkCandidate(worktreeId)) {
          continue
        }
        queuedWorktreeIds.add(worktreeId)
        candidates.push({ worktreeId, type })
      }
    }

    // Clear any pending retry timer
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }

    // If worktrees are flagged but not ready yet, retry after 2s.
    // The effect has no dependency that changes when worktree status goes
    // from pending → ready, so without this retry the effect would never
    // re-fire for those worktrees.
    if (skippedNotReady > 0) {
      retryTimerRef.current = setTimeout(() => setRetryTick(t => t + 1), 2000)
    }

    if (candidates.length === 0) return

    // Process each candidate
    for (const { worktreeId, type } of candidates) {
      processingRef.current.add(worktreeId)

      // Keep the flag until the backend has durably accepted the prompt. If
      // prompt construction or the start command fails, the retry below can
      // try again instead of silently leaving an empty session behind.
      const uiStore = useUIStore.getState()
      const consumeByType = {
        issue: uiStore.consumeAutoInvestigate,
        pr: uiStore.consumeAutoInvestigatePR,
        'security-alert': uiStore.consumeAutoInvestigateSecurityAlert,
        advisory: uiStore.consumeAutoInvestigateAdvisory,
        'linear-issue': uiStore.consumeAutoInvestigateLinearIssue,
        'sentry-issue': uiStore.consumeAutoInvestigateSentryIssue,
      } satisfies Record<InvestigationType, (worktreeId: string) => void>

      processBackgroundInvestigation(
        worktreeId,
        type,
        preferencesRef.current,
        null,
        queryClient
      )
        .then(() => {
          consumeByType[type](worktreeId)
        })
        .catch(err => {
          logger.error('Background investigation failed', { worktreeId, err })
          if (!retryTimerRef.current) {
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null
              setRetryTick(t => t + 1)
            }, 2000)
          }
        })
        .finally(() => {
          processingRef.current.delete(worktreeId)
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAutoInvestigate, worktreePathCount, queryClient, retryTick])
}

/**
 * Build the investigation prompt for a given type and worktree.
 */
async function buildPrompt(
  worktreeId: string,
  type: InvestigationType,
  preferences: ReturnType<typeof usePreferences>['data'],
  projectId?: string
): Promise<string> {
  if (type === 'issue') {
    const contexts = await invoke<{ number: number }[]>(
      'list_loaded_issue_contexts',
      { sessionId: worktreeId }
    )
    const refs = (contexts ?? []).map(c => `#${c.number}`).join(', ')
    const word = (contexts ?? []).length === 1 ? 'issue' : 'issues'
    const customPrompt = preferences?.magic_prompts?.investigate_issue
    const template =
      customPrompt && customPrompt.trim()
        ? customPrompt
        : DEFAULT_INVESTIGATE_ISSUE_PROMPT
    return template
      .replace(/\{issueWord\}/g, word)
      .replace(/\{issueRefs\}/g, refs)
  }

  if (type === 'pr') {
    const contexts = await invoke<{ number: number }[]>(
      'list_loaded_pr_contexts',
      { sessionId: worktreeId }
    )
    const refs = (contexts ?? []).map(c => `#${c.number}`).join(', ')
    const word = (contexts ?? []).length === 1 ? 'PR' : 'PRs'
    const customPrompt = preferences?.magic_prompts?.investigate_pr
    const template =
      customPrompt && customPrompt.trim()
        ? customPrompt
        : DEFAULT_INVESTIGATE_PR_PROMPT
    return template.replace(/\{prWord\}/g, word).replace(/\{prRefs\}/g, refs)
  }

  if (type === 'security-alert') {
    const contexts = await invoke<
      { number: number; packageName: string; severity: string }[]
    >('list_loaded_security_contexts', { sessionId: worktreeId })
    const refs = (contexts ?? [])
      .map(c => `#${c.number} ${c.packageName} (${c.severity})`)
      .join(', ')
    const word = (contexts ?? []).length === 1 ? 'alert' : 'alerts'
    const customPrompt = preferences?.magic_prompts?.investigate_security_alert
    const template =
      customPrompt && customPrompt.trim()
        ? customPrompt
        : DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT
    return template
      .replace(/\{alertWord\}/g, word)
      .replace(/\{alertRefs\}/g, refs)
  }

  if (type === 'linear-issue') {
    const pid = projectId ?? ''
    const [contexts, contentItems] = await Promise.all([
      invoke<
        {
          identifier: string
          title: string
          commentCount: number
          projectName: string
        }[]
      >('list_loaded_linear_issue_contexts', {
        sessionId: worktreeId,
        worktreeId,
        projectId: pid,
      }),
      invoke<{ identifier: string; title: string; content: string }[]>(
        'get_linear_issue_context_contents',
        { sessionId: worktreeId, worktreeId, projectId: pid }
      ),
    ])
    const refs = (contexts ?? []).map(c => c.identifier).join(', ')
    const word = (contexts ?? []).length === 1 ? 'issue' : 'issues'
    const linearContext = (contentItems ?? [])
      .map(c => c.content)
      .join('\n\n---\n\n')
    const customPrompt = preferences?.magic_prompts?.investigate_linear_issue
    const template =
      customPrompt && customPrompt.trim()
        ? customPrompt
        : DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT
    return template
      .replace(/\{linearWord\}/g, word)
      .replace(/\{linearRefs\}/g, refs)
      .replace(/\{linearContext\}/g, linearContext)
  }

  if (type === 'sentry-issue') {
    const contexts = await invoke<
      {
        id: string
        shortId: string
        title: string
        permalink: string
        content: string
      }[]
    >('get_sentry_issue_context_contents', {
      sessionId: worktreeId,
      worktreeId,
      projectId: projectId ?? '',
    })
    const refs = contexts.map(context => context.shortId).join(', ')
    const word = contexts.length === 1 ? 'issue' : 'issues'
    const sentryContext = contexts
      .map(context => context.content)
      .join('\n\n---\n\n')
    const customPrompt = preferences?.magic_prompts?.investigate_sentry_issue
    const template =
      customPrompt && customPrompt.trim()
        ? customPrompt
        : DEFAULT_INVESTIGATE_SENTRY_ISSUE_PROMPT
    return template
      .replace(/\{sentryWord\}/g, word)
      .replace(/\{sentryRefs\}/g, refs)
      .replace(/\{sentryContext\}/g, sentryContext)
  }

  // advisory
  const contexts = await invoke<
    { ghsaId: string; severity: string; summary: string }[]
  >('list_loaded_advisory_contexts', { sessionId: worktreeId })
  const refs = (contexts ?? [])
    .map(c => `${c.ghsaId} (${c.severity})`)
    .join(', ')
  const word = (contexts ?? []).length === 1 ? 'advisory' : 'advisories'
  const customPrompt = preferences?.magic_prompts?.investigate_advisory
  const template =
    customPrompt && customPrompt.trim()
      ? customPrompt
      : DEFAULT_INVESTIGATE_ADVISORY_PROMPT
  return template
    .replace(/\{advisoryWord\}/g, word)
    .replace(/\{advisoryRefs\}/g, refs)
}

const investigationConfig = {
  issue: {
    modelKey: 'investigate_issue_model',
    providerKey: 'investigate_issue_provider',
    effortKey: 'investigate_issue_effort',
    modeKey: 'investigate_issue_mode',
  },
  pr: {
    modelKey: 'investigate_pr_model',
    providerKey: 'investigate_pr_provider',
    effortKey: 'investigate_pr_effort',
    modeKey: 'investigate_pr_mode',
  },
  'security-alert': {
    modelKey: 'investigate_security_alert_model',
    providerKey: 'investigate_security_alert_provider',
    effortKey: 'investigate_security_alert_effort',
    modeKey: 'investigate_security_alert_mode',
  },
  advisory: {
    modelKey: 'investigate_advisory_model',
    providerKey: 'investigate_advisory_provider',
    effortKey: 'investigate_advisory_effort',
    modeKey: 'investigate_advisory_mode',
  },
  'linear-issue': {
    modelKey: 'investigate_linear_issue_model',
    providerKey: 'investigate_linear_issue_provider',
    effortKey: 'investigate_linear_issue_effort',
    modeKey: 'investigate_linear_issue_mode',
  },
  'sentry-issue': {
    modelKey: 'investigate_sentry_issue_model',
    providerKey: 'investigate_sentry_issue_provider',
    effortKey: 'investigate_sentry_issue_effort',
    modeKey: 'investigate_sentry_issue_mode',
  },
} as const satisfies Record<
  InvestigationType,
  {
    modelKey: keyof NonNullable<
      ReturnType<typeof usePreferences>['data']
    >['magic_prompt_models']
    providerKey: keyof NonNullable<
      ReturnType<typeof usePreferences>['data']
    >['magic_prompt_providers']
    effortKey: keyof NonNullable<
      ReturnType<typeof usePreferences>['data']
    >['magic_prompt_efforts']
    modeKey: keyof NonNullable<
      ReturnType<typeof usePreferences>['data']
    >['magic_prompt_modes']
  }
>

/**
 * Process a single background investigation: build prompt, then ask the backend
 * to reuse the same active/first session selection and send flow as Jean MCP.
 */
async function processBackgroundInvestigation(
  worktreeId: string,
  type: InvestigationType,
  preferences: ReturnType<typeof usePreferences>['data'],
  cliVersion: string | null,
  queryClient: ReturnType<typeof useQueryClient>
): Promise<void> {
  const worktreePath = useChatStore.getState().worktreePaths[worktreeId]
  if (!worktreePath) {
    // Throw so the caller keeps the auto-investigate flag and retries instead
    // of treating a missing path as success and consuming the flag.
    throw new Error(`Worktree path not registered for ${worktreeId}`)
  }

  logger.info('Starting background investigation', { worktreeId, type })

  // Resolve projectId for Linear issue investigations
  const cachedWorktree = queryClient.getQueryData<Worktree>([
    ...projectsQueryKeys.all,
    'worktree',
    worktreeId,
  ])
  const projectId = cachedWorktree?.project_id

  // Resolve model, provider, backend
  const { modelKey, providerKey, effortKey, modeKey } =
    investigationConfig[type]

  const selectedModel =
    preferences?.magic_prompt_models?.[modelKey] ??
    preferences?.selected_model ??
    'sonnet'
  const provider = resolveMagicPromptProvider(
    preferences?.magic_prompt_providers,
    providerKey,
    preferences?.default_provider
  )
  const backend = resolveBackend(selectedModel)

  // Resolve custom profile name
  let customProfileName: string | undefined
  if (provider && provider !== '__anthropic__') {
    const profile = preferences?.custom_cli_profiles?.find(
      p => p.name === provider
    )
    customProfileName = profile?.name
  }

  // Determine adaptive thinking
  const isCustomProvider = Boolean(provider && provider !== '__anthropic__')
  const useAdaptive =
    !isCustomProvider && supportsAdaptiveThinking(selectedModel, cliVersion)
  const effortLevel =
    preferences?.magic_prompt_efforts?.[effortKey] ??
    (useAdaptive ? 'high' : undefined)
  const executionMode =
    preferences?.magic_prompt_modes?.[modeKey] ??
    DEFAULT_MAGIC_PROMPT_MODES[modeKey]

  // Build the investigation prompt (append fix directive when mode is yolo)
  const prompt = applyYoloInvestigationFixDirective(
    await buildPrompt(worktreeId, type, preferences, projectId),
    executionMode
  )

  const result = await invoke<{
    sessionId: string
    worktreeId: string
    status: string
  }>('start_background_investigation', {
    worktreeId,
    worktreePath,
    message: prompt,
    model: selectedModel,
    backend,
    provider,
    effortLevel,
    customProfileName,
    parallelExecutionPrompt: preferences?.parallel_execution_prompt_enabled
      ? (preferences.magic_prompts?.parallel_execution ??
        DEFAULT_PARALLEL_EXECUTION_PROMPT)
      : undefined,
    chromeEnabled: preferences?.chrome_enabled ?? false,
    aiLanguage: preferences?.ai_language,
    executionMode,
  })

  const sessionId = result.sessionId

  // Register session-worktree mapping so streaming events can find the worktree
  const {
    setActiveSession,
    setSelectedModel,
    setSelectedProvider,
    setSelectedBackend,
    setExecutingMode,
    clearStreamingContent,
    clearToolCalls,
    clearStreamingContentBlocks,
    setLastSentMessage,
    setError,
    setSessionReviewing,
  } = useChatStore.getState()

  setActiveSession(worktreeId, sessionId)

  // Invalidate sessions query so ProjectCanvasView picks up the session
  queryClient.invalidateQueries({
    queryKey: chatQueryKeys.sessions(worktreeId),
  })

  // Mirror local pre-send state while backend owns session selection/config + send.
  setSelectedModel(sessionId, selectedModel)
  setSelectedProvider(sessionId, provider)
  setSelectedBackend(sessionId, backend)
  setExecutingMode(sessionId, executionMode)
  clearStreamingContent(sessionId)
  clearToolCalls(sessionId)
  clearStreamingContentBlocks(sessionId)
  setLastSentMessage(sessionId, prompt)
  setError(sessionId, null)
  setSessionReviewing(sessionId, false)

  logger.info('Background investigation started', {
    worktreeId,
    sessionId,
    type,
    model: selectedModel,
  })
}
