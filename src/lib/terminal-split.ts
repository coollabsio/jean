/**
 * Pure helpers for the terminal split-pane layout tree.
 *
 * A split layout is an immutable tree of leaves (one terminal each) and split
 * nodes (horizontal/vertical groups of children). Layouts live in session
 * memory only (terminal-store) and are never persisted — they describe a
 * temporary tiling of the terminals that already exist for a worktree/session.
 *
 * All functions are pure: they return a new tree only when something changed,
 * otherwise they return the same reference (so the store's no-op guards hold).
 */

export type SplitOrientation = 'horizontal' | 'vertical'

export type SplitNode =
  | { type: 'leaf'; terminalId: string }
  | {
      type: 'split'
      orientation: SplitOrientation
      children: SplitNode[]
      /** Panel sizes in percent, one per child. Undefined = equal split. */
      sizes?: number[]
    }

/** Build a single-leaf layout. */
export function leaf(terminalId: string): SplitNode {
  return { type: 'leaf', terminalId }
}

/** All terminal IDs in the tree, left-to-right / top-to-bottom order. */
export function collectLeafIds(node: SplitNode): string[] {
  if (node.type === 'leaf') return [node.terminalId]
  return node.children.flatMap(collectLeafIds)
}

/** Whether the tree contains a leaf for this terminal. */
export function hasLeaf(node: SplitNode, terminalId: string): boolean {
  if (node.type === 'leaf') return node.terminalId === terminalId
  return node.children.some(child => hasLeaf(child, terminalId))
}

/** The first (top-left-most) leaf's terminal ID. */
export function firstLeafId(node: SplitNode): string {
  let current = node
  while (current.type === 'split') {
    current = current.children[0] as SplitNode
  }
  return current.terminalId
}

/** Number of leaves (panes) in the tree. */
export function countLeaves(node: SplitNode): number {
  if (node.type === 'leaf') return 1
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0)
}

/**
 * Replace the leaf for `targetTerminalId` with a split that contains the old
 * leaf and a new leaf for `newTerminalId`. Returns the same node reference if
 * the target leaf is not present.
 */
export function splitLeaf(
  node: SplitNode,
  targetTerminalId: string,
  orientation: SplitOrientation,
  newTerminalId: string
): SplitNode {
  if (node.type === 'leaf') {
    if (node.terminalId !== targetTerminalId) return node
    return {
      type: 'split',
      orientation,
      children: [leaf(targetTerminalId), leaf(newTerminalId)],
      // Explicit 50/50 so react-resizable-panels has concrete sizes on first
      // mount (avoids a transient layout where the divider is invisible).
      sizes: [50, 50],
    }
  }

  let changed = false
  const children = node.children.map(child => {
    const next = splitLeaf(child, targetTerminalId, orientation, newTerminalId)
    if (next !== child) changed = true
    return next
  })
  if (!changed) return node
  // Replacing a leaf child with a split child keeps the child count, so the
  // parent's `sizes` array stays valid.
  return { ...node, children }
}

/**
 * Remove the leaf for `terminalId`. Split nodes left with a single child
 * collapse into that child. Returns null when the whole tree is removed, or
 * the same reference when the terminal was not present.
 */
export function pruneLeaf(
  node: SplitNode,
  terminalId: string
): SplitNode | null {
  if (node.type === 'leaf') {
    return node.terminalId === terminalId ? null : node
  }

  let changed = false
  const kept: { child: SplitNode; index: number }[] = []
  node.children.forEach((child, index) => {
    const pruned = pruneLeaf(child, terminalId)
    if (pruned === null) {
      changed = true
      return
    }
    if (pruned !== child) changed = true
    kept.push({ child: pruned, index })
  })

  if (!changed) return node
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0]?.child ?? null

  const children = kept.map(entry => entry.child)
  let sizes = node.sizes
  if (sizes && children.length !== node.children.length) {
    const picked = kept.map(entry => node.sizes?.[entry.index] ?? 0)
    const total = picked.reduce((sum, value) => sum + value, 0)
    sizes = total > 0 ? picked.map(value => (value / total) * 100) : undefined
  }
  return { ...node, children, sizes }
}

/**
 * Set the `sizes` array of the split node at `path` (a list of child indices
 * from the root). Returns the same reference when nothing changed.
 */
export function setSizesAtPath(
  node: SplitNode,
  path: number[],
  sizes: number[]
): SplitNode {
  if (path.length === 0) {
    if (node.type !== 'split') return node
    if (sizesEqual(node.sizes, sizes)) return node
    return { ...node, sizes }
  }
  if (node.type !== 'split') return node
  const [head, ...rest] = path
  if (head === undefined) return node
  const child = node.children[head]
  if (!child) return node
  const next = setSizesAtPath(child, rest, sizes)
  if (next === child) return node
  const children = [...node.children]
  children[head] = next
  return { ...node, children }
}

function sizesEqual(a: number[] | undefined, b: number[]): boolean {
  if (!a || a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}
