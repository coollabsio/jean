import { useMemo, useState } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buildFileTree, type TreeNode } from './git-diff-tree'

const INDENT_PX = 12

interface FileItem {
  key: string
  fileName: string
}

interface GitDiffFileTreeProps<F extends FileItem> {
  /** Already-filtered files (search filter is applied by the parent). */
  files: F[]
  renderFile: (file: F, index: number, indentPx: number) => React.ReactNode
  /** When true, all folders are auto-expanded so search matches stay visible. */
  searchActive: boolean
  compactFolders?: boolean
  isMobile?: boolean
}

export function GitDiffFileTree<F extends FileItem>({
  files,
  renderFile,
  searchActive,
  compactFolders = true,
  isMobile = false,
}: GitDiffFileTreeProps<F>) {
  const tree = useMemo(
    () => buildFileTree(files, { compactFolders }),
    [files, compactFolders]
  )

  // Folder expand state (full path → expanded). Default: all collapsed.
  // Stale paths (folders no longer in the tree) are kept on purpose so the
  // user's expand choice is restored if the folder reappears (e.g. clearing
  // a search filter that hid it).
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(
    () => new Set()
  )

  // When search is active, every folder is treated as expanded so matches
  // stay visible. The check is per-row (`isExpandedFolder`) to avoid
  // building a full path set on every render.
  const isExpandedFolder = (path: string) =>
    searchActive || manualExpanded.has(path)

  const toggle = (path: string) =>
    setManualExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <>
      {tree.children.map(child => (
        <TreeRow
          key={child.type === 'folder' ? `f:${child.fullPath}` : child.file.key}
          node={child}
          depth={0}
          isExpandedFolder={isExpandedFolder}
          onToggle={toggle}
          renderFile={renderFile}
          isMobile={isMobile}
        />
      ))}
    </>
  )
}

interface TreeRowProps<F extends FileItem> {
  node: TreeNode<F>
  depth: number
  isExpandedFolder: (path: string) => boolean
  onToggle: (path: string) => void
  renderFile: GitDiffFileTreeProps<F>['renderFile']
  isMobile: boolean
}

function TreeRow<F extends FileItem>({
  node,
  depth,
  isExpandedFolder,
  onToggle,
  renderFile,
  isMobile,
}: TreeRowProps<F>) {
  if (node.type === 'file') {
    return <>{renderFile(node.file, node.index, depth * INDENT_PX)}</>
  }

  const isExpanded = isExpandedFolder(node.fullPath)
  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(node.fullPath)}
        className={cn(
          'w-full flex items-center gap-1.5 text-left text-muted-foreground transition-colors hover:bg-muted/50 cursor-pointer',
          isMobile ? 'py-2 text-sm' : 'py-1.5'
        )}
        style={{ paddingLeft: depth * INDENT_PX + 8, paddingRight: 8 }}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
            isExpanded && 'rotate-90'
          )}
        />
        {isExpanded ? (
          <FolderOpen className="h-[1em] w-[1em] shrink-0" />
        ) : (
          <Folder className="h-[1em] w-[1em] shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isExpanded &&
        node.children.map(child => (
          <TreeRow
            key={
              child.type === 'folder' ? `f:${child.fullPath}` : child.file.key
            }
            node={child}
            depth={depth + 1}
            isExpandedFolder={isExpandedFolder}
            onToggle={onToggle}
            renderFile={renderFile}
            isMobile={isMobile}
          />
        ))}
    </>
  )
}
