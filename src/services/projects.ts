import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { disposeAllWorktreeTerminals } from '@/lib/terminal-instances'
import type {
  Project,
  Worktree,
  WorktreeCreatedEvent,
  WorktreeCreateErrorEvent,
  WorktreeDeletedEvent,
  WorktreeDeleteErrorEvent,
  WorktreeArchivedEvent,
  WorktreeUnarchivedEvent,
  WorktreePermanentlyDeletedEvent,
  WorktreePathExistsEvent,
  WorktreeBranchExistsEvent,
  ForkSource,
} from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'

// Check if running in Tauri context (vs plain browser)
// In Tauri v2, we check for __TAURI_INTERNALS__ which is always injected
export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Query keys for projects
export const projectsQueryKeys = {
  all: ['projects'] as const,
  list: () => [...projectsQueryKeys.all, 'list'] as const,
  detail: (id: string) => [...projectsQueryKeys.all, 'detail', id] as const,
  worktrees: (projectId: string) =>
    [...projectsQueryKeys.all, 'worktrees', projectId] as const,
}

// ============================================================================
// Project Queries
// ============================================================================

/**
 * Hook to list all projects
 */
export function useProjects() {
  return useQuery({
    queryKey: projectsQueryKeys.list(),
    queryFn: async (): Promise<Project[]> => {
      if (!isTauri()) {
        logger.debug('Not in Tauri context, returning empty projects')
        return []
      }

      try {
        logger.debug('Loading projects from backend')
        const projects = await invoke<Project[]>('list_projects')
        logger.info('Projects loaded successfully', { count: projects.length })
        return projects
      } catch (error) {
        logger.error('Failed to load projects', { error })
        return []
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10, // 10 minutes
  })
}

/**
 * Hook to list worktrees for a specific project
 */
export function useWorktrees(projectId: string | null) {
  return useQuery({
    queryKey: projectsQueryKeys.worktrees(projectId ?? ''),
    queryFn: async (): Promise<Worktree[]> => {
      if (!isTauri() || !projectId) {
        return []
      }

      try {
        logger.debug('Loading worktrees for project', { projectId })
        const worktrees = await invoke<Worktree[]>('list_worktrees', {
          projectId,
        })
        logger.info('Worktrees loaded successfully', {
          count: worktrees.length,
        })
        return worktrees
      } catch (error) {
        logger.error('Failed to load worktrees', { error, projectId })
        return []
      }
    },
    enabled: !!projectId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  })
}

/**
 * Hook to fetch a single worktree by ID
 * Used for displaying PR link and other worktree-specific info
 */
export function useWorktree(worktreeId: string | null) {
  return useQuery({
    queryKey: [...projectsQueryKeys.all, 'worktree', worktreeId ?? ''] as const,
    queryFn: async (): Promise<Worktree | null> => {
      if (!isTauri() || !worktreeId) {
        return null
      }

      try {
        logger.debug('Loading worktree', { worktreeId })
        const worktree = await invoke<Worktree>('get_worktree', {
          worktreeId,
        })
        logger.info('Worktree loaded successfully', { id: worktree.id })
        return worktree
      } catch (error) {
        logger.error('Failed to load worktree', { error, worktreeId })
        return null
      }
    },
    enabled: !!worktreeId,
    staleTime: 1000 * 30, // 30 seconds - PR info may change
    gcTime: 1000 * 60 * 5,
  })
}

// ============================================================================
// Project Mutations
// ============================================================================

/**
 * Hook to add a new project
 */
export function useAddProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      path,
      parentId,
    }: {
      path: string
      parentId?: string
    }): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Adding project', { path, parentId })
      const project = await invoke<Project>('add_project', { path, parentId })
      logger.info('Project added successfully', { project })
      return project
    },
    onSuccess: (project, { parentId }) => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
      toast.success(`Added project: ${project.name}`)

      // Auto-expand the new project and parent folder if applicable
      const { expandProject, expandFolder } = useProjectsStore.getState()
      if (parentId) {
        expandFolder(parentId)
      }
      expandProject(project.id)
    },
    onError: error => {
      // Tauri invoke errors are thrown as strings, not Error objects
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to add project', { error })
      toast.error('Failed to add project', { description: message })
    },
  })
}

/**
 * Hook to initialize a new project (create directory, git init, add to list)
 */
export function useInitProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      path,
      parentId,
    }: {
      path: string
      parentId?: string
    }): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Initializing new project', { path, parentId })
      const project = await invoke<Project>('init_project', { path, parentId })
      logger.info('Project initialized successfully', { project })
      return project
    },
    onSuccess: (project, { parentId }) => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
      toast.success(`Created project: ${project.name}`)

      // Auto-expand the new project and parent folder if applicable
      const { expandProject, expandFolder } = useProjectsStore.getState()
      if (parentId) {
        expandFolder(parentId)
      }
      expandProject(project.id)
    },
    onError: error => {
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to initialize project', { error })
      toast.error('Failed to create project', { description: message })
    },
  })
}

/**
 * Hook to initialize git in an existing folder
 * Used when user selects a folder that is not a git repository
 */
export function useInitGitInFolder() {
  return useMutation({
    mutationFn: async (path: string): Promise<string> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Initializing git in folder', { path })
      const result = await invoke<string>('init_git_in_folder', { path })
      logger.info('Git initialized successfully', { path: result })
      return result
    },
    onError: error => {
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to initialize git', { error, message })
      // Don't show toast here - let the modal handle error display
    },
  })
}

/**
 * Hook to remove a project
 */
export function useRemoveProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (projectId: string): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Removing project', { projectId })
      await invoke('remove_project', { projectId })
      logger.info('Project removed successfully')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
      toast.success('Project removed')
    },
    onError: error => {
      // Tauri invoke errors are thrown as strings, not Error objects
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to remove project', { error })
      toast.error('Failed to remove project', { description: message })
    },
  })
}

// ============================================================================
// Worktree Mutations
// ============================================================================

