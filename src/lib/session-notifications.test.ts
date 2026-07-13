import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@/lib/transport'
import { notifyIfBackground } from './session-notifications'

const environment = vi.hoisted(() => ({ native: true }))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('./environment', () => ({
  isNativeApp: () => environment.native,
}))

describe('notifyIfBackground', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    environment.native = true
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('lets the native backend decide whether the window is backgrounded', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    notifyIfBackground('Session finished', 'Fix notifications')

    expect(invoke).toHaveBeenCalledWith('send_native_notification', {
      title: 'Session finished',
      body: 'Fix notifications',
      backgroundOnly: true,
    })
  })

  it('does not invoke the desktop command in web access', () => {
    environment.native = false

    notifyIfBackground('Session finished')

    expect(invoke).not.toHaveBeenCalled()
  })
})
