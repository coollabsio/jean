/**
 * remark plugin: nest interrupting sibling unordered lists under the preceding
 * ordered-list item and merge the split ordered lists back together.
 *
 * LLMs often emit:
 *
 *   1. Parent A
 *   - child
 *   - child
 *
 *   1. Parent B
 *   - child
 *
 * CommonMark treats the unindented `-` lines as a sibling list that ends the
 * ordered list. Each subsequent `1.` then starts a fresh `<ol>`, so the UI
 * shows 1, 1, 1 instead of 1, 2, 3 (GitHub issue #200).
 *
 * Properly indented nested bullets already parse as one list and are left alone.
 */

export interface MdastNode {
  type: string
  children?: MdastNode[]
  ordered?: boolean
  start?: number | null
  spread?: boolean | null
  checked?: boolean | null
  [key: string]: unknown
}

export interface MdastParent extends MdastNode {
  children: MdastNode[]
}

function isList(node: MdastNode | undefined): node is MdastParent {
  return node?.type === 'list' && Array.isArray(node.children)
}

function isOrderedList(node: MdastNode | undefined): node is MdastParent {
  return isList(node) && node.ordered === true
}

function isUnorderedList(node: MdastNode | undefined): node is MdastParent {
  return isList(node) && node.ordered !== true
}

function lastListItem(list: MdastParent): MdastParent | null {
  const items = list.children
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.type === 'listItem' && Array.isArray(item.children)) {
      return item as MdastParent
    }
  }
  return null
}

/**
 * True when `list` already ends with a nested list — further sibling ULs are
 * more likely intentional separate lists than orphaned nested content.
 */
function lastItemAlreadyHasNestedList(list: MdastParent): boolean {
  const item = lastListItem(list)
  if (!item) return false
  const lastChild = item.children[item.children.length - 1]
  return isList(lastChild)
}

/**
 * Merge ordered lists that were split only by intervening unordered lists.
 * Mutates the tree in place (remark plugin convention).
 */
export function fixInterruptedOrderedLists(tree: MdastParent): void {
  if (!Array.isArray(tree.children) || tree.children.length < 2) return

  // Recurse into block containers so nested content is handled too.
  for (const child of tree.children) {
    if (child && Array.isArray(child.children) && child.type !== 'list') {
      fixInterruptedOrderedLists(child as MdastParent)
    }
  }

  const out: MdastNode[] = []
  let i = 0
  const children = tree.children

  while (i < children.length) {
    const node = children[i]
    if (!node) {
      i++
      continue
    }

    if (!isOrderedList(node)) {
      out.push(node)
      i++
      continue
    }

    // Absorb following `ul, ol` pairs (and a trailing `ul`) into this list.
    let j = i + 1
    while (j < children.length) {
      const maybeUl = children[j]
      if (!isUnorderedList(maybeUl)) break

      const maybeOl = children[j + 1]
      if (isOrderedList(maybeOl)) {
        if (lastItemAlreadyHasNestedList(node)) break

        const lastItem = lastListItem(node)
        if (!lastItem) break

        lastItem.children.push(maybeUl)
        // Merged items continue the same ordered list; ignore source start
        // values that all say "1." (the LLM restart pattern).
        node.children.push(...maybeOl.children)
        if (node.spread || maybeOl.spread) {
          node.spread = true
        }
        j += 2
        continue
      }

      // Trailing unordered list after an ordered list (end of section).
      if (j === children.length - 1 || !isOrderedList(children[j + 1])) {
        if (!lastItemAlreadyHasNestedList(node)) {
          const lastItem = lastListItem(node)
          if (lastItem) {
            lastItem.children.push(maybeUl)
            j += 1
          }
        }
      }
      break
    }

    out.push(node)
    i = j > i ? j : i + 1
  }

  tree.children = out
}

/**
 * remark plugin factory.
 */
export function remarkFixInterruptedLists() {
  return (tree: MdastParent) => {
    fixInterruptedOrderedLists(tree)
  }
}