/**
 * Hook to create a new worktree (background creation with events)
 *
 * The backend returns immediately with a pending worktree, then emits events
 * as the background creation progresses. This hook:
 * 1. Adds the pending worktree to the cache immediately (with status: 'pending')
 * 2. Listens for worktree:created and worktree:error events
 * 3. Updates the cache when creation completes or fails
 */
export function useCreateWorktree() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      projectId,
      baseBranch,
      issueContext,
      prContext,
      customName,
      forkSource,
    }: {
      projectId: string
      baseBranch?: string
      issueContext?: {
        number: number
        title: string
        body?: string
        comments: { body: string; author: { login: string }; createdAt: string }[]
      }
      /** PR context to pass when creating a worktree from a PR */
      prContext?: {
        number: number
        title: string
        body?: string
        headRefName: string
        baseRefName: string
        comments: { body: string; author: { login: string }; createdAt: string }[]
        reviews: { body: string; state: string; author: { login: string }; submittedAt?: string }[]
      }
      /** Custom worktree name (used when retrying after path conflict) */
      customName?: string
      /** Fork source for conversation forking */
      forkSource?: ForkSource
    }): Promise<Worktree> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Creating worktree (background)', { projectId, baseBranch, issueNumber: issueContext?.number, prNumber: prContext?.number, customName, forkSource })
      const worktree = await invoke<Worktree>('create_worktree', {
        projectId,
        baseBranch,
        issueContext,
        prContext,
        customName,
        forkSource,
      })
      // Mark as pending since creation is happening in background
      return { ...worktree, status: 'pending' as const }
    },
    onSuccess: (pendingWorktree, { projectId }) => {
      logger.info('Worktree creation started (pending)', {
        id: pendingWorktree.id,
        name: pendingWorktree.name,
      })

      // Add pending worktree to both caches immediately:
      // 1. The worktrees list cache (for sidebar)
      queryClient.setQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId),
        old => {
          if (!old) return [pendingWorktree]
          return [...old, pendingWorktree]
        }
      )
      // 2. The single worktree cache (for useWorktree hook used by ChatWindow)
      queryClient.setQueryData<Worktree>(
        [...projectsQueryKeys.all, 'worktree', pendingWorktree.id],
        pendingWorktree
      )

      // Auto-expand the project and select the new worktree
      const { expandProject, selectWorktree } = useProjectsStore.getState()
      expandProject(projectId)
      selectWorktree(pendingWorktree.id)
    },
    onError: error => {
      let message: string
      if (error instanceof Error) {
        message = error.message
      } else if (typeof error === 'string') {
        message = error
      } else {
        message = String(error)
      }
      logger.error('Failed to start worktree creation', { error, message })
      toast.error('Failed to create worktree', { description: message })
    },
  })
}

/**
 * Hook to create a worktree from an existing branch
 *
 * Used when the user chooses "Use Existing Branch" in the BranchConflictModal.
 * This creates a worktree that checks out an existing branch instead of creating a new one.
 */
export function useCreateWorktreeFromExistingBranch() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      projectId,
      branchName,
      issueContext,
      prContext,
    }: {
      projectId: string
      branchName: string
      issueContext?: {
        number: number
        title: string
        body?: string
        comments: { body: string; author: { login: string }; createdAt: string }[]
      }
      prContext?: {
        number: number
        title: string
        body?: string
        headRefName: string
        baseRefName: string
        comments: { body: string; author: { login: string }; createdAt: string }[]
        reviews: { body: string; state: string; author: { login: string }; submittedAt?: string }[]
      }
    }): Promise<Worktree> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Creating worktree from existing branch', { projectId, branchName })
      const worktree = await invoke<Worktree>('create_worktree_from_existing_branch', {
        projectId,
        branchName,
        issueContext,
        prContext,
      })
      return { ...worktree, status: 'pending' as const }
    },
    onSuccess: (pendingWorktree, { projectId }) => {
      logger.info('Worktree creation from existing branch started (pending)', {
        id: pendingWorktree.id,
        name: pendingWorktree.name,
      })

      // Add pending worktree to both caches immediately
      queryClient.setQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId),
        old => {
          if (!old) return [pendingWorktree]
          return [...old, pendingWorktree]
        }
      )
      queryClient.setQueryData<Worktree>(
        [...projectsQueryKeys.all, 'worktree', pendingWorktree.id],
        pendingWorktree
      )

      // Auto-expand the project and select the new worktree
      const { expandProject, selectWorktree } = useProjectsStore.getState()
      expandProject(projectId)
      selectWorktree(pendingWorktree.id)
    },
    onError: error => {
      let message: string
      if (error instanceof Error) {
        message = error.message
      } else if (typeof error === 'string') {
        message = error
      } else {
        message = String(error)
      }
      logger.error('Failed to create worktree from existing branch', { error, message })
      toast.error('Failed to create worktree', { description: message })
    },
  })
}

/**
 * Hook to handle the CMD+N keybinding for creating a new worktree.
 *
 * Listens for 'create-new-worktree' custom event and opens the new worktree modal.
 */
export function useCreateWorktreeKeybinding() {
  useEffect(() => {
    const handleCreateWorktree = async () => {
      // Import dynamically to avoid circular dependency
      const { useUIStore } = await import('@/store/ui-store')
      const { setNewWorktreeModalOpen } = useUIStore.getState()
      setNewWorktreeModalOpen(true)
    }

    window.addEventListener('create-new-worktree', handleCreateWorktree)
    return () =>
      window.removeEventListener('create-new-worktree', handleCreateWorktree)
  }, [])
}

/**
 * Hook to listen for worktree events (background creation/deletion)
 *
 * This should be mounted once in the app to handle all worktree background events.
 * It updates the query cache when worktrees are created, deleted, or fail.
 */
