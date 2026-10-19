import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { DirectoryBrowser } from '@/components/projects/DirectoryBrowser'
import { shouldUseDirectoryBrowser } from '@/components/projects/project-dialog-routing'
import { isLocalBackend, isNativeApp } from '@/lib/environment'
import {
  existingWorktreeImportBlock,
  IMPORT_EXISTING_WORKTREE_EVENT,
  type ImportExistingWorktreeDetail,
} from '@/lib/import-existing-worktree'
import { isClientMacOS } from '@/lib/platform'
import { parseServerResourceKey } from '@/lib/server-resource'
import {
  unmanagedWorktreesQueryKey,
  useImportWorktree,
  useUnmanagedWorktrees,
} from '@/services/projects'
import { useQueryClient } from '@tanstack/react-query'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import type { BlockedImportPath, UnmanagedWorktree } from '@/types/projects'

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function manualRow(path: string): UnmanagedWorktree {
  return {
    path,
    branch: null,
    head: '',
    headShort: '',
    prunable: false,
    locked: false,
    detached: false,
    bare: false,
  }
}

function branchLabel(worktree: UnmanagedWorktree): string {
  if (worktree.branch) return worktree.branch
  if (worktree.detached) return 'detached HEAD'
  if (worktree.bare) return 'bare'
  return 'no branch'
}

function statusLabel(worktree: UnmanagedWorktree, manual: boolean): string {
  if (manual) return 'Entered path'
  const bits = [branchLabel(worktree), worktree.headShort || 'no HEAD']
  if (worktree.locked) bits.push('locked')
  if (worktree.prunable) bits.push('prunable')
  if (worktree.bare && worktree.branch) bits.push('bare')
  if (worktree.detached && worktree.branch) bits.push('detached')
  return bits.join(' · ')
}

