import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronUp,
  Folder,
  FolderGit2,
  Loader2,
  EyeOff,
  Check,
} from 'lucide-react'
import { toast } from 'sonner'
import { invoke, invokeForServer } from '@/lib/transport'
import type { BrowseDirectoryResult, DirEntry } from '@/types/projects'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'

type DirectoryBrowserMode = 'select' | 'save'

interface DirectoryBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (path: string) => void
  mode: DirectoryBrowserMode
  title?: string
  description?: string
  defaultName?: string
  serverId?: string
}

function buildSavePath(currentPath: string, name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return currentPath
  const separator = currentPath.includes('\\') ? '\\' : '/'
  return `${currentPath.replace(/[\\/]+$/, '')}${separator}${trimmed}`
}

export function DirectoryBrowser({
  open,
  onOpenChange,
  onSelect,
  mode,
  title,
  description,
  defaultName,
  serverId,
}: DirectoryBrowserProps) {
  const [result, setResult] = useState<BrowseDirectoryResult | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [nameInput, setNameInput] = useState(defaultName ?? '')
  const [showHidden, setShowHidden] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setNameInput(defaultName ?? '')
  }, [defaultName, open])

  const loadDirectory = useCallback(
    async (path?: string) => {
      const requestId = ++requestIdRef.current
      setIsLoading(true)

      try {
        const next = serverId
          ? await invokeForServer<BrowseDirectoryResult>(
              serverId,
              'browse_directory',
              { path }
            )
          : await invoke<BrowseDirectoryResult>('browse_directory', { path })
        if (requestId !== requestIdRef.current) return
        setResult(next)
        setPathInput(next.current_path)
      } catch (error) {
        if (requestId !== requestIdRef.current) return
        const message =
          typeof error === 'string'
            ? error
            : error instanceof Error
              ? error.message
              : 'Unknown error occurred'
        toast.error('Failed to browse directory', { description: message })
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false)
        }
      }
    },
    [serverId]
  )

  useEffect(() => {
    if (!open) return
    void loadDirectory()
  }, [loadDirectory, open])

  const visibleEntries = useMemo(
    () =>
      (result?.entries ?? []).filter(entry => showHidden || !entry.is_hidden),
    [result?.entries, showHidden]
  )

  const handleNavigate = useCallback(
    async (path?: string) => {
      await loadDirectory(path)
    },
    [loadDirectory]
  )

  const handleConfirm = useCallback(() => {
    if (!result) return
    if (mode === 'select') {
      onSelect(result.current_path)
      onOpenChange(false)
      return
    }

    const trimmedName = nameInput.trim()
    if (!trimmedName) {
      toast.error('Please enter a folder name.')
      return
    }

    onSelect(buildSavePath(result.current_path, trimmedName))
    onOpenChange(false)
  }, [mode, nameInput, onOpenChange, onSelect, result])

  const primaryLabel =
    mode === 'select' ? 'Select current folder' : 'Choose location'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-auto sm:!max-w-2xl sm:!h-auto sm:!max-h-[85vh] sm:!rounded-lg flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title ?? 'Browse directories'}</DialogTitle>
          <DialogDescription>
            {description ??
              (mode === 'select'
                ? 'Navigate the server filesystem and choose a folder.'
                : 'Choose a parent folder, then enter a name.')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 py-4 pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="directory-browser-path" className="text-xs">
              Current path
            </Label>
            <Input
              id="directory-browser-path"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleNavigate(pathInput.trim() || undefined)
                }
              }}
              disabled={isLoading}
            />
          </div>

          {mode === 'save' && (
            <div className="space-y-1.5">
              <Label htmlFor="directory-browser-name" className="text-xs">
                Folder name
              </Label>
              <Input
                id="directory-browser-name"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleConfirm()
                  }
                }}
                placeholder="my-project"
              />
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={showHidden} onCheckedChange={setShowHidden} />
            <span>Show hidden folders</span>
          </label>

          {mode === 'save' && result && (
            <p className="text-xs text-muted-foreground break-all">
              Will use:{' '}
              <span className="font-mono">
                {buildSavePath(result.current_path, nameInput)}
              </span>
            </p>
          )}

          <div className="rounded-lg border">
            <ScrollArea className="h-60 sm:h-72">
              <div className="p-2">
                {result?.parent_path && (
                  <DirectoryRow
                    entry={{
                      name: '..',
                      path: result.parent_path,
                      is_dir: true,
                      is_git_repo: false,
                      is_hidden: false,
                    }}
                    icon={<ChevronUp className="h-4 w-4" />}
                    onClick={() => void handleNavigate(result.parent_path)}
                  />
                )}

                {isLoading && !result ? (
                  <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading directories...
                  </div>
                ) : visibleEntries.length > 0 ? (
                  visibleEntries.map(entry => (
                    <DirectoryRow
                      key={entry.path}
                      entry={entry}
                      onClick={() => void handleNavigate(entry.path)}
                    />
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                    <EyeOff className="h-4 w-4" />
                    <span>No folders to show.</span>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!result || isLoading}>
            <Check className="h-4 w-4" />
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DirectoryRow({
  entry,
  icon,
  onClick,
}: {
  entry: DirEntry
  icon?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      <span className="text-muted-foreground">
        {icon ??
          (entry.is_git_repo ? (
            <FolderGit2 className="h-4 w-4" />
          ) : (
            <Folder className="h-4 w-4" />
          ))}
      </span>
      <span className="truncate">{entry.name}</span>
    </button>
  )
}
