import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileIcon, FolderIcon } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { useWorktreeFiles, fileQueryKeys } from '@/services/files'
import type { WorktreeFile, PendingFile } from '@/types/chat'
import { useProjects } from '@/services/projects'
import { isFolder } from '@/types/projects'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/uuid'
import { getExtensionColor } from '@/lib/file-colors'
import { fuzzySearchFiles } from '@/lib/fuzzy-search'

export interface FileMentionPopoverHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: () => void
  selectPreviousScope: () => void
  selectNextScope: () => void
}

interface FileMentionPopoverProps {
  /** Worktree path for file listing */
  worktreePath: string | null
  /** Current project ID, used to show linked projects as selectable scopes */
  currentProjectId?: string | null
  /** Whether the popover is open */
  open: boolean
  /** Callback when popover should close */
  onOpenChange: (open: boolean) => void
  /** Callback when a file is selected */
  onSelectFile: (file: PendingFile) => void
  /** Current search query (text after @) */
  searchQuery: string
  /** Position for the anchor (relative to textarea container) */
  anchorPosition: { top: number; left: number } | null
  /** Width of the container (textarea) for popover sizing */
  containerWidth?: number
  /** Ref to expose navigation methods to parent */
  handleRef?: React.RefObject<FileMentionPopoverHandle | null>
}

interface FileMentionScope {
  id: string
  name: string
  rootPath: string
  isCurrent: boolean
}