export function ImportExistingWorktreeDialog() {
  const queryClient = useQueryClient()
  const importWorktree = useImportWorktree()
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [manualRows, setManualRows] = useState<UnmanagedWorktree[]>([])
  const [manualPath, setManualPath] = useState('')
  const [browserOpen, setBrowserOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pathError, setPathError] = useState<string | null>(null)

  const native = isNativeApp()
  const serverId =
    (projectId && parseServerResourceKey(projectId)?.serverId) ||
    LOCAL_SERVER_ID

  const { data, isLoading, isError, error, refetch, isFetching } =
    useUnmanagedWorktrees(projectId, open)
  const blockedPaths: BlockedImportPath[] = data?.blockedPaths ?? []

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ImportExistingWorktreeDetail>).detail
      if (!detail?.projectId) return
      setProjectId(detail.projectId)
      setSelected(new Set())
      setManualRows([])
      setManualPath('')
      setPathError(null)
      setBrowserOpen(false)
      setOpen(true)
    }

    window.addEventListener(IMPORT_EXISTING_WORKTREE_EVENT, handler)
    return () =>
      window.removeEventListener(IMPORT_EXISTING_WORKTREE_EVENT, handler)
  }, [])

  const manualPaths = useMemo(
    () => new Set(manualRows.map(row => row.path)),
    [manualRows]
  )

  const rows = useMemo(() => {
    const discovered = data?.worktrees ?? []
    const known = new Set(discovered.map(worktree => worktree.path))
    return [...discovered, ...manualRows.filter(row => !known.has(row.path))]
  }, [data, manualRows])

  const selectableRows = useMemo(
    () => rows.filter(row => !row.prunable),
    [rows]
  )

  const addPath = useCallback(
    (path: string) => {
      const trimmed = path.trim()
      if (!trimmed) return
      const blocked = existingWorktreeImportBlock(trimmed, blockedPaths)
      if (blocked) {
        setPathError(blocked)
        return
      }
      setPathError(null)
      setManualRows(current => {
        if (current.some(row => row.path === trimmed)) return current
        return [...current, manualRow(trimmed)]
      })
      setSelected(current => {
        if (current.has(trimmed)) return current
        const next = new Set(current)
        next.add(trimmed)
        return next
      })
      setManualPath('')
    },
    [blockedPaths]
  )

  const toggle = useCallback((path: string, checked: boolean) => {
    setSelected(current => {
      const has = current.has(path)
      if (checked === has) return current
      const next = new Set(current)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const handleBrowse = useCallback(async () => {
    if (
      shouldUseDirectoryBrowser({
        isLocalBackend: isLocalBackend(),
        isClientMacOS,
        isLocalTarget: serverId === LOCAL_SERVER_ID,
      })
    ) {
      setBrowserOpen(true)
      return
    }

    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog')
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: 'Select a git worktree',
      })
      if (typeof picked === 'string' && picked) addPath(picked)
    } catch (browseError) {
      if (
        browseError instanceof Error &&
        browseError.message.toLowerCase().includes('cancel')
      ) {
        return
      }
    }
  }, [addPath, serverId])

  const handleImport = useCallback(async () => {
    if (!projectId || selected.size === 0 || importing) return
    const paths = [...selected].filter(path => {
      const row = rows.find(candidate => candidate.path === path)
      return !row?.prunable
    })
    if (paths.length === 0) return
    setImporting(true)
    const failed = new Set<string>()
    try {
      for (const path of paths) {
        const blocked = existingWorktreeImportBlock(path, blockedPaths)
        if (blocked) {
          failed.add(path)
          setPathError(blocked)
          continue
        }
        try {
          await importWorktree.mutateAsync({ projectId, path })
        } catch {
          failed.add(path)
        }
      }
    } finally {
      setImporting(false)
    }

    setManualRows(current => current.filter(row => failed.has(row.path)))
    setSelected(failed)
    await queryClient.invalidateQueries({
      queryKey: unmanagedWorktreesQueryKey(projectId),
    })
    if (failed.size === 0) setOpen(false)
  }, [
    blockedPaths,
    importWorktree,
    importing,
    projectId,
    queryClient,
    rows,
    selected,
  ])

  const allSelected =
    selectableRows.length > 0 &&
    selectableRows.every(row => selected.has(row.path))

  const importPaths = [...selected].filter(path => {
    const row = rows.find(candidate => candidate.path === path)
    return !row?.prunable && !existingWorktreeImportBlock(path, blockedPaths)
  })

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={next => {
          if (!importing) setOpen(next)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import existing worktree</DialogTitle>
            <DialogDescription>
              Choose git worktrees that already exist for this project. Nothing
              is imported until you confirm.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-24 flex-col gap-3">
            {isError && (
              <div
                role="alert"
                className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                <span>{errorText(error)}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void refetch()}
                >
                  Retry
                </Button>
              </div>
            )}

            {isLoading || (isFetching && rows.length === 0 && !isError) ? (
              <div className="flex items-center justify-center py-6">
                <Spinner />
              </div>
            ) : rows.length === 0 && !isError ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No unmanaged worktrees found for this project.
              </p>
            ) : (
              rows.length > 0 && (
                <div className="flex flex-col gap-2">
                  {selectableRows.length > 0 && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setSelected(
                            allSelected
                              ? new Set()
                              : new Set(selectableRows.map(row => row.path))
                          )
                        }
                      >
                        {allSelected ? 'Clear' : 'Select all'}
                      </button>
                    </div>
                  )}
                  <ul className="max-h-64 space-y-1 overflow-y-auto">
                    {rows.map(worktree => {
                      const checked = selected.has(worktree.path)
                      const disabled = worktree.prunable
                      return (
                        <li key={worktree.path}>
                          <label
                            className={`flex items-start gap-3 rounded-md px-2 py-2 ${
                              disabled
                                ? 'cursor-not-allowed opacity-60'
                                : 'cursor-pointer hover:bg-muted/50'
                            }`}
                          >
                            <Checkbox
                              className="mt-0.5"
                              checked={checked}
                              disabled={disabled}
                              onCheckedChange={value => {
                                if (disabled) return
                                toggle(worktree.path, value === true)
                              }}
                              aria-label={`Import ${worktree.path}`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-mono text-xs">
                                {worktree.path}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {statusLabel(
                                  worktree,
                                  manualPaths.has(worktree.path)
                                )}
                              </span>
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            )}

            {pathError && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {pathError}
              </div>
            )}

            {!native && (
              <form
                className="flex gap-2"
                onSubmit={event => {
                  event.preventDefault()
                  addPath(manualPath)
                }}
              >
                <Input
                  value={manualPath}
                  onChange={event => {
                    setManualPath(event.target.value)
                    setPathError(null)
                  }}
                  placeholder="/path/to/existing/worktree"
                  aria-label="Worktree path"
                  disabled={importing}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={importing || !manualPath.trim()}
                >
                  Add
                </Button>
              </form>
            )}
          </div>

          <DialogFooter>
            {native && (
              <Button
                type="button"
                variant="outline"
                className="sm:mr-auto"
                onClick={() => void handleBrowse()}
                disabled={importing}
              >
                <FolderOpen />
                Browse...
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleImport()}
              disabled={importing || importPaths.length === 0}
            >
              {importing && <Spinner />}
              Import{importPaths.length > 0 ? ` (${importPaths.length})` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {native && (
        <DirectoryBrowser
          open={browserOpen}
          onOpenChange={setBrowserOpen}
          onSelect={addPath}
          mode="select"
          title="Select worktree folder"
          description="Choose an existing git worktree directory."
          serverId={serverId === LOCAL_SERVER_ID ? undefined : serverId}
        />
      )}
    </>
  )
}
