import { normalizePath } from '@/lib/path-utils'

/** A node in the git diff file tree — either a folder or a leaf file. */
export type TreeNode<F> = FolderNode<F> | FileNode<F>

export interface FolderNode<F> {
  type: 'folder'
  /** Display segment(s) for this folder. With compaction, may contain '/'. */
  name: string
  /** Stable key for expand/collapse state. */
  fullPath: string
  children: TreeNode<F>[]
}

export interface FileNode<F> {
  type: 'file'
  name: string
  fullPath: string
  /** Original index in the input list — needed by callers to keep selection in sync. */
  index: number
  file: F
}

interface BuildOptions {
  /** Collapse folders that contain only a single sub-folder into one row (VSCode-style). */
  compactFolders?: boolean
}

/**
 * Build a tree from a flat list of files identified by `fileName` (forward-slash path).
 * The original index is preserved on each leaf so callers can keep their selection.
 */
export function buildFileTree<F extends { fileName: string }>(
  files: F[],
  options: BuildOptions = {}
): FolderNode<F> {
  const root: FolderNode<F> = {
    type: 'folder',
    name: '',
    fullPath: '',
    children: [],
  }

  files.forEach((file, index) => {
    const segments = normalizePath(file.fileName).split('/').filter(Boolean)
    const fileName = segments.pop()
    if (!fileName) return

    let currentFolder = root
    let path = ''
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment
      let next = currentFolder.children.find(
        (c): c is FolderNode<F> => c.type === 'folder' && c.fullPath === path
      )
      if (!next) {
        next = { type: 'folder', name: segment, fullPath: path, children: [] }
        currentFolder.children.push(next)
      }
      currentFolder = next
    }

    currentFolder.children.push({
      type: 'file',
      name: fileName,
      fullPath: file.fileName,
      index,
      file,
    })
  })

  sortTree(root)
  if (options.compactFolders) compactTree(root)
  return root
}

function sortTree<F>(node: FolderNode<F>) {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const child of node.children) {
    if (child.type === 'folder') sortTree(child)
  }
}

/**
 * Collapse single-child folder chains into a combined row, like VSCode "compact folders".
 * Example: src → components → ui → button.tsx becomes "src/components/ui" + button.tsx.
 * Never merges into the root; the root keeps each top-level entry separate.
 */
function compactTree<F>(node: FolderNode<F>) {
  for (const child of node.children) {
    if (child.type === 'folder') compactTree(child)
  }
  for (const child of node.children) {
    if (child.type !== 'folder') continue
    let inner = child.children[0]
    while (
      child.children.length === 1 &&
      inner &&
      inner.type === 'folder'
    ) {
      child.name = `${child.name}/${inner.name}`
      child.fullPath = inner.fullPath
      child.children = inner.children
      inner = child.children[0]
    }
  }
}

