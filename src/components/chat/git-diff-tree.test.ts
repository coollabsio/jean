import { describe, expect, it } from 'vitest'
import { buildFileTree, type FolderNode, type TreeNode } from './git-diff-tree'

interface TestFile {
  fileName: string
}

const mk = (...names: string[]): TestFile[] => names.map(fileName => ({ fileName }))

/** Find a child folder by name in a folder node. */
function folder<F>(node: FolderNode<F>, name: string): FolderNode<F> {
  const child = node.children.find(
    (c): c is FolderNode<F> => c.type === 'folder' && c.name === name
  )
  if (!child) throw new Error(`Folder '${name}' not found in '${node.fullPath}'`)
  return child
}

/** Get the names of all children in order. */
const childNames = <F>(node: FolderNode<F>) =>
  node.children.map((c: TreeNode<F>) => c.name)

describe('buildFileTree', () => {
  it('returns an empty root when there are no files', () => {
    const tree = buildFileTree([])
    expect(tree.type).toBe('folder')
    expect(tree.children).toEqual([])
  })

  it('preserves the original file index on each leaf (used for selection)', () => {
    const tree = buildFileTree(mk('a.ts', 'b.ts', 'c.ts'))
    const indexes = tree.children.map(c =>
      c.type === 'file' ? c.index : -1
    )
    // children are alphabetically sorted, so order matches input here
    expect(indexes).toEqual([0, 1, 2])
  })

  it('places top-level files directly under the root', () => {
    const tree = buildFileTree(mk('README.md'))
    expect(tree.children).toHaveLength(1)
    const child = tree.children[0]
    expect(child?.type).toBe('file')
    if (child?.type === 'file') {
      expect(child.name).toBe('README.md')
      expect(child.fullPath).toBe('README.md')
    }
  })

  it('normalizes Windows backslashes to forward slashes', () => {
    const tree = buildFileTree(mk('src\\components\\foo.ts'))
    const src = folder(tree, 'src')
    const components = folder(src, 'components')
    expect(components.children).toHaveLength(1)
    const file = components.children[0]
    expect(file?.type).toBe('file')
    if (file?.type === 'file') expect(file.name).toBe('foo.ts')
  })

  it('sorts folders before files, both alphabetical', () => {
    const tree = buildFileTree(
      mk('z.ts', 'a.ts', 'src/x.ts', 'lib/y.ts')
    )
    expect(childNames(tree)).toEqual(['lib', 'src', 'a.ts', 'z.ts'])
  })

  it('groups files into the right folders', () => {
    const tree = buildFileTree(
      mk('src/a.ts', 'src/b.ts', 'docs/README.md')
    )
    expect(folder(tree, 'src').children).toHaveLength(2)
    expect(folder(tree, 'docs').children).toHaveLength(1)
  })
})

describe('compactFolders option', () => {
  it('collapses single-child folder chains when enabled', () => {
    const tree = buildFileTree(mk('src/components/ui/button.tsx'), {
      compactFolders: true,
    })
    expect(tree.children).toHaveLength(1)
    const collapsed = tree.children[0]
    expect(collapsed?.type).toBe('folder')
    if (collapsed?.type === 'folder') {
      expect(collapsed.name).toBe('src/components/ui')
      expect(collapsed.children).toHaveLength(1)
      const file = collapsed.children[0]
      if (file?.type === 'file') expect(file.name).toBe('button.tsx')
    }
  })

  it('does not collapse when a folder has multiple children', () => {
    const tree = buildFileTree(
      mk('src/components/a.ts', 'src/components/b.ts'),
      { compactFolders: true }
    )
    // src/components has two files, so the chain stops at "src/components"
    const collapsed = folder(tree, 'src/components')
    expect(collapsed.children).toHaveLength(2)
  })

  it('stops collapsing when a folder has both a sub-folder and a file', () => {
    const tree = buildFileTree(
      mk('src/components/ui/button.tsx', 'src/components/index.ts'),
      { compactFolders: true }
    )
    const components = folder(tree, 'src/components')
    expect(childNames(components)).toEqual(['ui', 'index.ts'])
  })

  it('never merges into the root (top-level entries stay separate)', () => {
    const tree = buildFileTree(
      mk('src/foo/bar.ts', 'docs/readme.md'),
      { compactFolders: true }
    )
    // Two top-level entries: src/foo and docs (each compacted internally)
    expect(tree.children).toHaveLength(2)
    expect(childNames(tree).sort()).toEqual(['docs', 'src/foo'])
  })

  it('leaves the tree unchanged when compactFolders is omitted', () => {
    const tree = buildFileTree(mk('src/components/ui/button.tsx'))
    // Without compaction, each segment is its own folder node
    const src = folder(tree, 'src')
    const components = folder(src, 'components')
    const ui = folder(components, 'ui')
    expect(ui.children).toHaveLength(1)
  })
})
