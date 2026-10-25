import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BROWSER_CLIENT_ID_KEY,
  getOrCreateBrowserClientId,
  isClientId,
  resetClientIdForTests,
} from './client-session'

describe('browser client id', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    resetClientIdForTests()
    vi.mocked(localStorage.getItem).mockImplementation(
      key => storage.get(key) ?? null
    )
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      storage.set(key, value)
    })
  })

  it('keeps one id for the browser profile', () => {
    const first = getOrCreateBrowserClientId()
    expect(isClientId(first)).toBe(true)
    expect(localStorage.getItem(BROWSER_CLIENT_ID_KEY)).toBe(first)
    expect(getOrCreateBrowserClientId()).toBe(first)
  })

  it('replaces a stored id that is not a client id', () => {
    localStorage.setItem(BROWSER_CLIENT_ID_KEY, '../ui-state')
    const id = getOrCreateBrowserClientId()
    expect(isClientId(id)).toBe(true)
    expect(id).not.toBe('../ui-state')
  })
})
