import { useState } from 'react'

/**
 * Local edit state for a saved value.
 *
 * When the saved value changes (a save, or an edit from another client), an
 * untouched draft follows it. A draft with local edits is kept. The last seen
 * saved value is always updated, so later changes are compared against it.
 */
export function useSavedDraft<T>(
  saved: T,
  same: (left: T, right: T) => boolean
): [T, (value: T) => void] {
  const [draft, setDraft] = useState<T>(saved)
  const [seen, setSeen] = useState<T>(saved)
  if (!same(seen, saved)) {
    if (same(draft, seen)) setDraft(saved)
    setSeen(saved)
  }
  return [draft, setDraft]
}
