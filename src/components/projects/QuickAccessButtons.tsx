import { useCallback } from 'react'
import { Terminal, Play, Code, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePreferences } from '@/services/preferences'
import { useTerminalStore } from '@/store/terminal-store'
import {
  useOpenWorktreeInFinder,
  useOpenWorktreeInTerminal,
  useOpenWorktreeInEditor,
  useRunScript,
} from '@/services/projects'
import {
  getEditorLabel,
  getTerminalLabel,
  type QuickAccessAction,
} from '@/types/preferences'
import type { Worktree } from '@/types/projects'

interface QuickAccessButtonsProps {
  worktree: Worktree
  isNarrowSidebar?: boolean
}

// Map action types to their icons
const actionIcons: Record<QuickAccessAction, typeof Terminal> = {
  terminal: Terminal,
  run: Play,
  editor: Code,
  finder: FolderOpen,
  terminal_app: Terminal,
}

export function QuickAccessButtons({
  worktree,
  isNarrowSidebar,
}: QuickAccessButtonsProps) {
  const { data: preferences } = usePreferences()
  const { data: runScript } = useRunScript(worktree.path)
  const openInFinder = useOpenWorktreeInFinder()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInEditor = useOpenWorktreeInEditor()

  const handleAction = useCallback(
    (e: React.MouseEvent, action: QuickAccessAction) => {
      e.stopPropagation() // Prevent worktree selection

      switch (action) {
        case 'terminal':
          useTerminalStore.getState().addTerminal(worktree.id)
          break
        case 'run':
          if (runScript) {
            useTerminalStore.getState().startRun(worktree.id, runScript)
          }
          break
        case 'editor':
          openInEditor.mutate({
            worktreePath: worktree.path,
            editor: preferences?.editor,
          })
          break
        case 'finder':
          openInFinder.mutate(worktree.path)
          break
        case 'terminal_app':
          openInTerminal.mutate({
            worktreePath: worktree.path,
            terminal: preferences?.terminal,
          })
          break
      }
    },
    [
      worktree.id,
      worktree.path,
      runScript,
      preferences?.editor,
      preferences?.terminal,
      openInEditor,
      openInFinder,
      openInTerminal,
    ]
  )

  const getLabel = useCallback(
    (action: QuickAccessAction): string => {
      switch (action) {
        case 'terminal':
          return 'Terminal'
        case 'run':
          return 'Run'
        case 'editor':
          return getEditorLabel(preferences?.editor)
        case 'finder':
          return 'Finder'
        case 'terminal_app':
          return getTerminalLabel(preferences?.terminal)
      }
    },
    [preferences?.editor, preferences?.terminal]
  )

  // Early return if quick access is disabled or sidebar is too narrow
  if (!preferences?.quick_access_enabled || isNarrowSidebar) {
    return null
  }

  const actions = preferences.quick_access_actions ?? ['terminal', 'editor']
  const isCompact = preferences.quick_access_compact ?? false

  // Filter out 'run' if no runScript exists
  const visibleActions = actions.filter(
    action => action !== 'run' || runScript
  ) as QuickAccessAction[]

  if (visibleActions.length === 0) {
    return null
  }

  // Limit to max 4 actions
  const displayActions = visibleActions.slice(0, 4)

  return (
    <div
      className={cn(
        'hidden group-hover:grid gap-1 pl-7 pr-2 pb-1.5',
        'animate-in fade-in slide-in-from-top-1 duration-150',
        // Grid columns based on number of actions
        displayActions.length === 1 && 'grid-cols-1',
        displayActions.length === 2 && 'grid-cols-2',
        displayActions.length === 3 && 'grid-cols-3',
        displayActions.length >= 4 && 'grid-cols-4'
      )}
    >
      {displayActions.map(action => {
        const Icon = actionIcons[action]
        return (
          <button
            key={action}
            type="button"
            onClick={e => handleAction(e, action)}
            title={getLabel(action)}
            className={cn(
              'flex items-center justify-center gap-1 rounded py-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors',
              isCompact ? '' : 'text-[11px]'
            )}
          >
            <Icon className="h-3 w-3 shrink-0" />
            {!isCompact && <span className="truncate">{getLabel(action)}</span>}
          </button>
        )
      })}
    </div>
  )
}
