import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownUp, ChevronDown } from '@/components/icons/reicon'
import {
  convertFileSrc,
  convertProjectFileSrc,
  convertServerFileSrc,
  convertServerProjectFileSrc,
} from '@/lib/transport'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/projects'
import { isBaseSession } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { useRemotePicker } from '@/hooks/useRemotePicker'
import {
  useAppDataDir,
  useUpdateProjectSettings,
  useWorktrees,
} from '@/services/projects'
import {
  useFetchWorktreesStatus,
  useGitStatus,
  performGitSync,
} from '@/services/git-status'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { WorktreeList } from './WorktreeList'
import { ProjectContextMenu } from './ProjectContextMenu'
import { matchesProjectSearch, matchesWorktreeSearch } from './project-search'
import { CollapsedCountBadge } from './CollapsedCountBadge'

interface ProjectTreeItemProps {
  project: Project
  searchQuery?: string
}

export function ProjectTreeItem({
  project,
  searchQuery = '',
}: ProjectTreeItemProps) {
  const isMobile = useIsMobile()
  const isOffline = project.offline === true
  const isProjectExpanded = useProjectsStore(state =>
    state.expandedProjectIds.has(project.id)
  )
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const selectProject = useProjectsStore(state => state.selectProject)
  const toggleProjectExpanded = useProjectsStore(
    state => state.toggleProjectExpanded
  )
  const shouldLoadWorktrees =
    !isOffline &&
    (Boolean(searchQuery) ||
      isProjectExpanded ||
      selectedProjectId === project.id)
  const { data: loadedWorktrees, isLoading: worktreesLoading } = useWorktrees(
    project.id,
    {
      enabled: shouldLoadWorktrees,
    }
  )
  const worktrees = useMemo(
    () =>
      (loadedWorktrees ?? []).filter(
        worktree => worktree.origin !== 'auto_fix'
      ),
    [loadedWorktrees]
  )
  const { data: appDataDir = '' } = useAppDataDir()
  // Prefer loaded worktrees: project.worktree_count can be stale
  const worktreeCount = loadedWorktrees
    ? worktrees.length
    : (project.worktree_count ?? 0)
  const hasWorktrees = !isOffline && worktreeCount > 0
  const projectMatchesSearch = matchesProjectSearch(project, searchQuery)
  const hasMatchingWorktree = worktrees.some(worktree =>
    matchesWorktreeSearch(worktree, searchQuery)
  )
  const isExpanded = hasWorktrees && (Boolean(searchQuery) || isProjectExpanded)

  const avatarKey = project.avatar_path ?? project.default_avatar_path ?? null

  // Track image load errors to fall back to letter avatar
  // Use avatar key to reset error state when it changes
  const [imgErrorKey, setImgErrorKey] = useState<string | null>(null)
  const imgError = imgErrorKey === avatarKey

  // Build avatar URL from relative path
  const avatarUrl =
    project.avatar_path && !imgError
      ? project.serverId
        ? convertServerFileSrc(project.serverId, project.avatar_path)
        : appDataDir
          ? convertFileSrc(`${appDataDir}/${project.avatar_path}`)
          : null
      : project.default_avatar_path && !imgError
        ? project.serverId
          ? convertServerProjectFileSrc(
              project.serverId,
              project.default_avatar_path
            )
          : convertProjectFileSrc(project.default_avatar_path)
        : null

  // Fetch git status for all worktrees when project is expanded
  useFetchWorktreesStatus(project.id, isExpanded && !searchQuery)

  // Check if base session exists
  const hasBaseSession = worktrees.some(w => isBaseSession(w))

  // Get base branch status from any worktree (all have it)
  const firstWorktree = worktrees[0]
  const { data: gitStatus } = useGitStatus(
    searchQuery ? null : (firstWorktree?.id ?? null)
  )

  // Only show on project line when no base session
  const baseBranchBehindCount = !hasBaseSession
    ? (gitStatus?.base_branch_behind_count ??
      firstWorktree?.cached_base_branch_behind_count ??
      0)
    : 0
  const baseBranchAheadCount = !hasBaseSession
    ? (gitStatus?.base_branch_ahead_count ??
      firstWorktree?.cached_base_branch_ahead_count ??
      0)
    : 0

  // Get chat store state
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const clearActiveWorktree = useChatStore(state => state.clearActiveWorktree)

  // Project is only selected if it's the selected project AND no worktree is active
  const isSelected = selectedProjectId === project.id && !activeWorktreeId

  // Inline rename (double-click), matching folder/worktree patterns
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const editStartTimeRef = useRef<number>(0)
  const updateSettings = useUpdateProjectSettings()

  useEffect(() => {
    if (isEditing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditName(project.name)
      editStartTimeRef.current = Date.now()
    }
  }, [isEditing, project.name])

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleClick = useCallback(() => {
    if (isEditing || isOffline) return

    selectProject(project.id)
    clearActiveWorktree()
    if (isMobile) {
      useUIStore.getState().setLeftSidebarVisible(false)
    }
  }, [
    isEditing,
    isOffline,
    project.id,
    selectProject,
    clearActiveWorktree,
    isMobile,
  ])

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isEditing || isOffline) return
      setEditName(project.name)
      setIsEditing(true)
    },
    [isEditing, isOffline, project.name]
  )

  const handleSubmitRename = useCallback(
    (fromBlur = false) => {
      // Ignore blur events within 300ms of edit start (prevents re-render blur issues)
      if (fromBlur && Date.now() - editStartTimeRef.current < 300) {
        inputRef.current?.focus()
        return
      }

      const trimmedName = editName.trim()
      if (trimmedName && trimmedName !== project.name) {
        updateSettings.mutate({ projectId: project.id, name: trimmedName })
      }
      setIsEditing(false)
    },
    [editName, project.id, project.name, updateSettings]
  )

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        handleSubmitRename(false)
      } else if (e.key === 'Escape') {
        setEditName(project.name)
        setIsEditing(false)
      }
    },
    [handleSubmitRename, project.name]
  )

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      toggleProjectExpanded(project.id)
    },
    [project.id, toggleProjectExpanded]
  )

  const pickRemoteOrRun = useRemotePicker(project.path)

  const handleBaseSync = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      pickRemoteOrRun(async remote => {
        await performGitSync({
          needsPull: baseBranchBehindCount > 0,
          needsPush: baseBranchAheadCount > 0,
          pull: {
            worktreeId: '',
            worktreePath: project.path,
            baseBranch: project.default_branch,
            projectId: project.id,
          },
          pushRemote: remote,
        })
      })
    },
    [
      pickRemoteOrRun,
      baseBranchBehindCount,
      baseBranchAheadCount,
      project.path,
      project.default_branch,
      project.id,
    ]
  )

  if (
    searchQuery &&
    !projectMatchesSearch &&
    !worktreesLoading &&
    !hasMatchingWorktree
  ) {
    return null
  }

  return (
    <ProjectContextMenu project={project}>
      <div>
        {/* Project Row */}
        <div
          className={cn(
            'group relative flex items-center gap-1.5 px-2 py-1.5 overflow-hidden transition-colors duration-150',
            isOffline ? 'cursor-default opacity-70' : 'cursor-pointer',
            isSelected
              ? 'bg-primary/10 text-foreground before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:bg-primary'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
          )}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          data-testid={`project-row-${project.id}`}
        >
          {/* Avatar */}
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={project.name}
              className="size-4 shrink-0 rounded object-cover"
              onError={() => setImgErrorKey(avatarKey)}
            />
          ) : (
            <div className="flex size-4 shrink-0 items-center justify-center rounded bg-muted-foreground/20">
              <span className="text-[10px] font-medium uppercase">
                {project.name[0]}
              </span>
            </div>
          )}

          {/* Name + Chevron */}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              aria-label="Project name"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={() => handleSubmitRename(true)}
              onKeyDown={handleRenameKeyDown}
              className="flex-1 bg-transparent text-base outline-none ring-1 ring-primary/50 rounded px-1 md:text-sm"
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="flex flex-1 items-center gap-0.5 truncate text-sm">
              <span className="truncate">{project.name}</span>
              {isOffline && (
                <span className="shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[10px] text-warning">
                  Offline
                </span>
              )}
              {hasWorktrees && (
                <button
                  type="button"
                  aria-label={
                    isExpanded ? 'Collapse project' : 'Expand project'
                  }
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded transition-opacity hover:bg-accent-foreground/10',
                    isMobile
                      ? 'opacity-70'
                      : 'opacity-0 group-hover:opacity-50 hover:!opacity-100'
                  )}
                  onClick={handleChevronClick}
                >
                  <ChevronDown
                    className={cn(
                      'size-3 transition-transform',
                      isExpanded && 'rotate-180'
                    )}
                  />
                </button>
              )}
            </span>
          )}

          {/* Base branch pull/push indicators (when no base session) */}
          {!isOffline &&
            (baseBranchBehindCount > 0 || baseBranchAheadCount > 0) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleBaseSync}
                    className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400 transition-colors hover:bg-violet-500/20"
                  >
                    <span className="flex items-center gap-0.5">
                      <ArrowDownUp className="h-3 w-3" />
                      {baseBranchBehindCount > 0 && baseBranchAheadCount > 0
                        ? `${baseBranchBehindCount}/${baseBranchAheadCount}`
                        : baseBranchBehindCount > 0
                          ? baseBranchBehindCount
                          : baseBranchAheadCount}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {(() => {
                    const parts: string[] = []
                    if (baseBranchBehindCount > 0) {
                      parts.push(
                        `pull ${baseBranchBehindCount} commit${baseBranchBehindCount > 1 ? 's' : ''}`
                      )
                    }
                    if (baseBranchAheadCount > 0) {
                      parts.push(
                        `push ${baseBranchAheadCount} commit${baseBranchAheadCount > 1 ? 's' : ''}`
                      )
                    }
                    return `Sync ${project.default_branch}: ${parts.join(', ')}`
                  })()}
                </TooltipContent>
              </Tooltip>
            )}

          <CollapsedCountBadge
            count={worktreeCount}
            label="workspaces"
            isExpanded={isExpanded}
          />
        </div>

        {/* Worktrees */}
        {isExpanded && (
          <WorktreeList
            projectId={project.id}
            projectPath={project.path}
            worktrees={worktrees}
            defaultBranch={project.default_branch}
            searchQuery={projectMatchesSearch ? '' : searchQuery}
            searchActive={Boolean(searchQuery)}
            loadSessionCounts={!searchQuery}
          />
        )}
      </div>
    </ProjectContextMenu>
  )
}
