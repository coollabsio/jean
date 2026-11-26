import { useEffect, useRef, useState, type ComponentType } from 'react'
import {
  CircleDot,
  FileText,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Github,
  Heart,
  MessagesSquare,
  Plug,
  Sentry,
  Shield,
  ShieldAlert,
} from '@/components/icons/reicon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  UsageMenuItem,
  useUsageEntries,
} from '@/components/usage/usage-entries'
import { useIsMobile } from '@/hooks/use-mobile'
import { openExternal } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useGitStatus } from '@/services/git-status'
import { usePreferences } from '@/services/preferences'
import { useWorktree } from '@/services/projects'
import { useUIStore } from '@/store/ui-store'
import type { McpServerInfo } from '@/types/chat'
import type {
  AttachedSavedContext,
  LoadedAdvisoryContext,
  LoadedDiscussionContext,
  LoadedIssueContext,
  LoadedPullRequestContext,
  LoadedSecurityAlertContext,
} from '@/types/github'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import type { LoadedLinearIssueContext } from '@/types/linear'
import { isBaseSession } from '@/types/projects'
import type { SentryIssueContext } from '@/types/sentry'

export interface ThreadContextItem {
  key: string
  label: string
  Icon: ComponentType<{ className?: string }>
  iconClassName: string
  onSelect: () => void
}

interface ThreadContextSources {
  issues: LoadedIssueContext[]
  prs: LoadedPullRequestContext[]
  discussions: LoadedDiscussionContext[]
  security: LoadedSecurityAlertContext[]
  advisories: LoadedAdvisoryContext[]
  linear: LoadedLinearIssueContext[]
  sentry: SentryIssueContext[]
  saved: AttachedSavedContext[]
  onViewIssue: (ctx: LoadedIssueContext) => void
  onViewPR: (ctx: LoadedPullRequestContext) => void
  onViewDiscussion: (ctx: LoadedDiscussionContext) => void
  onViewSecurityAlert: (ctx: LoadedSecurityAlertContext) => void
  onViewAdvisory: (ctx: LoadedAdvisoryContext) => void
  onViewLinear: (ctx: LoadedLinearIssueContext) => void
  onViewSentry: (ctx: SentryIssueContext) => void
  onViewSavedContext: (ctx: AttachedSavedContext) => void
}

/** Flattens every context attached to the session into one list. */
// eslint-disable-next-line react-refresh/only-export-components
export function buildThreadContextItems(
  s: ThreadContextSources
): ThreadContextItem[] {
  return [
    ...s.issues.map(ctx => ({
      key: `issue-${ctx.number}`,
      label: `#${ctx.number} ${ctx.title}`,
      Icon: CircleDot,
      iconClassName: 'text-success',
      onSelect: () => s.onViewIssue(ctx),
    })),
    ...s.prs.map(ctx => ({
      key: `pr-${ctx.number}`,
      label: `#${ctx.number} ${ctx.title}`,
      Icon: GitPullRequest,
      iconClassName: 'text-success',
      onSelect: () => s.onViewPR(ctx),
    })),
    ...s.discussions.map(ctx => ({
      key: `discussion-${ctx.number}`,
      label: `#${ctx.number} ${ctx.title}`,
      Icon: MessagesSquare,
      iconClassName: 'text-success',
      onSelect: () => s.onViewDiscussion(ctx),
    })),
    ...s.security.map(ctx => ({
      key: `security-${ctx.number}`,
      label: `#${ctx.number} ${ctx.packageName} (${ctx.severity})`,
      Icon: Shield,
      iconClassName: 'text-warning',
      onSelect: () => s.onViewSecurityAlert(ctx),
    })),
    ...s.advisories.map(ctx => ({
      key: `advisory-${ctx.ghsaId}`,
      label: `${ctx.ghsaId} — ${ctx.summary}`,
      Icon: ShieldAlert,
      iconClassName: 'text-warning',
      onSelect: () => s.onViewAdvisory(ctx),
    })),
    ...s.linear.map(ctx => ({
      key: `linear-${ctx.identifier}`,
      label: `${ctx.identifier} ${ctx.title}`,
      Icon: LinearIcon,
      iconClassName: 'text-violet-600 dark:text-violet-400',
      onSelect: () => s.onViewLinear(ctx),
    })),
    ...s.sentry.map(ctx => ({
      key: `sentry-${ctx.id}`,
      label: `${ctx.shortId} ${ctx.title}`,
      Icon: Sentry,
      iconClassName: 'text-warning',
      onSelect: () => s.onViewSentry(ctx),
    })),
    ...s.saved.map(ctx => ({
      key: `saved-${ctx.slug}`,
      label: ctx.name || ctx.slug,
      Icon: FolderOpen,
      iconClassName: 'text-info',
      onSelect: () => s.onViewSavedContext(ctx),
    })),
  ]
}

interface ThreadDetailsButtonProps {
  worktreeId: string | null
  contexts: ThreadContextItem[]
  availableMcpServers: McpServerInfo[]
  enabledMcpServers: string[]
  onManageContexts: () => void
  /** Called each time the menu opens (e.g. to refresh MCP health). */
  onOpen?: () => void
}

const openDiff = (type: 'uncommitted' | 'branch') =>
  window.dispatchEvent(new CustomEvent('open-git-diff', { detail: { type } }))

function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="ml-auto pl-3 text-xs tabular-nums">
      <span className="text-success">+{added}</span>{' '}
      <span className="text-destructive">−{removed}</span>
    </span>
  )
}

