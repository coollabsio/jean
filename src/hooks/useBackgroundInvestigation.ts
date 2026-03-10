import { useEffect, useRef } from 'react'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { usePreferences } from '@/services/preferences'
import { chatQueryKeys, persistEnqueue } from '@/services/chat'
import { resolveBackend, supportsAdaptiveThinking } from '@/lib/model-utils'
import {
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_PR_PROMPT,
  DEFAULT_INVESTIGATE_SECURITY_ALERT_PROMPT,
  DEFAULT_INVESTIGATE_ADVISORY_PROMPT,
  DEFAULT_INVESTIGATE_LINEAR_ISSUE_PROMPT,
  resolveMagicPromptProvider,
} from '@/types/preferences'
import type { WorktreeSessions, QueuedMessage } from '@/types/chat'
import { logger } from '@/lib/logger'
import { useQueryClient } from '@tanstack/react-query'
import { projectsQueryKeys } from '@/services/projects'
import type { Worktree } from '@/types/projects'

type InvestigationType = 'issue' | 'pr' | 'security-alert' | 'advisory' | 'linear-issue'

/**
 * Headless hook for starting investigations on background-created worktrees.
 *
 * When a worktree is created via CMD+Click with auto-investigate, the ChatWindow
 * never mounts (no modal opens), so the auto-investigate flag is never consumed.
 * This hook watches those flags, builds the investigation prompt, and enqueues
 * it into messageQueues for useQueueProcessor to send — no modal needed.
 *
 * Must be mounted at App level alongside useQueueProcessor.
 */
export function useBackgroundInvestigation(): void {
  const { data: preferences } = usePreferences()
  const queryClient = useQueryClient()
  const processingRef = useRef<Set<string>>(new Set())

  // Subscribe to auto-investigate flags — re-run effect when they change
  const hasAutoInvestigate = useUIStore(state =>
    state.autoInvestigateWorktreeIds.size > 0 ||
    state.autoInvestigatePRWorktreeIds.size > 0 ||
    state.autoInvestigateSecurityAlertWorktreeIds.size > 0 ||
    state.autoInvestigateAdvisoryWorktreeIds.size > 0 ||
    state.autoInvestigateLinearIssueWorktreeIds.size > 0
  )

  // Re-trigger effect when new worktree paths are registered.
  // Without this, the effect runs when the flag is set (before the worktree is ready),
  // skips because worktreePaths[id] is undefined, and never re-runs.
  const worktreePathCount = useChatStore(state =>
    Object.keys(state.worktreePaths).length
  )

  useEffect(() => {
    if (!hasAutoInvestigate) return

    const {
      autoInvestigateWorktreeIds,
      autoInvestigatePRWorktreeIds,
      autoInvestigateSecurityAlertWorktreeIds,
      autoInvestigateAdvisoryWorktreeIds,
      autoInvestigateLinearIssueWorktreeIds,
    } = useUIStore.getState()

    const { worktreePaths, activeWorktreeId } = useChatStore.getState()

    // Helper: check if worktree is ready (directory exists on disk).
    // Only worktrees marked 'ready' by handleWorktreeReady have their
    // git directory created. Without this check, worktreePaths may be
    // populated early by setActiveWorktree before the directory exists.
    const isWorktreeReady = (worktreeId: string): boolean => {
      const cached = queryClient.getQueryData<Worktree>(
        [...projectsQueryKeys.all, 'worktree', worktreeId]
      )
      return cached?.status === 'ready'
    }

    // Collect all worktree IDs that need background investigation
    const candidates: { worktreeId: string; type: InvestigationType }[] = []

    for (const worktreeId of autoInvestigateWorktreeIds) {
      // Skip foreground worktrees — ChatWindow handles those
      if (worktreeId === activeWorktreeId) continue
      // Skip if worktree path not yet registered (still pending)
      if (!worktreePaths[worktreeId]) continue
      // Skip if worktree directory not yet created (status !== 'ready')
      if (!isWorktreeReady(worktreeId)) continue
      // Skip if already being processed
      if (processingRef.current.has(worktreeId)) continue
      candidates.push({ worktreeId, type: 'issue' })
    }

    for (const worktreeId of autoInvestigatePRWorktreeIds) {
      if (worktreeId === activeWorktreeId) continue
      if (!worktreePaths[worktreeId]) continue
      if (!isWorktreeReady(worktreeId)) continue
      if (processingRef.current.has(worktreeId)) continue
      if (candidates.some(c => c.worktreeId === worktreeId)) continue
      candidates.push({ worktreeId, type: 'pr' })
    }

    for (const worktreeId of autoInvestigateSecurityAlertWorktreeIds) {
      if (worktreeId === activeWorktreeId) continue
      if (!worktreePaths[worktreeId]) continue
      if (!isWorktreeReady(worktreeId)) continue
      if (processingRef.current.has(worktreeId)) continue
      if (candidates.some(c => c.worktreeId === worktreeId)) continue
      candidates.push({ worktreeId, type: 'security-alert' })
    }

    for (const worktreeId of autoInvestigateAdvisoryWorktreeIds) {
      if (worktreeId === activeWorktreeId) continue
      if (!worktreePaths[worktreeId]) continue
      if (!isWorktreeReady(worktreeId)) continue
      if (processingRef.current.has(worktreeId)) continue
      if (candidates.some(c => c.worktreeId === worktreeId)) continue
      candidates.push({ worktreeId, type: 'advisory' })
    }

    for (const worktreeId of autoInvestigateLinearIssueWorktreeIds) {
      if (worktreeId === activeWorktreeId) continue
      if (!worktreePaths[worktreeId]) continue
      if (!isWorktreeReady(worktreeId)) continue
      if (processingRef.current.has(worktreeId)) continue
      if (candidates.some(c => c.worktreeId === worktreeId)) continue
      candidates.push({ worktreeId, type: 'linear-issue' })
    }

    if (candidates.length === 0) return

    // Process each candidate
    for (const { worktreeId, type } of candidates) {
      processingRef.current.add(worktreeId)

      // Consume the flag immediately so we don't re-process
      const uiStore = useUIStore.getState()
      if (type === 'issue') {
        uiStore.consumeAutoInvestigate(worktreeId)
      } else if (type === 'pr') {
        uiStore.consumeAutoInvestigatePR(worktreeId)
      } else if (type === 'security-alert') {
        uiStore.consumeAutoInvestigateSecurityAlert(worktreeId)
      } else if (type === 'linear-issue') {
        uiStore.consumeAutoInvestigateLinearIssue(worktreeId)
      } else {
        uiStore.consumeAutoInvestigateAdvisory(worktreeId)
      }

      processBackgroundInvestigation(
        worktreeId,
        type,
        preferences,
        null,
        queryClient,
      ).catch(err => {
        logger.error('Background investigation failed', { worktreeId, err })
      }).finally(() => {
        processingRef.current.delete(worktreeId)
      })
    }
  }, [hasAutoInvestigate, worktreePathCount, preferences, queryClient])
}

