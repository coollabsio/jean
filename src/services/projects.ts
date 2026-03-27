import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke, useWsConnectionStatus, setAppDataDir } from '@/lib/transport'
import { listen, type UnlistenFn } from '@/lib/transport'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { disposeAllWorktreeTerminals } from '@/lib/terminal-instances'
import type {
  Project,
  Worktree,
  DetectPrResponse,
  WorktreeCreatingEvent,
  WorktreeCreatedEvent,
  WorktreeCreateErrorEvent,
  WorktreeDeletingEvent,
  WorktreeDeletedEvent,
  WorktreeDeleteErrorEvent,
  WorktreeArchivedEvent,
  WorktreeUnarchivedEvent,
  WorktreePermanentlyDeletedEvent,
  WorktreePathExistsEvent,
  WorktreeBranchExistsEvent,
  WorktreeSetupCompleteEvent,
} from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { getFileManagerName } from '@/lib/platform'

import type { AppPreferences } from '@/types/preferences'
import type { AdvisoryContext } from '@/types/github'
import { hasBackend } from '@/lib/environment'
import { openExternal, preOpenWindow } from '@/lib/platform'

// Check if a backend is available (Tauri IPC or WebSocket)
// Kept as `isTauri` for backward compatibility across the codebase
export const isTauri = hasBackend

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
  const queryClient = useQueryClient()
  const queryKey = [
    ...projectsQueryKeys.all,
    'worktree',
    worktreeId ?? '',
  ] as const

  // Skip backend fetch while worktree is pending — it's not in projects.json yet
  const cachedData = queryClient.getQueryData<Worktree>(queryKey)
  const isPending = cachedData?.status === 'pending'

  return useQuery({
    queryKey,
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
    enabled: !!worktreeId && !isPending,
    staleTime: 1000 * 30, // 30 seconds - PR info may change
    gcTime: 1000 * 60 * 5,
  })
}

// ============================================================================
// Project Mutations
// ============================================================================

/**
 * After adding a project, auto-create and open the base session
 */
async function openBaseSessionForProject(
  projectId: string,
  queryClient: ReturnType<typeof useQueryClient>
) {
  try {
    const session = await invoke<Worktree>('create_base_session', {
      projectId,
    })
    queryClient.invalidateQueries({
      queryKey: projectsQueryKeys.worktrees(projectId),
    })
    // Select worktree in sidebar but stay on ProjectCanvasView (don't set activeWorktreePath)
    useProjectsStore.getState().selectWorktree(session.id)
    // Mark for auto-open so ProjectCanvasView opens the chat modal when it renders
    useUIStore.getState().markWorktreeForAutoOpenSession(session.id)
  } catch (error) {
    logger.error('Failed to auto-open base session', { error })
  }
}

/**
 * Show the jean.json config wizard if the user hasn't seen it yet
 */
function maybeShowJeanConfigWizard(
  projectId: string,
  queryClient: ReturnType<typeof useQueryClient>
) {
  const prefs = queryClient.getQueryData<AppPreferences>(['preferences'])
  if (prefs && !prefs.has_seen_jean_config_wizard) {
    setTimeout(() => {
      useProjectsStore.getState().openJeanConfigWizard(projectId)
    }, 400)
  }
}

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
      const { expandProject, expandFolder, selectProject } =
        useProjectsStore.getState()
      if (parentId) {
        expandFolder(parentId)
      }
      expandProject(project.id)
      selectProject(project.id)

      // Show jean.json wizard if not seen yet
      maybeShowJeanConfigWizard(project.id, queryClient)

      // Auto-create and open the base session for immediate use
      openBaseSessionForProject(project.id, queryClient)
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
      const { expandProject, expandFolder, selectProject } =
        useProjectsStore.getState()
      if (parentId) {
        expandFolder(parentId)
      }
      expandProject(project.id)
      selectProject(project.id)

      // Show jean.json wizard if not seen yet
      maybeShowJeanConfigWizard(project.id, queryClient)

      // Auto-create and open the base session for immediate use
      openBaseSessionForProject(project.id, queryClient)
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
 * Hook to clone a remote git repository and add it as a project
 */
