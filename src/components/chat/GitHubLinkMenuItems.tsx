import type React from 'react'
import { toast } from 'sonner'
import {
  ExternalLink,
  GitBranchPlus,
  MessageSquarePlus,
  Wand2,
} from '@/components/icons/reicon'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { useIsMobile } from '@/hooks/use-mobile'
import { isNativeApp } from '@/lib/environment'
import { githubLinkRepoArg, type GitHubItemLink } from '@/lib/github-item-link'
import { getCurrentWorktree } from '@/lib/local-file'
import { getModifierSymbol, openExternal } from '@/lib/platform'
import { fetchIssueContext, fetchPullRequestContext } from '@/services/github'
import { usePreferences } from '@/services/preferences'
import {
  useCreateWorktree,
  useGitHubRemotes,
  useWorktree,
} from '@/services/projects'
import { useUIStore } from '@/store/ui-store'
import type { GitHubIssue, GitHubPullRequest } from '@/types/github'
import { investigateInNewSession } from './context-mention-investigation'

/**
 * Menu items for a GitHub issue or PR link: open it on the web, and (when the
 * link belongs to a GitHub remote of the current worktree's project)
 * investigate it in a new session or open/investigate it in a new worktree.
 * Mounted only while the menu is open. Cmd/Ctrl+click runs in the background.
 */
export function GitHubLinkMenuItems({
  link,
  url,
}: {
  link: GitHubItemLink
  url: string
}) {
  const isMobile = useIsMobile()
  const worktreeId = getCurrentWorktree().id
  const { data: worktree } = useWorktree(worktreeId)
  const { data: remotes } = useGitHubRemotes(
    worktree?.path ?? null,
    { worktreeId: worktreeId ?? '' },
    Boolean(worktreeId && worktree)
  )
  const { data: preferences } = usePreferences()
  const createWorktree = useCreateWorktree()

  const repo = worktree && remotes ? githubLinkRepoArg(link, remotes) : null
  const label = `${link.kind === 'pr' ? 'PR' : 'Issue'} #${link.number}`

  const openOnWeb = (
    <ContextMenuItem
      onSelect={() => {
        void openExternal(url).catch(error =>
          toast.error(`Failed to open link: ${error}`)
        )
      }}
    >
      <ExternalLink className="h-4 w-4" />
      Open on web
    </ContextMenuItem>
  )

  if (!worktree || repo === null) {
    return (
      <>
        {openOnWeb}
        <ContextMenuSeparator />
      </>
    )
  }

  const runInWorktree = async (investigate: boolean, background: boolean) => {
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

  // Session context loads from the primary remote only, the same as the
  // new session context menu.
  const runInSession = async (background: boolean) => {
    const toastId = toast.loading(`Starting investigation of ${label}…`)
    try {
      const ref = { number: link.number }
      await investigateInNewSession({
        items: [
          {
            id: `${link.kind}-${link.number}`,
            type: link.kind,
            label: `#${link.number}`,
            title: label,
            ...(link.kind === 'pr'
              ? { pr: ref as GitHubPullRequest }
              : { issue: ref as GitHubIssue }),
          },
        ],
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        projectId: worktree.project_id,
        templates: {
          issue: preferences?.magic_prompts?.investigate_issue,
          pr: preferences?.magic_prompts?.investigate_pr,
        },
        openSession: !background,
      })
      toast.success(`Started investigation of ${label}`, { id: toastId })
    } catch (error) {
      toast.error(`Failed to investigate ${label}: ${error}`, { id: toastId })
    }
  }

  const isBackground = (event: React.MouseEvent) =>
    event.metaKey || event.ctrlKey

  return (
    <>
      {openOnWeb}
      {repo === undefined && (
        <ContextMenuItem
          onClick={event => void runInSession(isBackground(event))}
        >
          <MessageSquarePlus className="h-4 w-4" />
          Investigate in new session
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onClick={event => void runInWorktree(true, isBackground(event))}
      >
        <Wand2 className="h-4 w-4" />
        Investigate in new worktree
      </ContextMenuItem>
      <ContextMenuItem
        onClick={event => void runInWorktree(false, isBackground(event))}
      >
        <GitBranchPlus className="h-4 w-4" />
        Open in new worktree
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
