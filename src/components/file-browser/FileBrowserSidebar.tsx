import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  FileIcon,
  Folder,
  FolderOpen,
  FolderTree,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useWorktree, useProjects } from '@/services/projects'
import { fileQueryKeys, useWorktreeFiles } from '@/services/files'
import { getExtensionColor } from '@/lib/file-colors'
import { getFilename, joinPaths } from '@/lib/path-utils'
import type { WorktreeFile } from '@/types/chat'
import { isFolder } from '@/types/projects'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  buildFileTree,
  flattenVisibleTree,
  pathsToExpandForMatches,
  type FileTreeNode,
} from './build-file-tree'

/**
 * Stable empty list for useWorktreeFiles while data is undefined.
 * Inline `= []` creates a new array every render; when that identity is an
 * effect dependency, setState in the effect causes React error #185
 * (maximum update depth exceeded). See issue #628.
 */
const EMPTY_WORKTREE_FILES: WorktreeFile[] = []

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

interface FileBrowserSidebarProps {
  className?: string
  /** When true, hide the close button (e.g. mobile sheet has its own chrome) */
  hideCloseButton?: boolean
}

function useFileBrowserRootPath(): {
  rootPath: string | null
  label: string | null
} {
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const { data: selectedWorktree } = useWorktree(selectedWorktreeId)
  const { data: projects = [] } = useProjects()

  return useMemo(() => {
    if (activeWorktreePath) {
      return {
        rootPath: activeWorktreePath,
        label: getFilename(activeWorktreePath),
      }
    }
    if (selectedWorktree?.path) {
      return {
        rootPath: selectedWorktree.path,
        label: selectedWorktree.name || getFilename(selectedWorktree.path),
      }
    }
    const project = projects.find(
      p => p.id === selectedProjectId && !isFolder(p)
    )
    if (project?.path) {
      return {
        rootPath: project.path,
        label: project.name || getFilename(project.path),
      }
    }
    return { rootPath: null, label: null }
  }, [
    activeWorktreePath,
    selectedWorktree,
    projects,
    selectedProjectId,
  ])
}