export function useWorktreeEvents() {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!isTauri()) return

    const unlistenPromises: Promise<UnlistenFn>[] = []

    // =========================================================================
    // Creation events
    // =========================================================================

    // Listen for successful creation
    unlistenPromises.push(
      listen<WorktreeCreatedEvent>('worktree:created', event => {
        const { worktree } = event.payload
        logger.info('Worktree created (background complete)', {
          id: worktree.id,
          name: worktree.name,
        })

        // Update cache: replace pending worktree with completed one
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(worktree.project_id),
          old => {
            if (!old) return [{ ...worktree, status: 'ready' as const }]
            return old.map(w =>
              w.id === worktree.id
                ? { ...worktree, status: 'ready' as const }
                : w
            )
          }
        )

        // Set as active worktree for chat
        const { setActiveWorktree, addSetupScriptResult } =
          useChatStore.getState()
        setActiveWorktree(worktree.id, worktree.path)

        // Add setup script output to chat store if present
        if (worktree.setup_output) {
          addSetupScriptResult(worktree.id, {
            worktreeName: worktree.name,
            worktreePath: worktree.path,
            script: worktree.setup_script ?? '',
            output: worktree.setup_output,
            success: true,
          })
        }

        // Check if this worktree was marked for auto-investigate (issue)
        const shouldInvestigateIssue = useUIStore.getState().autoInvestigateWorktreeIds.has(worktree.id)
        if (shouldInvestigateIssue) {
          // Wait for ChatWindow to signal readiness (session + contexts loaded)
          // with timeout fallback for edge cases
          const timeoutId = setTimeout(() => {
            window.removeEventListener('chat-ready-for-investigate', issueReadyHandler as EventListener)
            // Consume the flag before dispatching
            useUIStore.getState().consumeAutoInvestigate(worktree.id)
            window.dispatchEvent(
              new CustomEvent('magic-command', { detail: { command: 'investigate-issue' } })
            )
          }, 5000) // 5 second max wait

          const issueReadyHandler = (e: CustomEvent<{ worktreeId: string; type: string }>) => {
            if (e.detail.worktreeId === worktree.id && e.detail.type === 'issue') {
              clearTimeout(timeoutId)
              window.removeEventListener('chat-ready-for-investigate', issueReadyHandler as EventListener)
              // Consume the flag before dispatching
              useUIStore.getState().consumeAutoInvestigate(worktree.id)
              window.dispatchEvent(
                new CustomEvent('magic-command', { detail: { command: 'investigate-issue' } })
              )
            }
          }

          window.addEventListener('chat-ready-for-investigate', issueReadyHandler as EventListener)
        }

        // Check if this worktree was marked for auto-investigate (PR)
        const shouldInvestigatePR = useUIStore.getState().autoInvestigatePRWorktreeIds.has(worktree.id)
        if (shouldInvestigatePR) {
          // Wait for ChatWindow to signal readiness (session + contexts loaded)
          // with timeout fallback for edge cases
          const prTimeoutId = setTimeout(() => {
            window.removeEventListener('chat-ready-for-investigate', prReadyHandler as EventListener)
            // Consume the flag before dispatching
            useUIStore.getState().consumeAutoInvestigatePR(worktree.id)
            window.dispatchEvent(
              new CustomEvent('magic-command', { detail: { command: 'investigate-pr' } })
            )
          }, 5000) // 5 second max wait

          const prReadyHandler = (e: CustomEvent<{ worktreeId: string; type: string }>) => {
            if (e.detail.worktreeId === worktree.id && e.detail.type === 'pr') {
              clearTimeout(prTimeoutId)
              window.removeEventListener('chat-ready-for-investigate', prReadyHandler as EventListener)
              // Consume the flag before dispatching
              useUIStore.getState().consumeAutoInvestigatePR(worktree.id)
              window.dispatchEvent(
                new CustomEvent('magic-command', { detail: { command: 'investigate-pr' } })
              )
            }
          }

          window.addEventListener('chat-ready-for-investigate', prReadyHandler as EventListener)
        }
      })
    )

    // Listen for creation errors
    unlistenPromises.push(
      listen<WorktreeCreateErrorEvent>('worktree:error', event => {
        const { id, project_id, error } = event.payload
        logger.error('Worktree creation failed', { id, project_id, error })

        // Remove pending worktree from cache
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(project_id),
          old => {
            if (!old) return []
            return old.filter(w => w.id !== id)
          }
        )

        // Clear selection if this was selected
        const { selectedWorktreeId, selectWorktree } =
          useProjectsStore.getState()
        if (selectedWorktreeId === id) {
          selectWorktree(null)
        }

        toast.error('Failed to create worktree', { description: error })
      })
    )

    // =========================================================================
    // Deletion events
    // =========================================================================

    // Listen for successful deletion
    unlistenPromises.push(
      listen<WorktreeDeletedEvent>('worktree:deleted', event => {
        const { id, project_id } = event.payload
        logger.info('Worktree deleted (background complete)', { id })

        // Remove worktree from cache
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(project_id),
          old => {
            if (!old) return []
            return old.filter(w => w.id !== id)
          }
        )
      })
    )

    // Listen for deletion errors
    unlistenPromises.push(
      listen<WorktreeDeleteErrorEvent>('worktree:delete_error', event => {
        const { id, project_id, error } = event.payload
        logger.error('Worktree deletion failed', { id, project_id, error })

        // Revert worktree status to 'ready'
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(project_id),
          old => {
            if (!old) return []
            return old.map(w =>
              w.id === id ? { ...w, status: 'ready' as const } : w
            )
          }
        )

        toast.error('Failed to delete worktree', { description: error })
      })
    )

    // =========================================================================
    // Archive events
    // =========================================================================

    // Listen for successful archive
    unlistenPromises.push(
      listen<WorktreeArchivedEvent>('worktree:archived', event => {
        const { id, project_id } = event.payload
        logger.info('Worktree archived', { id })

        // Remove worktree from cache (archived worktrees are filtered out)
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(project_id),
          old => {
            if (!old) return []
            return old.filter(w => w.id !== id)
          }
        )

        // Clear chat if this worktree was active
        const { activeWorktreeId, clearActiveWorktree } =
          useChatStore.getState()
        if (activeWorktreeId === id) {
          clearActiveWorktree()
        }

        // Clear selection if this worktree was selected
        const { selectedWorktreeId, selectWorktree } =
          useProjectsStore.getState()
        if (selectedWorktreeId === id) {
          selectWorktree(null)
        }
      })
    )

    // Listen for successful unarchive
    unlistenPromises.push(
      listen<WorktreeUnarchivedEvent>('worktree:unarchived', event => {
        const { worktree } = event.payload
        logger.info('Worktree unarchived', { id: worktree.id })

        // Add worktree back to cache
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(worktree.project_id),
          old => {
            if (!old) return [{ ...worktree, status: 'ready' as const }]
            // Check if already exists (shouldn't, but be safe)
            const exists = old.some(w => w.id === worktree.id)
            if (exists) {
              return old.map(w =>
                w.id === worktree.id
                  ? { ...worktree, status: 'ready' as const }
                  : w
              )
            }
            return [...old, { ...worktree, status: 'ready' as const }]
          }
        )

        // Select the restored worktree and set as active for chat
        const { expandProject, selectWorktree } = useProjectsStore.getState()
        const { setActiveWorktree } = useChatStore.getState()
        expandProject(worktree.project_id)
        selectWorktree(worktree.id)
        setActiveWorktree(worktree.id, worktree.path)

        // Invalidate archived worktrees query
        queryClient.invalidateQueries({ queryKey: ['archived-worktrees'] })
      })
    )

    // Listen for permanent deletion
    unlistenPromises.push(
      listen<WorktreePermanentlyDeletedEvent>(
        'worktree:permanently_deleted',
        event => {
          const { id, project_id } = event.payload
          logger.info('Worktree permanently deleted', { id })

          // Invalidate archived worktrees query
          queryClient.invalidateQueries({ queryKey: ['archived-worktrees'] })

          // Also remove from main cache just in case
          queryClient.setQueryData<Worktree[]>(
            projectsQueryKeys.worktrees(project_id),
            old => {
              if (!old) return []
              return old.filter(w => w.id !== id)
            }
          )
        }
      )
    )

    // Listen for path exists conflicts
    unlistenPromises.push(
      listen<WorktreePathExistsEvent>('worktree:path_exists', event => {
        const {
          project_id,
          path,
          suggested_name,
          archived_worktree_id,
          archived_worktree_name,
          issue_context,
        } = event.payload
        logger.warn('Worktree path already exists', {
          project_id,
          path,
          archived_worktree_id,
        })

        // Open the path conflict modal
        const { openPathConflictModal } = useUIStore.getState()
        openPathConflictModal({
          projectId: project_id,
          path,
          suggestedName: suggested_name,
          archivedWorktreeId: archived_worktree_id,
          archivedWorktreeName: archived_worktree_name,
          issueContext: issue_context,
        })
      })
    )

    // Listen for branch exists conflicts
    unlistenPromises.push(
      listen<WorktreeBranchExistsEvent>('worktree:branch_exists', event => {
        const { project_id, branch, suggested_name, issue_context, pr_context } =
          event.payload
        logger.warn('Worktree branch already exists', {
          project_id,
          branch,
        })

        // Open the branch conflict modal
        const { openBranchConflictModal } = useUIStore.getState()
        openBranchConflictModal({
          projectId: project_id,
          branch,
          suggestedName: suggested_name,
          issueContext: issue_context,
          prContext: pr_context,
        })
      })
    )

    // Cleanup listeners on unmount
    return () => {
      Promise.all(unlistenPromises).then(unlistens => {
        unlistens.forEach(unlisten => unlisten())
      })
    }
  }, [queryClient])
}

