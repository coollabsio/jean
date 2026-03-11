import { useCallback, useState, useRef, useEffect, useMemo } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  Eye,
  FileText,
  Wand2,
  BookmarkPlus,
  FolderOpen,
  Bug,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useWorktree, useProjects } from '@/services/projects'
import { useLoadedIssueContexts, useLoadedPRContexts } from '@/services/github'
import { usePreferences } from '@/services/preferences'
import { invoke } from '@/lib/transport'
import { generateId } from '@/lib/uuid'
import { openExternal } from '@/lib/platform'
import { notify } from '@/lib/notifications'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import {
  gitPush,
  triggerImmediateGitPoll,
  fetchWorktreesStatus,
  performGitPull,
} from '@/services/git-status'
import type {
  CreateCommitResponse,
  CreatePrResponse,
  MergeConflictsResponse,
  ReviewResponse,
} from '@/types/projects'
import type { Session } from '@/types/chat'
import {
  DEFAULT_RESOLVE_CONFLICTS_PROMPT,
  resolveMagicPromptProvider,
} from '@/types/preferences'
import { useRemotePicker } from '@/hooks/useRemotePicker'
import { chatQueryKeys } from '@/services/chat'
import { saveWorktreePr, projectsQueryKeys } from '@/services/projects'
import { useQueryClient } from '@tanstack/react-query'

type MagicOption =
  | 'save-context'
  | 'load-context'
  | 'create-recap'
  | 'commit'
  | 'commit-and-push'
  | 'pull'
  | 'push'
  | 'open-pr'
  | 'update-pr'
  | 'review'
  | 'merge'
  | 'resolve-conflicts'
  | 'release-notes'
  | 'investigate-issue'
  | 'investigate-pr'

/** Options that work on canvas without an open session (git-only operations) */
const CANVAS_ALLOWED_OPTIONS = new Set<MagicOption>([
  'create-recap',
  'commit',
  'commit-and-push',
  'pull',
  'push',
  'open-pr',
  'update-pr',
  'review',
  'release-notes',
  'merge',
  'resolve-conflicts',
])

/** Canvas options that navigate to worktree chat and dispatch a magic-command event */
const CANVAS_NAVIGATE_AND_DISPATCH_OPTIONS = new Set<MagicOption>(['merge'])

interface MagicOptionItem {
  id: MagicOption
  label: string
  icon: typeof GitCommitHorizontal
  key: string
}

interface MagicSection {
  header: string
  options: MagicOptionItem[]
}

interface MagicColumns {
  left: MagicSection[]
  right: MagicSection[]
  all: MagicSection[]
}

function buildMagicColumns(hasOpenPr: boolean): MagicColumns {
  const left: MagicSection[] = [
    {
      header: 'Context',
      options: [
        {
          id: 'save-context',
          label: 'Save Context',
          icon: BookmarkPlus,
          key: 'S',
        },
        {
          id: 'load-context',
          label: 'Load Context',
          icon: FolderOpen,
          key: 'L',
        },
        {
          id: 'create-recap',
          label: 'Create Recap',
          icon: Sparkles,
          key: 'T',
        },
      ],
    },
    {
      header: 'Commit',
      options: [
        { id: 'commit', label: 'Commit', icon: GitCommitHorizontal, key: 'C' },
        {
          id: 'commit-and-push',
          label: 'Commit & Push',
          icon: GitCommitHorizontal,
          key: 'P',
        },
      ],
    },
    {
      header: 'Sync',
      options: [
        { id: 'pull', label: 'Pull', icon: ArrowDownToLine, key: 'D' },
        { id: 'push', label: 'Push', icon: ArrowUpToLine, key: 'U' },
      ],
    },
  ]

  const right: MagicSection[] = [
    {
      header: 'Pull Request',
      options: [
        {
          id: 'open-pr',
          label: hasOpenPr ? 'Open' : 'Create',
          icon: GitPullRequest,
          key: 'O',
        },
        { id: 'review', label: 'Review', icon: Eye, key: 'R' },
      ],
    },
    {
      header: 'Release',
      options: [
        {
          id: 'release-notes',
          label: 'Generate Notes',
          icon: FileText,
          key: 'G',
        },
        {
          id: 'update-pr',
          label: 'Generate PR Description',
          icon: RefreshCw,
          key: 'E',
        },
      ],
    },
    {
      header: 'Investigate',
      options: [
        { id: 'investigate-issue', label: 'Issue', icon: Bug, key: 'I' },
        {
          id: 'investigate-pr',
          label: 'PR',
          icon: GitPullRequestArrow,
          key: 'A',
        },
      ],
    },
    {
      header: 'Branch',
      options: [
        { id: 'merge', label: 'Merge to Base', icon: GitMerge, key: 'M' },
        {
          id: 'resolve-conflicts',
          label: 'Resolve Conflicts',
          icon: GitMerge,
          key: 'F',
        },
      ],
    },
  ]

  return { left, right, all: [...left, ...right] }
}