export function FileBrowserSidebar({
  className,
  hideCloseButton = false,
}: FileBrowserSidebarProps) {
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const setFileBrowserVisible = useUIStore(state => state.setFileBrowserVisible)
  const setViewingFilePath = useUIStore(state => state.setViewingFilePath)
  const viewingFilePath = useUIStore(state => state.viewingFilePath)

  const { rootPath, label } = useFileBrowserRootPath()
  const {
    data: files = EMPTY_WORKTREE_FILES,
    isLoading,
    isFetching,
    isError,
    error,
  } = useWorktreeFiles(rootPath)

  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Remember user-expanded dirs so search clear restores them (lazy init)
  const userExpandedRef = useRef<Set<string> | null>(null)
  if (userExpandedRef.current === null) {
    userExpandedRef.current = new Set()
  }
  // Mirror expanded for pure toggles (avoid writing refs inside setState updaters)
  const expandedRef = useRef(expanded)
  useLayoutEffect(() => {
    expandedRef.current = expanded
  })

  // Reset expansion when root path changes (project/worktree switch).
  // Also close the file viewer if it was showing a file from the previous root
  // so we don't keep loading stale paths mid-switch (can race and hard-crash).
  useEffect(() => {
    setExpanded(prev => (prev.size === 0 ? prev : new Set()))
    userExpandedRef.current = new Set()
    setSelectedPath(null)
    setSearch('')

    const viewing = useUIStore.getState().viewingFilePath
    if (!viewing) return

    if (!rootPath) {
      useUIStore.getState().setViewingFilePath(null)
      return
    }

    const normalizedRoot = rootPath
      .replace(/[\\/]+$/, '')
      .replace(/\\/g, '/')
    const normalizedView = viewing.replace(/\\/g, '/')
    if (
      normalizedView !== normalizedRoot &&
      !normalizedView.startsWith(`${normalizedRoot}/`)
    ) {
      useUIStore.getState().setViewingFilePath(null)
    }
  }, [rootPath])

  // Auto-expand parents when searching
  useEffect(() => {
    const q = search.trim()
    if (!q) {
      const restored = new Set(userExpandedRef.current ?? [])
      setExpanded(prev => (setsEqual(prev, restored) ? prev : restored))
      return
    }
    const next = pathsToExpandForMatches(files, q)
    setExpanded(prev => (setsEqual(prev, next) ? prev : next))
  }, [search, files])

  const tree = useMemo(() => buildFileTree(files), [files])

  const filteredTree = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return tree

    const filterNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
      const result: FileTreeNode[] = []
      for (const node of nodes) {
        if (node.isDir) {
          const children = filterNodes(node.children)
          const selfMatch = node.relativePath.toLowerCase().includes(q)
          if (selfMatch || children.length > 0) {
            result.push({ ...node, children })
          }
        } else if (node.relativePath.toLowerCase().includes(q)) {
          result.push(node)
        }
      }
      return result
    }
    return filterNodes(tree)
  }, [tree, search])

  const visibleRows = useMemo(
    () => flattenVisibleTree(filteredTree, expanded),
    [filteredTree, expanded]
  )

  const handleRefresh = useCallback(() => {
    if (!rootPath) return
    void queryClient.invalidateQueries({
      queryKey: fileQueryKeys.worktreeFiles(rootPath),
    })
  }, [queryClient, rootPath])

  const toggleDir = useCallback((relativePath: string) => {
    const next = new Set(expandedRef.current)
    if (next.has(relativePath)) next.delete(relativePath)
    else next.add(relativePath)
    setExpanded(next)
    if (!search.trim()) {
      userExpandedRef.current = next
    }
  }, [search])

  const openFile = useCallback(
    (relativePath: string) => {
      if (!rootPath) return
      const absolute = joinPaths(rootPath, relativePath)
      setSelectedPath(relativePath)
      setViewingFilePath(absolute)
      // Mobile file browser is a sheet above the main UI; close it so the
      // file viewer is not trapped under the sheet / dismissed with it.
      if (isMobile) {
        setFileBrowserVisible(false)
      }
    },
    [rootPath, setViewingFilePath, isMobile, setFileBrowserVisible]
  )

  const handleRowActivate = useCallback(
    (node: FileTreeNode) => {
      if (node.isDir) {
        toggleDir(node.relativePath)
        setSelectedPath(node.relativePath)
      } else {
        openFile(node.relativePath)
      }
    },
    [openFile, toggleDir]
  )

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent, node: FileTreeNode) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleRowActivate(node)
      } else if (e.key === 'ArrowRight' && node.isDir) {
        e.preventDefault()
        if (!expanded.has(node.relativePath)) toggleDir(node.relativePath)
      } else if (e.key === 'ArrowLeft' && node.isDir) {
        e.preventDefault()
        if (expanded.has(node.relativePath)) toggleDir(node.relativePath)
      }
    },
    [expanded, handleRowActivate, toggleDir]
  )

  // Sync selected path with currently viewed file
  useEffect(() => {
    if (!viewingFilePath || !rootPath) return
    const normalizedRoot = rootPath.replace(/[\\/]+$/, '')
    const normalizedView = viewingFilePath.replace(/\\/g, '/')
    const normalizedRootFwd = normalizedRoot.replace(/\\/g, '/')
    if (normalizedView.startsWith(normalizedRootFwd + '/')) {
      setSelectedPath(normalizedView.slice(normalizedRootFwd.length + 1))
    }
  }, [viewingFilePath, rootPath])

  return (
    <div
      className={cn(
        'flex h-full flex-col bg-sidebar text-sidebar-foreground',
        className
      )}
      data-testid="file-browser-sidebar"
    >
      {/* Header */}
      <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1.5">
        <FolderTree className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">Files</p>
          {label && (
            <p
              className="truncate text-[0.625rem] text-muted-foreground"
              title={rootPath ?? undefined}
            >
              {label}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={handleRefresh}
              disabled={!rootPath || isFetching}
              aria-label="Refresh file list"
            >
              {isFetching ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Refresh</TooltipContent>
        </Tooltip>
        {!hideCloseButton && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => setFileBrowserVisible(false)}
                aria-label="Close file browser"
              >
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Search */}
      <div className="border-b border-sidebar-border px-2 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter files…"
            className="h-7 bg-background/50 pl-7 pr-7 text-xs"
            disabled={!rootPath}
            aria-label="Filter files"
          />
          {search && (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => setSearch('')}
              aria-label="Clear filter"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* Tree */}
      <ScrollArea className="flex-1">
        <div
          className="p-1 pb-[calc(var(--safe-area-bottom)+1rem)]"
          role="tree"
          aria-label="Worktree files"
        >
          {!rootPath && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              Select a project or worktree to browse files.
            </p>
          )}
          {rootPath && isLoading && files.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading files…
            </div>
          )}
          {rootPath && isError && (
            <p className="px-2 py-4 text-center text-sm text-destructive">
              {error instanceof Error
                ? error.message
                : 'Failed to load files'}
            </p>
          )}
          {rootPath && !isLoading && !isError && visibleRows.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {search.trim() ? 'No matching files' : 'No files found'}
            </p>
          )}
          {visibleRows.map(({ node, depth }) => {
            const isExpanded = expanded.has(node.relativePath)
            const isSelected = selectedPath === node.relativePath
            const color = node.isDir
              ? 'text-muted-foreground'
              : getExtensionColor(node.extension)

            return (
              <button
                key={node.relativePath}
                type="button"
                role="treeitem"
                aria-expanded={node.isDir ? isExpanded : undefined}
                aria-selected={isSelected}
                className={cn(
                  // Match projects/worktree list: text-sm row labels
                  'flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-left text-sm',
                  'hover:bg-sidebar-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  isSelected && 'bg-sidebar-accent text-sidebar-accent-foreground'
                )}
                style={{ paddingLeft: `${depth * 12 + 4}px` }}
                onClick={() => handleRowActivate(node)}
                onKeyDown={e => handleKeyDown(e, node)}
                title={node.relativePath}
              >
                {node.isDir ? (
                  isExpanded ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                {node.isDir ? (
                  isExpanded ? (
                    <FolderOpen className={cn('size-3.5 shrink-0', color)} />
                  ) : (
                    <Folder className={cn('size-3.5 shrink-0', color)} />
                  )
                ) : (
                  <FileIcon className={cn('size-3.5 shrink-0', color)} />
                )}
                <span className="truncate">{node.name}</span>
              </button>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

export default FileBrowserSidebar
