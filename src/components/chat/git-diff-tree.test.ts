import { describe, it, expect } from 'vitest'
import {
  buildFileTree,
  diffTypeToStatus,
  getDirFileNames,
  type FlattenedFile,
  type FileTreeDir,
  type FileTreeFile,
} from './GitDiffModal'

// Minimal FlattenedFile factory for testing (fileDiff.type is only used by rendering, not buildFileTree)
function file(fileName: string, i: number, additions = 0, deletions = 0): FlattenedFile {
  return {
    fileName,
    key: `${i}`,
    additions,
    deletions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileDiff: { type: 'change', hunks: [], splitLineCount: 0, unifiedLineCount: 0 } as any,
  }
}

describe('diffTypeToStatus', () => {
  it('maps new → added', () => expect(diffTypeToStatus('new')).toBe('added'))
  it('maps deleted → deleted', () => expect(diffTypeToStatus('deleted')).toBe('deleted'))
  it('maps rename-pure → renamed', () => expect(diffTypeToStatus('rename-pure')).toBe('renamed'))
  it('maps rename-changed → renamed', () => expect(diffTypeToStatus('rename-changed')).toBe('renamed'))
  it('maps change → modified', () => expect(diffTypeToStatus('change')).toBe('modified'))
  it('maps unknown → modified', () => expect(diffTypeToStatus('unknown-type')).toBe('modified'))
})

describe('buildFileTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildFileTree([])).toEqual([])
  })

  it('places root-level files directly in roots', () => {
    const tree = buildFileTree([file('README.md', 0), file('package.json', 1)])
    expect(tree).toHaveLength(2)
    expect(tree.every(n => n.type === 'file')).toBe(true)
    const names = tree.map(n => n.name)
    expect(names).toContain('README.md')
    expect(names).toContain('package.json')
  })

  it('groups files under their parent directory', () => {
    const tree = buildFileTree([file('src/index.ts', 0), file('src/utils.ts', 1)])
    expect(tree).toHaveLength(1)
    const src = tree[0] as FileTreeDir
    expect(src.type).toBe('dir')
    expect(src.name).toBe('src')
    expect(src.children).toHaveLength(2)
    expect(src.children.every(n => n.type === 'file')).toBe(true)
  })

  it('nests directories correctly', () => {
    const tree = buildFileTree([file('a/b/c/deep.ts', 0)])
    expect(tree).toHaveLength(1)
    const a = tree[0] as FileTreeDir
    expect(a.name).toBe('a')
    const b = a.children[0] as FileTreeDir
    expect(b.name).toBe('b')
    const c = b.children[0] as FileTreeDir
    expect(c.name).toBe('c')
    const deep = c.children[0] as FileTreeFile
    expect(deep.type).toBe('file')
    expect(deep.name).toBe('deep.ts')
    expect(deep.index).toBe(0)
  })

  it('sorts directories before files at each level', () => {
    const tree = buildFileTree([
      file('root.ts', 0),
      file('src/index.ts', 1),
      file('lib/utils.ts', 2),
    ])
    expect(tree[0]?.type).toBe('dir') // lib
    expect(tree[1]?.type).toBe('dir') // src
    expect(tree[2]?.type).toBe('file') // root.ts
  })

  it('sorts alphabetically within same type', () => {
    const tree = buildFileTree([
      file('src/z.ts', 0),
      file('src/a.ts', 1),
      file('src/m.ts', 2),
    ])
    const src = tree[0] as FileTreeDir
    const names = src.children.map(n => n.name)
    expect(names).toEqual(['a.ts', 'm.ts', 'z.ts'])
  })

  it('handles files with Windows-style backslash paths', () => {
    const tree = buildFileTree([file('src\\utils\\helper.ts', 0)])
    const src = tree[0] as FileTreeDir
    expect(src.name).toBe('src')
    const utils = src.children[0] as FileTreeDir
    expect(utils.name).toBe('utils')
    const helper = utils.children[0] as FileTreeFile
    expect(helper.name).toBe('helper.ts')
  })

  it('preserves filteredFiles index on file nodes', () => {
    const files = [file('a.ts', 0), file('b.ts', 1), file('c.ts', 2)]
    const tree = buildFileTree(files)
    const indices = (tree as FileTreeFile[]).map(n => n.index)
    expect(indices).toEqual([0, 1, 2])
  })

  it('index is correct after filtering (tree built from filtered subset)', () => {
    // Simulate what happens when the tree is built from filteredFiles
    // where index 0 = first matching file (not necessarily original index 0)
    const filtered = [file('src/b.ts', 1), file('src/c.ts', 2)]
    const tree = buildFileTree(filtered)
    const src = tree[0] as FileTreeDir
    const fileNodes = src.children as FileTreeFile[]
    expect(fileNodes[0]?.index).toBe(0) // index in filtered array
    expect(fileNodes[1]?.index).toBe(1)
  })

  it('shares directories between sibling files (no duplicate dirs)', () => {
    const tree = buildFileTree([
      file('src/a.ts', 0),
      file('src/b.ts', 1),
      file('src/c.ts', 2),
    ])
    // Should only have one "src" dir node
    expect(tree).toHaveLength(1)
    expect(tree[0]?.type).toBe('dir')
    expect((tree[0] as FileTreeDir).children).toHaveLength(3)
  })

  it('handles mixed root and nested files', () => {
    const tree = buildFileTree([
      file('root.ts', 0),
      file('src/index.ts', 1),
    ])
    // Sorted: dirs before files → src dir first, then root.ts
    expect(tree[0]?.type).toBe('dir')
    expect(tree[0]?.name).toBe('src')
    expect(tree[1]?.type).toBe('file')
    expect(tree[1]?.name).toBe('root.ts')
  })

  it('handles sibling directories', () => {
    const tree = buildFileTree([
      file('src/index.ts', 0),
      file('lib/utils.ts', 1),
      file('test/spec.ts', 2),
    ])
    expect(tree).toHaveLength(3)
    const names = tree.map(n => n.name)
    expect(names).toEqual(['lib', 'src', 'test']) // alphabetical
  })
})