/**
 * Title bar button + menu with the thread details: git state, attached
 * context, MCP servers, and backend usage. Replaces the chat burger menu.
 */
export function ThreadDetailsButton({
  worktreeId,
  contexts,
  availableMcpServers,
  enabledMcpServers,
  onManageContexts,
  onOpen,
}: ThreadDetailsButtonProps) {
  const isMobile = useIsMobile()
  const { data: preferences } = usePreferences()
  const [open, setOpen] = useState(false)

  const { data: worktree } = useWorktree(worktreeId)
  const { data: gitStatus } = useGitStatus(worktreeId)
  const usageEntries = useUsageEntries(open)

  useEffect(() => {
    const handler = () => setOpen(prev => !prev)
    window.addEventListener('toggle-quick-menu', handler)
    return () => window.removeEventListener('toggle-quick-menu', handler)
  }, [])

  // Ref: `onOpen` may change identity on every render (query results)
  const onOpenRef = useRef(onOpen)
  useEffect(() => {
    onOpenRef.current = onOpen
  })
  useEffect(() => {
    if (open) onOpenRef.current?.()
  }, [open])

  const isBase = worktree ? isBaseSession(worktree) : false
  const branch = gitStatus?.current_branch || worktree?.branch
  const uncommittedAdded =
    gitStatus?.uncommitted_added ?? worktree?.cached_uncommitted_added ?? 0
  const uncommittedRemoved =
    gitStatus?.uncommitted_removed ?? worktree?.cached_uncommitted_removed ?? 0
  const branchAdded = isBase
    ? 0
    : (gitStatus?.branch_diff_added ?? worktree?.cached_branch_diff_added ?? 0)
  const branchRemoved = isBase
    ? 0
    : (gitStatus?.branch_diff_removed ??
      worktree?.cached_branch_diff_removed ??
      0)
  const hasUncommitted = uncommittedAdded > 0 || uncommittedRemoved > 0
  const hasBranchDiff = branchAdded > 0 || branchRemoved > 0
  const ahead = gitStatus?.ahead_count ?? 0
  const behind = gitStatus?.behind_count ?? 0

  const enabledKeys = new Set(enabledMcpServers)
  const activeMcpServers = availableMcpServers.filter(
    server =>
      !server.disabled &&
      (enabledKeys.has(`${server.backend || 'claude'}:${server.name}`) ||
        enabledKeys.has(server.name))
  )

  const menuShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_quick_menu ??
      DEFAULT_KEYBINDINGS.open_quick_menu) as string
  )

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Thread details"
              data-testid="thread-details-button"
              className={cn(
                'rounded-none text-foreground/70 hover:text-foreground',
                open && 'bg-muted/50 text-foreground'
              )}
            >
              <FileText className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          Thread details
          {!isMobile && (
            <kbd className="ml-1 text-[0.625rem] opacity-60">
              {menuShortcut}
            </kbd>
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-80 max-h-[min(80vh,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto"
      >
        {worktree && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Git
            </DropdownMenuLabel>
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{branch ?? 'Detached HEAD'}</span>
              {(ahead > 0 || behind > 0) && (
                <span className="ml-auto pl-3 text-xs tabular-nums text-muted-foreground">
                  {ahead > 0 && `↑${ahead}`}
                  {ahead > 0 && behind > 0 && ' '}
                  {behind > 0 && `↓${behind}`}
                </span>
              )}
            </div>
            {hasUncommitted && (
              <DropdownMenuItem onClick={() => openDiff('uncommitted')}>
                <span className="text-muted-foreground">Uncommitted</span>
                <DiffCounts
                  added={uncommittedAdded}
                  removed={uncommittedRemoved}
                />
              </DropdownMenuItem>
            )}
            {!isBase && hasBranchDiff && (
              <DropdownMenuItem onClick={() => openDiff('branch')}>
                <span className="truncate text-muted-foreground">
                  vs {gitStatus?.base_branch || 'base'}
                </span>
                <DiffCounts added={branchAdded} removed={branchRemoved} />
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Context
        </DropdownMenuLabel>
        {contexts.map(({ key, label, Icon, iconClassName, onSelect }) => (
          <DropdownMenuItem key={key} onClick={onSelect}>
            <Icon className={cn('h-4 w-4 shrink-0', iconClassName)} />
            <span className="truncate">{label}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={onManageContexts}>
          <FolderOpen className="h-4 w-4" />
          {contexts.length > 0 ? 'Manage Contexts...' : 'Attach Context...'}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        {!isMobile && (
          <DropdownMenuItem
            onClick={() =>
              useUIStore.getState().openPreferencesPane('mcp-servers')
            }
          >
            <Plug
              className={cn(
                'h-4 w-4',
                activeMcpServers.length > 0 && 'text-success'
              )}
            />
            MCP Servers
            <DropdownMenuShortcut>
              {activeMcpServers.length}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {isMobile && (
          <>
            <DropdownMenuItem
              onClick={() => openExternal('https://github.com/coollabsio/jean')}
            >
              <Github className="h-4 w-4" />
              Jean on GitHub
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => openExternal('https://jean.build/sponsorships/')}
            >
              <Heart className="h-4 w-4" />
              Sponsor Jean
            </DropdownMenuItem>
          </>
        )}

        {usageEntries.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {usageEntries.map(entry => (
              <UsageMenuItem key={entry.id} entry={entry} />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