export function useCloneProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      url,
      path,
      parentId,
    }: {
      url: string
      path: string
      parentId?: string
    }): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Cloning project', { url, path, parentId })
      const project = await invoke<Project>('clone_project', {
        url,
        path,
        parentId,
      })
      logger.info('Project cloned successfully', { project })
      return project
    },
    onSuccess: (project, { parentId }) => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
      toast.success(`Cloned project: ${project.name}`)

      // Auto-expand the new project and parent folder if applicable
      const { expandProject, expandFolder, selectProject } =
        useProjectsStore.getState()
      if (parentId) {
        expandFolder(parentId)
      }
      expandProject(project.id)
      selectProject(project.id)

      // Show jean.json wizard if not seen yet
      maybeShowJeanConfigWizard(project.id, queryClient)

      // Auto-create and open the base session for immediate use
      openBaseSessionForProject(project.id, queryClient)
    },
    onError: error => {
      const message =
        typeof error === 'string'
          ? error
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred'
      logger.error('Failed to clone project', { error })
      toast.error('Failed to clone project', { description: message })
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
    onSuccess: (_data, projectId) => {
      queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })

      // Clear selection if the removed project was selected
      const { selectedProjectId, selectProject } = useProjectsStore.getState()
      if (selectedProjectId === projectId) {
        selectProject(null)
      }

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
      securityContext,
      advisoryContext,
      linearContext,
      customName,
      background: _background,
    }: {
      projectId: string
      baseBranch?: string
      issueContext?: {
        number: number
        title: string
        body?: string
        comments: {
          body: string
          author: { login: string }
          createdAt: string
        }[]
      }
      /** PR context to pass when creating a worktree from a PR */
      prContext?: {
        number: number
        title: string
        body?: string
        headRefName: string
        baseRefName: string
        comments: {
          body: string
          author: { login: string }
          createdAt: string
        }[]
        reviews: {
          body: string
          state: string
          author: { login: string }
          submittedAt?: string
        }[]
      }
      /** Security alert context to pass when creating a worktree from a security alert */
      securityContext?: {
        number: number
        packageName: string
        packageEcosystem: string
        severity: string
        summary: string
        description: string
        ghsaId: string
        cveId?: string
        manifestPath: string
      }
      /** Advisory context to pass when creating a worktree from a repository advisory */
      advisoryContext?: AdvisoryContext
      /** Linear issue context to pass when creating a worktree from a Linear issue */
      linearContext?: {
        id: string
        identifier: string
        title: string
        description?: string
        comments: {
          body: string
          user?: { name: string; displayName: string }
          createdAt: string
        }[]
      }
      /** Custom worktree name (used when retrying after path conflict) */
      customName?: string
      /** When true, skip auto-navigation (CMD+Click from new session modal) */
      background?: boolean
    }): Promise<Worktree> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Creating worktree (background)', {
        projectId,
        baseBranch,
        issueNumber: issueContext?.number,
        prNumber: prContext?.number,
        securityAlertNumber: securityContext?.number,
        advisoryGhsaId: advisoryContext?.ghsaId,
        customName,
      })
      const worktree = await invoke<Worktree>('create_worktree', {
        projectId,
        baseBranch,
        issueContext,
        prContext,
        securityContext,
        advisoryContext,
        linearContext,
        customName,
      })
      return worktree
    },
    onSuccess: (worktree, { projectId, background: isBackground }) => {
      // Check if this worktree was already resolved by an event handler
      // (e.g. unarchive_worktree emits worktree:unarchived which sets status: 'ready')
      const existing = queryClient.getQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId)
      )
      const existingEntry = existing?.find(w => w.id === worktree.id)
      if (existingEntry?.status === 'ready') {
        logger.info('Worktree already ready (unarchived), skipping pending', {
          id: worktree.id,
          name: worktree.name,
        })
        const { expandProject, selectWorktree } = useProjectsStore.getState()
        expandProject(projectId)
        if (!isBackground) selectWorktree(worktree.id)
        return
      }

      // Normal creation flow: mark as pending
      const pendingWorktree = { ...worktree, status: 'pending' as const }
      logger.info('Worktree creation started (pending)', {
        id: pendingWorktree.id,
        name: pendingWorktree.name,
      })

      // Add pending worktree to both caches immediately:
      // 1. The worktrees list cache (for sidebar) - with dedup check
      queryClient.setQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId),
        old => {
          if (!old) return [pendingWorktree]
          // Skip if already added by worktree:creating event handler
          if (old.some(w => w.id === pendingWorktree.id)) return old
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
      if (!isBackground) {
        selectWorktree(pendingWorktree.id)
        toast.loading('Setting up worktree...', {
          id: `worktree-creating-${pendingWorktree.id}`,
        })
      }
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
      // Don't show toast for path/branch conflicts — they're handled by
      // worktree:path_exists / worktree:branch_exists event listeners
      if (
        message.includes('Directory already exists') ||
        message.includes('Branch already exists')
      ) {
        return
      }
      toast.error('Failed to create worktree', { description: message })
    },
  })
}