export function FileMentionPopover({
  worktreePath,
  currentProjectId,
  open,
  onOpenChange,
  onSelectFile,
  searchQuery,
  anchorPosition,
  containerWidth,
  handleRef,
}: FileMentionPopoverProps) {
  const queryClient = useQueryClient()
  const { data: projects = [] } = useProjects()
  const [selectedRootPath, setSelectedRootPath] = useState<string | null>(
    worktreePath
  )
  const { data: files = [] } = useWorktreeFiles(selectedRootPath)
  const listRef = useRef<HTMLDivElement>(null)
  const scopeListRef = useRef<HTMLDivElement>(null)
  // File row index only. Project scopes live outside the command list so
  // 3+ linked projects never push file results out of view.
  const [selectedIndex, setSelectedIndex] = useState(0)

  const currentProject = useMemo(
    () => projects.find(p => p.id === currentProjectId) ?? null,
    [projects, currentProjectId]
  )

  const scopes = useMemo<FileMentionScope[]>(() => {
    const currentScopes: FileMentionScope[] = worktreePath
      ? [
          {
            id: currentProject?.id ?? 'current',
            name: currentProject?.name ?? 'Current worktree',
            rootPath: worktreePath,
            isCurrent: true,
          },
        ]
      : []

    const linkedIds = new Set(currentProject?.linked_project_ids ?? [])
    const linkedScopes = projects.flatMap(p =>
      linkedIds.has(p.id) && !isFolder(p) && p.path
        ? [
            {
              id: p.id,
              name: p.name,
              rootPath: p.path,
              isCurrent: false,
            },
          ]
        : []
    )

    return [...currentScopes, ...linkedScopes]
  }, [currentProject, projects, worktreePath])

  const selectedScope = useMemo(
    () => scopes.find(scope => scope.rootPath === selectedRootPath) ?? null,
    [scopes, selectedRootPath]
  )

  const selectedScopeIndex = useMemo(
    () => scopes.findIndex(scope => scope.rootPath === selectedRootPath),
    [scopes, selectedRootPath]
  )

  // On open, reset scope and invalidate so newly added files appear.
  // Invalidate in the same place we set selectedRootPath to avoid effect chains.
  useEffect(() => {
    if (!open) return
    setSelectedRootPath(worktreePath)
    setSelectedIndex(0)
    if (worktreePath) {
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.worktreeFiles(worktreePath),
      })
    }
  }, [open, worktreePath, queryClient])

  // Filter files based on search query (fuzzy match)
  const filteredFiles = useMemo(
    () => fuzzySearchFiles(files, searchQuery, 15),
    [files, searchQuery]
  )

  // Clamp selectedIndex to valid range (handles case when filter reduces results)
  const clampedSelectedIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredFiles.length - 1)
  )

  const handleScopeSelect = useCallback(
    (scope: FileMentionScope) => {
      setSelectedRootPath(scope.rootPath)
      setSelectedIndex(0)
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.worktreeFiles(scope.rootPath),
      })
    },
    [queryClient]
  )

  const handleScopeCycle = useCallback(
    (direction: -1 | 1) => {
      if (scopes.length === 0) return

      const currentIndex = selectedScopeIndex >= 0 ? selectedScopeIndex : 0
      const nextIndex =
        (currentIndex + direction + scopes.length) % scopes.length
      const nextScope = scopes[nextIndex]
      if (nextScope) handleScopeSelect(nextScope)
    },
    [handleScopeSelect, scopes, selectedScopeIndex]
  )

  const handleSelect = useCallback(
    (file: WorktreeFile) => {
      const pendingFile: PendingFile = {
        id: generateId(),
        relativePath: file.relative_path,
        extension: file.extension,
        isDirectory: file.is_dir,
        ...(selectedScope && !selectedScope.isCurrent
          ? {
              sourceRootPath: selectedScope.rootPath,
              sourceProjectId: selectedScope.id,
              sourceProjectName: selectedScope.name,
            }
          : {}),
      }
      onSelectFile(pendingFile)
      onOpenChange(false)
    },
    [onSelectFile, onOpenChange, selectedScope]
  )

  // Expose navigation methods via ref for parent to call
  useImperativeHandle(handleRef, () => {
    return {
      moveUp: () => {
        setSelectedIndex(i => Math.max(i - 1, 0))
      },
      moveDown: () => {
        setSelectedIndex(i =>
          Math.min(i + 1, Math.max(0, filteredFiles.length - 1))
        )
      },
      selectCurrent: () => {
        const file = filteredFiles[clampedSelectedIndex]
        if (file) {
          handleSelect(file)
        }
      },
      selectPreviousScope: () => handleScopeCycle(-1),
      selectNextScope: () => handleScopeCycle(1),
    }
  }, [filteredFiles, clampedSelectedIndex, handleSelect, handleScopeCycle])

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    const selectedItem = list.querySelector(
      `[data-index="${clampedSelectedIndex}"]`
    )
    selectedItem?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelectedIndex])

  // Scroll selected project scope into view when cycling with keyboard.
  useEffect(() => {
    const scopeList = scopeListRef.current
    if (!open || !scopeList || selectedScopeIndex < 0) return

    const selectedScopeItem = scopeList.querySelector(
      `[data-scope-index="${selectedScopeIndex}"]`
    )
    selectedScopeItem?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [open, selectedScopeIndex])

  if (!open || !anchorPosition) return null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor
        className="-mx-4 md:-mx-6"
        style={{
          position: 'absolute',
          top: anchorPosition.top,
          left: 0,
          right: 0,
          pointerEvents: 'none',
        }}
      />
      <PopoverContent
        className="p-0"
        style={containerWidth ? { width: containerWidth } : undefined}
        align="start"
        collisionPadding={0}
        side="top"
        sideOffset={20}
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <div className="space-y-2 border-b px-3 py-2">
          <div className="flex min-h-5 items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">
              File links
            </span>
            {scopes.length > 1 && (
              <KbdGroup
                className="gap-0.5"
                aria-label="Use Control Shift Left or Right to switch scope"
              >
                <Kbd className="h-4 min-w-4 px-1 text-[10px]">Ctrl</Kbd>
                <Kbd className="h-4 min-w-4 px-1 text-[10px]">Shift</Kbd>
                <Kbd className="h-4 min-w-4 px-1 text-[10px]">←</Kbd>
                <Kbd className="h-4 min-w-4 px-1 text-[10px]">→</Kbd>
              </KbdGroup>
            )}
          </div>

          {scopes.length > 0 && (
            <div className="space-y-1.5">
              <div
                ref={scopeListRef}
                className="flex gap-1.5 overflow-x-auto pb-0.5"
                aria-label="Project scope selector"
              >
                {scopes.map((scope, index) => {
                  const isActiveScope = scope.rootPath === selectedRootPath
                  const label = scope.isCurrent
                    ? `${scope.name} current`
                    : scope.name

                  return (
                    <button
                      key={`${scope.id}:${scope.rootPath}`}
                      type="button"
                      title={scope.name}
                      data-scope-index={index}
                      aria-label={`Search files in ${label}`}
                      aria-pressed={isActiveScope}
                      onClick={() => handleScopeSelect(scope)}
                      className={cn(
                        'flex max-w-[11rem] shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                        isActiveScope
                          ? 'border-primary/55 bg-primary/15 text-primary shadow-sm'
                          : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                      )}
                    >
                      <FolderIcon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{scope.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        <Command shouldFilter={false}>
          <CommandList
            ref={listRef}
            className="min-h-[280px] max-h-[min(360px,60vh)]"
          >
            {filteredFiles.length === 0 ? (
              <CommandEmpty>
                {scopes.length === 0
                  ? 'No files found'
                  : 'No files found in selected project'}
              </CommandEmpty>
            ) : (
              <CommandGroup heading="Files">
                {filteredFiles.map((file, index) => {
                  const isSelected = index === clampedSelectedIndex
                  return (
                    <CommandItem
                      key={file.relative_path}
                      data-index={index}
                      value={file.relative_path}
                      onSelect={() => handleSelect(file)}
                      className={cn(
                        'flex items-center gap-2 cursor-pointer',
                        // Override cmdk's internal selection styling - we manage selection ourselves
                        'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                        isSelected && '!bg-accent !text-accent-foreground'
                      )}
                    >
                      {file.is_dir ? (
                        <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground/80" />
                      ) : (
                        <FileIcon
                          className={cn(
                            'h-4 w-4 shrink-0',
                            getExtensionColor(file.extension)
                          )}
                        />
                      )}
                      <span className="truncate text-sm">
                        {file.is_dir
                          ? `${file.relative_path}/`
                          : file.relative_path}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