/**
 * Hook to rename a worktree
 */
export function useRenameWorktree() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      newName,
    }: {
      worktreeId: string
      projectId: string
      newName: string
    }): Promise<Worktree> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Renaming worktree', { worktreeId, newName })
      const worktree = await invoke<Worktree>('rename_worktree', {
        worktreeId,
        newName,
      })
      logger.info('Worktree renamed successfully', { worktree })
      return worktree
    },
    onSuccess: (_worktree, { projectId }) => {
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })
    },
    onError: error => {
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to rename worktree', { error })
      toast.error(message)
    },
  })
}

/**
 * Hook to delete a worktree (background deletion with events)
 *
 * The backend returns immediately after marking the worktree for deletion,
 * then emits events as the background deletion progresses. This hook:
 * 1. Marks the worktree as 'deleting' in the cache immediately
 * 2. Listens for worktree:deleted and worktree:delete_error events
 * 3. Removes from cache when deletion completes or reverts on failure
 */
export function useDeleteWorktree() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      projectId,
    }: {
      worktreeId: string
      projectId: string
    }): Promise<{ worktreeId: string; projectId: string }> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Deleting worktree (background)', { worktreeId })
      await invoke('delete_worktree', { worktreeId })
      logger.info('Worktree deletion started (background)')
      return { worktreeId, projectId }
    },
    onSuccess: ({ worktreeId, projectId }) => {
      // Mark worktree as 'deleting' in cache immediately
      queryClient.setQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId),
        old => {
          if (!old) return []
          return old.map(w =>
            w.id === worktreeId ? { ...w, status: 'deleting' as const } : w
          )
        }
      )

      // Cleanup terminal instances for this worktree
      disposeAllWorktreeTerminals(worktreeId)

      // Clear chat if the deleted worktree was active
      const { activeWorktreeId, clearActiveWorktree } = useChatStore.getState()
      if (activeWorktreeId === worktreeId) {
        clearActiveWorktree()
      }

      // Clear selection if this worktree was selected
      const { selectedWorktreeId, selectWorktree } = useProjectsStore.getState()
      if (selectedWorktreeId === worktreeId) {
        selectWorktree(null)
      }
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to start worktree deletion', { error })
      toast.error('Failed to delete worktree', { description: message })
    },
  })
}

