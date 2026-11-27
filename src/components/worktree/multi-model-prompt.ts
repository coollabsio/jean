import type { CliBackend } from '@/types/preferences'
import type { BackendModelSection } from '@/components/chat/toolbar/useToolbarDerivedState'

export const MIN_PROMPT_MODELS = 2
export const MAX_PROMPT_MODELS = 6

export interface PromptModelRow {
  /** `backend:model`, the same key as `favorite_models`. */
  key: string
  backend: CliBackend
  model: string
  label: string
}

export interface PromptModelGroup {
  id: string
  label: string
  rows: PromptModelRow[]
}

/** Favorites first (in favorite order), then every other model by backend. */
export function buildPromptModelGroups(
  sections: BackendModelSection[],
  favoriteKeys: readonly string[]
): PromptModelGroup[] {
  const rowsByKey = new Map<string, PromptModelRow>()
  for (const section of sections) {
    for (const option of section.options) {
      const key = `${section.backend}:${option.value}`
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, {
          key,
          backend: section.backend,
          model: option.value,
          label: option.label,
        })
      }
    }
  }
  const favorites = favoriteKeys.flatMap(key => {
    const row = rowsByKey.get(key)
    return row ? [row] : []
  })
  const favoriteSet = new Set(favorites.map(row => row.key))
  const groups: PromptModelGroup[] = favorites.length
    ? [{ id: 'favorites', label: 'Favorites', rows: favorites }]
    : []
  for (const section of sections) {
    const rows = [...rowsByKey.values()].filter(
      row => row.backend === section.backend && !favoriteSet.has(row.key)
    )
    if (rows.length) {
      groups.push({ id: section.backend, label: section.label, rows })
    }
  }
  return groups
}

/** Toggle one model; adding past the limit is a no-op. */
export function togglePromptModel(
  selected: readonly string[],
  key: string
): string[] {
  if (selected.includes(key)) return selected.filter(k => k !== key)
  if (selected.length >= MAX_PROMPT_MODELS) return [...selected]
  return [...selected, key]
}
