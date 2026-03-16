import { useMemo, useState, useCallback } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import {
  Archive,
  Loader2,
  Search,
  Trash2,
  RotateCcw,
  MessageSquare,
  GitBranch,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  useArchivedWorktrees,
  useUnarchiveWorktree,
  usePermanentlyDeleteWorktree,
} from '@/services/projects'
import { useProjects } from '@/services/projects'
import {
  useAllArchivedSessions,
  useUnarchiveSession,
  useRestoreSessionWithBase,
  useDeleteArchivedSession,
} from '@/services/chat'
import { useQueryClient } from '@tanstack/react-query'
import { usePreferences } from '@/services/preferences'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { navigateToRestoredItem } from '@/lib/restore-navigation'
import type { Worktree, Project } from '@/types/projects'
import type { ArchivedSessionEntry } from '@/types/chat'

interface ArchivedModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Format a Unix timestamp to a human-readable date */
function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Group archived worktrees by project */
interface GroupedWorktrees {
  project: Project
  worktrees: Worktree[]
}

/** Group archived sessions by project/worktree */
interface GroupedSessions {
  project_name: string
  worktree_name: string
  worktree_id: string
  worktree_path: string
  sessions: ArchivedSessionEntry[]
}

type DeleteConfirmType =
  | { type: 'worktree'; item: Worktree }
  | { type: 'session'; item: ArchivedSessionEntry }
  | { type: 'all' }

interface CleanupResult {
  deleted_worktrees: number
  deleted_sessions: number
}

