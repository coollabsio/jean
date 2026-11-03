import type { QueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { resolveCodeReviewConfigs } from '@/lib/code-review-configs'
import { chatQueryKeys } from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { Session } from '@/types/chat'
import {
  type AppPreferences,
  type CliBackend,
  DEFAULT_CODE_REVIEW_PROMPT,
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  resolveMagicPromptBackend,
  resolveMagicPromptProvider,
} from '@/types/preferences'

/**
 * Build the Jean review prompt. Custom prompts written for the old
 * structured review embed `{diff}`; the chat review lets the agent read the
 * diff itself, so those templates fall back to the default.
 */
export function buildJeanReviewPrompt(
  customPrompt: string | null | undefined,
  baseRef: string
): string {
  const template =
    customPrompt?.trim() && !customPrompt.includes('{diff}')
      ? customPrompt
      : DEFAULT_CODE_REVIEW_PROMPT
  return template.replaceAll('{base_branch}', baseRef)
}

/**
 * Jean review: create a "Review" session and send the review prompt as a
 * normal chat message, so the run is visible and can be continued.
 * Uses the first configured code-review reviewer (backend/model/effort).
 */
export async function startJeanReviewSession({
  worktreeId,
  worktreePath,
  baseRef,
  preferences,
  queryClient,
}: {
  worktreeId: string
  worktreePath: string
  /** Base ref to compare against, e.g. `origin/main` */
  baseRef: string
  preferences: AppPreferences | undefined
  queryClient: QueryClient
}): Promise<string> {
  const [config] = resolveCodeReviewConfigs({
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
  const backend = (config?.backend ?? 'claude') as CliBackend
  const model = config?.model ?? 'sonnet'
  const provider =
    backend === 'claude'
      ? resolveMagicPromptProvider(
          preferences?.magic_prompt_providers,
          'code_review_provider',
          preferences?.default_provider
        )
      : null
  const effortLevel =
    config?.reasoning_effort ??
    preferences?.magic_prompt_efforts?.code_review_effort ??
    undefined
  const executionMode = 'plan'
  const prompt = buildJeanReviewPrompt(
    preferences?.magic_prompts?.code_review,
    baseRef
  )

  const session = await invoke<Session>('create_session', {
    worktreeId,
    worktreePath,
    name: 'Review',
  })

  const store = useChatStore.getState()
  store.registerWorktreePath(worktreeId, worktreePath)

  await invoke('start_background_investigation', {
    worktreeId,
    worktreePath,
    message: prompt,
    model,
    backend,
    provider,
    effortLevel,
    customProfileName:
      provider && provider !== '__anthropic__' ? provider : undefined,
    parallelExecutionPrompt:
      preferences?.magic_prompts?.parallel_execution ??
      DEFAULT_PARALLEL_EXECUTION_PROMPT,
    chromeEnabled: preferences?.chrome_enabled ?? false,
    aiLanguage: preferences?.ai_language,
    executionMode,
    sessionId: session.id,
  })

  // Mirror the backend-owned session config locally, then open the session.
  store.setSelectedModel(session.id, model)
  store.setSelectedProvider(session.id, provider)
  store.setSelectedBackend(session.id, backend)
  store.setExecutionMode(session.id, executionMode)
  store.setExecutingMode(session.id, executionMode)
  store.setLastSentMessage(session.id, prompt)
  store.setError(session.id, null)

  store.setActiveSession(worktreeId, session.id)
  useProjectsStore.getState().selectWorktree(worktreeId)
  store.clearActiveWorktree()
  useUIStore.getState().markWorktreeForAutoOpenSession(worktreeId, session.id)
  queryClient.invalidateQueries({
    queryKey: chatQueryKeys.sessions(worktreeId),
  })
  return session.id
}