/** Keyboard shortcut to option ID mapping */
const KEY_TO_OPTION: Record<string, MagicOption> = {
  s: 'save-context',
  l: 'load-context',
  t: 'create-recap',
  c: 'commit',
  p: 'commit-and-push',
  d: 'pull',
  u: 'push',
  o: 'open-pr',
  e: 'update-pr',
  r: 'review',
  m: 'merge',
  f: 'resolve-conflicts',
  g: 'release-notes',
  i: 'investigate-issue',
  a: 'investigate-pr',
}

export function MagicModal() {
  const { magicModalOpen, setMagicModalOpen, sessionChatModalWorktreeId } =
    useUIStore()
  const selectedWorktreeIdFromProjects = useProjectsStore(
    state => state.selectedWorktreeId
  )
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  // Fall back chain: projects store → chat store → session modal worktree
  // Session modal worktree is set when user opens a session from canvas view
  const selectedWorktreeId =
    selectedWorktreeIdFromProjects ??
    activeWorktreeId ??
    sessionChatModalWorktreeId
  const { data: worktree } = useWorktree(selectedWorktreeId)
  const contentRef = useRef<HTMLDivElement>(null)
  const hasInitializedRef = useRef(false)
  const [selectedOption, setSelectedOption] =
    useState<MagicOption>('save-context')

  const hasOpenPr = Boolean(worktree?.pr_url)

  // Check if worktree has loaded issue/PR contexts (for enabling investigate options)
  // Contexts may be registered under session ID (Load Context) or worktree ID (create_worktree)
  const activeSessionId = useChatStore(state =>
    selectedWorktreeId ? state.activeSessionIds[selectedWorktreeId] : undefined
  )
  const { data: issueContexts } = useLoadedIssueContexts(
    activeSessionId ?? selectedWorktreeId,
    selectedWorktreeId
  )
  const { data: prContexts } = useLoadedPRContexts(
    activeSessionId ?? selectedWorktreeId,
    selectedWorktreeId
  )
  const hasIssueContexts = (issueContexts?.length ?? 0) > 0
  const hasPrContexts = (prContexts?.length ?? 0) > 0

  const sessionModalOpen = useUIStore(state => state.sessionChatModalOpen)
  // Whether MagicModal was opened from ProjectCanvasView (no active chat session)
  const isOnCanvas = !useChatStore(state => state.activeWorktreePath) && !sessionModalOpen
  const pickRemoteOrRun = useRemotePicker(worktree?.path)

  // Build columns dynamically based on PR state
  const magicColumns = useMemo(() => buildMagicColumns(hasOpenPr), [hasOpenPr])

  // Flatten all options for arrow key navigation
  const allOptions = useMemo(
    () =>
      magicColumns.all.flatMap(section => section.options.map(opt => opt.id)),
    [magicColumns]
  )

  // Reset selection tracking when modal closes
  useEffect(() => {
    if (!magicModalOpen) {
      hasInitializedRef.current = false
    }
  }, [magicModalOpen])

  // Initialize selection when modal opens
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open && !hasInitializedRef.current) {
        setSelectedOption(isOnCanvas ? 'commit' : 'save-context')
        hasInitializedRef.current = true
      }
      setMagicModalOpen(open)
    },
    [setMagicModalOpen, isOnCanvas]
  )

  const queryClient = useQueryClient()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const { data: preferences } = usePreferences()
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null

  // Direct git execution for when ChatWindow isn't rendered (project canvas)
  const executeGitDirectly = useCallback(
    async (option: MagicOption) => {
      if (!selectedWorktreeId || !worktree?.path) return

      const { setWorktreeLoading, clearWorktreeLoading } =
        useChatStore.getState()

      const doCommit = async (isPush: boolean, remote?: string) => {
        setWorktreeLoading(selectedWorktreeId, 'commit')
        const branch = worktree.branch ?? ''
        const toastId = toast.loading(
          isPush
            ? `Committing and pushing on ${branch}...`
            : `Creating commit on ${branch}...`
        )
        try {
          const result = await invoke<CreateCommitResponse>(
            'create_commit_with_ai',
            {
              worktreePath: worktree.path,
              customPrompt: preferences?.magic_prompts?.commit_message,
              push: isPush,
              remote: remote ?? null,
              prNumber: isPush ? (worktree.pr_number ?? null) : null,
              model: preferences?.magic_prompt_models?.commit_message_model,
              customProfileName: resolveMagicPromptProvider(
                preferences?.magic_prompt_providers,
                'commit_message_provider',
                preferences?.default_provider
              ),
              reasoningEffort: preferences?.magic_prompt_efforts?.commit_message_effort ?? null,
            }
          )
          triggerImmediateGitPoll()
          if (worktree.project_id) fetchWorktreesStatus(worktree.project_id)
          if (result.push_fell_back) {
            toast.warning('Could not push to PR branch, pushed to new branch instead', {
              id: toastId,
            })
          } else if (result.commit_hash) {
            const prefix = isPush ? 'Committed and pushed' : 'Committed'
            toast.success(`${prefix}: ${result.message.split('\n')[0]}`, {
              id: toastId,
            })
          } else {
            toast.success('Pushed to remote', { id: toastId })
          }
        } catch (error) {
          toast.error(`Failed: ${error}`, { id: toastId })
        } finally {
          clearWorktreeLoading(selectedWorktreeId)
        }
      }

      switch (option) {
        case 'commit': {
          await doCommit(false)
          break
        }
        case 'commit-and-push': {
          if (worktree.pr_number) {
            await doCommit(true)
          } else {
            await pickRemoteOrRun(remote => doCommit(true, remote))
          }
          break
        }
        case 'pull': {
          await pickRemoteOrRun(async remote => {
            await performGitPull({
              worktreeId: selectedWorktreeId,
              worktreePath: worktree.path,
              baseBranch: project?.default_branch ?? 'main',
              branchLabel: worktree.branch,
              projectId: worktree.project_id ?? undefined,
              remote,
              onMergeConflict: () => executeGitDirectly('resolve-conflicts'),
            })
          })
          break
        }
        case 'push': {
          const doPush = async (remote?: string) => {
            const toastId = toast.loading(`Pushing ${worktree.branch}...`)
            try {
              const result = await gitPush(worktree.path, worktree.pr_number, remote)
              triggerImmediateGitPoll()
              if (worktree.project_id) fetchWorktreesStatus(worktree.project_id)
              if (result.fellBack) {
                toast.warning('Could not push to PR branch, pushed to new branch instead', { id: toastId })
              } else {
                toast.success('Changes pushed', { id: toastId })
              }
            } catch (error) {
              toast.error(`Push failed: ${error}`, { id: toastId })
            }
          }
          if (worktree.pr_number) {
            await doPush()
          } else {
            await pickRemoteOrRun(doPush)
          }
          break
        }
        case 'open-pr': {
          if (worktree.pr_url) {
            await openExternal(worktree.pr_url)
            return
          }
          setWorktreeLoading(selectedWorktreeId, 'pr')
          const branch = worktree.branch ?? ''
          const toastId = toast.loading(`Creating PR for ${branch}...`)
          try {
            const result = await invoke<CreatePrResponse>(
              'create_pr_with_ai_content',
              {
                worktreePath: worktree.path,
                customPrompt: preferences?.magic_prompts?.pr_content,
                model: preferences?.magic_prompt_models?.pr_content_model,
                customProfileName: resolveMagicPromptProvider(
                  preferences?.magic_prompt_providers,
                  'pr_content_provider',
                  preferences?.default_provider
                ),
                reasoningEffort: preferences?.magic_prompt_efforts?.pr_content_effort ?? null,
              }
            )
            if (!result.existing) {
              await saveWorktreePr(
                selectedWorktreeId,
                result.pr_number,
                result.pr_url
              )
            }
            queryClient.invalidateQueries({
              queryKey: projectsQueryKeys.worktrees(worktree.project_id),
            })
            queryClient.invalidateQueries({
              queryKey: [
                ...projectsQueryKeys.all,
                'worktree',
                selectedWorktreeId,
              ],
            })
            triggerImmediateGitPoll()
            if (worktree.project_id) fetchWorktreesStatus(worktree.project_id)
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
            clearWorktreeLoading(selectedWorktreeId)
          }
          break
        }
        case 'resolve-conflicts': {
          const toastId = toast.loading('Checking for merge conflicts...')
          try {
            const result = await invoke<MergeConflictsResponse>(
              'get_merge_conflicts',
              { worktreeId: selectedWorktreeId }
            )

            if (!result.has_conflicts) {
              toast.info('No merge conflicts detected', { id: toastId })
              return
            }

            toast.warning(
              `Found conflicts in ${result.conflicts.length} file(s)`,
              {
                id: toastId,
                description: 'Opening conflict resolution session...',
              }
            )

            const {
              setActiveWorktree,
              setActiveSession,
              setInputDraft,
              copySessionSettings,
              activeSessionIds,
            } = useChatStore.getState()
            const currentSessionId = activeSessionIds[selectedWorktreeId]

            const newSession = await invoke<Session>('create_session', {
              worktreeId: selectedWorktreeId,
              worktreePath: worktree.path,
              name: 'Resolve conflicts',
            })

            // Inherit model/mode/thinking settings from current session
            if (currentSessionId) copySessionSettings(currentSessionId, newSession.id)

            // Navigate to session in chat view
            useProjectsStore.getState().selectWorktree(selectedWorktreeId)
            setActiveWorktree(selectedWorktreeId, worktree.path)
            setActiveSession(selectedWorktreeId, newSession.id)

            // Build conflict resolution prompt
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

            setInputDraft(newSession.id, conflictPrompt)

            queryClient.invalidateQueries({
              queryKey: chatQueryKeys.sessions(selectedWorktreeId),
            })
          } catch (error) {
            toast.error(`Failed to check conflicts: ${error}`, { id: toastId })
          }
          break
        }
        case 'review': {
          setWorktreeLoading(selectedWorktreeId, 'review')
          const projectName = project?.name ?? 'project'
          const worktreeName = worktree.name ?? worktree.branch ?? ''
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
                      toast.info(
                        `No active review to cancel for ${reviewTarget}`,
                        { id: toastId }
                      )
                    }
                  })
                  .catch(error => {
                    toast.error(`Failed to cancel review: ${error}`, {
                      id: toastId,
                    })
                  })
              },
            },
          })
          try {
            const result = await invoke<ReviewResponse>('run_review_with_ai', {
              worktreePath: worktree.path,
              customPrompt: preferences?.magic_prompts?.code_review,
              model: preferences?.magic_prompt_models?.code_review_model,
              customProfileName: resolveMagicPromptProvider(
                preferences?.magic_prompt_providers,
                'code_review_provider',
                preferences?.default_provider
              ),
              reasoningEffort: preferences?.magic_prompt_efforts?.code_review_effort ?? null,
              reviewRunId,
            })

            const newSession = await invoke<Session>('create_session', {
              worktreeId: selectedWorktreeId,
              worktreePath: worktree.path,
              name: 'Code Review',
            })

            const {
              setReviewResults,
              setActiveSession,
              clearActiveWorktree,
              copySessionSettings,
              activeSessionIds,
            } = useChatStore.getState()
            const currentReviewSessionId = activeSessionIds[selectedWorktreeId]
            setReviewResults(newSession.id, result)

            // Inherit model/mode/thinking settings from current session
            if (currentReviewSessionId) copySessionSettings(currentReviewSessionId, newSession.id)

            // Navigate to ProjectCanvasView and auto-open session modal
            setActiveSession(selectedWorktreeId, newSession.id)
            useProjectsStore.getState().selectWorktree(selectedWorktreeId)
            clearActiveWorktree()
            useUIStore
              .getState()
              .markWorktreeForAutoOpenSession(
                selectedWorktreeId,
                newSession.id
              )

            // Persist review results to session file
            invoke('update_session_state', {
              worktreeId: selectedWorktreeId,
              worktreePath: worktree.path,
              sessionId: newSession.id,
              reviewResults: result,
              // eslint-disable-next-line @typescript-eslint/no-empty-function
            }).catch(() => {})

            queryClient.invalidateQueries({
              queryKey: chatQueryKeys.sessions(selectedWorktreeId),
            })

            const findingCount = result.findings.length
            toast.success(
              `Review done on ${reviewTarget} (${findingCount} findings)`,
              {
              id: toastId,
              action: {
                label: 'Open',
                onClick: () => {
                  const {
                    setActiveSession,
                    clearActiveWorktree,
                  } = useChatStore.getState()
                  useProjectsStore.getState().selectWorktree(selectedWorktreeId)
                  clearActiveWorktree()
                  setActiveSession(selectedWorktreeId, newSession.id)
                  setTimeout(() => {
                    window.dispatchEvent(
                      new CustomEvent('open-session-modal', {
                        detail: {
                          sessionId: newSession.id,
                          worktreeId: selectedWorktreeId,
                          worktreePath: worktree.path,
                        },
                      })
                    )
                  }, 50)
                },
              },
            })
          } catch (error) {
            const errorString = String(error)
            const cancelled =
              cancelRequested ||
              errorString.toLowerCase().includes('cancelled') ||
              errorString.toLowerCase().includes('canceled')
            if (cancelled) {
              toast.info(`Review cancelled for ${reviewTarget}`, {
                id: toastId,
              })
            } else {
              toast.error(`Review failed: ${error}`, { id: toastId })
            }
          } finally {
            clearWorktreeLoading(selectedWorktreeId)
          }
          break
        }
      }
    },
    [
      selectedWorktreeId,
      worktree,
      preferences,
      project,
      queryClient,
      pickRemoteOrRun,
    ]
  )

  const executeAction = useCallback(
    async (option: MagicOption) => {
      // Block disabled options on canvas
      if (isOnCanvas && !CANVAS_ALLOWED_OPTIONS.has(option)) {
        return
      }

      // release-notes only needs a project selected, not a worktree
      if (option === 'release-notes') {
        if (!selectedProjectId) {
          notify('No project selected', undefined, { type: 'error' })
          setMagicModalOpen(false)
          return
        }
        useUIStore.getState().setReleaseNotesModalOpen(true)
        setMagicModalOpen(false)
        return
      }

      if (!selectedWorktreeId) {
        notify('No worktree selected', undefined, { type: 'error' })
        setMagicModalOpen(false)
        return
      }

      // Create recap: dispatch open-recap event (handled by ChatWindow or canvas hooks)
      if (option === 'create-recap') {
        if (!activeSessionId) {
          toast.info('No active session to create a recap for')
          setMagicModalOpen(false)
          return
        }
        setMagicModalOpen(false)
        window.dispatchEvent(new CustomEvent('open-recap'))
        return
      }

      // Investigate options: guard against missing contexts
      if (option === 'investigate-issue' || option === 'investigate-pr') {
        const type = option === 'investigate-issue' ? 'issue' : 'pr'
        const hasContexts = type === 'issue' ? hasIssueContexts : hasPrContexts
        if (!hasContexts) {
          notify(
            `No ${type === 'issue' ? 'issue' : 'PR'} context loaded for this worktree`,
            undefined,
            { type: 'error' }
          )
          setMagicModalOpen(false)
          return
        }
        window.dispatchEvent(
          new CustomEvent('magic-command', {
            detail: { command: 'investigate', type },
          })
        )
        setMagicModalOpen(false)
        return
      }

      // Update PR description: open the update dialog (requires open PR)
      if (option === 'update-pr') {
        if (!worktree?.pr_number) {
          notify('No PR open for this worktree', undefined, { type: 'error' })
          setMagicModalOpen(false)
          return
        }
        useUIStore.getState().setUpdatePrModalOpen(true)
        setMagicModalOpen(false)
        return
      }

      // If PR already exists, open it in the browser instead of creating a new one
      if (option === 'open-pr' && worktree?.pr_url) {
        await openExternal(worktree.pr_url)
        setMagicModalOpen(false)
        return
      }

      // Commands that need ChatWindow: navigate to worktree first, then set pending command
      if (
        isOnCanvas &&
        CANVAS_NAVIGATE_AND_DISPATCH_OPTIONS.has(option) &&
        worktree?.path
      ) {
        setMagicModalOpen(false)
        const { setActiveWorktree, setPendingMagicCommand } =
          useChatStore.getState()
        // Navigate to worktree chat view
        useProjectsStore.getState().selectWorktree(selectedWorktreeId)
        setActiveWorktree(selectedWorktreeId, worktree.path)
        // Store pending command — ChatWindow picks it up on mount/update (no fragile timeout)
        setPendingMagicCommand({ command: option })
        return
      }

      // For canvas-allowed git ops: if no ChatWindow rendered, execute directly
      // Exclude CANVAS_NAVIGATE_AND_DISPATCH_OPTIONS to prevent silent no-ops
      if (
        CANVAS_ALLOWED_OPTIONS.has(option) &&
        !CANVAS_NAVIGATE_AND_DISPATCH_OPTIONS.has(option) &&
        !useChatStore.getState().activeWorktreePath
      ) {
        setMagicModalOpen(false)
        executeGitDirectly(option)
        return
      }

      // Dispatch magic command for ChatWindow to handle
      window.dispatchEvent(
        new CustomEvent('magic-command', { detail: { command: option } })
      )

      setMagicModalOpen(false)
    },
    [
      selectedWorktreeId,
      selectedProjectId,
      setMagicModalOpen,
      worktree?.pr_url,
      isOnCanvas,
      executeGitDirectly,
      hasIssueContexts,
      hasPrContexts,
      activeSessionId,
      worktree?.path,
      worktree?.pr_number,
    ]
  )

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const key = e.key.toLowerCase()

      // Check for direct key shortcuts (s, l, c, p, r)
      const mappedOption = KEY_TO_OPTION[key]
      if (mappedOption) {
        e.preventDefault()
        executeAction(mappedOption)
        return
      }

      if (key === 'enter') {
        e.preventDefault()
        executeAction(selectedOption)
      } else if (key === 'arrowdown' || key === 'arrowup') {
        e.preventDefault()
        const currentIndex = allOptions.indexOf(selectedOption)
        const newIndex =
          key === 'arrowdown'
            ? (currentIndex + 1) % allOptions.length
            : (currentIndex - 1 + allOptions.length) % allOptions.length
        const newOptionId = allOptions[newIndex]
        if (newOptionId) {
          setSelectedOption(newOptionId)
        }
      }
    },
    [executeAction, selectedOption, allOptions]
  )

  return (
    <Dialog open={magicModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        className="sm:max-w-[560px] p-0 outline-none"
        onOpenAutoFocus={e => {
          e.preventDefault()
          contentRef.current?.focus()
        }}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="px-4 pt-5 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            Magic
          </DialogTitle>
        </DialogHeader>

        <div className="pb-2 grid grid-cols-2">
          {[magicColumns.left, magicColumns.right].map(
            (columnSections, colIndex) => (
              <div
                key={colIndex}
                className={cn(colIndex === 0 && 'border-r border-border')}
              >
                {columnSections.map((section, sectionIndex) => (
                  <div key={section.header}>
                    {/* Section header */}
                    <div className="px-4 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {section.header}
                    </div>

                    {/* Section options */}
                    {section.options.map(option => {
                      const Icon = option.icon
                      const isSelected = selectedOption === option.id
                      const isDisabled =
                        (isOnCanvas &&
                          !CANVAS_ALLOWED_OPTIONS.has(option.id)) ||
                        (option.id === 'create-recap' && !activeSessionId) ||
                        (option.id === 'investigate-issue' &&
                          !hasIssueContexts) ||
                        (option.id === 'investigate-pr' && !hasPrContexts) ||
                        (option.id === 'update-pr' && !hasOpenPr)

                      return (
                        <button
                          key={option.id}
                          onClick={() =>
                            !isDisabled && executeAction(option.id)
                          }
                          onMouseEnter={() => setSelectedOption(option.id)}
                          className={cn(
                            'w-full flex items-center justify-between px-4 py-2 text-sm transition-colors',
                            'focus:outline-none',
                            isDisabled
                              ? 'opacity-40 cursor-not-allowed'
                              : 'hover:bg-accent',
                            isSelected && !isDisabled && 'bg-accent'
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            <span>{option.label}</span>
                          </div>
                          <kbd className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {option.key}
                          </kbd>
                        </button>
                      )
                    })}

                    {/* Separator between sections within column (not after last) */}
                    {sectionIndex < columnSections.length - 1 && (
                      <div className="my-1 mx-4 border-t border-border" />
                    )}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default MagicModal