export function ArchivedModal({ open, onOpenChange }: ArchivedModalProps) {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const isDelete = (preferences?.removal_behavior ?? 'delete') === 'delete'
  const [searchQuery, setSearchQuery] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmType | null>(
    null
  )
  const [activeTab, setActiveTab] = useState<'worktrees' | 'sessions'>(
    'worktrees'
  )
  const [isDeletingAll, setIsDeletingAll] = useState(false)

  // Get current selection from stores
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)

  // Fetch archived worktrees
  const { data: archivedWorktrees, isLoading: isLoadingArchived } =
    useArchivedWorktrees()

  // Fetch archived sessions
  const { data: archivedSessions, isLoading: isLoadingSessions } =
    useAllArchivedSessions()

  // Fetch projects for grouping
  const { data: projects, isLoading: isLoadingProjects } = useProjects()

  // Worktree mutations
  const unarchiveWorktree = useUnarchiveWorktree()
  const permanentlyDeleteWorktree = usePermanentlyDeleteWorktree()

  // Session mutations
  const unarchiveSession = useUnarchiveSession()
  const restoreSessionWithBase = useRestoreSessionWithBase()
  const deleteArchivedSession = useDeleteArchivedSession()

  // Group worktrees by project, with current project first
  const groupedWorktrees = useMemo((): (GroupedWorktrees & {
    isCurrentProject: boolean
  })[] => {
    if (!archivedWorktrees || !projects) return []

    const groups = new Map<string, Worktree[]>()

    // Group worktrees by project_id
    for (const worktree of archivedWorktrees) {
      const existing = groups.get(worktree.project_id) || []
      groups.set(worktree.project_id, [...existing, worktree])
    }

    // Convert to array with project info
    const result = projects
      .filter(project => groups.has(project.id))
      .map(project => ({
        project,
        worktrees: groups.get(project.id) || [],
        isCurrentProject: project.id === selectedProjectId,
      }))

    // Sort: current project first, then alphabetically
    return result.sort((a, b) => {
      if (a.isCurrentProject && !b.isCurrentProject) return -1
      if (!a.isCurrentProject && b.isCurrentProject) return 1
      return a.project.name.localeCompare(b.project.name)
    })
  }, [archivedWorktrees, projects, selectedProjectId])

  // Group sessions by worktree, with current worktree first
  const groupedSessions = useMemo((): (GroupedSessions & {
    isCurrentWorktree: boolean
  })[] => {
    if (!archivedSessions || archivedSessions.length === 0) return []

    const groups = new Map<string, ArchivedSessionEntry[]>()

    for (const entry of archivedSessions) {
      const key = entry.worktree_id
      const existing = groups.get(key) || []
      groups.set(key, [...existing, entry])
    }

    const result = Array.from(groups.entries()).map(
      ([worktreeId, sessions]) => {
        const firstSession = sessions[0]
        return {
          project_name: firstSession?.project_name ?? '',
          worktree_name: firstSession?.worktree_name ?? '',
          worktree_id: worktreeId,
          worktree_path: firstSession?.worktree_path ?? '',
          sessions,
          isCurrentWorktree: worktreeId === activeWorktreeId,
        }
      }
    )

    // Sort: current worktree first, then alphabetically
    return result.sort((a, b) => {
      if (a.isCurrentWorktree && !b.isCurrentWorktree) return -1
      if (!a.isCurrentWorktree && b.isCurrentWorktree) return 1
      return `${a.project_name}/${a.worktree_name}`.localeCompare(
        `${b.project_name}/${b.worktree_name}`
      )
    })
  }, [archivedSessions, activeWorktreeId])

  // Filter worktrees by search query (searches both tabs)
  const filteredWorktreeGroups = useMemo((): (GroupedWorktrees & {
    isCurrentProject: boolean
  })[] => {
    if (!searchQuery) return groupedWorktrees

    const query = searchQuery.toLowerCase()

    return groupedWorktrees
      .map(group => ({
        ...group,
        worktrees: group.worktrees.filter(
          w =>
            w.name.toLowerCase().includes(query) ||
            w.branch.toLowerCase().includes(query) ||
            group.project.name.toLowerCase().includes(query)
        ),
      }))
      .filter(group => group.worktrees.length > 0)
  }, [groupedWorktrees, searchQuery])

  // Filter sessions by search query (searches both tabs)
  const filteredSessionGroups = useMemo((): (GroupedSessions & {
    isCurrentWorktree: boolean
  })[] => {
    if (!searchQuery) return groupedSessions

    const query = searchQuery.toLowerCase()

    return groupedSessions
      .map(group => ({
        ...group,
        sessions: group.sessions.filter(
          s =>
            s.session.name.toLowerCase().includes(query) ||
            s.worktree_name.toLowerCase().includes(query) ||
            s.project_name.toLowerCase().includes(query)
        ),
      }))
      .filter(group => group.sessions.length > 0)
  }, [groupedSessions, searchQuery])

  // Count filtered results for both tabs
  const filteredWorktreesCount = filteredWorktreeGroups.reduce(
    (acc, g) => acc + g.worktrees.length,
    0
  )
  const filteredSessionsCount = filteredSessionGroups.reduce(
    (acc, g) => acc + g.sessions.length,
    0
  )

  // Combined and sorted search results (most recently archived first)
  type SearchResult =
    | {
        type: 'worktree'
        worktree: Worktree
        projectName: string
        isCurrentContext: boolean
      }
    | {
        type: 'session'
        entry: ArchivedSessionEntry
        isCurrentContext: boolean
      }

  const sortedSearchResults = useMemo((): SearchResult[] => {
    if (!searchQuery) return []

    const results: SearchResult[] = []

    // Add filtered worktrees
    for (const group of filteredWorktreeGroups) {
      for (const worktree of group.worktrees) {
        results.push({
          type: 'worktree',
          worktree,
          projectName: group.project.name,
          isCurrentContext: group.isCurrentProject,
        })
      }
    }

    // Add filtered sessions
    for (const group of filteredSessionGroups) {
      for (const entry of group.sessions) {
        results.push({
          type: 'session',
          entry,
          isCurrentContext: group.isCurrentWorktree,
        })
      }
    }

    // Sort by archived_at descending (most recent first)
    return results.sort((a, b) => {
      const aTime =
        a.type === 'worktree'
          ? a.worktree.archived_at
          : a.entry.session.archived_at
      const bTime =
        b.type === 'worktree'
          ? b.worktree.archived_at
          : b.entry.session.archived_at
      return (bTime ?? 0) - (aTime ?? 0)
    })
  }, [searchQuery, filteredWorktreeGroups, filteredSessionGroups])

  const handleRestoreWorktree = (worktree: Worktree) => {
    unarchiveWorktree.mutate(worktree.id, {
      onSuccess: () => {
        navigateToRestoredItem(worktree.id, worktree.path)
        onOpenChange(false)
      },
    })
  }

  const handleRestoreSession = (entry: ArchivedSessionEntry) => {
    // Check if the worktree is archived - if so, restore it first
    const worktreeIsArchived = archivedWorktrees?.some(
      w => w.id === entry.worktree_id
    )

    const doRestore = () => {
      // Use restore_session_with_base which handles:
      // 1. Normal session restore (worktree exists)
      // 2. Base session recreation (worktree was closed)
      restoreSessionWithBase.mutate(
        {
          worktreeId: entry.worktree_id,
          worktreePath: entry.worktree_path,
          sessionId: entry.session.id,
          projectId: entry.project_id,
        },
        {
          onSuccess: response => {
            // Invalidate the all-archived-sessions query
            queryClient.invalidateQueries({
              queryKey: ['all-archived-sessions'],
            })

            navigateToRestoredItem(
              response.worktree.id,
              response.worktree.path,
              entry.session.id
            )
            onOpenChange(false)
          },
        }
      )
    }

    if (worktreeIsArchived) {
      // Worktree is archived - restore it first, then the session
      unarchiveWorktree.mutate(entry.worktree_id, {
        onSuccess: () => {
          doRestore()
        },
      })
    } else {
      // Worktree exists or is a closed base session - the backend handles both cases
      doRestore()
    }
  }

  const handleDeleteWorktreeForever = (worktree: Worktree) => {
    setDeleteConfirm({ type: 'worktree', item: worktree })
  }

  const handleDeleteSessionForever = (entry: ArchivedSessionEntry) => {
    setDeleteConfirm({ type: 'session', item: entry })
  }

  const handleDeleteAllArchives = useCallback(async () => {
    setIsDeletingAll(true)
    const toastId = toast.loading('Deleting all archives...')

    try {
      const result = await invoke<CleanupResult>('delete_all_archives')

      // Invalidate archive queries to refresh UI
      queryClient.invalidateQueries({ queryKey: ['archived-worktrees'] })
      queryClient.invalidateQueries({ queryKey: ['all-archived-sessions'] })

      const parts: string[] = []
      if (result.deleted_worktrees > 0) {
        parts.push(
          `${result.deleted_worktrees} worktree${result.deleted_worktrees === 1 ? '' : 's'}`
        )
      }
      if (result.deleted_sessions > 0) {
        parts.push(
          `${result.deleted_sessions} session${result.deleted_sessions === 1 ? '' : 's'}`
        )
      }

      if (parts.length > 0) {
        toast.success(`Deleted ${parts.join(' and ')}`, { id: toastId })
      } else {
        toast.info('No archives to delete', { id: toastId })
      }

      // Close modal after successful deletion
      onOpenChange(false)
    } catch (error) {
      toast.error(`Failed to delete archives: ${error}`, { id: toastId })
    } finally {
      setIsDeletingAll(false)
      setDeleteConfirm(null)
    }
  }, [queryClient, onOpenChange])

  const confirmDelete = () => {
    if (!deleteConfirm) return

    if (deleteConfirm.type === 'all') {
      handleDeleteAllArchives()
      return
    }

    if (deleteConfirm.type === 'worktree') {
      permanentlyDeleteWorktree.mutate(deleteConfirm.item.id, {
        onSuccess: () => {
          setDeleteConfirm(null)
          const remainingWorktrees = (archivedWorktrees?.length ?? 0) - 1
          const remainingSessions = archivedSessions?.length ?? 0
          if (remainingWorktrees <= 0 && remainingSessions <= 0) {
            onOpenChange(false)
          }
        },
      })
    } else {
      const entry = deleteConfirm.item
      deleteArchivedSession.mutate(
        {
          worktreeId: entry.worktree_id,
          worktreePath: entry.worktree_path,
          sessionId: entry.session.id,
        },
        {
          onSuccess: () => {
            setDeleteConfirm(null)
            // Invalidate the all-archived-sessions query
            queryClient.invalidateQueries({
              queryKey: ['all-archived-sessions'],
            })

            const remainingWorktrees = archivedWorktrees?.length ?? 0
            const remainingSessions = (archivedSessions?.length ?? 0) - 1
            if (remainingWorktrees <= 0 && remainingSessions <= 0) {
              onOpenChange(false)
            }
          },
        }
      )
    }
  }

  const isLoading = isLoadingArchived || isLoadingProjects || isLoadingSessions
  const worktreesCount = archivedWorktrees?.length ?? 0
  const sessionsCount = archivedSessions?.length ?? 0
  const isEmpty = worktreesCount === 0 && sessionsCount === 0 && !isLoading

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[90vw] sm:!max-w-[90vw] sm:!h-[85vh] sm:!max-h-[85vh] sm:!rounded-lg flex flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Archive className="h-4 w-4" />
              Archived Items
              {!isEmpty && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteConfirm({ type: 'all' })}
                  disabled={isDeletingAll}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Delete All
                </Button>
              )}
            </DialogTitle>
          </DialogHeader>

          {/* Search Input */}
          <div className="relative shrink-0">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search archived items..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-8"
            />
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : isEmpty ? (
            <div className="text-center py-8 text-muted-foreground">
              No archived items.
              <br />
              {isDelete ? (
                <span className="text-sm">
                  Removal behavior is set to delete — closed items are
                  permanently removed.{' '}
                  <button
                    type="button"
                    className="underline hover:text-foreground transition-colors"
                    onClick={() => {
                      onOpenChange(false)
                      useUIStore.getState().openPreferencesPane('general')
                    }}
                  >
                    Change in Settings
                  </button>
                </span>
              ) : (
                <span className="text-sm">
                  Archive worktrees and sessions to keep them for later without
                  cluttering your workspace.
                </span>
              )}
            </div>
          ) : searchQuery ? (
            // Consolidated search results view
            <ScrollArea className="flex-1 min-h-0">
              {filteredWorktreesCount === 0 && filteredSessionsCount === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  No results found for &ldquo;{searchQuery}&rdquo;
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {sortedSearchResults.map(result =>
                    result.type === 'worktree' ? (
                      <SearchResultItem
                        key={`worktree-${result.worktree.id}`}
                        type="worktree"
                        name={result.worktree.name}
                        subtitle={
                          <>
                            <span className="font-mono text-xs">
                              {result.worktree.branch}
                            </span>
                            <span className="text-border mx-1">•</span>
                            <span>{result.projectName}</span>
                          </>
                        }
                        archivedAt={result.worktree.archived_at}
                        isCurrentContext={result.isCurrentContext}
                        onRestore={() => handleRestoreWorktree(result.worktree)}
                        onDelete={() =>
                          handleDeleteWorktreeForever(result.worktree)
                        }
                        isRestoring={
                          unarchiveWorktree.isPending &&
                          unarchiveWorktree.variables === result.worktree.id
                        }
                        disabled={unarchiveWorktree.isPending}
                      />
                    ) : (
                      <SearchResultItem
                        key={`session-${result.entry.session.id}`}
                        type="session"
                        name={result.entry.session.name}
                        subtitle={
                          <>
                            <span>
                              {result.entry.session.message_count ??
                                result.entry.session.messages.length}{' '}
                              messages
                            </span>
                            <span className="text-border mx-1">•</span>
                            <span>
                              {result.entry.project_name} /{' '}
                              {result.entry.worktree_name}
                            </span>
                          </>
                        }
                        archivedAt={result.entry.session.archived_at}
                        isCurrentContext={result.isCurrentContext}
                        onRestore={() => handleRestoreSession(result.entry)}
                        onDelete={() =>
                          handleDeleteSessionForever(result.entry)
                        }
                        isRestoring={
                          unarchiveSession.isPending &&
                          unarchiveSession.variables?.sessionId ===
                            result.entry.session.id
                        }
                        disabled={unarchiveSession.isPending}
                      />
                    )
                  )}
                </div>
              )}
            </ScrollArea>
          ) : (
            // Tab-based view when not searching
            <div className="flex flex-col flex-1 min-h-0 gap-4">
              <div className="flex gap-1 p-1 bg-muted rounded-lg shrink-0">
                <Button
                  variant={activeTab === 'worktrees' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setActiveTab('worktrees')}
                  className="flex-1 flex items-center justify-center gap-1.5"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                  Worktrees
                  {worktreesCount > 0 && (
                    <span className="ml-1 text-xs bg-background px-1.5 py-0.5 rounded-full">
                      {worktreesCount}
                    </span>
                  )}
                </Button>
                <Button
                  variant={activeTab === 'sessions' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setActiveTab('sessions')}
                  className="flex-1 flex items-center justify-center gap-1.5"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  Sessions
                  {sessionsCount > 0 && (
                    <span className="ml-1 text-xs bg-background px-1.5 py-0.5 rounded-full">
                      {sessionsCount}
                    </span>
                  )}
                </Button>
              </div>

              {activeTab === 'worktrees' && (
                <ScrollArea className="flex-1 min-h-0">
                  {groupedWorktrees.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      No archived worktrees
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {groupedWorktrees.map(group => (
                        <WorktreeProjectGroup
                          key={group.project.id}
                          group={group}
                          isCurrentProject={group.isCurrentProject}
                          onRestore={handleRestoreWorktree}
                          onDeleteForever={handleDeleteWorktreeForever}
                          isRestoring={unarchiveWorktree.isPending}
                          restoringId={
                            unarchiveWorktree.isPending
                              ? unarchiveWorktree.variables
                              : null
                          }
                        />
                      ))}
                    </div>
                  )}
                </ScrollArea>
              )}

              {activeTab === 'sessions' && (
                <ScrollArea className="flex-1 min-h-0">
                  {groupedSessions.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      No archived sessions
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {groupedSessions.map(group => (
                        <SessionWorktreeGroup
                          key={group.worktree_id}
                          group={group}
                          isCurrentWorktree={group.isCurrentWorktree}
                          onRestore={handleRestoreSession}
                          onDeleteForever={handleDeleteSessionForever}
                          isRestoring={unarchiveSession.isPending}
                          restoringId={
                            unarchiveSession.isPending
                              ? (unarchiveSession.variables?.sessionId ?? null)
                              : null
                          }
                        />
                      ))}
                    </div>
                  )}
                </ScrollArea>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={deleteConfirm !== null}
        onOpenChange={open => !open && setDeleteConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteConfirm?.type === 'all'
                ? 'Delete all archives?'
                : deleteConfirm?.type === 'worktree'
                  ? 'Permanently delete worktree?'
                  : 'Permanently delete session?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirm?.type === 'all' ? (
                <>
                  This will permanently delete all archived worktrees and
                  sessions, including their git branches and worktree
                  directories. This action cannot be undone.
                </>
              ) : deleteConfirm?.type === 'worktree' ? (
                <>
                  This will permanently delete the worktree &quot;
                  {deleteConfirm.item.name}&quot; and its git branch. This
                  action cannot be undone.
                </>
              ) : deleteConfirm?.type === 'session' ? (
                <>
                  This will permanently delete the session &quot;
                  {deleteConfirm.item.session.name}&quot; and all its messages.
                  This action cannot be undone.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingAll}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={isDeletingAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {permanentlyDeleteWorktree.isPending ||
              deleteArchivedSession.isPending ||
              isDeletingAll ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              {deleteConfirm?.type === 'all' ? 'Delete All' : 'Delete Forever'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Component for a group of worktrees from a single project */
function WorktreeProjectGroup({
  group,
  isCurrentProject,
  onRestore,
  onDeleteForever,
  isRestoring,
  restoringId,
}: {
  group: GroupedWorktrees
  isCurrentProject: boolean
  onRestore: (worktree: Worktree) => void
  onDeleteForever: (worktree: Worktree) => void
  isRestoring: boolean
  restoringId: string | null
}) {
  return (
    <div className="space-y-1">
      {/* Project header */}
      <div
        className={cn(
          'text-xs font-medium uppercase tracking-wide px-1',
          isCurrentProject ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        {group.project.name}
        {isCurrentProject && (
          <span className="ml-1.5 text-[10px] normal-case tracking-normal opacity-70">
            (current)
          </span>
        )}
      </div>

      {/* Worktrees in this project */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {group.worktrees.map(worktree => {
          const isCurrentlyRestoring =
            isRestoring && restoringId === worktree.id

          return (
            <div
              key={worktree.id}
              className={cn(
                'p-3 rounded-lg border',
                'hover:bg-accent/50 transition-colors',
                'group'
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{worktree.name}</div>
                  <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-mono text-xs">{worktree.branch}</span>
                    {worktree.archived_at && (
                      <>
                        <span className="text-border">|</span>
                        <span className="whitespace-nowrap">
                          Archived {formatDate(worktree.archived_at)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRestore(worktree)}
                        disabled={isRestoring}
                      >
                        {isCurrentlyRestoring ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                        <span className="ml-1">Restore</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Restore worktree</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onDeleteForever(worktree)}
                        disabled={isRestoring}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete forever</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Component for a group of sessions from a single worktree */
function SessionWorktreeGroup({
  group,
  isCurrentWorktree,
  onRestore,
  onDeleteForever,
  isRestoring,
  restoringId,
}: {
  group: GroupedSessions
  isCurrentWorktree: boolean
  onRestore: (entry: ArchivedSessionEntry) => void
  onDeleteForever: (entry: ArchivedSessionEntry) => void
  isRestoring: boolean
  restoringId: string | null
}) {
  return (
    <div className="space-y-1">
      {/* Worktree header */}
      <div
        className={cn(
          'text-xs font-medium uppercase tracking-wide px-1',
          isCurrentWorktree ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        {group.project_name} / {group.worktree_name}
        {isCurrentWorktree && (
          <span className="ml-1.5 text-[10px] normal-case tracking-normal opacity-70">
            (current)
          </span>
        )}
      </div>

      {/* Sessions in this worktree */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {group.sessions.map(entry => {
          const isCurrentlyRestoring =
            isRestoring && restoringId === entry.session.id

          return (
            <div
              key={entry.session.id}
              className={cn(
                'p-3 rounded-lg border',
                'hover:bg-accent/50 transition-colors',
                'group'
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {entry.session.name}
                  </div>
                  <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-xs">
                      {entry.session.message_count ??
                        entry.session.messages.length}{' '}
                      messages
                    </span>
                    {entry.session.archived_at && (
                      <>
                        <span className="text-border">|</span>
                        <span className="whitespace-nowrap">
                          Archived {formatDate(entry.session.archived_at)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRestore(entry)}
                        disabled={isRestoring}
                      >
                        {isCurrentlyRestoring ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCcw className="h-4 w-4" />
                        )}
                        <span className="ml-1">Restore</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Restore session</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onDeleteForever(entry)}
                        disabled={isRestoring}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete forever</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Individual search result item for consolidated search view */
function SearchResultItem({
  type,
  name,
  subtitle,
  archivedAt,
  isCurrentContext,
  onRestore,
  onDelete,
  isRestoring,
  disabled,
}: {
  type: 'worktree' | 'session'
  name: string
  subtitle: React.ReactNode
  archivedAt?: number
  isCurrentContext: boolean
  onRestore: () => void
  onDelete: () => void
  isRestoring: boolean
  disabled: boolean
}) {
  const Icon = type === 'worktree' ? GitBranch : MessageSquare

  return (
    <div
      className={cn(
        'p-3 rounded-lg border',
        'hover:bg-accent/50 transition-colors',
        'group',
        isCurrentContext && 'border-primary/50 bg-primary/5'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 flex-1 min-w-0">
          {/* Type indicator */}
          <div
            className={cn(
              'flex items-center justify-center w-7 h-7 rounded-md mt-0.5 shrink-0',
              type === 'worktree'
                ? 'bg-blue-500/10 text-blue-500'
                : 'bg-orange-500/10 text-orange-500'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{name}</span>
              {isCurrentContext && (
                <span className="text-[10px] text-primary opacity-70 shrink-0">
                  (current)
                </span>
              )}
            </div>
            <div className="text-sm text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {subtitle}
              {archivedAt && (
                <>
                  <span className="text-border">|</span>
                  <span className="whitespace-nowrap">
                    Archived {formatDate(archivedAt)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRestore}
                disabled={disabled}
              >
                {isRestoring ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                <span className="ml-1">Restore</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`Restore ${type}`}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onDelete}
                disabled={disabled}
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete forever</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

export default ArchivedModal