/**
 * Hook to create a worktree from an existing branch
 *
 * Used when creating a worktree from an existing branch (e.g. after branch conflict auto-resolution).
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
      securityContext,
      advisoryContext,
      background: _background,
    }: {
      projectId: string
      branchName: string
      /** When true, skip auto-navigation (CMD+Click from new session modal) */
      background?: boolean
      issueContext?: {
        number: number
        title: string
        body?: string
        comments: {
          body: string
          author: { login: string }
          createdAt: string
        }[]
      }
      prContext?: {
        number: number
        title: string
        body?: string
        headRefName: string
        baseRefName: string
        comments: {
          body: string
          author: { login: string }
          createdAt: string
        }[]
        reviews: {
          body: string
          state: string
          author: { login: string }
          submittedAt?: string
        }[]
      }
      securityContext?: {
        number: number
        packageName: string
        packageEcosystem: string
        severity: string
        summary: string
        description: string
        ghsaId: string
        cveId?: string
        manifestPath: string
      }
      /** Advisory context to pass when creating a worktree from a repository advisory */
      advisoryContext?: AdvisoryContext
    }): Promise<Worktree> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Creating worktree from existing branch', {
        projectId,
        branchName,
      })
      const worktree = await invoke<Worktree>(
        'create_worktree_from_existing_branch',
        {
          projectId,
          branchName,
          issueContext,
          prContext,
          securityContext,
          advisoryContext,
        }
      )
      return { ...worktree, status: 'pending' as const }
    },
    onSuccess: (pendingWorktree, { projectId, background: isBackground }) => {
      logger.info('Worktree creation from existing branch started (pending)', {
        id: pendingWorktree.id,
        name: pendingWorktree.name,
      })

      // Add pending worktree to both caches immediately - with dedup check
      queryClient.setQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId),
        old => {
          if (!old) return [pendingWorktree]
          // Skip if already added by worktree:creating event handler
          if (old.some(w => w.id === pendingWorktree.id)) return old
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
      if (!isBackground) {
        selectWorktree(pendingWorktree.id)
        toast.loading('Setting up worktree...', {
          id: `worktree-creating-${pendingWorktree.id}`,
        })
      }
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
      logger.error('Failed to create worktree from existing branch', {
        error,
        message,
      })
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

/** Shared post-ready logic for both new and unarchived worktrees */
function handleWorktreeReady(
  worktree: Worktree,
  queryClient: ReturnType<typeof useQueryClient>
) {
  // Update cache
  const readyWorktree = { ...worktree, status: 'ready' as const }
  queryClient.setQueryData<Worktree[]>(
    projectsQueryKeys.worktrees(worktree.project_id),
    old => {
      if (!old) return [readyWorktree]
      const exists = old.some(w => w.id === worktree.id)
      if (exists)
        return old.map(w => (w.id === worktree.id ? readyWorktree : w))
      return [...old, readyWorktree]
    }
  )
  queryClient.setQueryData<Worktree>(
    [...projectsQueryKeys.all, 'worktree', worktree.id],
    readyWorktree
  )

  // Skip auto-navigation for background-created worktrees (CMD+Click)
  const isBackground = useUIStore.getState().consumePendingBackgroundCreation()

  // Select in sidebar
  const { expandProject, selectWorktree } = useProjectsStore.getState()
  expandProject(worktree.project_id)
  if (!isBackground) {
    selectWorktree(worktree.id)
  }

  // Register worktree path
  const { setActiveWorktree, registerWorktreePath } = useChatStore.getState()
  registerWorktreePath(worktree.id, worktree.path)

  // Fire-and-forget: detect and link PR if not already linked
  if (!worktree.pr_url) {
    invoke<DetectPrResponse | null>('detect_and_link_pr', {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
    })
      .then(result => {
        if (result) {
          queryClient.invalidateQueries({
            queryKey: projectsQueryKeys.worktrees(worktree.project_id),
          })
          queryClient.invalidateQueries({
            queryKey: [...projectsQueryKeys.all, 'worktree', worktree.id],
          })
        }
      })
      .catch(() => {
        /* noop - PR detection is best-effort */
      })
  }

  if (!isBackground) {
    const uiStore = useUIStore.getState()

    // If a session modal is already open on the project canvas (for example the
    // base session), switch that modal directly to the new worktree instead of
    // waiting for ProjectCanvasView's auto-open effect to run later.
    if (uiStore.sessionChatModalOpen) {
      window.dispatchEvent(
        new CustomEvent('open-worktree-modal', {
          detail: { worktreeId: worktree.id, worktreePath: worktree.path },
        })
      )
    } else {
      // Mark for auto-open so whichever canvas is currently active can open
      // the new session.
      uiStore.markWorktreeForAutoOpenSession(worktree.id)
    }

    // Only switch to worktree view if user is already in a worktree canvas.
    // If user is on project canvas (activeWorktreePath is null), keep them there.
    const { activeWorktreePath } = useChatStore.getState()
    if (activeWorktreePath) {
      setActiveWorktree(worktree.id, worktree.path)
    }
  }
  // Background worktrees with auto-investigate flags are handled
  // headlessly by useBackgroundInvestigation hook (no modal needed).
}

/**
 * Hook to listen for worktree events (background creation/deletion)
 *
 * This should be mounted once in the app to handle all worktree background events.
 * It updates the query cache when worktrees are created, deleted, or fail.
 */
export function useWorktreeEvents() {
  const queryClient = useQueryClient()
  // Re-run effect when WS connects so event listeners register in web mode
  const wsConnected = useWsConnectionStatus()

  useEffect(() => {
    if (!isTauri()) return

    const unlistenPromises: Promise<UnlistenFn>[] = []

    // Track pending worktree timeouts for recovery if events are missed
    const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

    const clearPendingTimeout = (worktreeId: string) => {
      const timeout = pendingTimeouts.get(worktreeId)
      if (timeout) {
        clearTimeout(timeout)
        pendingTimeouts.delete(worktreeId)
      }
    }

    const startPendingTimeout = (worktreeId: string, projectId: string) => {
      clearPendingTimeout(worktreeId)
      const timeoutId = setTimeout(() => {
        pendingTimeouts.delete(worktreeId)
        logger.warn('Pending worktree timed out, forcing refetch', {
          worktreeId,
          projectId,
        })
        // Force refetch to get actual state from backend
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(projectId),
        })
        queryClient.invalidateQueries({
          queryKey: [...projectsQueryKeys.all, 'worktree', worktreeId],
        })
      }, 60_000) // 60s timeout
      pendingTimeouts.set(worktreeId, timeoutId)
    }

    // =========================================================================
    // Creation events
    // =========================================================================

    // Listen for creation starting - add pending worktree immediately
    unlistenPromises.push(
      listen<WorktreeCreatingEvent>('worktree:creating', event => {
        const { id, project_id, name, path, branch, pr_number, issue_number } =
          event.payload
        logger.info('Worktree creating (background started)', { id, name })

        // Add pending worktree to cache so it appears instantly on all clients
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(project_id),
          old => {
            // Skip if this worktree already exists (e.g. on the originating client)
            if (old?.some(w => w.id === id)) return old
            const pending: Worktree = {
              id,
              project_id,
              name,
              path,
              branch,
              pr_number,
              issue_number,
              created_at: Math.floor(Date.now() / 1000),
              status: 'pending' as const,
              session_type: 'worktree' as Worktree['session_type'],
              order: 0,
            }
            return [...(old ?? []), pending]
          }
        )

        // Auto-expand the project so the new worktree is visible in sidebar
        const { expandProject } = useProjectsStore.getState()
        expandProject(project_id)

        // Start timeout recovery in case worktree:created/error events are never received
        startPendingTimeout(id, project_id)
      })
    )

    // Listen for successful creation (fires before setup script runs)
    unlistenPromises.push(
      listen<WorktreeCreatedEvent>('worktree:created', event => {
        const { worktree } = event.payload
        logger.info('Worktree created (background complete)', {
          id: worktree.id,
          name: worktree.name,
        })

        clearPendingTimeout(worktree.id)

        const openWorktreeAction = {
          label: 'Open',
          onClick: () => {
            const { selectWorktree, selectProject } =
              useProjectsStore.getState()
            selectProject(worktree.project_id)
            selectWorktree(worktree.id)
            // Clear active worktree so we land on ProjectCanvasView (not bare
            // ChatWindow), then open the session modal with the full header.
            const { clearActiveWorktree } = useChatStore.getState()
            clearActiveWorktree()
            // Use both mechanisms: markWorktreeForAutoOpenSession for when the
            // canvas is mounting (lazy-loaded), and a deferred event dispatch
            // for when it's already mounted. The auto-open effect consumes the
            // mark, so only one will take effect.
            useUIStore
              .getState()
              .markWorktreeForAutoOpenSession(worktree.id)
            setTimeout(() => {
              window.dispatchEvent(
                new CustomEvent('open-worktree-modal', {
                  detail: { worktreeId: worktree.id, worktreePath: worktree.path },
                })
              )
            }, 0)
          },
        }

        toast.success('Worktree ready', {
          id: `worktree-creating-${worktree.id}`,
          action: openWorktreeAction,
        })

        handleWorktreeReady(worktree, queryClient)
      })
    )

    // Listen for setup script completion (fires after worktree:created)
    unlistenPromises.push(
      listen<WorktreeSetupCompleteEvent>('worktree:setup_complete', event => {
        const { id, project_id, setup_output, setup_script, setup_success } =
          event.payload
        logger.info('Worktree setup script complete', {
          id,
          success: setup_success,
        })

        // Update worktree in query cache with setup results
        const updateWorktree = (worktree: Worktree): Worktree => ({
          ...worktree,
          setup_output,
          setup_script,
          setup_success,
        })
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(project_id),
          old => old?.map(w => (w.id === id ? updateWorktree(w) : w))
        )
        queryClient.setQueryData<Worktree>(
          [...projectsQueryKeys.all, 'worktree', id],
          old => (old ? updateWorktree(old) : old)
        )

        // Get worktree info from cache for the setup result display
        const cachedWorktree = queryClient
          .getQueryData<Worktree[]>(projectsQueryKeys.worktrees(project_id))
          ?.find(w => w.id === id)

        // Add setup script output to chat store
        const { addSetupScriptResult } = useChatStore.getState()
        addSetupScriptResult(id, {
          worktreeName: cachedWorktree?.name ?? id,
          worktreePath: cachedWorktree?.path ?? '',
          script: setup_script,
          output: setup_output,
          success: setup_success,
        })

        if (!setup_success) {
          toast.error('Setup script failed', {
            description:
              'Worktree is ready but the setup script exited with an error.',
          })
        }
      })
    )

    // Listen for creation errors
    unlistenPromises.push(
      listen<WorktreeCreateErrorEvent>('worktree:error', event => {
        const { id, project_id, error } = event.payload
        logger.error('Worktree creation failed', { id, project_id, error })

        // Clear recovery timeout since we got the error event
        clearPendingTimeout(id)
        toast.dismiss(`worktree-creating-${id}`)

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

        // Don't show toast for path/branch conflicts — they're handled by
        // worktree:path_exists / worktree:branch_exists event listeners
        if (
          !error.includes('Directory already exists') &&
          !error.includes('Branch already exists')
        ) {
          toast.error('Failed to create worktree', { description: error })
        }
      })
    )

    // =========================================================================
    // Deletion events
    // =========================================================================

    // Listen for deletion starting - remove worktree immediately
    unlistenPromises.push(
      listen<WorktreeDeletingEvent>('worktree:deleting', event => {
        const { id, project_id } = event.payload
        logger.info('Worktree deleting (background started)', { id })

        // Optimistically remove from cache so it disappears instantly on all clients
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(project_id),
          old => {
            if (!old) return []
            return old.filter(w => w.id !== id)
          }
        )

        // Clear chat/selection if this worktree was active
        const { activeWorktreeId, clearActiveWorktree } =
          useChatStore.getState()
        if (activeWorktreeId === id) {
          clearActiveWorktree()
        }
        const { selectedWorktreeId, selectWorktree } =
          useProjectsStore.getState()
        if (selectedWorktreeId === id) {
          selectWorktree(null)
        }

        // Close SessionChatModal if it's open for this worktree
        window.dispatchEvent(
          new CustomEvent('close-worktree-modal', { detail: { worktreeId: id } })
        )
      })
    )

    // Listen for successful deletion
    unlistenPromises.push(
      listen<WorktreeDeletedEvent>('worktree:deleted', event => {
        const { id, project_id, teardown_output } = event.payload
        logger.info('Worktree deleted (background complete)', { id })

        // Remove worktree from cache
        queryClient.setQueryData<Worktree[]>(
          projectsQueryKeys.worktrees(project_id),
          old => {
            if (!old) return []
            return old.filter(w => w.id !== id)
          }
        )

        // Clear chat/selection if this worktree was active
        // (handles cases where worktree:deleting wasn't emitted, e.g. close_base_session)
        const { activeWorktreeId, clearActiveWorktree } =
          useChatStore.getState()
        if (activeWorktreeId === id) {
          clearActiveWorktree()
        }
        const { selectedWorktreeId, selectWorktree } =
          useProjectsStore.getState()
        if (selectedWorktreeId === id) {
          selectWorktree(null)
        }

        // Show teardown output if a teardown script ran
        if (teardown_output) {
          toast.success('Teardown completed', {
            description:
              teardown_output.length > 200
                ? teardown_output.slice(0, 200) + '…'
                : teardown_output,
            action: {
              label: 'View Output',
              onClick: () =>
                window.dispatchEvent(
                  new CustomEvent('show-teardown-output', {
                    detail: { output: teardown_output, success: true },
                  })
                ),
            },
          })
        }
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

        toast.error('Failed to delete worktree', {
          description: error,
          duration: Infinity,
          action: {
            label: 'View Output',
            onClick: () =>
              window.dispatchEvent(
                new CustomEvent('show-teardown-output', {
                  detail: { output: error, success: false },
                })
              ),
          },
        })
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

        handleWorktreeReady(worktree, queryClient)
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

    // =========================================================================
    // Generic worktree change notification (for backend-created worktrees)
    // =========================================================================

    unlistenPromises.push(
      listen<{ project_id: string }>('worktrees:changed', event => {
        const { project_id } = event.payload
        logger.info('Worktrees changed (backend notification)', { project_id })
        queryClient.invalidateQueries({
          queryKey: projectsQueryKeys.worktrees(project_id),
        })
      })
    )

    // Listen for path exists conflicts — show error toast instead of auto-creating
    unlistenPromises.push(
      listen<WorktreePathExistsEvent>('worktree:path_exists', event => {
        const { path, archived_worktree_id, archived_worktree_name } =
          event.payload

        if (archived_worktree_id) {
          logger.warn('Path conflict with archived worktree', {
            path,
            archivedName: archived_worktree_name,
            archivedId: archived_worktree_id,
          })
          toast.error(
            `Path conflict with archived worktree "${archived_worktree_name}"`,
            {
              description: 'Restore it or permanently delete it first.',
            }
          )
        } else {
          logger.warn('Path conflict with unknown directory', { path })
          toast.error('Worktree path already exists', {
            description: `Remove directory manually: ${path}`,
          })
        }
      })
    )

    // Listen for branch exists conflicts — dispatch DOM event for BranchConflictDialog
    unlistenPromises.push(
      listen<WorktreeBranchExistsEvent>('worktree:branch_exists', event => {
        const { branch } = event.payload
        logger.warn('Branch conflict', { branch })
        window.dispatchEvent(
          new CustomEvent('branch-conflict-detected', {
            detail: event.payload,
          })
        )
      })
    )

    // Cleanup listeners and pending timeouts on unmount
    return () => {
      Promise.all(unlistenPromises).then(unlistens => {
        unlistens.forEach(unlisten => unlisten())
      })
      for (const timeout of pendingTimeouts.values()) {
        clearTimeout(timeout)
      }
      pendingTimeouts.clear()
    }
  }, [queryClient, wsConnected])
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
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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

      // Register path and only switch to worktree view if already in one.
      // If on project canvas (activeWorktreePath is null), keep them there.
      const { setActiveWorktree, activeWorktreePath, registerWorktreePath } =
        useChatStore.getState()
      registerWorktreePath(session.id, session.path)
      if (activeWorktreePath) {
        setActiveWorktree(session.id, session.path)
      }

      // Mark for auto-open so ProjectCanvasView opens the chat modal
      useUIStore.getState().markWorktreeForAutoOpenSession(session.id)

      toast.success(`Base session: ${session.name}`)
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to close session (clean)', { error })
      toast.error('Failed to close session', { description: message })
    },
  })
}

