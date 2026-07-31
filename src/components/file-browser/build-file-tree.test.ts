import { describe, expect, it } from 'vitest'
import type { WorktreeFile } from '@/types/chat'
import {
  buildFileTree,
  flattenVisibleTree,
  pathsToExpandForMatches,
} from './build-file-tree'

const sampleFiles: WorktreeFile[] = [
  { relative_path: 'src', extension: '', is_dir: true },
  { relative_path: 'src/components', extension: '', is_dir: true },
  { relative_path: 'src/App.tsx', extension: 'tsx', is_dir: false },
  {
    relative_path: 'src/components/Button.tsx',
    extension: 'tsx',
    is_dir: false,
  },
  { relative_path: 'README.md', extension: 'md', is_dir: false },
  { relative_path: 'package.json', extension: 'json', is_dir: false },
]

describe('buildFileTree', () => {
  it('nests files under directories and sorts dirs first', () => {
    const tree = buildFileTree(sampleFiles)
    expect(tree.map(n => n.name)).toEqual(['src', 'package.json', 'README.md'])
    const src = tree.find(n => n.name === 'src')
    expect(src?.isDir).toBe(true)
    expect(src?.children.map(n => n.name)).toEqual(['components', 'App.tsx'])
    const components = src?.children.find(n => n.name === 'components')
    expect(components?.children.map(n => n.name)).toEqual(['Button.tsx'])
  })

  it('creates intermediate dirs when only files are listed', () => {
    const files: WorktreeFile[] = [
      { relative_path: 'a/b/c.ts', extension: 'ts', is_dir: false },
    ]
    const tree = buildFileTree(files)
    expect(tree).toHaveLength(1)
    expect(tree[0]?.name).toBe('a')
    expect(tree[0]?.children[0]?.name).toBe('b')
    expect(tree[0]?.children[0]?.children[0]?.name).toBe('c.ts')
  })
})

describe('flattenVisibleTree', () => {
  it('only includes children of expanded dirs', () => {
    const tree = buildFileTree(sampleFiles)
    const collapsed = flattenVisibleTree(tree, new Set())
    expect(collapsed.map(r => r.node.name)).toEqual([
      'src',
      'package.json',
      'README.md',
    ])

    const expanded = flattenVisibleTree(tree, new Set(['src']))
    expect(expanded.map(r => r.node.name)).toEqual([
      'src',
      'components',
      'App.tsx',
      'package.json',
      'README.md',
    ])
  })
})

describe('pathsToExpandForMatches', () => {
  it('returns parent dirs for matching files', () => {
    const expanded = pathsToExpandForMatches(sampleFiles, 'button')
    expect(expanded.has('src')).toBe(true)
    expect(expanded.has('src/components')).toBe(true)
  })
})
