import type React from 'react'
import { toast } from 'sonner'
import { GitBranchPlus, Wand2 } from '@/components/icons/reicon'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { useIsMobile } from '@/hooks/use-mobile'
import { isNativeApp } from '@/lib/environment'
import { githubLinkRepoArg, type GitHubItemLink } from '@/lib/github-item-link'
import { getCurrentWorktree } from '@/lib/local-file'
import { getModifierSymbol } from '@/lib/platform'
import { fetchIssueContext, fetchPullRequestContext } from '@/services/github'
import {
  useCreateWorktree,
  useGitHubRemotes,
  useWorktree,
} from '@/services/projects'
import { useUIStore } from '@/store/ui-store'

/**
 * "Open / Investigate in new worktree" items for a GitHub issue or PR link.
 * Mounted only while the menu is open. Shown only when the link belongs to a
 * GitHub remote of the current worktree's project. Cmd/Ctrl+click creates the
 * worktree in the background.
 */
export function GitHubLinkMenuItems({ link }: { link: GitHubItemLink }) {
  const isMobile = useIsMobile()
  const worktreeId = getCurrentWorktree().id
  const { data: worktree } = useWorktree(worktreeId)
  const { data: remotes } = useGitHubRemotes(
    worktree?.path ?? null,
    { worktreeId: worktreeId ?? '' },
    Boolean(worktreeId && worktree)
  )
  const createWorktree = useCreateWorktree()

  if (!worktree || !remotes) return null
  const repo = githubLinkRepoArg(link, remotes)
  if (repo === null) return null

  const label = `${link.kind === 'pr' ? 'PR' : 'Issue'} #${link.number}`

  const run = async (investigate: boolean, background: boolean) => {
    const { path, project_id: projectId } = worktree
    const toastId = toast.loading(`Fetching ${label}…`)
    try {
      const item = { number: link.number, repo }
      const context =
        link.kind === 'pr'
          ? { prContext: await fetchPullRequestContext(path, projectId, item) }
          : { issueContext: await fetchIssueContext(path, projectId, item) }
      toast.dismiss(toastId)
      const ui = useUIStore.getState()
      if (background) ui.incrementPendingBackgroundCreations()
      const created = await createWorktree.mutateAsync({
        projectId,
        ...context,
        background,
      })
      if (!investigate) return
      if (link.kind === 'pr') ui.markWorktreeForAutoInvestigatePR(created.id)
      else ui.markWorktreeForAutoInvestigate(created.id)
    } catch (error) {
      toast.error(`Failed to open ${label}: ${error}`, { id: toastId })
    }
  }

  const handleClick = (investigate: boolean) => (event: React.MouseEvent) => {
    void run(investigate, event.metaKey || event.ctrlKey)
  }

  return (
    <>
      <ContextMenuItem onClick={handleClick(false)}>
        <GitBranchPlus className="h-4 w-4" />
        Open in new worktree
      </ContextMenuItem>
      <ContextMenuItem onClick={handleClick(true)}>
        <Wand2 className="h-4 w-4" />
        Investigate in new worktree
      </ContextMenuItem>
      {isNativeApp() && !isMobile && (
        <div className="px-2 pb-1 text-xs text-muted-foreground">
          {getModifierSymbol()}+click to run in background
        </div>
      )}
      <ContextMenuSeparator />
    </>
  )
}