describe('buildFileTree: aggregated stats', () => {
  it('computes additions/deletions on dir nodes', () => {
    const tree = buildFileTree([
      file('src/a.ts', 0, 10, 5),
      file('src/b.ts', 1, 3, 1),
    ])
    const src = tree[0] as FileTreeDir
    expect(src.additions).toBe(13)
    expect(src.deletions).toBe(6)
  })

  it('aggregates stats through multiple levels', () => {
    const tree = buildFileTree([
      file('a/b/c/deep.ts', 0, 20, 10),
      file('a/other.ts', 1, 5, 2),
    ])
    const a = tree[0] as FileTreeDir
    expect(a.additions).toBe(25)
    expect(a.deletions).toBe(12)
    const b = a.children.find(n => n.name === 'b') as FileTreeDir
    expect(b.additions).toBe(20)
    expect(b.deletions).toBe(10)
  })

  it('root-level files do not affect dir stats', () => {
    const tree = buildFileTree([
      file('src/index.ts', 0, 5, 3),
      file('root.ts', 1, 100, 50),
    ])
    const src = tree.find(n => n.name === 'src') as FileTreeDir
    expect(src.additions).toBe(5)
    expect(src.deletions).toBe(3)
  })

  it('dir with zero-stat files shows zero', () => {
    const tree = buildFileTree([file('src/empty.ts', 0, 0, 0)])
    const src = tree[0] as FileTreeDir
    expect(src.additions).toBe(0)
    expect(src.deletions).toBe(0)
  })
})

describe('getDirFileNames', () => {
  it('returns all file names recursively', () => {
    const tree = buildFileTree([
      file('src/a.ts', 0),
      file('src/sub/b.ts', 1),
      file('src/sub/c.ts', 2),
    ])
    const src = tree[0] as FileTreeDir
    const names = getDirFileNames(src.children).sort()
    expect(names).toEqual(['src/a.ts', 'src/sub/b.ts', 'src/sub/c.ts'].sort())
  })

  it('returns empty array for empty nodes', () => {
    expect(getDirFileNames([])).toEqual([])
  })

  it('returns file names at all nesting depths', () => {
    const tree = buildFileTree([
      file('a/b/c/d.ts', 0),
      file('a/e.ts', 1),
    ])
    const a = tree[0] as FileTreeDir
    const names = getDirFileNames(a.children).sort()
    expect(names).toEqual(['a/b/c/d.ts', 'a/e.ts'].sort())
  })
})
