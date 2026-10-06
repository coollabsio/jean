import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve())
const viewedMock = vi.fn((_sessionId: string) => true)

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
vi.mock('@/lib/session-notifications', () => ({
  isSessionCurrentlyViewed: (sessionId: string) => viewedMock(sessionId),
}))

import { markSessionOpenedWhenSeen } from './session-read'

describe('markSessionOpenedWhenSeen', () => {
  let focused = true

  beforeEach(() => {
    focused = true
    invokeMock.mockClear()
    viewedMock.mockReset().mockReturnValue(true)
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks the session read at once when the window has focus', () => {
    markSessionOpenedWhenSeen('s1')
    expect(invokeMock).toHaveBeenCalledWith('set_session_last_opened', {
      sessionId: 's1',
    })
  })

  it('keeps the session unread while the window has no focus', () => {
    focused = false
    markSessionOpenedWhenSeen('s1')
    expect(invokeMock).not.toHaveBeenCalled()

    focused = true
    window.dispatchEvent(new Event('focus'))
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('set_session_last_opened', {
      sessionId: 's1',
    })

    // The pending entry is used once.
    window.dispatchEvent(new Event('focus'))
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('does not mark read on focus when the session is no longer on screen', () => {
    focused = false
    markSessionOpenedWhenSeen('s1')
    viewedMock.mockReturnValue(false)

    focused = true
    window.dispatchEvent(new Event('focus'))
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
