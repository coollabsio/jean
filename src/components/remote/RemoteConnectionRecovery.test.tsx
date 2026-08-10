import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RemoteConnectionRecovery } from './RemoteConnectionRecovery'

const dismissTransientUi = vi.fn()

vi.mock('@/lib/dismiss-transient-ui', () => ({
  dismissTransientUi: () => dismissTransientUi(),
}))

vi.mock('@/lib/remote-connections', () => ({
  LOCAL_CONNECTION_ID: 'local',
  markConnectionSwitch: vi.fn(),
  selectConnection: vi.fn(),
}))

describe('RemoteConnectionRecovery', () => {
  beforeEach(() => {
    dismissTransientUi.mockClear()
  })

  it('dismisses open overlays on mount so recovery stays interactive', () => {
    render(
      <RemoteConnectionRecovery
        connection={{
          id: 'remote-1',
          name: 'Lab',
          url: 'https://lab.example',
          token: 'tok',
        }}
        error="Connection to the selected Jean server was lost."
      />
    )

    expect(dismissTransientUi).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: /Couldn't connect to Lab/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Switch to Local' })
    ).toBeInTheDocument()
  })

  it('uses a z-index above dialogs and menus', () => {
    const { container } = render(
      <RemoteConnectionRecovery
        connection={{
          id: 'remote-1',
          name: 'Lab',
          url: 'https://lab.example',
          token: 'tok',
        }}
        error="lost"
      />
    )

    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('z-[100]')
  })

  it('automatically retries the connection every 10 seconds', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')

    const { unmount } = render(
      <RemoteConnectionRecovery
        connection={{
          id: 'remote-1',
          name: 'Lab',
          url: 'https://lab.example',
          token: 'tok',
        }}
        error="lost"
      />
    )

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000)

    unmount()
    setIntervalSpy.mockRestore()
  })
})
