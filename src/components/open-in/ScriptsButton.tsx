import { Play, Star } from '@/components/icons/reicon'
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
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ScriptsButtonProps {
  projectId?: string
  worktreePath: string
  onRun: (script: PackageScript) => void
}

function ScriptMenuItems({
  projectId,
  worktreePath,
  onRun,
}: ScriptsButtonProps) {
  const { data: scripts = [] } = usePackageScripts(worktreePath)
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

export function ScriptsButton(props: ScriptsButtonProps) {
  const { data: scripts = [] } = usePackageScripts(props.worktreePath)
  if (scripts.length === 0) return null

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={raisedToolbar}
              aria-label="Scripts"
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Scripts</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-48">
        <ScriptMenuItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The same script list as a submenu, for hosting inside another menu. */
export function ScriptsSubmenu(props: ScriptsButtonProps) {
  const { data: scripts = [] } = usePackageScripts(props.worktreePath)
  if (scripts.length === 0) return null

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <Play className="h-4 w-4 text-muted-foreground" />
        Scripts
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-48">
        <ScriptMenuItems {...props} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