export function useCloseBaseSessionArchive() {
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

      logger.debug('Closing base session (archive)', { worktreeId })
      await invoke('close_base_session_archive', { worktreeId })
      logger.info('Base session closed (archive)')
    },
    onSuccess: (_, { projectId, worktreeId }) => {
      queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.worktrees(projectId),
      })

      // Invalidate archived sessions query so they show up immediately
      queryClient.invalidateQueries({ queryKey: ['all-archived-sessions'] })

      // Cleanup terminal instances for this worktree
      disposeAllWorktreeTerminals(worktreeId)

      // Clear chat if the closed session was active
      const { activeWorktreeId, clearActiveWorktree } = useChatStore.getState()
      if (activeWorktreeId === worktreeId) {
        clearActiveWorktree()
      }

      toast.success('Session archived & closed')
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to close session (archive)', { error })
      toast.error('Failed to close session', { description: message })
    },
  })
}

/**
 * Hook to open a branch on GitHub
 * Works in both native (uses tauri-plugin-opener) and web (uses window.open)
 */
export function useOpenBranchOnGitHub() {
  return useMutation({
    mutationFn: async ({
      repoPath,
      branch,
    }: {
      repoPath: string
      branch: string
    }): Promise<void> => {
      if (!isTauri()) {
        throw new Error('No backend available')
      }

      // Pre-open window synchronously to avoid mobile popup blockers
      const win = preOpenWindow()

      logger.debug('Opening branch on GitHub', { repoPath, branch })

      try {
        const url = await invoke<string>('get_github_branch_url', {
          repoPath,
          branch,
        })

        await openExternal(url, win)
      } catch (e) {
        win?.close()
        throw e
      }

      logger.info('Opened branch on GitHub')
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to open on GitHub', { error })
      toast.error('Failed to open on GitHub', { description: message })
    },
  })
}