// ============================================================================
// Archive Operations
// ============================================================================

/**
 * Hook to archive a worktree
 * Archives the worktree (hides from UI) but keeps git worktree/branch on disk
 */
export function useArchiveWorktree() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
      projectId,
    }: {
      worktreeId: string
      projectId: string
    }): Promise<{ worktreeId: string; projectId: string }> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Archiving worktree', { worktreeId })
      await invoke('archive_worktree', { worktreeId })
      logger.info('Worktree archived')
      return { worktreeId, projectId }
    },
    onSuccess: ({ worktreeId, projectId }) => {
      // Remove worktree from cache (event listener will also do this)
      queryClient.setQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId),
        old => {
          if (!old) return []
          return old.filter(w => w.id !== worktreeId)
        }
      )

      // Invalidate archived worktrees query so it shows up immediately
      queryClient.invalidateQueries({ queryKey: ['archived-worktrees'] })

      // Invalidate archived sessions query (worktree's sessions are also archived)
      queryClient.invalidateQueries({ queryKey: ['all-archived-sessions'] })

      // Cleanup terminal instances for this worktree
      disposeAllWorktreeTerminals(worktreeId)

      // Clear chat if this worktree was active
      const { activeWorktreeId, clearActiveWorktree } = useChatStore.getState()
      if (activeWorktreeId === worktreeId) {
        clearActiveWorktree()
      }

      // Clear selection if this worktree was selected
      const { selectedWorktreeId, selectWorktree } = useProjectsStore.getState()
      if (selectedWorktreeId === worktreeId) {
        selectWorktree(null)
      }

      toast.success('Worktree archived')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to archive worktree', { error })
      toast.error('Failed to archive worktree', { description: message })
    },
  })
}

/**
 * Hook to unarchive a worktree
 * Restores the worktree to the UI
 */
export function useUnarchiveWorktree() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (worktreeId: string): Promise<Worktree> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Unarchiving worktree', { worktreeId })
      const worktree = await invoke<Worktree>('unarchive_worktree', {
        worktreeId,
      })
      logger.info('Worktree unarchived', { worktree })
      return worktree
    },
    onSuccess: () => {
      // Note: Worktree is added to cache by the event listener for 'worktree:unarchived'
      // Invalidate archived queries
      queryClient.invalidateQueries({ queryKey: ['archived-worktrees'] })
      queryClient.invalidateQueries({ queryKey: ['all-archived-sessions'] })

      toast.success('Worktree restored')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to unarchive worktree', { error })
      toast.error('Failed to restore worktree', { description: message })
    },
  })
}

/**
 * Hook to import an existing worktree directory
 * Used when a directory exists but isn't tracked by Jean
 */
export function useImportWorktree() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      projectId,
      path,
    }: {
      projectId: string
      path: string
    }): Promise<Worktree> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Importing worktree', { projectId, path })
      const worktree = await invoke<Worktree>('import_worktree', {
        projectId,
        path,
      })
      logger.info('Worktree imported', { worktree })
      return worktree
    },
    onSuccess: (worktree, { projectId }) => {
      // Worktree is added to cache by the worktree:created event listener
      // Invalidate worktrees query to ensure consistency
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })

      // Auto-expand the project and select the new worktree
      const { expandProject, selectWorktree } = useProjectsStore.getState()
      expandProject(projectId)
      selectWorktree(worktree.id)

      toast.success('Worktree imported', { description: worktree.name })
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to import worktree', { error })
      toast.error('Failed to import worktree', { description: message })
    },
  })
}

/**
 * Hook to list all archived worktrees
 */
export function useArchivedWorktrees() {
  return useQuery({
    queryKey: ['archived-worktrees'],
    queryFn: async (): Promise<Worktree[]> => {
      if (!isTauri()) {
        return []
      }

      logger.debug('Listing archived worktrees')
      const worktrees = await invoke<Worktree[]>('list_archived_worktrees')
      logger.debug('Got archived worktrees', { count: worktrees.length })
      return worktrees
    },
    staleTime: 1000 * 60, // 1 minute
  })
}

/**
 * Hook to permanently delete an archived worktree
 * This actually removes the git worktree and branch from disk
 */
export function usePermanentlyDeleteWorktree() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (worktreeId: string): Promise<string> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Permanently deleting worktree', { worktreeId })
      await invoke('permanently_delete_worktree', { worktreeId })
      logger.info('Worktree permanently deleted')
      return worktreeId
    },
    onSuccess: () => {
      // Invalidate archived worktrees query (event listener will also handle this)
      queryClient.invalidateQueries({ queryKey: ['archived-worktrees'] })
      toast.success('Worktree permanently deleted')
    },
    onError: error => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to permanently delete worktree', { error })
      toast.error('Failed to delete worktree', { description: message })
    },
  })
}

/**
 * Hook to create or reopen a base branch session
 * Base sessions use the project's base directory directly (no git worktree)
 */
export function useCreateBaseSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (projectId: string): Promise<Worktree> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Creating base session', { projectId })
      const session = await invoke<Worktree>('create_base_session', {
        projectId,
      })
      logger.info('Base session created/reopened', { session })
      return session
    },
    onSuccess: (session, projectId) => {
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })

      // Auto-expand the project and select the session
      const { expandProject, selectWorktree } = useProjectsStore.getState()
      expandProject(projectId)
      selectWorktree(session.id)

      // Set as active for chat
      const { setActiveWorktree } = useChatStore.getState()
      setActiveWorktree(session.id, session.path)

      toast.success(`Base session: ${session.name}`)
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to create base session', { error })
      toast.error('Failed to create base session', { description: message })
    },
  })
}

/**
 * Hook to close a base session (removes record, no git operations)
 * Preserves sessions for later restoration
 */
