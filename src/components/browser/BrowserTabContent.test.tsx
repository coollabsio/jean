import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { render } from '@/test/test-utils'
import { BrowserTabContent } from './BrowserTabContent'

const browserBackendMock = vi.hoisted(() => ({
  create: vi.fn(),
  setBounds: vi.fn(),
  setVisible: vi.fn(),
  hasActive: vi.fn(),
  close: vi.fn(),
}))

const windowMock = vi.hoisted(() => ({
  onScaleChanged: vi.fn(),
}))

vi.mock('@/hooks/useBrowserPane', () => ({
  browserBackend: browserBackendMock,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMock,
}))

class ResizeObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
}

describe('BrowserTabContent', () => {
  beforeEach(() => {
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() })
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    browserBackendMock.create.mockResolvedValue(undefined)
    browserBackendMock.setBounds.mockResolvedValue(undefined)
    browserBackendMock.setVisible.mockResolvedValue(undefined)
    browserBackendMock.hasActive.mockResolvedValue(false)
    browserBackendMock.close.mockResolvedValue(undefined)
    windowMock.onScaleChanged.mockResolvedValue(vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('does not park a tab on unmount after the backend tab is already closed', async () => {
    const { unmount } = render(
      <BrowserTabContent tabId="tab-1" isActive={false} />
    )

    unmount()

    await waitFor(() => {
      expect(browserBackendMock.hasActive).toHaveBeenCalledWith('tab-1')
    })
    expect(browserBackendMock.setBounds).not.toHaveBeenCalled()
    expect(browserBackendMock.setVisible).not.toHaveBeenCalled()
  })

  it('cleans up a scale listener that finishes registering after unmount', async () => {
    let finishRegistration: ((listener: () => void) => void) | undefined
    const listener = vi.fn().mockRejectedValue(
      new Error("undefined is not an object (evaluating 'listeners[eventId].handlerId')")
    )
    windowMock.onScaleChanged.mockReturnValue(
      new Promise(resolve => {
        finishRegistration = resolve
      })
    )

    const { unmount } = render(
      <BrowserTabContent tabId="tab-1" isActive={false} />
    )
    unmount()
    finishRegistration?.(listener)

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
  })
})
