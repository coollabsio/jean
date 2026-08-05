import type { LabelData } from '@/types/chat'
import type { Worktree } from '@/types/projects'

export interface PinnedWorktreeLabelTab {
  value: `label:${string}`
  label: string
  labelName: string
  color: string
  count: number
}

export function getWorktreeLabels(
  worktree: Pick<Worktree, 'labels' | 'label'> | null | undefined
): LabelData[] {
  if (!worktree) return []
  const labels =
    worktree.labels && worktree.labels.length > 0
      ? worktree.labels
      : worktree.label
        ? [worktree.label]
        : []
  const seen = new Set<string>()
  const result: LabelData[] = []
  for (const label of labels) {
    const key = label.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(label)
  }
  return result
}

export function updateWorktreeLabelsByName(
  labels: LabelData[],
  labelName: string,
  newColor: string
): LabelData[] {
  const target = labelName.toLowerCase()
  return labels.map(label =>
    label.name.toLowerCase() === target ? { ...label, color: newColor } : label
  )
}

export function mergeLabelRegistry(
  registryLabels: LabelData[],
  assignedLabels: LabelData[]
): LabelData[] {
  const labelsByName = new Map<string, LabelData>()

  for (const label of registryLabels) {
    labelsByName.set(label.name.toLowerCase(), label)
  }

  for (const label of assignedLabels) {
    const key = label.name.toLowerCase()
    const existing = labelsByName.get(key)
    labelsByName.set(key, {
      ...(existing ?? label),
      color: label.color,
      pinned: label.pinned ?? existing?.pinned,
    })
  }

  return [...labelsByName.values()]
}

export function deleteLabelFromRegistry(
  registryLabels: LabelData[],
  labelName: string
): LabelData[] {
  const target = labelName.toLowerCase()
  return registryLabels.filter(label => label.name.toLowerCase() !== target)
}

export function removeLabelFromLabels(
  labels: LabelData[],
  labelName: string
): LabelData[] {
  const target = labelName.toLowerCase()
  return labels.filter(label => label.name.toLowerCase() !== target)
}

export function countWorktreesWithLabel(
  worktrees: Pick<Worktree, 'labels' | 'label' | 'status'>[],
  labelName: string
): number {
  const target = labelName.toLowerCase()
  return worktrees.filter(worktree => {
    if (worktree.status === 'deleting') return false
    return getWorktreeLabels(worktree).some(
      label => label.name.toLowerCase() === target
    )
  }).length
}

export function mergePinnedLabels(
  labels: LabelData[],
  pinnedLabels: LabelData[]
): LabelData[] {
  const pinnedByName = new Map(
    pinnedLabels.flatMap(label =>
      label.pinned ? [[label.name.toLowerCase(), label] as const] : []
    )
  )

  return labels.map(label => {
    const pinned = pinnedByName.get(label.name.toLowerCase())
    return pinned ? { ...label, pinned: true } : label
  })
}

export function setLabelPinned(
  pinnedLabels: LabelData[],
  label: LabelData,
  pinned: boolean
): LabelData[] {
  const key = label.name.toLowerCase()
  const withoutLabel = pinnedLabels.filter(
    existing => existing.name.toLowerCase() !== key
  )

  if (!pinned) return withoutLabel

  return [
    ...withoutLabel,
    {
      name: label.name,
      color: label.color,
      pinned: true,
    },
  ]
}

export function getPinnedWorktreeLabelTabs(
  worktrees: Pick<Worktree, 'labels' | 'label' | 'status'>[],
  pinnedLabels: LabelData[] = []
): PinnedWorktreeLabelTab[] {
  const tabs = new Map<string, PinnedWorktreeLabelTab>()

  for (const label of pinnedLabels) {
    if (!label.pinned) continue

    const key = label.name.toLowerCase()
    if (tabs.has(key)) continue

    tabs.set(key, {
      value: `label:${key}`,
      label: label.name,
      labelName: label.name,
      color: label.color,
      count: 0,
    })
  }

  // First collect which label names should be shown as pinned filter tabs.
  for (const worktree of worktrees) {
    if (worktree.status === 'deleting') continue

    for (const label of getWorktreeLabels(worktree)) {
      if (!label.pinned) continue

      const key = label.name.toLowerCase()
      if (tabs.has(key)) continue

      tabs.set(key, {
        value: `label:${key}`,
        label: label.name,
        labelName: label.name,
        color: label.color,
        count: 0,
      })
    }
  }

  // Then count all worktrees with those label names. Only one label instance
  // needs to be pinned to create the tab; the tab filter matches by label name.
  for (const worktree of worktrees) {
    if (worktree.status === 'deleting') continue

    const seenOnWorktree = new Set<string>()
    for (const label of getWorktreeLabels(worktree)) {
      const key = label.name.toLowerCase()
      const tab = tabs.get(key)
      if (!tab || seenOnWorktree.has(key)) continue

      seenOnWorktree.add(key)
      tab.count += 1
    }
  }

  return [...tabs.values()]
}
