import { describe, expect, it } from 'vitest'
import { mergeMuseModels, toMuseModelValue } from './muse-cli'

describe('toMuseModelValue', () => {
  it('prefixes bare ids and keeps prefixed ids', () => {
    expect(toMuseModelValue('muse-spark-1.2')).toBe('muse/muse-spark-1.2')
    expect(toMuseModelValue('muse/default')).toBe('muse/default')
  })
})

describe('mergeMuseModels', () => {
  it('keeps the fallback rows when the backend returns none', () => {
    expect(mergeMuseModels([])).toEqual([
      { id: 'muse/default', label: 'Default', isDefault: true },
      { id: 'muse/muse-spark-1.2', label: 'Muse Spark 1.2' },
    ])
  })

  it('overrides fallback labels and appends new backend models', () => {
    expect(
      mergeMuseModels([
        { id: 'muse-spark-1.2', label: 'Spark 1.2 (server)' },
        { id: 'muse/muse-pro-2', label: 'Muse Pro 2' },
      ])
    ).toEqual([
      { id: 'muse/default', label: 'Default', isDefault: true },
      { id: 'muse/muse-spark-1.2', label: 'Spark 1.2 (server)' },
      { id: 'muse/muse-pro-2', label: 'Muse Pro 2' },
    ])
  })
})