/**
 * Build the investigation prompt for a given type and worktree.
 */
async function buildPrompt(
  worktreeId: string,
  type: InvestigationType,
  preferences: ReturnType<typeof usePreferences>['data'],
  projectId?: string,
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
    return template
      .replace(/\{prWord\}/g, word)
      .replace(/\{prRefs\}/g, refs)
  }

  if (type === 'security-alert') {
    const contexts = await invoke<{ number: number; packageName: string; severity: string }[]>(
      'list_loaded_security_contexts',
      { sessionId: worktreeId }
    )
    const refs = (contexts ?? []).map(c => `#${c.number} ${c.packageName} (${c.severity})`).join(', ')
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
      invoke<{ identifier: string; title: string; commentCount: number; projectName: string }[]>(
        'list_loaded_linear_issue_contexts',
        { sessionId: worktreeId, worktreeId, projectId: pid }
      ),
      invoke<{ identifier: string; title: string; content: string }[]>(
        'get_linear_issue_context_contents',
        { sessionId: worktreeId, worktreeId, projectId: pid }
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
    return template
      .replace(/\{linearWord\}/g, word)
      .replace(/\{linearRefs\}/g, refs)
      .replace(/\{linearContext\}/g, linearContext)
  }

  // advisory
  const contexts = await invoke<{ ghsaId: string; severity: string; summary: string }[]>(
    'list_loaded_advisory_contexts',
    { sessionId: worktreeId }
  )
  const refs = (contexts ?? []).map(c => `${c.ghsaId} (${c.severity})`).join(', ')
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

/**
 * Resolve model/provider keys for the given investigation type.
 */
function resolveModelProviderKeys(type: InvestigationType) {
  switch (type) {
    case 'issue':
      return { modelKey: 'investigate_issue_model' as const, providerKey: 'investigate_issue_provider' as const }
    case 'pr':
      return { modelKey: 'investigate_pr_model' as const, providerKey: 'investigate_pr_provider' as const }
    case 'security-alert':
      return { modelKey: 'investigate_security_alert_model' as const, providerKey: 'investigate_security_alert_provider' as const }
    case 'advisory':
      return { modelKey: 'investigate_advisory_model' as const, providerKey: 'investigate_advisory_provider' as const }
    case 'linear-issue':
      return { modelKey: 'investigate_linear_issue_model' as const, providerKey: 'investigate_linear_issue_provider' as const }
  }
}

/**
 * Process a single background investigation: fetch session, build prompt, enqueue message.
 */
async function processBackgroundInvestigation(
  worktreeId: string,
  type: InvestigationType,
  preferences: ReturnType<typeof usePreferences>['data'],
  cliVersion: string | null,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  const worktreePath = useChatStore.getState().worktreePaths[worktreeId]
  if (!worktreePath) return

  logger.info('Starting background investigation', { worktreeId, type })

  // Fetch sessions — auto-creates "Session 1" if none exist
  const sessions = await invoke<WorktreeSessions>('get_sessions', {
    worktreeId,
    worktreePath,
    includeMessageCounts: false,
  })

  const sessionId = sessions.active_session_id ?? sessions.sessions[0]?.id
  if (!sessionId) {
    logger.error('Background investigation: no session found', { worktreeId })
    return
  }

  // Register session-worktree mapping so useQueueProcessor can find the worktree
  const { setActiveSession } = useChatStore.getState()
  setActiveSession(worktreeId, sessionId)

  // Invalidate sessions query so ProjectCanvasView picks up the session
  queryClient.invalidateQueries({
    queryKey: chatQueryKeys.sessions(worktreeId),
  })

  // Resolve projectId for Linear issue investigations
  const cachedWorktree = queryClient.getQueryData<Worktree>(
    [...projectsQueryKeys.all, 'worktree', worktreeId]
  )
  const projectId = cachedWorktree?.project_id

  // Build the investigation prompt
  const prompt = await buildPrompt(worktreeId, type, preferences, projectId)

  // Resolve model, provider, backend
  const { modelKey, providerKey } = resolveModelProviderKeys(type)

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

  // Set session config on backend
  await Promise.all([
    invoke('set_session_backend', {
      worktreeId,
      worktreePath,
      sessionId,
      backend,
    }),
    invoke('set_session_model', {
      worktreeId,
      worktreePath,
      sessionId,
      model: selectedModel,
    }),
    invoke('set_session_provider', {
      worktreeId,
      worktreePath,
      sessionId,
      provider,
    }),
  ])

  // Set Zustand state for the session
  const {
    setSelectedModel,
    setSelectedProvider,
    setSelectedBackend,
    setExecutingMode,
    enqueueMessage,
  } = useChatStore.getState()

  setSelectedModel(sessionId, selectedModel)
  setSelectedProvider(sessionId, provider)
  setSelectedBackend(sessionId, backend)
  setExecutingMode(sessionId, 'plan')

  // Determine adaptive thinking
  const isCustomProvider = Boolean(provider && provider !== '__anthropic__')
  const useAdaptive =
    !isCustomProvider && supportsAdaptiveThinking(selectedModel, cliVersion)

  // Build and enqueue the message
  const queuedMessage: QueuedMessage = {
    id: `bg-investigate-${worktreeId}-${Date.now()}`,
    message: prompt,
    pendingImages: [],
    pendingFiles: [],
    pendingSkills: [],
    pendingTextFiles: [],
    model: selectedModel,
    provider: customProfileName ?? null,
    executionMode: 'plan',
    thinkingLevel: 'think',
    effortLevel: useAdaptive ? 'high' : undefined,
    backend,
    queuedAt: Date.now(),
  }

  enqueueMessage(sessionId, queuedMessage)
  persistEnqueue(worktreeId, worktreePath, sessionId, queuedMessage)

  logger.info('Background investigation enqueued', {
    worktreeId,
    sessionId,
    type,
    model: selectedModel,
  })
}
