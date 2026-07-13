import { Play, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePackageScripts, type PackageScript } from '@/services/projects'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import { cn } from '@/lib/utils'

interface ScriptsButtonProps {
  projectId?: string
  worktreePath: string
  onRun: (script: PackageScript) => void
}

export function ScriptsButton({
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
      ? favoriteKeys
          .filter(key => key.startsWith(favoritePrefix))
          .map(key => key.slice(favoritePrefix.length))
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

  if (scripts.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 border border-border/50 bg-muted/50 px-2 text-xs text-muted-foreground hover:text-foreground"
          aria-label="Scripts"
        >
          <Play className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Scripts</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {sortedScripts.map(script => (
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
                      'fill-yellow-500 text-yellow-500'
                  )}
                />
              </button>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