export function useCloseBaseSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
    }: {
      worktreeId: string
      projectId: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Closing base session', { worktreeId })
      await invoke('close_base_session', { worktreeId })
      logger.info('Base session closed')
    },
    onSuccess: (_, { projectId, worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })

      // Cleanup terminal instances for this worktree
      disposeAllWorktreeTerminals(worktreeId)

      // Clear chat if the closed session was active
      const { activeWorktreeId, clearActiveWorktree } = useChatStore.getState()
      if (activeWorktreeId === worktreeId) {
        clearActiveWorktree()
      }

      toast.success('Session closed')
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to close session', { error })
      toast.error('Failed to close session', { description: message })
    },
  })
}

/**
 * Hook to close a base session with clean state (no session preservation)
 * The base session will start fresh when reopened
 */
export function useCloseBaseSessionClean() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      worktreeId,
    }: {
      worktreeId: string
      projectId: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Closing base session (clean)', { worktreeId })
      await invoke('close_base_session_clean', { worktreeId })
      logger.info('Base session closed (clean)')
    },
    onSuccess: (_, { projectId, worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })

      // Cleanup terminal instances for this worktree
      disposeAllWorktreeTerminals(worktreeId)

      // Clear chat if the closed session was active
      const { activeWorktreeId, clearActiveWorktree } = useChatStore.getState()
      if (activeWorktreeId === worktreeId) {
        clearActiveWorktree()
      }

      toast.success('Session closed')
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to close session (clean)', { error })
      toast.error('Failed to close session', { description: message })
    },
  })
}

/**
 * Hook to open a worktree in Finder
 */
export function useOpenWorktreeInFinder() {
  return useMutation({
    mutationFn: async (worktreePath: string): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Opening worktree in Finder', { worktreePath })
      await invoke('open_worktree_in_finder', { worktreePath })
      logger.info('Opened worktree in Finder')
    },
    onError: error => {
      // Tauri invoke errors are thrown as strings, not Error objects
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to open in Finder', { error })
      toast.error('Failed to open in Finder', { description: message })
    },
  })
}

/**
 * Hook to open a project's worktrees folder in Finder (~/jean/<project-name>)
 */
export function useOpenProjectWorktreesFolder() {
  return useMutation({
    mutationFn: async (projectName: string): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Opening project worktrees folder', { projectName })
      await invoke('open_project_worktrees_folder', { projectName })
      logger.info('Opened project worktrees folder')
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to open worktrees folder', { error })
      toast.error('Failed to open worktrees folder', { description: message })
    },
  })
}

/**
 * Hook to open a worktree in Terminal
 */
export function useOpenWorktreeInTerminal() {
  return useMutation({
    mutationFn: async ({
      worktreePath,
      terminal,
    }: {
      worktreePath: string
      terminal?: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Opening worktree in Terminal', { worktreePath, terminal })
      await invoke('open_worktree_in_terminal', { worktreePath, terminal })
      logger.info('Opened worktree in Terminal')
    },
    onError: error => {
      // Tauri invoke errors are thrown as strings, not Error objects
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to open in Terminal', { error })
      toast.error('Failed to open in Terminal', { description: message })
    },
  })
}

/**
 * Hook to open a worktree in Editor
 */
export function useOpenWorktreeInEditor() {
  return useMutation({
    mutationFn: async ({
      worktreePath,
      editor,
    }: {
      worktreePath: string
      editor?: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Opening worktree in Editor', { worktreePath, editor })
      await invoke('open_worktree_in_editor', { worktreePath, editor })
      logger.info('Opened worktree in Editor')
    },
    onError: error => {
      // Tauri invoke errors are thrown as strings, not Error objects
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to open in Editor', { error })
      toast.error('Failed to open in Editor', { description: message })
    },
  })
}

/**
 * Hook to get the run script from jean.json for a worktree
 */
export function useRunScript(worktreePath: string | null) {
  return useQuery<string | null>({
    queryKey: ['run-script', worktreePath],
    queryFn: async () => {
      if (!isTauri() || !worktreePath) return null

      logger.debug('Fetching run script', { worktreePath })
      const script = await invoke<string | null>('get_run_script', {
        worktreePath,
      })
      logger.debug('Run script result', { script })
      return script
    },
    enabled: !!worktreePath,
    staleTime: 30_000, // Cache for 30 seconds
  })
}

/**
 * Hook to commit changes in a worktree
 */
export function useCommitChanges() {
  return useMutation({
    mutationFn: async ({
      worktreeId,
      message,
      stageAll,
    }: {
      worktreeId: string
      message: string
      stageAll?: boolean
    }): Promise<string> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Committing changes', { worktreeId, stageAll })
      const commitHash = await invoke<string>('commit_changes', {
        worktreeId,
        message,
        stageAll,
      })
      logger.info('Changes committed successfully', { commitHash })
      return commitHash
    },
    onSuccess: commitHash => {
      const shortHash = commitHash.slice(0, 7)
      toast.success(`Changes committed`, { description: shortHash })
    },
    onError: error => {
      // Tauri invoke errors come as strings directly
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to commit', { error })
      toast.error(message)
    },
  })
}

/**
 * Hook to open a project on GitHub
 */
export function useOpenProjectOnGitHub() {
  return useMutation({
    mutationFn: async (projectId: string): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Opening project on GitHub', { projectId })
      await invoke('open_project_on_github', { projectId })
      logger.info('Opened project on GitHub')
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to open on GitHub', { error })
      toast.error('Failed to open on GitHub', { description: message })
    },
  })
}

/**
 * Get a dynamically generated PR prompt with git context
 * Includes uncommitted changes count, branch info, and PR template if available
 */
export async function getPrPrompt(worktreePath: string): Promise<string> {
  if (!isTauri()) {
    throw new Error('Not in Tauri context')
  }

  logger.debug('Getting PR prompt', { worktreePath })
  const prompt = await invoke<string>('get_pr_prompt', { worktreePath })
  logger.info('PR prompt generated successfully')
  return prompt
}

