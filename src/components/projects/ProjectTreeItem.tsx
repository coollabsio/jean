import { useCallback, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, MoreHorizontal, Plus } from 'lucide-react'
import { FaGithub } from 'react-icons/fa'
import { FaGitlab } from 'react-icons/fa6'
import { convertFileSrc } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/projects'
import { isBaseSession } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useWorktrees, useAppDataDir } from '@/services/projects'
import {
  useFetchWorktreesStatus,
  useGitStatus,
  gitPull,
  gitPush,
  fetchWorktreesStatus,
} from '@/services/git-status'
import { WorktreeList } from './WorktreeList'
import { ProjectContextMenu } from './ProjectContextMenu'

interface ProjectTreeItemProps {
  project: Project
}

export function ProjectTreeItem({ project }: ProjectTreeItemProps) {
  const {
    expandedProjectIds,
    selectedProjectId,
    selectProject,
    toggleProjectExpanded,
    openProjectSettings,
  } = useProjectsStore()
  const { data: worktrees = [] } = useWorktrees(project.id)
  const { data: appDataDir = '' } = useAppDataDir()
  const hasWorktrees = worktrees.length > 0
  const isExpanded = hasWorktrees && expandedProjectIds.has(project.id)
  const setNewWorktreeModalOpen = useUIStore(
    state => state.setNewWorktreeModalOpen
  )

  // Track image load errors to fall back to letter avatar
  // Use avatar_path as key to reset error state when it changes
  const [imgErrorKey, setImgErrorKey] = useState<string | null>(null)
  const imgError = imgErrorKey === project.avatar_path

  // Build avatar URL from relative path
  const avatarUrl =
    project.avatar_path && appDataDir && !imgError
      ? convertFileSrc(`${appDataDir}/${project.avatar_path}`)
      : null

  // Fetch git status for all worktrees when project is expanded
  useFetchWorktreesStatus(project.id, isExpanded)

  // Check if base session exists
  const hasBaseSession = worktrees.some(w => isBaseSession(w))

  // Get base branch status from any worktree (all have it)
  const firstWorktree = worktrees[0]
  const { data: gitStatus } = useGitStatus(firstWorktree?.id ?? null)

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

  const handleClick = useCallback(() => {
    selectProject(project.id)
    // Clear active worktree so ChatWindow shows Session Board view
    clearActiveWorktree()
  }, [project.id, selectProject, clearActiveWorktree])

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      toggleProjectExpanded(project.id)
    },
    [project.id, toggleProjectExpanded]
  )

  const handleAddWorktree = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      // Select this project first so the modal knows which project to use
      selectProject(project.id)
      // Open the New Session modal
      setNewWorktreeModalOpen(true)
    },
    [project.id, selectProject, setNewWorktreeModalOpen]
  )

  const handleBasePull = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const toastId = toast.loading('Pulling changes...')
      try {
        await gitPull(project.path, project.default_branch)
        fetchWorktreesStatus(project.id)
        toast.success('Changes pulled', { id: toastId })
      } catch (error) {
        toast.error(`Pull failed: ${error}`, { id: toastId })
      }
    },
    [project.id, project.path, project.default_branch]
  )

  const handleBasePush = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const toastId = toast.loading('Pushing changes...')
      try {
        await gitPush(project.path)
        fetchWorktreesStatus(project.id)
        toast.success('Changes pushed', { id: toastId })
      } catch (error) {
        toast.error(`Push failed: ${error}`, { id: toastId })
      }
    },
    [project.id, project.path]
  )

  return (
    <ProjectContextMenu project={project}>
      <div>
        {/* Project Row */}
        <div
          className={cn(
            'group relative flex cursor-pointer items-center gap-1.5 px-2 py-1.5 transition-colors duration-150',
            isSelected
              ? 'bg-primary/10 text-foreground before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:bg-primary'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
          )}
          onClick={handleClick}
        >
          {/* Avatar - show git provider icon or custom avatar */}
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={project.name}
              className="size-4 shrink-0 rounded object-cover"
              onError={() => setImgErrorKey(project.avatar_path ?? null)}
            />
          ) : project.git_provider === 'github' ? (
            <FaGithub className="size-4 shrink-0 text-muted-foreground" />
          ) : project.git_provider === 'gitlab' ? (
            <FaGitlab className="size-4 shrink-0 text-orange-500" />
          ) : (
            <div className="flex size-4 shrink-0 items-center justify-center rounded bg-muted-foreground/20">
              <span className="text-[10px] font-medium uppercase">
                {project.name[0]}
              </span>
            </div>
          )}

          {/* Name + Chevron */}
          <span className="flex flex-1 items-center gap-0.5 truncate text-sm">
            <span className="truncate">{project.name}</span>
            {hasWorktrees && (
              <button
                className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-50 hover:!opacity-100 hover:bg-accent-foreground/10"
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

          {/* Base branch pull/push indicators (when no base session) */}
          {baseBranchBehindCount > 0 && (
            <button
              onClick={handleBasePull}
              className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
              title={`Pull ${baseBranchBehindCount} commit${baseBranchBehindCount > 1 ? 's' : ''} on ${project.default_branch}`}
            >
              <span className="flex items-center gap-0.5">
                <ArrowDown className="h-3 w-3" />
                {baseBranchBehindCount}
              </span>
            </button>
          )}
          {baseBranchAheadCount > 0 && (
            <button
              onClick={handleBasePush}
              className="shrink-0 rounded bg-orange-500/10 px-1.5 py-0.5 text-[11px] font-medium text-orange-500 transition-colors hover:bg-orange-500/20"
              title={`Push ${baseBranchAheadCount} commit${baseBranchAheadCount > 1 ? 's' : ''} on ${project.default_branch}`}
            >
              <span className="flex items-center gap-0.5">
                <ArrowUp className="h-3 w-3" />
                {baseBranchAheadCount}
              </span>
            </button>
          )}

          {/* Settings */}
          <button
            onClick={e => {
              e.stopPropagation()
              openProjectSettings(project.id)
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded opacity-50 hover:bg-accent-foreground/10 hover:opacity-100"
            title="Project settings"
          >
            <MoreHorizontal className="size-3.5" />
          </button>

          {/* Add Worktree */}
          <button
            onClick={handleAddWorktree}
            className="flex size-4 shrink-0 items-center justify-center rounded opacity-50 hover:bg-accent-foreground/10 hover:opacity-100"
            title="New worktree"
          >
            <Plus className="size-3.5" />
          </button>
        </div>

        {/* Worktrees */}
        {isExpanded && (
          <WorktreeList
            projectId={project.id}
            projectPath={project.path}
            worktrees={worktrees}
            defaultBranch={project.default_branch}
          />
        )}
      </div>
    </ProjectContextMenu>
  )
}
