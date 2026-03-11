import { useCallback, useContext, useMemo } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { ThemeProviderContext, type Theme } from '@/lib/theme-context'
import { notify } from '@/lib/notifications'
import { logger } from '@/lib/logger'
import type { CommandContext } from '@/lib/commands/types'
import type { AppPreferences, ClaudeModel } from '@/types/preferences'
import { resolveMagicPromptProvider } from '@/types/preferences'
import type { ThinkingLevel, ExecutionMode } from '@/types/chat'
import type { Project, ReviewResponse } from '@/types/projects'
import { useQueryClient } from '@tanstack/react-query'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { chatQueryKeys } from '@/services/chat'
import { projectsQueryKeys } from '@/services/projects'
import { triggerImmediateGitPoll, performGitPull } from '@/services/git-status'

/**
 * Command context hook - provides essential actions for commands
 * @param preferences - Optional preferences for terminal/editor selection
 */
export function useCommandContext(
  preferences?: AppPreferences
): CommandContext {
  'use no memo'

  const queryClient = useQueryClient()
  const themeContext = useContext(ThemeProviderContext)
  const { installedBackends } = useInstalledBackends()

  // Preferences
  const openPreferences = useCallback(() => {
    useUIStore.getState().togglePreferences()
  }, [])

  // Notifications
  const showToast = useCallback(
    (message: string, type: 'success' | 'error' | 'info' = 'info') => {
      notify(message, undefined, { type })
    },
    []
  )

  // GitHub - Open PR
  const openPullRequest = useCallback(async () => {
    const { selectedWorktreeId } = useProjectsStore.getState()

    if (!selectedWorktreeId) {
      notify('No worktree selected. Select a worktree first.', undefined, {
        type: 'error',
      })
      return
    }

    logger.info('Opening pull request for worktree:', { selectedWorktreeId })
    notify('Opening pull request...', undefined, { type: 'info' })

    try {
      const result = await invoke<string>('open_pull_request', {
        worktreeId: selectedWorktreeId,
      })
      logger.info('Pull request opened:', { result })
      notify('Pull request opened successfully!', undefined, {
        type: 'success',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to open pull request:', { error: message })
      notify(message, undefined, { type: 'error' })
    }
  }, [])

  // Git - Open commit modal
  const openCommitModal = useCallback(() => {
    const { selectedWorktreeId } = useProjectsStore.getState()

    if (!selectedWorktreeId) {
      notify('No worktree selected. Select a worktree first.', undefined, {
        type: 'error',
      })
      return
    }

    useUIStore.getState().setCommitModalOpen(true)
  }, [])

  // Git - View diff modal
  const viewGitDiff = useCallback(() => {
    const { selectedWorktreeId } = useProjectsStore.getState()

    if (!selectedWorktreeId) {
      notify('No worktree selected. Select a worktree first.', undefined, {
        type: 'error',
      })
      return
    }

    window.dispatchEvent(new CustomEvent('open-git-diff'))
  }, [])

  // Git - Rebase worktree
  const rebaseWorktree = useCallback(async () => {
    const { selectedWorktreeId } = useProjectsStore.getState()

    if (!selectedWorktreeId) {
      notify('No worktree selected. Select a worktree first.', undefined, {
        type: 'error',
      })
      return
    }

    notify('Rebasing worktree...', undefined, { type: 'info' })

    try {
      await invoke('rebase_worktree', { worktreeId: selectedWorktreeId })
      notify('Rebase completed successfully!', undefined, { type: 'success' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to rebase worktree:', { error: message })
      notify(message, undefined, { type: 'error' })
    }
  }, [])

  // Sessions - Create new session
  const createSession = useCallback(() => {
    const { activeWorktreeId } = useChatStore.getState()

    if (!activeWorktreeId) {
      notify('No worktree selected. Select a worktree first.', undefined, {
        type: 'error',
      })
      return
    }

    // Dispatch custom event for session creation (handled by ChatWindow)
    window.dispatchEvent(new CustomEvent('command:create-session'))
  }, [])

  // Sessions - Close current session
  const closeSession = useCallback(() => {
    // Dispatch custom event for session close (handled by ChatWindow)
    window.dispatchEvent(new CustomEvent('command:close-session'))
  }, [])

  // Sessions - Navigate to next session
  const nextSession = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:next-session'))
  }, [])

  // Sessions - Navigate to previous session
  const previousSession = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:previous-session'))
  }, [])

  // Sessions - Clear chat history
  const clearSessionHistory = useCallback(async () => {
    const { activeWorktreeId, getActiveSession } = useChatStore.getState()
    if (!activeWorktreeId) return

    const sessionId = getActiveSession(activeWorktreeId)
    if (!sessionId) return

    try {
      await invoke('clear_session_history', {
        worktreeId: activeWorktreeId,
        sessionId,
      })
      await queryClient.invalidateQueries({
        queryKey: chatQueryKeys.session(sessionId),
      })
      notify('Chat history cleared', undefined, { type: 'success' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notify(message, undefined, { type: 'error' })
    }
  }, [queryClient])

  // Sessions - Rename session
  const renameSession = useCallback(() => {
    const { activeWorktreeId, getActiveSession } = useChatStore.getState()
    if (!activeWorktreeId) {
      notify('No worktree selected', undefined, { type: 'error' })
      return
    }

    const sessionId = getActiveSession(activeWorktreeId)
    if (!sessionId) {
      notify('No session selected', undefined, { type: 'error' })
      return
    }

    window.dispatchEvent(
      new CustomEvent('command:rename-session', { detail: { sessionId } })
    )
  }, [])

  // Worktrees - Create new worktree
  const createWorktree = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:create-worktree'))
  }, [])

  // Worktrees - Navigate to next worktree
  const nextWorktree = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:next-worktree'))
  }, [])

  // Worktrees - Navigate to previous worktree
  const previousWorktree = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:previous-worktree'))
  }, [])

  // Worktrees - Delete worktree
  const deleteWorktree = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:delete-worktree'))
  }, [])

  // Worktrees - Rename worktree (triggers edit mode in WorktreeItem)
  const renameWorktree = useCallback(() => {
    const { selectedWorktreeId } = useProjectsStore.getState()
    if (!selectedWorktreeId) {
      notify('No worktree selected', undefined, { type: 'error' })
      return
    }

    window.dispatchEvent(
      new CustomEvent('command:rename-worktree', {
        detail: { worktreeId: selectedWorktreeId },
      })
    )
  }, [])

  // Helper to get target path (worktree or project)
  const getTargetPath = useCallback(() => {
    const { selectedWorktreeId, selectedProjectId } =
      useProjectsStore.getState()

    // Try worktree path first
    if (selectedWorktreeId) {
      const path = useChatStore.getState().getWorktreePath(selectedWorktreeId)
      if (path) return path
    }

    // Fall back to project path
    if (selectedProjectId) {
      const projects = queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )
      const project = projects?.find(p => p.id === selectedProjectId)
      if (project) return project.path
    }

    return null
  }, [queryClient])

  // Open In - Finder
  const openInFinder = useCallback(async () => {
    const worktreePath = getTargetPath()
    if (!worktreePath) {
      notify('No project or worktree selected', undefined, { type: 'error' })
      return
    }

    try {
      await invoke('open_worktree_in_finder', { worktreePath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notify(message, undefined, { type: 'error' })
    }
  }, [getTargetPath])

  // Open In - Terminal
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const openInTerminal = useCallback(async () => {
    const worktreePath = getTargetPath()
    if (!worktreePath) {
      notify('No project or worktree selected', undefined, { type: 'error' })
      return
    }

    try {
      await invoke('open_worktree_in_terminal', {
        worktreePath,
        terminal: preferences?.terminal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notify(message, undefined, { type: 'error' })
    }
  }, [getTargetPath, preferences?.terminal])

  // Open In - Editor
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const openInEditor = useCallback(async () => {
    const worktreePath = getTargetPath()
    if (!worktreePath) {
      notify('No project or worktree selected', undefined, { type: 'error' })
      return
    }

    try {
      await invoke('open_worktree_in_editor', {
        worktreePath,
        editor: preferences?.editor,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notify(message, undefined, { type: 'error' })
    }
  }, [getTargetPath, preferences?.editor])

  // Open In - GitHub
  const openOnGitHub = useCallback(async () => {
    const { selectedProjectId } = useProjectsStore.getState()
    if (!selectedProjectId) {
      notify('No project selected', undefined, { type: 'error' })
      return
    }

    try {
      await invoke('open_project_on_github', { projectId: selectedProjectId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notify(message, undefined, { type: 'error' })
    }
  }, [])

  // Open In - Modal
  const openOpenInModal = useCallback(() => {
    const { selectedWorktreeId, selectedProjectId } =
      useProjectsStore.getState()
    if (!selectedWorktreeId && !selectedProjectId) {
      notify('No project or worktree selected', undefined, { type: 'error' })
      return
    }
    useUIStore.getState().setOpenInModalOpen(true)
  }, [])

  // Model/Thinking - Set model (stored in preferences via event)
  const setModel = useCallback((model: ClaudeModel) => {
    window.dispatchEvent(
      new CustomEvent('command:set-model', { detail: { model } })
    )
    notify(`Model set to ${model}`, undefined, { type: 'success' })
  }, [])

  // Model/Thinking - Set thinking level
  const setThinkingLevel = useCallback((level: ThinkingLevel) => {
    const {
      activeWorktreeId,
      getActiveSession,
      setThinkingLevel: setLevel,
    } = useChatStore.getState()
    if (!activeWorktreeId) return

    const sessionId = getActiveSession(activeWorktreeId)
    if (!sessionId) return

    setLevel(sessionId, level)
    notify(`Thinking level set to ${level}`, undefined, { type: 'success' })
  }, [])

  // Execution Mode - Set mode
  const setExecutionMode = useCallback((mode: ExecutionMode) => {
    const {
      activeWorktreeId,
      getActiveSession,
      setExecutionMode: setMode,
    } = useChatStore.getState()
    if (!activeWorktreeId) return

    const sessionId = getActiveSession(activeWorktreeId)
    if (!sessionId) return

    setMode(sessionId, mode)
    notify(`Execution mode set to ${mode}`, undefined, { type: 'success' })
  }, [])

  // Execution Mode - Cycle mode
  const cycleExecutionMode = useCallback(() => {
    const {
      activeWorktreeId,
      getActiveSession,
      cycleExecutionMode: cycle,
    } = useChatStore.getState()
    if (!activeWorktreeId) return

    const sessionId = getActiveSession(activeWorktreeId)
    if (!sessionId) return

    cycle(sessionId)
  }, [])

  // Theme - Set theme
  const setTheme = useCallback(
    (theme: Theme) => {
      themeContext.setTheme(theme)
      notify(`Theme set to ${theme}`, undefined, { type: 'success' })
    },
    [themeContext]
  )

  // Focus - Focus chat input
  const focusChatInput = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:focus-chat-input'))
  }, [])

  // Projects - Add project
  const addProject = useCallback(() => {
    useProjectsStore.getState().setAddProjectDialogOpen(true)
  }, [])

  // Projects - Init project
  const initProject = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:init-project'))
  }, [])

  // Projects - Remove project
  const removeProject = useCallback(async () => {
    const { selectedProjectId } = useProjectsStore.getState()
    if (!selectedProjectId) {
      notify('No project selected', undefined, { type: 'error' })
      return
    }

    // Confirm before removing
    window.dispatchEvent(
      new CustomEvent('command:remove-project', {
        detail: { projectId: selectedProjectId },
      })
    )
  }, [])

  // Projects - Open project settings
  const openProjectSettings = useCallback(() => {
    const { selectedProjectId } = useProjectsStore.getState()
    if (!selectedProjectId) {
      notify('No project selected', undefined, { type: 'error' })
      return
    }
    useProjectsStore.getState().openProjectSettings(selectedProjectId)
  }, [])

  // State getters
  const hasActiveSession = useCallback(() => {
    const { activeWorktreeId, getActiveSession } = useChatStore.getState()
    if (!activeWorktreeId) return false
    return !!getActiveSession(activeWorktreeId)
  }, [])

  const hasActiveWorktree = useCallback(() => {
    const { selectedWorktreeId } = useProjectsStore.getState()
    return !!selectedWorktreeId
  }, [])

  const hasSelectedProject = useCallback(() => {
    const { selectedProjectId } = useProjectsStore.getState()
    return !!selectedProjectId
  }, [])

  const hasInstalledBackend = useCallback(
    () => installedBackends.length > 0,
    [installedBackends]
  )

  const hasMultipleSessions = useCallback(() => {
    // This would need access to sessions data - return true as default
    // Actual implementation would check query cache
    return true
  }, [])

  const hasMultipleWorktrees = useCallback(() => {
    // This would need access to worktrees data - return true as default
    return true
  }, [])

  const getCurrentTheme = useCallback((): Theme => {
    return themeContext.theme
  }, [themeContext])

  const getCurrentModel = useCallback((): ClaudeModel => {
    // Default to opus - actual model comes from preferences
    return 'opus'
  }, [])

  const getCurrentThinkingLevel = useCallback((): ThinkingLevel => {
    const { activeWorktreeId, getActiveSession, getThinkingLevel } =
      useChatStore.getState()
    if (!activeWorktreeId) return 'off'
    const sessionId = getActiveSession(activeWorktreeId)
    if (!sessionId) return 'off'
    return getThinkingLevel(sessionId)
  }, [])

  const getCurrentExecutionMode = useCallback((): ExecutionMode => {
    const { activeWorktreeId, getActiveSession, getExecutionMode } =
      useChatStore.getState()
    if (!activeWorktreeId) return 'plan'
    const sessionId = getActiveSession(activeWorktreeId)
    if (!sessionId) return 'plan'
    return getExecutionMode(sessionId)
  }, [])

  // Git - Pull changes from remote
  const doGitPull = useCallback(async () => {
    const worktreePath = getTargetPath()
    if (!worktreePath) {
      notify('No project or worktree selected', undefined, { type: 'error' })
      return
    }

    // Get base branch from project's default_branch
    const { selectedWorktreeId, selectedProjectId } =
      useProjectsStore.getState()
    const projects = queryClient.getQueryData<Project[]>(
      projectsQueryKeys.list()
    )

    let baseBranch = 'main' // Default fallback

    if (selectedWorktreeId) {
      // Get worktree to find project_id
      const worktree = queryClient.getQueryData<{
        project_id: string
      }>([...projectsQueryKeys.all, 'worktree', selectedWorktreeId])
      if (worktree) {
        const project = projects?.find(p => p.id === worktree.project_id)
        if (project?.default_branch) {
          baseBranch = project.default_branch
        }
      }
    } else if (selectedProjectId) {
      const project = projects?.find(p => p.id === selectedProjectId)
      if (project?.default_branch) {
        baseBranch = project.default_branch
      }
    }

    const { activeWorktreeId } = useChatStore.getState()
    await performGitPull({
      worktreeId: activeWorktreeId ?? '',
      worktreePath,
      baseBranch,
    })
  }, [getTargetPath, queryClient])

  // Git - Refresh git status immediately
  const refreshGitStatus = useCallback(() => {
    triggerImmediateGitPoll()
    notify('Git status refreshed', undefined, { type: 'info' })
  }, [])

  // AI - Run code review
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const runAIReview = useCallback(async () => {
    const { activeWorktreeId, activeWorktreePath } = useChatStore.getState()
    if (!activeWorktreeId || !activeWorktreePath) {
      notify('No worktree selected', undefined, { type: 'error' })
      return
    }

    const toastId = toast.loading('Running AI code review...')
    try {
      const result = await invoke<ReviewResponse>('run_review_with_ai', {
        worktreePath: activeWorktreePath,
        customPrompt: preferences?.magic_prompts?.code_review,
        model: preferences?.magic_prompt_models?.code_review_model,
        customProfileName: resolveMagicPromptProvider(
          preferences?.magic_prompt_providers,
          'code_review_provider',
          preferences?.default_provider
        ),
        reasoningEffort: preferences?.magic_prompt_efforts?.code_review_effort ?? null,
      })

      // Store review results in Zustand (also activates review tab)
      const { setReviewResults } = useChatStore.getState()
      setReviewResults(activeWorktreeId, result)

      const findingCount = result.findings.length
      const statusEmoji =
        result.approval_status === 'approved'
          ? 'Approved'
          : result.approval_status === 'changes_requested'
            ? 'Changes requested'
            : 'Needs discussion'

      toast.success(
        `Review complete: ${statusEmoji} (${findingCount} findings)`,
        { id: toastId }
      )
    } catch (error) {
      toast.error(`Failed to review: ${error}`, { id: toastId })
    }
  }, [
    preferences?.magic_prompts?.code_review,
    preferences?.magic_prompt_models?.code_review_model,
    preferences?.magic_prompt_providers,
    preferences?.default_provider,
    preferences?.magic_prompt_efforts?.code_review_effort,
  ])

  // Terminal - Open terminal panel
  const openTerminalPanel = useCallback(() => {
    const { selectedWorktreeId } = useProjectsStore.getState()
    if (!selectedWorktreeId) {
      notify('No worktree selected', undefined, { type: 'error' })
      return
    }

    const { addTerminal, setTerminalPanelOpen, setTerminalVisible } =
      useTerminalStore.getState()
    const terminals = useTerminalStore
      .getState()
      .getTerminals(selectedWorktreeId)

    // Create a new terminal if none exists
    if (terminals.length === 0) {
      addTerminal(selectedWorktreeId)
    } else {
      // Just show the panel
      setTerminalPanelOpen(selectedWorktreeId, true)
      setTerminalVisible(true)
    }
  }, [])

  // Terminal - Run script from jean.json
  const runScript = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:run-script'))
  }, [])

  // Context - Save current session context
  const saveContext = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:save-context'))
  }, [])

  // Context - Load context (opens modal)
  const loadContext = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:load-context'))
  }, [])

  // Archive - Open archived modal
  const openArchivedModal = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:open-archived-modal'))
  }, [])

  // Archive - Restore last archived
  const restoreLastArchived = useCallback(() => {
    window.dispatchEvent(new CustomEvent('restore-last-archived'))
  }, [])

  // Unread sessions
  const openUnreadSessions = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:open-unread-sessions'))
  }, [])

  // Developer - Toggle debug mode
  const toggleDebugMode = useCallback(() => {
    window.dispatchEvent(new CustomEvent('command:toggle-debug-mode'))
  }, [])

  // Session - Resume session (reconnect to Claude CLI)
  const resumeSession = useCallback(async () => {
    const { activeWorktreeId, getActiveSession } = useChatStore.getState()
    if (!activeWorktreeId) {
      notify('No worktree selected', undefined, { type: 'error' })
      return
    }

    const sessionId = getActiveSession(activeWorktreeId)
    if (!sessionId) {
      notify('No session selected', undefined, { type: 'error' })
      return
    }

    const toastId = toast.loading('Resuming session...')
    try {
      await invoke('resume_session', {
        sessionId,
        worktreeId: activeWorktreeId,
      })
      toast.success('Session resumed', { id: toastId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(`Failed to resume: ${message}`, { id: toastId })
    }
  }, [])

  // Session - Regenerate session name using AI
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const regenerateSessionName = useCallback(async () => {
    const chatState = useChatStore.getState()
    const worktreeId =
      chatState.activeWorktreeId ??
      useProjectsStore.getState().selectedWorktreeId
    if (!worktreeId) {
      notify('No worktree selected', undefined, { type: 'error' })
      return
    }

    const sessionId = chatState.getActiveSession(worktreeId)
    if (!sessionId) {
      notify('No session selected', undefined, { type: 'error' })
      return
    }

    const worktreePath = chatState.getWorktreePath(worktreeId)
    if (!worktreePath) {
      notify('No worktree path found', undefined, { type: 'error' })
      return
    }

    const toastId = toast.loading('Regenerating session title...')
    try {
      await invoke('regenerate_session_name', {
        worktreeId,
        worktreePath,
        sessionId,
        customPrompt: preferences?.magic_prompts?.session_naming ?? null,
        model: preferences?.magic_prompt_models?.session_naming_model ?? null,
        customProfileName: resolveMagicPromptProvider(
          preferences?.magic_prompt_providers,
          'session_naming_provider',
          preferences?.default_provider
        ),
        reasoningEffort: preferences?.magic_prompt_efforts?.session_naming_effort ?? null,
      })
      toast.success('Session title will update shortly', { id: toastId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(`Failed to regenerate: ${message}`, { id: toastId })
    }
  }, [
    preferences?.magic_prompts?.session_naming,
    preferences?.magic_prompt_models?.session_naming_model,
    preferences?.magic_prompt_providers,
    preferences?.default_provider,
    preferences?.magic_prompt_efforts?.session_naming_effort,
  ])

  // State getter - Check if run script is available
  const hasRunScript = useCallback(() => {
    // This needs to check if jean.json has a run script
    // For now return true - actual check happens in the run script handler
    return true
  }, [])

  return useMemo(
    () => ({
      // Query client
      queryClient,

      // Preferences
      openPreferences,

      // Notifications
      showToast,

      // GitHub
      openPullRequest,

      // Git
      openCommitModal,
      viewGitDiff,
      rebaseWorktree,
      gitPull: doGitPull,
      refreshGitStatus,

      // Sessions
      createSession,
      closeSession,
      nextSession,
      previousSession,
      clearSessionHistory,
      renameSession,
      resumeSession,
      regenerateSessionName,

      // Worktrees
      createWorktree,
      nextWorktree,
      previousWorktree,
      deleteWorktree,
      renameWorktree,

      // Open In
      openInFinder,
      openInTerminal,
      openInEditor,
      openOnGitHub,
      openOpenInModal,

      // Model/Thinking
      setModel,
      setThinkingLevel,

      // Execution Mode
      setExecutionMode,
      cycleExecutionMode,

      // Theme
      setTheme,

      // Focus
      focusChatInput,

      // Projects
      addProject,
      initProject,
      removeProject,
      openProjectSettings,

      // AI
      runAIReview,

      // Terminal
      openTerminalPanel,
      runScript,

      // Context
      saveContext,
      loadContext,

      // Archive
      openArchivedModal,
      restoreLastArchived,

      // Unread
      openUnreadSessions,

      // Developer
      toggleDebugMode,

      // State getters
      hasActiveSession,
      hasActiveWorktree,
      hasSelectedProject,
      hasInstalledBackend,
      hasMultipleSessions,
      hasMultipleWorktrees,
      hasRunScript,
      getCurrentTheme,
      getCurrentModel,
      getCurrentThinkingLevel,
      getCurrentExecutionMode,
    }),
    [
      queryClient,
      openPreferences,
      showToast,
      openPullRequest,
      openCommitModal,
      viewGitDiff,
      rebaseWorktree,
      doGitPull,
      refreshGitStatus,
      createSession,
      closeSession,
      nextSession,
      previousSession,
      clearSessionHistory,
      renameSession,
      resumeSession,
      regenerateSessionName,
      createWorktree,
      nextWorktree,
      previousWorktree,
      deleteWorktree,
      renameWorktree,
      openInFinder,
      openInTerminal,
      openInEditor,
      openOnGitHub,
      openOpenInModal,
      setModel,
      setThinkingLevel,
      setExecutionMode,
      cycleExecutionMode,
      setTheme,
      focusChatInput,
      addProject,
      initProject,
      removeProject,
      openProjectSettings,
      runAIReview,
      openTerminalPanel,
      runScript,
      saveContext,
      loadContext,
      openArchivedModal,
      restoreLastArchived,
      openUnreadSessions,
      toggleDebugMode,
      hasActiveSession,
      hasActiveWorktree,
      hasSelectedProject,
      hasInstalledBackend,
      hasMultipleSessions,
      hasMultipleWorktrees,
      hasRunScript,
      getCurrentTheme,
      getCurrentModel,
      getCurrentThinkingLevel,
      getCurrentExecutionMode,
    ]
  )
}