/** Response from generating a review prompt */
export interface ReviewPromptResponse {
  /** The full review prompt to send to Claude (includes instructions + diff + commits) */
  prompt: string
}

/**
 * Generate a review prompt with git diff and commit history
 * Returns the full prompt inline (no file is saved)
 */
export async function getReviewPrompt(
  worktreePath: string
): Promise<ReviewPromptResponse> {
  if (!isTauri()) {
    throw new Error('Not in Tauri context')
  }

  logger.debug('Generating review prompt', { worktreePath })
  const response = await invoke<{
    prompt: string
  }>('get_review_prompt', { worktreePath })
  logger.info('Review prompt generated successfully')
  return {
    prompt: response.prompt,
  }
}

/**
 * Save PR information to a worktree
 * Called after a PR is created to store the PR number and URL for display in the UI.
 */
export async function saveWorktreePr(
  worktreeId: string,
  prNumber: number,
  prUrl: string
): Promise<void> {
  if (!isTauri()) {
    throw new Error('Not in Tauri context')
  }

  logger.debug('Saving PR info', { worktreeId, prNumber, prUrl })
  await invoke('save_worktree_pr', { worktreeId, prNumber, prUrl })
  logger.info('PR info saved successfully', { worktreeId, prNumber })
}

/**
 * Clear PR information from a worktree
 * Called when a PR is closed/merged and the user wants to remove the link.
 */
export async function clearWorktreePr(worktreeId: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('Not in Tauri context')
  }

  logger.debug('Clearing PR info', { worktreeId })
  await invoke('clear_worktree_pr', { worktreeId })
  logger.info('PR info cleared successfully', { worktreeId })
}

/**
 * Update cached status for a worktree
 * Called after polling git/PR status to persist for next app launch.
 */
export async function updateWorktreeCachedStatus(
  worktreeId: string,
  prStatus: string | null,
  checkStatus: string | null,
  behindCount: number | null,
  aheadCount: number | null,
  uncommittedAdded: number | null = null,
  uncommittedRemoved: number | null = null,
  branchDiffAdded: number | null = null,
  branchDiffRemoved: number | null = null,
  baseBranchAheadCount: number | null = null,
  baseBranchBehindCount: number | null = null,
  worktreeAheadCount: number | null = null
): Promise<void> {
  if (!isTauri()) return

  await invoke('update_worktree_cached_status', {
    worktreeId,
    prStatus,
    checkStatus,
    behindCount,
    aheadCount,
    uncommittedAdded,
    uncommittedRemoved,
    branchDiffAdded,
    branchDiffRemoved,
    baseBranchAheadCount,
    baseBranchBehindCount,
    worktreeAheadCount,
  })
}

// ============================================================================
// Project Settings
// ============================================================================

/**
 * Hook to fetch available branches for a project
 * Fetches from origin first, then returns remote branches (or local if no remote)
 */
export function useProjectBranches(projectId: string | null) {
  return useQuery({
    queryKey: [
      ...projectsQueryKeys.detail(projectId ?? ''),
      'branches',
    ] as const,
    queryFn: async (): Promise<string[]> => {
      if (!isTauri() || !projectId) {
        return []
      }

      try {
        logger.debug('Fetching branches for project', { projectId })
        const branches = await invoke<string[]>('get_project_branches', {
          projectId,
        })
        logger.info('Branches loaded successfully', { count: branches.length })
        return branches
      } catch (error) {
        logger.error('Failed to load branches', { error, projectId })
        throw error
      }
    },
    enabled: !!projectId,
    staleTime: 1000 * 30, // 30 seconds - branches change less frequently
    gcTime: 1000 * 60 * 5, // 5 minutes
  })
}

/**
 * Hook to update project settings
 */
export function useUpdateProjectSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      projectId,
      defaultBranch,
    }: {
      projectId: string
      defaultBranch?: string
    }): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Updating project settings', { projectId, defaultBranch })
      const project = await invoke<Project>('update_project_settings', {
        projectId,
        defaultBranch,
      })
      logger.info('Project settings updated', { project })
      return project
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
      toast.success('Project settings saved')
    },
    onError: error => {
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to update project settings', { error })
      toast.error('Failed to save settings', { description: message })
    },
  })
}

/**
 * Hook to reorder projects in the sidebar
 */
export function useReorderProjects() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      projectIds,
    }: {
      projectIds: string[]
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Reordering projects', { projectIds })
      await invoke('reorder_projects', { projectIds })
      logger.info('Projects reordered')
    },
    onMutate: async ({ projectIds }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: projectsQueryKeys.list() })

      // Snapshot previous value
      const previousProjects = queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )

      // Optimistically update the cache
      if (previousProjects) {
        const reorderedProjects = projectIds
          .map((id, index) => {
            const project = previousProjects.find(p => p.id === id)
            return project ? { ...project, order: index } : null
          })
          .filter((p): p is Project => p !== null)

        queryClient.setQueryData<Project[]>(
          projectsQueryKeys.list(),
          reorderedProjects
        )
      }

      return { previousProjects }
    },
    onError: (error, _, context) => {
      // Rollback on error
      if (context?.previousProjects) {
        queryClient.setQueryData(
          projectsQueryKeys.list(),
          context.previousProjects
        )
      }
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to reorder projects', { error })
      toast.error('Failed to reorder projects', { description: message })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
    },
  })
}

/**
 * Hook to reorder worktrees within a project
 */
