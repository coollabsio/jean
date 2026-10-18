import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

describe('fetchUnreadSessionCount', () => {
  beforeEach(() => invoke.mockReset())

  it('returns the backend count without loading all sessions', async () => {
    invoke.mockResolvedValueOnce(4)
    const { fetchUnreadSessionCount } = await import('./chat')

    await expect(fetchUnreadSessionCount()).resolves.toBe(4)
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('get_unread_session_count')
  })

  it('keeps transport failures as query errors instead of unread zero', async () => {
    const error = new Error('transport unavailable')
    invoke.mockRejectedValueOnce(error)
    const { fetchUnreadSessionCount } = await import('./chat')

    await expect(fetchUnreadSessionCount()).rejects.toBe(error)
  })
})
