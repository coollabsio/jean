import { useCallback } from 'react'
import { Code, Terminal, FolderOpen, Github, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { isNativeApp } from '@/lib/environment'

interface OpenInButtonProps {
  worktreePath: string
  branch?: string | null
  className?: string
}

export function OpenInButton({
  worktreePath,
  branch,
  className,
}: OpenInButtonProps) {
  const { data: preferences } = usePreferences()
  const openInEditor = useOpenWorktreeInEditor()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInFinder = useOpenWorktreeInFinder()
  const openOnGitHub = useOpenBranchOnGitHub()

  const openAction = useCallback(
    (target: string) => {
      switch (target) {
        case 'terminal':
          openInTerminal.mutate({
            worktreePath,
            terminal: preferences?.terminal,
          })
          break
        case 'finder':
          openInFinder.mutate(worktreePath)
          break
        case 'github':
          if (branch) openOnGitHub.mutate({ repoPath: worktreePath, branch })
          else
            openInEditor.mutate({ worktreePath, editor: preferences?.editor })
          break
        default:
          openInEditor.mutate({ worktreePath, editor: preferences?.editor })
      }
    },
    [
      openInEditor,
      openInTerminal,
      openInFinder,
      openOnGitHub,
      worktreePath,
      branch,
      preferences?.editor,
      preferences?.terminal,
    ]
  )

  const defaultLabel = getOpenInDefaultLabel(
    preferences?.open_in ?? 'editor',
    preferences?.editor,
    preferences?.terminal
  )

  if (!isNativeApp()) return null

  return (
    <div
      className={`hidden items-center rounded-md border border-border/50 bg-muted/50 sm:inline-flex ${className ?? ''}`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            className="h-7 rounded-r-none border-0 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => openAction(preferences?.open_in ?? 'editor')}
          >
            Open in {defaultLabel}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in {defaultLabel}</TooltipContent>
      </Tooltip>
      <div className="h-4 w-px bg-border/50" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-6 rounded-l-none border-0 px-0 text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openAction('editor')}>
            <Code className="h-4 w-4" />
            {getOpenInDefaultLabel(
              'editor',
              preferences?.editor,
              preferences?.terminal
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openAction('terminal')}>
            <Terminal className="h-4 w-4" />
            {getOpenInDefaultLabel(
              'terminal',
              preferences?.editor,
              preferences?.terminal
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openAction('finder')}>
            <FolderOpen className="h-4 w-4" />
            Finder
          </DropdownMenuItem>
          {branch && (
            <DropdownMenuItem onSelect={() => openAction('github')}>
              <Github className="h-4 w-4" />
              GitHub
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