export interface GitHubRemote {
  name: string
  url: string
}

/**
 * Hook to fetch all GitHub remotes for a repository
 */
export function useGitHubRemotes(repoPath: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['github-remotes', repoPath],
    queryFn: async () => {
      if (!repoPath) return []
      return invoke<GitHubRemote[]>('get_github_remotes', { repoPath })
    },
    enabled: enabled && repoPath !== null,
    staleTime: 30_000,
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

      logger.debug(`Opening worktree in ${getFileManagerName()}`, { worktreePath })
      await invoke('open_worktree_in_finder', { worktreePath })
      logger.info(`Opened worktree in ${getFileManagerName()}`)
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error(`Failed to open in ${getFileManagerName()}`, { error })
      toast.error(`Failed to open in ${getFileManagerName()}`, { description: message })
    },
  })
}

/**
 * Hook to open a project's worktrees folder in Finder
 */
export function useOpenProjectWorktreesFolder() {
  return useMutation({
    mutationFn: async (projectId: string): Promise<void> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Opening project worktrees folder', { projectId })
      await invoke('open_project_worktrees_folder', { projectId })
      logger.info('Opened project worktrees folder')
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
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
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
      logger.error('Failed to open in Editor', { error })
      toast.error('Failed to open in Editor', { description: message })
    },
  })
}

