import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLastProjectDestination,
  getParentDirectory,
  rememberProjectDestination,
} from './project-destination'

describe('project destination persistence', () => {
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

  it('keeps a separate last destination for each Jean instance', () => {
    rememberProjectDestination('local', '/Users/me/code/first-project')
    rememberProjectDestination('remote-1', '/home/me/apps/remote-project')

    expect(getLastProjectDestination('local')).toBe('/Users/me/code')
    expect(getLastProjectDestination('remote-1')).toBe('/home/me/apps')
    expect(getLastProjectDestination('remote-2')).toBeUndefined()
  })

  it('supports Windows project paths', () => {
    expect(getParentDirectory('C:\\Users\\me\\code\\project')).toBe(
      'C:\\Users\\me\\code'
    )
    expect(getParentDirectory('C:\\project')).toBe('C:\\')
    expect(getParentDirectory('/project')).toBe('/')
  })
})
