import { describe, expect, it } from 'vitest'
import {
  fixInterruptedOrderedLists,
  type MdastNode,
  type MdastParent,
} from './remark-fix-interrupted-lists'

function textParagraph(value: string): MdastNode {
  return {
    type: 'paragraph',
    children: [{ type: 'text', value }],
  }
}

function listItem(...children: MdastNode[]): MdastNode {
  return {
    type: 'listItem',
    spread: false,
    checked: null,
    children,
  }
}

function orderedList(items: MdastNode[], start: number | null = 1): MdastNode {
  return {
    type: 'list',
    ordered: true,
    start,
    spread: false,
    children: items,
  }
}

function unorderedList(items: MdastNode[]): MdastNode {
  return {
    type: 'list',
    ordered: false,
    start: null,
    spread: false,
    children: items,
  }
}

describe('fixInterruptedOrderedLists', () => {
  it('merges ordered lists interrupted by sibling unordered lists (issue #200)', () => {
    const tree: MdastParent = {
      type: 'root',
      children: [
        orderedList([listItem(textParagraph('Define architecture'))]),
        unorderedList([
          listItem(textParagraph('Pick default backend')),
          listItem(textParagraph('Decide on fallbacks')),
        ]),
        orderedList([listItem(textParagraph('Centralize resolution'))]),
        unorderedList([
          listItem(textParagraph('Create helper')),
          listItem(textParagraph('Replace call sites')),
        ]),
        orderedList([listItem(textParagraph('Make migrations'))]),
        unorderedList([
          listItem(textParagraph('Apply to all')),
          listItem(textParagraph('Ensure consistency')),
        ]),
      ],
    }

    fixInterruptedOrderedLists(tree)

    expect(tree.children).toHaveLength(1)
    const ol = tree.children[0] as MdastParent
    expect(ol.type).toBe('list')
    expect(ol.ordered).toBe(true)
    expect(ol.children).toHaveLength(3)

    for (const item of ol.children) {
      const li = item as MdastParent
      expect(li.type).toBe('listItem')
      const nested = li.children[li.children.length - 1] as MdastParent
      expect(nested.type).toBe('list')
      expect(nested.ordered).toBe(false)
      expect(nested.children.length).toBe(2)
    }
  })

  it('merges when sequential numbers are used after interruption', () => {
    const tree: MdastParent = {
      type: 'root',
      children: [
        orderedList([listItem(textParagraph('First'))], 1),
        unorderedList([
          listItem(textParagraph('a')),
          listItem(textParagraph('b')),
        ]),
        orderedList([listItem(textParagraph('Second'))], 2),
        unorderedList([listItem(textParagraph('c'))]),
        orderedList([listItem(textParagraph('Third'))], 3),
      ],
    }

    fixInterruptedOrderedLists(tree)

    expect(tree.children).toHaveLength(1)
    const ol = tree.children[0] as MdastParent
    expect(ol.children).toHaveLength(3)
  })

  it('leaves a single ordered list with already-nested bullets unchanged', () => {
    const nestedUl = unorderedList([
      listItem(textParagraph('a')),
      listItem(textParagraph('b')),
    ])
    const tree: MdastParent = {
      type: 'root',
      children: [
        orderedList([
          listItem(textParagraph('First'), nestedUl),
          listItem(
            textParagraph('Second'),
            unorderedList([listItem(textParagraph('c'))])
          ),
          listItem(textParagraph('Third')),
        ]),
      ],
    }

    const before = JSON.stringify(tree)
    fixInterruptedOrderedLists(tree)
    expect(JSON.stringify(tree)).toBe(before)
  })

  it('does not merge when a non-list node separates ordered lists', () => {
    const tree: MdastParent = {
      type: 'root',
      children: [
        orderedList([listItem(textParagraph('First'))]),
        textParagraph('Interlude'),
        orderedList([listItem(textParagraph('Second'))], 2),
      ],
    }

    fixInterruptedOrderedLists(tree)

    expect(tree.children).toHaveLength(3)
    expect((tree.children[0] as MdastParent).ordered).toBe(true)
    expect(tree.children[1]?.type).toBe('paragraph')
    expect((tree.children[2] as MdastParent).start).toBe(2)
  })

  it('does not steal a following ul when the last item already has a nested list', () => {
    const tree: MdastParent = {
      type: 'root',
      children: [
        orderedList([
          listItem(
            textParagraph('A'),
            unorderedList([listItem(textParagraph('nested'))])
          ),
        ]),
        unorderedList([listItem(textParagraph('sibling bullets'))]),
        orderedList([listItem(textParagraph('B'))]),
      ],
    }

    fixInterruptedOrderedLists(tree)

    expect(tree.children).toHaveLength(3)
  })

  it('nests a trailing unordered list under the last ordered item', () => {
    const tree: MdastParent = {
      type: 'root',
      children: [
        orderedList([listItem(textParagraph('Only parent'))]),
        unorderedList([
          listItem(textParagraph('child a')),
          listItem(textParagraph('child b')),
        ]),
      ],
    }

    fixInterruptedOrderedLists(tree)

    expect(tree.children).toHaveLength(1)
    const ol = tree.children[0] as MdastParent
    const li = ol.children[0] as MdastParent
    const nested = li.children[li.children.length - 1] as MdastParent
    expect(nested.type).toBe('list')
    expect(nested.ordered).toBe(false)
    expect(nested.children).toHaveLength(2)
  })
})
