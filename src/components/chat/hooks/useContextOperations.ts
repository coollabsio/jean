import { useCallback } from 'react'
import { invoke } from '@/lib/transport'
import { useUIStore } from '@/store/ui-store'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { SaveContextResponse, SavedContextsResponse } from '@/types/chat'
import type { Project, Worktree } from '@/types/projects'
import { projectsQueryKeys } from '@/services/projects'
import {
  resolveMagicPromptProvider,
  type AppPreferences,
} from '@/types/preferences'

interface UseContextOperationsParams {
  activeSessionId: string | null | undefined
  activeWorktreeId: string | null | undefined
  activeWorktreePath: string | null | undefined
  worktree: Worktree | null | undefined
  queryClient: QueryClient
  preferences: AppPreferences | undefined
}

interface UseContextOperationsReturn {
  /** Opens modal to select saved context */
  handleLoadContext: () => void
  /** Saves context with AI summarization (toast-based) */
  handleSaveContext: () => Promise<void>
  /** Whether the load context modal is open */
  loadContextModalOpen: boolean
  /** Setter for load context modal open state */
  setLoadContextModalOpen: (open: boolean) => void
}

/**
 * Hook for context save/load operations.
 *
 * Provides handlers for saving current session context with AI summarization
 * and loading saved contexts as attachments.
 */
export function useContextOperations({
  activeSessionId,
  activeWorktreeId,
  activeWorktreePath,
  worktree,
  queryClient,
  preferences,
}: UseContextOperationsParams): UseContextOperationsReturn {
  const loadContextModalOpen = useUIStore(state => state.loadContextModalOpen)
  const setLoadContextModalOpen = useUIStore(
    state => state.setLoadContextModalOpen
  )

  // Handle Save Context - generates context summary in the background
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleSaveContext = useCallback(async () => {
    if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

    // Get project display name (e.g., "royal-camel") instead of worktree name (e.g., "main")
    const projects = queryClient.getQueryData<Project[]>(
      projectsQueryKeys.list()
    )
    const projectName =
      projects?.find(p => p.id === worktree?.project_id)?.name ??
      worktree?.name ??
      'unknown-project'

    // Check if this session already has a saved context
    const cachedContexts = queryClient.getQueryData<SavedContextsResponse>([
      'session-context',
    ])
    const existingContext = cachedContexts?.contexts.find(
      c => c.source_session_id === activeSessionId
    )
    const toastId = toast.loading(
      existingContext
        ? `Updating context: ${existingContext.name || existingContext.slug}...`
        : 'Saving context...'
    )

    try {
      // Call background summarization command
      const result = await invoke<SaveContextResponse>(
        'generate_context_from_session',
        {
          worktreePath: activeWorktreePath,
          worktreeId: activeWorktreeId,
          sourceSessionId: activeSessionId,
          projectName,
          customPrompt: preferences?.magic_prompts?.context_summary,
          model: preferences?.magic_prompt_models?.context_summary_model,
          customProfileName: resolveMagicPromptProvider(
            preferences?.magic_prompt_providers,
            'context_summary_provider',
            preferences?.default_provider
          ),
          reasoningEffort:
            preferences?.magic_prompt_efforts?.context_summary_effort ?? null,
        }
      )

      const verb = result.updated ? 'Context updated' : 'Context saved'
      toast.success(`${verb}: ${result.filename}`, { id: toastId })

      // Invalidate saved contexts query so Load Context modal shows the new context
      queryClient.invalidateQueries({ queryKey: ['session-context'] })
    } catch (err) {
      console.error('Failed to save context:', err)
      toast.error(`Failed to save context: ${err}`, { id: toastId })
    }
  }, [
    activeSessionId,
    activeWorktreeId,
    activeWorktreePath,
    worktree?.name,
    queryClient,
    preferences?.magic_prompts?.context_summary,
    preferences?.magic_prompt_models?.context_summary_model,
    preferences?.magic_prompt_providers,
    preferences?.default_provider,
    preferences?.magic_prompt_efforts?.context_summary_effort,
  ])

  // Handle Load Context - opens modal to select saved context
  const handleLoadContext = useCallback(() => {
    setLoadContextModalOpen(true)
  }, [setLoadContextModalOpen])

  return {
    handleLoadContext,
    handleSaveContext,
    loadContextModalOpen,
    setLoadContextModalOpen,
  }
}