/**
 * A port entry from jean.json
 */
export interface PortEntry {
  port: number
  label: string
}

/**
 * Jean.json config shape
 */
export interface JeanConfig {
  scripts: {
    setup: string | null
    teardown: string | null
    run: string | string[] | null
  }
  ports?: PortEntry[] | null
}

/**
 * Normalize a run script value (string | string[] | null) into a string array
 */
export function normalizeRunScripts(
  run: string | string[] | null | undefined
): string[] {
  if (!run) return []
  if (typeof run === 'string') return [run]
  return run
}

/**
 * Hook to get full jean.json config for a project
 */
export function useJeanConfig(projectPath: string | null) {
  return useQuery<JeanConfig | null>({
    queryKey: ['jean-config', projectPath],
    queryFn: async () => {
      if (!isTauri() || !projectPath) return null
      const config = await invoke<JeanConfig | null>('get_jean_config', {
        projectPath,
      })
      return config ?? null
    },
    enabled: !!projectPath,
    staleTime: 30_000,
  })
}

/**
 * Mutation hook to save jean.json config to disk
 */
export function useSaveJeanConfig() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      projectPath,
      config,
    }: {
      projectPath: string
      config: JeanConfig
    }) => {
      await invoke('save_jean_config', { projectPath, config })
    },
    onSuccess: (_, { projectPath }) => {
      queryClient.invalidateQueries({ queryKey: ['jean-config', projectPath] })
      queryClient.invalidateQueries({ queryKey: ['run-scripts'] })
      queryClient.invalidateQueries({ queryKey: ['ports'] })
    },
    onError: error => {
      toast.error('Failed to save jean.json', {
        description: String(error),
      })
    },
  })
}

