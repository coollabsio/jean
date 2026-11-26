import { useEffect, useState } from 'react'
import { ChevronDown, Play, Star } from '@/components/icons/reicon'
import { Button, raisedToolbar } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePackageScripts, type PackageScript } from '@/services/projects'
import type { GitRepoOwner } from '@/services/git-status'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'

interface ScriptsButtonProps {
  projectId?: string
  /** Worktree or project that owns `worktreePath` */
  owner: GitRepoOwner
  worktreePath: string
  onRun: (script: PackageScript) => void
}

interface ScriptsButtonOwnProps extends ScriptsButtonProps {
  /** Plain text style for the window title bar */
  inTitleBar?: boolean
}

function ScriptMenuItems({
  projectId,
  owner,
  worktreePath,
  onRun,
}: ScriptsButtonProps) {
  const { data: scripts = [] } = usePackageScripts(worktreePath, owner)
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const favoriteKeys = preferences?.favorite_package_scripts ?? []
  const favoritePrefix = projectId ? `${projectId}:` : null
  const favoriteScriptNames = new Set(
    favoritePrefix
      ? favoriteKeys.flatMap(key =>
          key.startsWith(favoritePrefix)
            ? [key.slice(favoritePrefix.length)]
            : []
        )
      : []
  )
  const sortedScripts = [...scripts].sort(
    (a, b) =>
      Number(favoriteScriptNames.has(b.name)) -
      Number(favoriteScriptNames.has(a.name))
  )

  const toggleFavorite = (scriptName: string) => {
    if (!projectId) return
    const key = `${projectId}:${scriptName}`
    patchPreferences.mutate({
      favorite_package_scripts: favoriteKeys.includes(key)
        ? favoriteKeys.filter(favorite => favorite !== key)
        : [...favoriteKeys, key],
    })
  }

  return sortedScripts.map(script => (
    <DropdownMenuItem
      key={script.name}
      aria-label={script.name}
      onSelect={() => onRun(script)}
    >
      <Play className="h-3.5 w-3.5" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        {script.name}
      </span>
      {projectId && (
        <button
          type="button"
          className="-my-1 -mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${favoriteScriptNames.has(script.name) ? 'Unfavorite' : 'Favorite'} ${script.name}`}
          aria-pressed={favoriteScriptNames.has(script.name)}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            toggleFavorite(script.name)
          }}
        >
          <Star
            className={cn(
              'h-3.5 w-3.5',
              favoriteScriptNames.has(script.name) &&
                'fill-warning text-warning'
            )}
          />
        </button>
      )}
    </DropdownMenuItem>
  ))
}

export function ScriptsButton({
  inTitleBar = false,
  ...props
}: ScriptsButtonOwnProps) {
  const { data: scripts = [], isLoading } = usePackageScripts(
    props.worktreePath,
    props.owner
  )
  const [open, setOpen] = useState(false)
  const menuRequested = useUIStore(state => state.scriptsMenuRequested)
  const hasScripts = scripts.length > 0

  // The open_scripts_menu shortcut opens the menu; arrow keys and Enter then
  // pick a script through the dropdown's own keyboard navigation.
  useEffect(() => {
    if (!menuRequested || isLoading) return
    useUIStore.getState().clearScriptsMenuRequest()
    if (hasScripts) setOpen(true)
  }, [menuRequested, isLoading, hasScripts])

  if (!hasScripts) return null

  const menuContent = (
    <DropdownMenuContent align="end" className="min-w-48">
      <ScriptMenuItems {...props} />
    </DropdownMenuContent>
  )

  if (inTitleBar) {
    return (
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-6 items-center gap-1 px-1.5 text-xs text-foreground/70 hover:text-foreground"
            aria-label="Scripts"
          >
            Scripts
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        {menuContent}
      </DropdownMenu>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={raisedToolbar}
              aria-label="Scripts"
            >
              <Play className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Scripts (package.json)</TooltipContent>
      </Tooltip>
      {menuContent}
    </DropdownMenu>
  )
}

/** The same script list as a submenu, for hosting inside another menu. */
export function ScriptsSubmenu(props: ScriptsButtonProps) {
  const { data: scripts = [] } = usePackageScripts(
    props.worktreePath,
    props.owner
  )
  if (scripts.length === 0) return null

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <Play className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1">Scripts</span>
        <span className="ml-3 text-2xs text-muted-foreground">
          package.json
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-48">
        <ScriptMenuItems {...props} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
