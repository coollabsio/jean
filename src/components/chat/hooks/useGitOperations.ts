import { useCallback, useState } from 'react'
import { invoke } from '@/lib/transport'
import { openExternal } from '@/lib/platform'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { generateId } from '@/lib/uuid'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { chatQueryKeys } from '@/services/chat'
import { saveWorktreePr, projectsQueryKeys } from '@/services/projects'
import {
  gitPush,
  triggerImmediateGitPoll,
  triggerImmediateRemotePoll,
  performGitPull,
} from '@/services/git-status'
import { prStatusQueryKeys } from '@/services/pr-status'
import type { PrStatusEvent } from '@/types/pr-status'
import { isBaseSession } from '@/types/projects'
import type {
  CreatePrResponse,
  CreateCommitResponse,
  DetectPrResponse,
  ReviewResponse,
  MergeWorktreeResponse,
  MergeConflictsResponse,
  MergeType,
  Worktree,
  Project,
} from '@/types/projects'
import type { Session } from '@/types/chat'
import {
  DEFAULT_RESOLVE_CONFLICTS_PROMPT,
  resolveMagicPromptProvider,
  type AppPreferences,
} from '@/types/preferences'

interface UseGitOperationsParams {
  activeWorktreeId: string | null | undefined
  activeSessionId: string | null | undefined
  activeWorktreePath: string | null | undefined
  worktree: Worktree | null | undefined
  project: Project | null | undefined
  queryClient: QueryClient
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  preferences: AppPreferences | undefined
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
  /** Creates PR with AI-generated title and description */
  handleOpenPr: () => Promise<void>
  /** Runs AI code review. If existingSessionId is provided, stores results on that session instead of creating a new one. */
  handleReview: (existingSessionId?: string) => Promise<void>
  /** Validates and shows merge options dialog */
  handleMerge: () => Promise<void>
  /** Detects existing merge conflicts and opens resolution session */
  handleResolveConflicts: () => Promise<void>
  /** Fetches base branch and merges to create local conflict state for PR conflict resolution */
  handleResolvePrConflicts: () => Promise<void>
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
}: UseGitOperationsParams): UseGitOperationsReturn {
  // Merge dialog state
  const [showMergeDialog, setShowMergeDialog] = useState(false)
  const [pendingMergeWorktree, setPendingMergeWorktree] =
    useState<Worktree | null>(null)

  // Handle Commit - creates commit with AI-generated message (no push)
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
    const toastId = toast.loading(`Creating commit on ${prefix}...`)

    try {
      const result = await invoke<CreateCommitResponse>(
        'create_commit_with_ai',
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
        }
      )

      // Clear selected files and trigger refresh
      clearGitDiffSelectedFiles()
      triggerImmediateGitPoll()
      window.dispatchEvent(new CustomEvent('git-commit-completed'))

      toast.success(`${prefix}: ${result.message.split('\n')[0]}`, {
        id: toastId,
      })
    } catch (error) {
      toast.error(`${prefix}: Failed to commit: ${error}`, { id: toastId })
    } finally {
      clearWorktreeLoading(activeWorktreeId)
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
      const toastId = toast.loading(`Committing and pushing on ${prefix}...`)

      try {
        const result = await invoke<CreateCommitResponse>(
          'create_commit_with_ai',
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
          }
        )

        // Clear selected files and trigger refresh
        clearGitDiffSelectedFiles()
        triggerImmediateGitPoll()
        window.dispatchEvent(new CustomEvent('git-commit-completed'))

        if (result.push_permission_denied) {
          toast.error(
            `${prefix}: No permission to push to PR #${worktree?.pr_number}. Create a separate PR instead.`,
            {
              id: toastId,
              action: {
                label: 'Open PR',
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
          toast.warning(
            `${prefix}: Could not push to PR branch, pushed to new branch instead`,
            { id: toastId }
          )
        } else if (result.commit_hash) {
          toast.success(`${prefix}: ${result.message.split('\n')[0]}`, {
            id: toastId,
          })
        } else {
          toast.success(`${prefix}: Pushed to remote`, { id: toastId })
        }
      } catch (error) {
        toast.error(`${prefix}: Failed: ${error}`, { id: toastId })
      } finally {
        clearWorktreeLoading(activeWorktreeId)
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
      const toastId = toast.loading(`Pushing ${branch}...`)

      try {
        const result = await gitPush(
          activeWorktreePath,
          worktree?.pr_number,
          remote
        )
        triggerImmediateGitPoll()
        if (result.permissionDenied) {
          toast.error(
            `No permission to push to PR #${worktree?.pr_number}. Create a separate PR instead.`,
            {
              id: toastId,
              action: {
                label: 'Open PR',
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
          toast.warning(
            'Could not push to PR branch, pushed to new branch instead',
            { id: toastId }
          )
        } else {
          toast.success('Changes pushed', { id: toastId })
        }
      } catch (error) {
        toast.error(`Push failed: ${error}`, { id: toastId })
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

  // Handle Open PR - creates PR with AI-generated title and description in background
  const handleOpenPr = useCallback(async () => {
    if (!activeWorktreeId || !activeWorktreePath || !worktree) return

    const { setWorktreeLoading, clearWorktreeLoading } = useChatStore.getState()
    setWorktreeLoading(activeWorktreeId, 'pr')
    const branch = worktree?.branch ?? ''
    const toastId = toast.loading(`Creating PR for ${branch}...`)

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
            label: 'Open',
            onClick: () => openExternal(result.pr_url),
          },
        }
      )
    } catch (error) {
      toast.error(`Failed to create PR: ${error}`, { id: toastId })
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
  const handleReview = useCallback(async () => {
    if (!activeWorktreeId || !activeWorktreePath) return

    const { setWorktreeLoading, clearWorktreeLoading } = useChatStore.getState()
    setWorktreeLoading(activeWorktreeId, 'review')
    const branch = worktree?.branch ?? ''
    const projectName = project?.name ?? 'project'
    const worktreeName = worktree?.name ?? branch
    const reviewTarget = `${projectName}/${worktreeName}`
    const reviewRunId = generateId()
    let cancelRequested = false
    const toastId = toast.loading(`Reviewing ${reviewTarget}...`, {
      cancel: {
        label: 'Cancel',
        onClick: () => {
          cancelRequested = true
          toast.loading(`Cancelling review for ${reviewTarget}...`, {
            id: toastId,
          })
          invoke<boolean>('cancel_review_with_ai', { reviewRunId })
            .then(cancelled => {
              if (cancelled) {
                toast.info(`Review cancelled for ${reviewTarget}`, {
                  id: toastId,
                })
              } else {
                toast.info(`No active review to cancel for ${reviewTarget}`, {
                  id: toastId,
                })
              }
            })
            .catch(error => {
              toast.error(`Failed to cancel review: ${error}`, { id: toastId })
            })
        },
      },
    })

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
      const result = await invoke<ReviewResponse>('run_review_with_ai', {
        worktreePath: activeWorktreePath,
        customPrompt: preferences?.magic_prompts?.code_review,
        model: preferences?.magic_prompt_models?.code_review_model,
        customProfileName: resolveMagicPromptProvider(
          preferences?.magic_prompt_providers,
          'code_review_provider',
          preferences?.default_provider
        ),
        reasoningEffort:
          preferences?.magic_prompt_efforts?.code_review_effort ?? null,
        reviewRunId,
      })

      // Always create a new session for the review
      const newSession = await invoke<Session>('create_session', {
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        name: 'Code Review',
      })
      const targetSessionId = newSession.id

      // Store review results in Zustand (session-scoped, auto-opens sidebar)
      const {
        setReviewResults,
        setActiveSession,
        clearActiveWorktree,
        copySessionSettings,
        activeSessionIds,
      } = useChatStore.getState()
      const currentReviewSessionId = activeSessionIds[activeWorktreeId]
      setReviewResults(targetSessionId, result)

      // Inherit model/mode/thinking settings from current session
      if (currentReviewSessionId)
        copySessionSettings(currentReviewSessionId, targetSessionId)

      // Navigate to ProjectCanvasView and open the review session
      setActiveSession(activeWorktreeId, targetSessionId)
      useProjectsStore.getState().selectWorktree(activeWorktreeId)
      clearActiveWorktree()
      useUIStore
        .getState()
        .markWorktreeForAutoOpenSession(activeWorktreeId, targetSessionId)

      // Persist review results to session file
      invoke('update_session_state', {
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        sessionId: targetSessionId,
        reviewResults: result,
      }).catch(() => {
        /* noop - best effort persist */
      })

      // Invalidate sessions query to refresh tab bar
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(activeWorktreeId),
      })

      const findingCount = result.findings.length
      toast.success(
        `Review done on ${projectName}/${worktreeName} (${findingCount} findings)`,
        {
          id: toastId,
          action: {
            label: 'Open',
            onClick: () => {
              if (!activeWorktreePath) return
              const { setActiveSession, clearActiveWorktree } =
                useChatStore.getState()
              useProjectsStore.getState().selectWorktree(activeWorktreeId)
              clearActiveWorktree()
              setActiveSession(activeWorktreeId, targetSessionId)
              useUIStore
                .getState()
                .markWorktreeForAutoOpenSession(
                  activeWorktreeId,
                  targetSessionId
                )
            },
          },
        }
      )
    } catch (error) {
      const errorString = String(error)
      const cancelled =
        cancelRequested ||
        errorString.toLowerCase().includes('cancelled') ||
        errorString.toLowerCase().includes('canceled')
      if (cancelled) {
        toast.info(`Review cancelled for ${reviewTarget}`, { id: toastId })
      } else {
        toast.error(`Failed to review: ${error}`, { id: toastId })
      }
    } finally {
      clearWorktreeLoading(activeWorktreeId)
    }
  }, [
    activeWorktreeId,
    activeWorktreePath,
    worktree,
    project?.name,
    queryClient,
    preferences?.magic_prompts?.code_review,
    preferences?.magic_prompt_models?.code_review_model,
    preferences?.magic_prompt_providers,
    preferences?.default_provider,
    preferences?.magic_prompt_efforts?.code_review_effort,
  ])

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

  // Handle Resolve Conflicts - detects existing merge conflicts and opens resolution session
  const handleResolveConflicts = useCallback(async () => {
    if (!activeWorktreeId || !worktree) return

    const toastId = toast.loading('Checking for merge conflicts...')

    try {
      const result = await invoke<MergeConflictsResponse>(
        'get_merge_conflicts',
        { worktreeId: activeWorktreeId }
      )

      if (!result.has_conflicts) {
        toast.info('No merge conflicts detected', { id: toastId })
        return
      }

      toast.warning(`Found conflicts in ${result.conflicts.length} file(s)`, {
        id: toastId,
        description: 'Opening conflict resolution session...',
      })

      const {
        setActiveSession,
        setInputDraft,
        copySessionSettings,
        activeSessionIds,
      } = useChatStore.getState()
      const currentSessionId = activeSessionIds[activeWorktreeId]

      // Create a NEW session tab for conflict resolution
      const newSession = await invoke<Session>('create_session', {
        worktreeId: activeWorktreeId,
        worktreePath: worktree.path,
        name: 'Resolve conflicts',
      })

      // Inherit model/mode/thinking settings from current session
      if (currentSessionId) copySessionSettings(currentSessionId, newSession.id)

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

      // Set the input draft for the new session
      setInputDraft(newSession.id, conflictPrompt)

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
  }, [activeWorktreeId, worktree, preferences, queryClient, inputRef])

  // Handle PR Conflicts - fetches base branch, merges locally to create conflict state
  const handleResolvePrConflicts = useCallback(async () => {
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

      const {
        setActiveSession,
        setInputDraft,
        copySessionSettings,
        activeSessionIds,
      } = useChatStore.getState()
      const currentSessionId = activeSessionIds[activeWorktreeId]

      // Create a NEW session tab for conflict resolution
      const newSession = await invoke<Session>('create_session', {
        worktreeId: activeWorktreeId,
        worktreePath: worktree.path,
        name: 'PR: resolve conflicts',
      })

      // Inherit model/mode/thinking settings from current session
      if (currentSessionId) copySessionSettings(currentSessionId, newSession.id)

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

      // Set the input draft for the new session
      setInputDraft(newSession.id, conflictPrompt)

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
  }, [activeWorktreeId, worktree, project, preferences, queryClient, inputRef])

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

          const {
            setActiveSession,
            setInputDraft,
            copySessionSettings,
            activeSessionIds,
          } = useChatStore.getState()
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

          // Set the input draft for the new session
          setInputDraft(newSession.id, conflictPrompt)

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
    ]
  )

  return {
    handleCommit,
    handleCommitAndPush,
    handlePull,
    handlePush,
    handleOpenPr,
    handleReview,
    handleMerge,
    handleResolveConflicts,
    handleResolvePrConflicts,
    executeMerge,
    showMergeDialog,
    setShowMergeDialog,
    pendingMergeWorktree,
  }
}
