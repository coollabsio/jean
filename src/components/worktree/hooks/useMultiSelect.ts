import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Multi-select state for New Session list tabs.
 * Selection keys that drop out of the visible list are pruned automatically.
 */
export function useMultiSelect<T, K extends string | number>(
  items: T[],
  getKey: (item: T) => K
) {
  const [checkedKeys, setCheckedKeys] = useState<Set<K>>(() => new Set())

  const visibleKeys = useMemo(
    () => items.map(item => getKey(item)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getKey is expected to be stable (property access)
    [items]
  )

  useEffect(() => {
    const visible = new Set(visibleKeys)
    setCheckedKeys(prev => {
      let changed = false
      const next = new Set<K>()
      for (const key of prev) {
        if (visible.has(key)) next.add(key)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [visibleKeys])

  const checkedCount = checkedKeys.size
  const showBulkBar = checkedCount >= 1

  const allVisibleChecked =
    visibleKeys.length > 0 && visibleKeys.every(key => checkedKeys.has(key))
  const someVisibleChecked =
    visibleKeys.some(key => checkedKeys.has(key)) && !allVisibleChecked

  const toggle = useCallback((key: K, checked: boolean) => {
    setCheckedKeys(prev => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const toggleAllVisible = useCallback(
    (checked: boolean) => {
      setCheckedKeys(prev => {
        const next = new Set(prev)
        if (checked) {
          for (const key of visibleKeys) next.add(key)
        } else {
          for (const key of visibleKeys) next.delete(key)
        }
        return next
      })
    },
    [visibleKeys]
  )

  const clear = useCallback(() => {
    setCheckedKeys(new Set())
  }, [])

  const isChecked = useCallback(
    (key: K) => checkedKeys.has(key),
    [checkedKeys]
  )

  const selectedItems = useMemo(
    () => items.filter(item => checkedKeys.has(getKey(item))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getKey is expected to be stable
    [items, checkedKeys]
  )

  return {
    checkedCount,
    showBulkBar,
    allVisibleChecked,
    someVisibleChecked,
    toggle,
    toggleAllVisible,
    clear,
    isChecked,
    selectedItems,
  }
}
