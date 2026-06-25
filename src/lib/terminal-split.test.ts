import { describe, it, expect } from 'vitest'
import {
  collectLeafIds,
  countLeaves,
  firstLeafId,
  hasLeaf,
  leaf,
  pruneLeaf,
  setSizesAtPath,
  splitLeaf,
  type SplitNode,
} from './terminal-split'

describe('terminal-split helpers', () => {
  describe('leaf / collectLeafIds / countLeaves', () => {
    it('builds a single leaf', () => {
      expect(leaf('a')).toEqual({ type: 'leaf', terminalId: 'a' })
      expect(collectLeafIds(leaf('a'))).toEqual(['a'])
      expect(countLeaves(leaf('a'))).toBe(1)
    })

    it('collects ids in document order across nested splits', () => {
      const tree: SplitNode = {
        type: 'split',
        orientation: 'horizontal',
        children: [
          leaf('a'),
          {
            type: 'split',
            orientation: 'vertical',
            children: [leaf('b'), leaf('c')],
          },
        ],
      }
      expect(collectLeafIds(tree)).toEqual(['a', 'b', 'c'])
      expect(countLeaves(tree)).toBe(3)
    })
  })

  describe('hasLeaf / firstLeafId', () => {
    it('detects presence', () => {
      const tree = splitLeaf(leaf('a'), 'a', 'horizontal', 'b')
      expect(hasLeaf(tree, 'a')).toBe(true)
      expect(hasLeaf(tree, 'b')).toBe(true)
      expect(hasLeaf(tree, 'z')).toBe(false)
    })

    it('returns the top-left leaf', () => {
      const tree = splitLeaf(leaf('a'), 'a', 'vertical', 'b')
      expect(firstLeafId(tree)).toBe('a')
    })
  })

  describe('splitLeaf', () => {
    it('wraps a single leaf into a binary split, old leaf first, 50/50', () => {
      const tree = splitLeaf(leaf('a'), 'a', 'horizontal', 'b')
      expect(tree).toEqual({
        type: 'split',
        orientation: 'horizontal',
        children: [leaf('a'), leaf('b')],
        sizes: [50, 50],
      })
    })

    it('splits a nested leaf without touching siblings or parent sizes', () => {
      const tree: SplitNode = {
        type: 'split',
        orientation: 'horizontal',
        children: [leaf('a'), leaf('b')],
        sizes: [30, 70],
      }
      const next = splitLeaf(tree, 'b', 'vertical', 'c')
      expect(next).toEqual({
        type: 'split',
        orientation: 'horizontal',
        children: [
          leaf('a'),
          {
            type: 'split',
            orientation: 'vertical',
            children: [leaf('b'), leaf('c')],
            sizes: [50, 50],
          },
        ],
        sizes: [30, 70],
      })
    })

    it('returns same reference when target is absent', () => {
      const tree = leaf('a')
      expect(splitLeaf(tree, 'z', 'horizontal', 'b')).toBe(tree)
    })
  })

  describe('pruneLeaf', () => {
    it('returns null when removing the only leaf', () => {
      expect(pruneLeaf(leaf('a'), 'a')).toBeNull()
    })

    it('collapses a binary split to the surviving sibling', () => {
      const tree = splitLeaf(leaf('a'), 'a', 'horizontal', 'b')
      expect(pruneLeaf(tree, 'b')).toEqual(leaf('a'))
    })

    it('keeps remaining children and renormalizes sizes', () => {
      const tree: SplitNode = {
        type: 'split',
        orientation: 'horizontal',
        children: [leaf('a'), leaf('b'), leaf('c')],
        sizes: [20, 30, 50],
      }
      const next = pruneLeaf(tree, 'b')
      expect(next).toEqual({
        type: 'split',
        orientation: 'horizontal',
        children: [leaf('a'), leaf('c')],
        // [20, 50] renormalized to 100
        sizes: [(20 / 70) * 100, (50 / 70) * 100],
      })
    })

    it('returns same reference when terminal is absent', () => {
      const tree = splitLeaf(leaf('a'), 'a', 'horizontal', 'b')
      expect(pruneLeaf(tree, 'z')).toBe(tree)
    })

    it('prunes deeply and collapses nested splits', () => {
      const tree: SplitNode = {
        type: 'split',
        orientation: 'horizontal',
        children: [
          leaf('a'),
          {
            type: 'split',
            orientation: 'vertical',
            children: [leaf('b'), leaf('c')],
          },
        ],
      }
      // Removing c collapses the inner split to leaf(b); outer split collapses
      // to a horizontal [a, b].
      expect(pruneLeaf(tree, 'c')).toEqual({
        type: 'split',
        orientation: 'horizontal',
        children: [leaf('a'), leaf('b')],
      })
    })
  })

  describe('setSizesAtPath', () => {
    it('sets sizes on the root split', () => {
      const tree = splitLeaf(leaf('a'), 'a', 'horizontal', 'b')
      const next = setSizesAtPath(tree, [], [40, 60])
      expect(next.type === 'split' && next.sizes).toEqual([40, 60])
    })

    it('sets sizes on a nested split via path', () => {
      const tree: SplitNode = {
        type: 'split',
        orientation: 'horizontal',
        children: [
          leaf('a'),
          {
            type: 'split',
            orientation: 'vertical',
            children: [leaf('b'), leaf('c')],
          },
        ],
      }
      const next = setSizesAtPath(tree, [1], [25, 75])
      const inner = next.type === 'split' ? next.children[1] : null
      expect(inner && inner.type === 'split' && inner.sizes).toEqual([25, 75])
    })

    it('returns same reference when sizes are unchanged', () => {
      const tree: SplitNode = {
        type: 'split',
        orientation: 'horizontal',
        children: [leaf('a'), leaf('b')],
        sizes: [50, 50],
      }
      expect(setSizesAtPath(tree, [], [50, 50])).toBe(tree)
    })
  })
})