/**
 * Hook to get the run script(s) from jean.json for a worktree.
 * Returns string[] (empty = none configured).
 */
export function useRunScripts(worktreePath: string | null) {
  return useQuery<string[]>({
    queryKey: ['run-scripts', worktreePath],
    queryFn: async () => {
      if (!isTauri() || !worktreePath) return []

      logger.debug('Fetching run scripts', { worktreePath })
      const scripts = await invoke<string[]>('get_run_scripts', {
        worktreePath,
      })
      logger.debug('Run scripts result', { scripts })
      return scripts
    },
    enabled: !!worktreePath,
    staleTime: 30_000, // Cache for 30 seconds
  })
}

/**
 * Hook to get configured ports from jean.json for a worktree.
 * Returns PortEntry[] (empty = none configured).
 */
export function usePorts(worktreePath: string | null) {
  return useQuery<PortEntry[]>({
    queryKey: ['ports', worktreePath],
    queryFn: async () => {
      if (!isTauri() || !worktreePath) return []
      const ports = await invoke<PortEntry[]>('get_ports', { worktreePath })
      return ports
    },
    enabled: !!worktreePath,
    staleTime: 30_000,
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
 * Works in both native (uses tauri-plugin-opener) and web (uses window.open)
 */
export function useOpenProjectOnGitHub() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (projectId: string): Promise<void> => {
      if (!isTauri()) {
        throw new Error('No backend available')
      }

      // Get project data from cache or fetch
      const projects = queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )
      const project = projects?.find(p => p.id === projectId)

      if (!project?.path) {
        throw new Error('Project not found or has no path')
      }

      // Pre-open window synchronously to avoid mobile popup blockers
      const win = preOpenWindow()

      logger.debug('Opening project on GitHub', {
        projectId,
        path: project.path,
      })

      try {
        const url = await invoke<string>('get_github_repo_url', {
          repoPath: project.path,
        })

        await openExternal(url, win)
      } catch (e) {
        win?.close()
        throw e
      }

      logger.info('Opened project on GitHub')
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
  branch: string | null,
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
  worktreeAheadCount: number | null = null,
  unpushedCount: number | null = null
): Promise<void> {
  if (!isTauri()) return

  await invoke('update_worktree_cached_status', {
    worktreeId,
    branch,
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
    unpushedCount,
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
      name,
      defaultBranch,
      enabledMcpServers,
      knownMcpServers,
      linkedProjectIds,
      customSystemPrompt,
      defaultProvider,
      defaultBackend,
      worktreesDir,
      linearApiKey,
      linearTeamId,
    }: {
      projectId: string
      name?: string
      defaultBranch?: string
      enabledMcpServers?: string[]
      knownMcpServers?: string[]
      customSystemPrompt?: string
      defaultProvider?: string | null
      defaultBackend?: string | null
      worktreesDir?: string
      linearApiKey?: string
      linearTeamId?: string
      linkedProjectIds?: string[]
    }): Promise<Project> => {
      if (!isTauri()) {
        throw new Error('Not in Tauri context')
      }

      logger.debug('Updating project settings', { projectId, name, defaultBranch })
      const project = await invoke<Project>('update_project_settings', {
        projectId,
        name,
        defaultBranch,
        enabledMcpServers,
        knownMcpServers,
        customSystemPrompt,
        defaultProvider,
        defaultBackend,
        worktreesDir,
        linearApiKey,
        linearTeamId,
        linkedProjectIds,
      })
      logger.info('Project settings updated', { project })
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
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
      await queryClient.invalidateQueries({
        queryKey: projectsQueryKeys.list(),
      })

      // Set the folder for immediate rename and expand it
      const { setEditingFolderId, expandFolder } = useProjectsStore.getState()
      expandFolder(folder.id)
      setEditingFolderId(folder.id)
    },
    onError: error => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
      const item = await invoke<Project>('move_item', {
        itemId,
        newParentId,
        targetIndex,
      })
      logger.info('Item moved successfully', { item })
      return item
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
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Unknown error occurred'
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
      // Cache for browser-mode file URL conversion
      if (dir) setAppDataDir(dir)
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
