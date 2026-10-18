import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadProjectCanvasSortModes,
  saveProjectCanvasSortModes,
} from './project-canvas-settings'

describe('project canvas settings', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    vi.mocked(localStorage.getItem).mockImplementation(
      key => storage.get(key) ?? null
    )
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      storage.set(key, value)
    })
  })

  it('persists sort modes by scoped project id in client storage', () => {
    saveProjectCanvasSortModes({
      'server-1:project-1': 'last_activity',
      'server-2:project-1': 'manual',
    })

    expect(loadProjectCanvasSortModes()).toEqual({
      'server-1:project-1': 'last_activity',
      'server-2:project-1': 'manual',
    })
  })

  it('ignores invalid saved values', () => {
    localStorage.setItem(
      'jean-project-canvas-sort-modes-v1',
      JSON.stringify({ valid: 'created', invalid: 'newest' })
    )

    expect(loadProjectCanvasSortModes()).toEqual({ valid: 'created' })
  })
})
