import { useCallback } from 'react'
import {
  Code,
  Terminal,
  FolderOpen,
  Github,
  ChevronDown,
  Settings,
} from '@/components/icons/reicon'
import { GitLabIcon } from '@/components/icons/GitLabIcon'
import { Button, edgePrimary, raised } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  useOpenWorktreeInEditor,
  useOpenWorktreeInTerminal,
  useOpenWorktreeInFinder,
  useOpenBranchOnGitHub,
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { getOpenInDefaultLabel } from '@/types/preferences'
import { providerLabels, useProjectGitProvider } from '@/services/git-provider'
import {
  canOpenInEditor,
  canOpenInFinder,
  canOpenInTerminal,
} from '@/lib/environment'
import { useUIStore } from '@/store/ui-store'
import type { ProjectServer } from '@/types/projects'
import {
  canOpenServerInFinder,
  openServerIn,
} from '@/components/projects/servers/server-open'

interface OpenInButtonProps {
  worktreeId: string
  worktreePath: string
  serverId?: string
  branch?: string | null
  className?: string
  /** Server project: open its home directory (remote over SSH), no GitHub */
  server?: ProjectServer | null
  /** Plain text style for the window title bar */
  inTitleBar?: boolean
}

export function OpenInButton({
  worktreeId,
  worktreePath,
  serverId,
  branch: worktreeBranch,
  className,
  server,
  inTitleBar = false,
}: OpenInButtonProps) {
  const branch = server ? null : worktreeBranch
  const { data: preferences } = usePreferences()
  const openPreferencesPane = useUIStore(state => state.openPreferencesPane)
  const openInEditor = useOpenWorktreeInEditor()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInFinder = useOpenWorktreeInFinder()
  const openOnGitHub = useOpenBranchOnGitHub()
  const { data: gitProviderInfo } = useProjectGitProvider(
    server ? null : worktreePath,
    { worktreeId }
  )
  const gitProvider = gitProviderInfo?.provider ?? 'github'
  const forgeName = providerLabels(gitProvider).name

  const canFinder =
    canOpenInFinder(serverId) &&
    (!server || canOpenServerInFinder(server, serverId))
  const canEditor = canOpenInEditor()
  const canTerminal = canOpenInTerminal()

  const openAction = useCallback(
    (target: string) => {
      if (server) {
        void openServerIn(
          server,
          target === 'terminal' || target === 'finder' ? target : 'editor',
          { editor: preferences?.editor, terminal: preferences?.terminal },
          serverId
        )
        return
      }
      switch (target) {
        case 'terminal':
          openInTerminal.mutate({
            worktreePath,
            worktreeId,
            terminal: preferences?.terminal,
          })
          break
        case 'finder':
          openInFinder.mutate({ worktreePath, worktreeId })
          break
        case 'github':
          if (branch)
            openOnGitHub.mutate({ repoPath: worktreePath, worktreeId, branch })
          else
            openInEditor.mutate({
              worktreePath,
              worktreeId,
              editor: preferences?.editor,
            })
          break
        default:
          openInEditor.mutate({
            worktreePath,
            worktreeId,
            editor: preferences?.editor,
          })
      }
    },
    [
      openInEditor,
      openInTerminal,
      openInFinder,
      openOnGitHub,
      worktreeId,
      worktreePath,
      branch,
      server,
      serverId,
      preferences?.editor,
      preferences?.terminal,
    ]
  )

  // Prefer the user's default when that target is available on this host.
  const preferred = preferences?.open_in ?? 'editor'
  const effectiveDefault =
    preferred === 'editor' && canEditor
      ? 'editor'
      : preferred === 'terminal' && canTerminal
        ? preferred
        : preferred === 'finder' && canFinder
          ? preferred
          : preferred === 'github' && branch
            ? 'github'
            : canEditor
              ? 'editor'
              : branch
                ? 'github'
                : 'editor'

  const defaultLabel =
    effectiveDefault === 'github'
      ? forgeName
      : getOpenInDefaultLabel(
          effectiveDefault,
          preferences?.editor,
          preferences?.terminal
        )

  const DefaultIcon =
    effectiveDefault === 'github'
      ? gitProvider === 'gitlab'
        ? GitLabIcon
        : Github
      : effectiveDefault === 'terminal'
        ? Terminal
        : effectiveDefault === 'finder'
          ? FolderOpen
          : Code

  if (!canEditor && !canTerminal && !canFinder) return null

  const menuContent = (
    <DropdownMenuContent align="end">
      {canEditor && (
        <DropdownMenuItem onSelect={() => openAction('editor')}>
          <Code className="h-4 w-4" />
          {getOpenInDefaultLabel(
            'editor',
            preferences?.editor,
            preferences?.terminal
          )}
        </DropdownMenuItem>
      )}
      {canTerminal && (
        <DropdownMenuItem onSelect={() => openAction('terminal')}>
          <Terminal className="h-4 w-4" />
          {getOpenInDefaultLabel(
            'terminal',
            preferences?.editor,
            preferences?.terminal
          )}
        </DropdownMenuItem>
      )}
      {canFinder && (
        <DropdownMenuItem onSelect={() => openAction('finder')}>
          <FolderOpen className="h-4 w-4" />
          Finder
        </DropdownMenuItem>
      )}
      {branch && (
        <DropdownMenuItem onSelect={() => openAction('github')}>
          {gitProvider === 'gitlab' ? (
            <GitLabIcon className="h-4 w-4" />
          ) : (
            <Github className="h-4 w-4" />
          )}
          {forgeName}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => openPreferencesPane('general')}>
        <Settings className="h-4 w-4" />
        Change default...
      </DropdownMenuItem>
    </DropdownMenuContent>
  )

  if (inTitleBar) {
    return (
      <div className={cn('flex h-6 items-center', className)}>
        <button
          type="button"
          className="px-1.5 h-full text-xs text-foreground/70 hover:text-foreground"
          onClick={() => openAction(effectiveDefault)}
        >
          Open in {defaultLabel}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-full items-center pr-1 text-foreground/70 hover:text-foreground"
              aria-label="More open options"
            >
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          {menuContent}
        </DropdownMenu>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'hidden h-7 items-center rounded-md border border-primary bg-primary sm:inline-flex dark:border-border/50 dark:bg-muted/50',
        raised,
        edgePrimary,
        'dark:[--btn-edge:color-mix(in_oklab,var(--foreground)_12%,transparent)]',
        className
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            className="h-full gap-1.5 rounded-r-none border-0 px-2 text-xs text-primary-foreground/85 hover:bg-primary-foreground/10 hover:text-primary-foreground dark:text-muted-foreground dark:hover:text-foreground"
            onClick={() => openAction(effectiveDefault)}
            aria-label={`Open in ${defaultLabel}`}
          >
            <DefaultIcon className="size-4 @5xl/header:hidden" />
            <span className="hidden @5xl/header:inline">
              Open in {defaultLabel}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in {defaultLabel}</TooltipContent>
      </Tooltip>
      <div className="h-4 w-px bg-primary-foreground/20 dark:bg-border/50" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-full w-5 rounded-l-none border-0 px-0 text-primary-foreground/85 hover:bg-primary-foreground/10 hover:text-primary-foreground dark:text-muted-foreground dark:hover:text-foreground"
            aria-label="More open options"
          >
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        {menuContent}
      </DropdownMenu>
    </div>
  )
}
