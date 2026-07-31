import type { WorktreeFile } from '@/types/chat'
import { getFilename } from '@/lib/path-utils'

export interface FileTreeNode {
  /** Entry name (not full path) */
  name: string
  /** Relative path from worktree root */
  relativePath: string
  isDir: boolean
  extension: string
  children: FileTreeNode[]
}

/**
 * Build a nested directory tree from a flat list of worktree files.
 * Directories are sorted before files; names are sorted alphabetically.
 */
export function buildFileTree(files: WorktreeFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = []
  const dirMap = new Map<string, FileTreeNode>()

  const ensureDir = (relativePath: string): FileTreeNode => {
    const existing = dirMap.get(relativePath)
    if (existing) return existing

    const parts = relativePath.split(/[/\\]/).filter(Boolean)
    let parentChildren = root
    let currentPath = ''

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      let node = dirMap.get(currentPath)
      if (!node) {
        node = {
          name: part,
          relativePath: currentPath,
          isDir: true,
          extension: '',
          children: [],
        }
        dirMap.set(currentPath, node)
        parentChildren.push(node)
      }
      parentChildren = node.children
    }

    const created = dirMap.get(relativePath)
    if (!created) {
      // Should be unreachable if relativePath is non-empty
      const fallback: FileTreeNode = {
        name: getFilename(relativePath),
        relativePath,
        isDir: true,
        extension: '',
        children: [],
      }
      dirMap.set(relativePath, fallback)
      root.push(fallback)
      return fallback
    }
    return created
  }

  // First pass: materialize all directories
  for (const file of files) {
    if (file.is_dir) {
      ensureDir(file.relative_path.replace(/\\/g, '/'))
    }
  }

  // Second pass: attach files (and intermediate dirs for nested files)
  for (const file of files) {
    if (file.is_dir) continue

    const normalized = file.relative_path.replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    if (parts.length === 0) continue

    const fileName = parts[parts.length - 1] ?? normalized
    const parentPath = parts.slice(0, -1).join('/')
    const parentChildren = parentPath ? ensureDir(parentPath).children : root

    // Skip duplicates
    if (parentChildren.some(c => c.relativePath === normalized && !c.isDir)) {
      continue
    }

    parentChildren.push({
      name: fileName,
      relativePath: normalized,
      isDir: false,
      extension:
        file.extension || getFilename(normalized).split('.').pop() || '',
      children: [],
    })
  }

  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    for (const node of nodes) {
      if (node.children.length > 0) sortNodes(node.children)
    }
  }

  sortNodes(root)
  return root
}

/** Flatten tree to a list of visible nodes given expanded directory paths. */
export function flattenVisibleTree(
  nodes: FileTreeNode[],
  expanded: Set<string>,
  depth = 0
): { node: FileTreeNode; depth: number }[] {
  const result: { node: FileTreeNode; depth: number }[] = []
  for (const node of nodes) {
    result.push({ node, depth })
    if (node.isDir && expanded.has(node.relativePath) && node.children.length) {
      result.push(...flattenVisibleTree(node.children, expanded, depth + 1))
    }
  }
  return result
}

/**
 * Collect directory paths that contain a matching file (for search expand).
 */
export function pathsToExpandForMatches(
  files: WorktreeFile[],
  query: string
): Set<string> {
  const q = query.trim().toLowerCase()
  const expanded = new Set<string>()
  if (!q) return expanded

  for (const file of files) {
    if (file.is_dir) continue
    const path = file.relative_path.replace(/\\/g, '/')
    if (!path.toLowerCase().includes(q)) continue
    const parts = path.split('/')
    let current = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (part === undefined) continue
      current = current ? `${current}/${part}` : part
      expanded.add(current)
    }
  }
  return expanded
}
