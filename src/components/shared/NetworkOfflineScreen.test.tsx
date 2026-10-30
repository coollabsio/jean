import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetworkOfflineScreen } from './NetworkOfflineScreen'

function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online)
  window.dispatchEvent(new Event(online ? 'online' : 'offline'))
}

describe('NetworkOfflineScreen', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders nothing while online', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<NetworkOfflineScreen />)
    expect(screen.queryByTestId('network-offline-screen')).toBeNull()
  })

  it('shows when the network drops and hides when it returns', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    render(<NetworkOfflineScreen />)

    act(() => setOnline(false))
    expect(screen.getByText('You are offline')).toBeTruthy()

    act(() => setOnline(true))
    expect(screen.queryByTestId('network-offline-screen')).toBeNull()
  })

  it('shows on start when already offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<NetworkOfflineScreen />)
    expect(screen.getByTestId('network-offline-screen')).toBeTruthy()
  })
})