export function useReorderWorktrees() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      projectId,
      worktreeIds,
    }: {
      projectId: string
      worktreeIds: string[]
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Reordering worktrees', { projectId, worktreeIds })
      await invoke('reorder_worktrees', { projectId, worktreeIds })
      logger.info('Worktrees reordered')
    },
    onMutate: async ({ projectId, worktreeIds }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })

      // Snapshot previous value
      const previousWorktrees = queryClient.getQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId)
      )

      // Optimistically update the cache
      if (previousWorktrees) {
        const reorderedWorktrees = worktreeIds
          .map((id, index) => {
            const worktree = previousWorktrees.find(w => w.id === id)
            // Base sessions keep order 0, others get index + 1
            if (worktree) {
              const newOrder = worktree.session_type === 'base' ? 0 : index + 1
              return { ...worktree, order: newOrder }
            }
            return null
          })
          .filter((w): w is Worktree => w !== null)

        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(projectId),
          reorderedWorktrees
        )
      }

      return { previousWorktrees, projectId }
    },
    onError: (error, _, context) => {
      // Rollback on error
      if (context?.previousWorktrees && context?.projectId) {
        queryClient.setQueryData(
          projectsQueryKeys.worktrees(context.projectId),
          context.previousWorktrees
        )
      }
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to reorder worktrees', { error })
      toast.error('Failed to reorder worktrees', { description: message })
    },
    onSettled: (_, __, { projectId }) => {
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })
    },
  })
}

// ============================================================================
// Folder Operations
// ============================================================================

/**
 * Hook to create a new folder
 */
export function useCreateFolder() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      name,
      parentId,
    }: {
      name: string
      parentId?: string
    }): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Creating folder', { name, parentId })
      const folder = await invoke<Project>('create_folder', { name, parentId })
      logger.info('Folder created successfully', { folder })
      return folder
    },
    onSuccess: async folder => {
      // Wait for query invalidation to complete so folder component exists
      await queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })

      // Set the folder for immediate rename and expand it
      const { setEditingFolderId, expandFolder } = useProjectsStore.getState()
      expandFolder(folder.id)
      setEditingFolderId(folder.id)
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to create folder', { error })
      toast.error('Failed to create folder', { description: message })
    },
  })
}

/**
 * Hook to rename a folder
 */
export function useRenameFolder() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      folderId,
      name,
    }: {
      folderId: string
      name: string
    }): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Renaming folder', { folderId, name })
      const folder = await invoke<Project>('rename_folder', { folderId, name })
      logger.info('Folder renamed successfully', { folder })
      return folder
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to rename folder', { error })
      toast.error('Failed to rename folder', { description: message })
    },
  })
}

/**
 * Hook to delete an empty folder
 */
export function useDeleteFolder() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (folderId: string): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Deleting folder', { folderId })
      await invoke('delete_folder', { folderId })
      logger.info('Folder deleted successfully', { folderId })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
      toast.success('Folder deleted')
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to delete folder', { error })
      toast.error('Failed to delete folder', { description: message })
    },
  })
}

/**
 * Hook to move a project or folder to a new parent
 */
export function useMoveItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      itemId,
      newParentId,
      targetIndex,
    }: {
      itemId: string
      newParentId?: string
      targetIndex?: number
    }): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Moving item', { itemId, newParentId, targetIndex })
      const item = await invoke<Project>('move_item', { itemId, newParentId, targetIndex })
      logger.info('Item moved successfully', { item })
      return item
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
    },
    onError: error => {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to move item', { error })
      toast.error('Failed to move item', { description: message })
    },
  })
}

/**
 * Hook to reorder items within a folder level
 */
export function useReorderItems() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      itemIds,
      parentId,
    }: {
      itemIds: string[]
      parentId?: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Reordering items', { itemIds, parentId })
      await invoke('reorder_items', { itemIds, parentId })
      logger.info('Items reordered')
    },
    onMutate: async ({ itemIds, parentId }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: projectsQueryKeys.list() })

      // Snapshot previous value
      const previousProjects = queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )

      // Optimistically update the cache
      if (previousProjects) {
        const reorderedProjects = previousProjects.map(project => {
          // Find if this project is in the reordering list
          const index = itemIds.indexOf(project.id)
          if (index !== -1 && project.parent_id === parentId) {
            return { ...project, order: index }
          }
          return project
        })

        queryClient.setQueryData<Project[]>(
          projectsQueryKeys.list(),
          reorderedProjects
        )
      }

      return { previousProjects }
    },
    onError: (error, _, context) => {
      // Rollback on error
      if (context?.previousProjects) {
        queryClient.setQueryData(
          projectsQueryKeys.list(),
          context.previousProjects
        )
      }
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred'
      logger.error('Failed to reorder items', { error })
      toast.error('Failed to reorder items', { description: message })
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
    },
  })
}

// ============================================================================
// Avatar Operations
// ============================================================================

/**
 * Hook to get the app data directory path
 * Used for resolving relative avatar paths to absolute file:// URLs
 */
export function useAppDataDir() {
  return useQuery({
    queryKey: ['app-data-dir'],
    queryFn: async (): Promise<string> => {
      if (!isTauri()) {
        return ''
      }

      logger.debug('Getting app data directory')
      const dir = await invoke<string>('get_app_data_dir')
      logger.debug('App data directory', { dir })
      return dir
    },
    staleTime: Infinity, // Path doesn't change during session
    gcTime: Infinity,
  })
}

/**
 * Hook to set a custom avatar for a project
 * Opens a file dialog and copies the selected image to the avatars directory
 */
export function useSetProjectAvatar() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (projectId: string): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Setting project avatar', { projectId })
      const project = await invoke<Project>('set_project_avatar', { projectId })
      logger.info('Project avatar set', { project })
      return project
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
    },
    onError: error => {
      // "No file selected" is not an error, user just cancelled
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      if (message !== 'No file selected') {
        logger.error('Failed to set project avatar', { error })
        toast.error('Failed to set avatar', { description: message })
      }
    },
  })
}

/**
 * Hook to remove a project's custom avatar
 * Deletes the avatar file and clears the avatar_path field
 */
export function useRemoveProjectAvatar() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (projectId: string): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Removing project avatar', { projectId })
      const project = await invoke<Project>('remove_project_avatar', {
        projectId,
      })
      logger.info('Project avatar removed', { project })
      return project
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
    },
    onError: error => {
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to remove project avatar', { error })
      toast.error('Failed to remove avatar', { description: message })
    },
  })
}
