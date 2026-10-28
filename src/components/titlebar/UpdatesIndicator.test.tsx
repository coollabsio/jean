import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { UpdatesIndicator } from './UpdatesIndicator'
import type * as EnvironmentModule from '@/lib/environment'

const mocks = vi.hoisted(() => ({ applyServerUpdate: vi.fn() }))
vi.mock('@/hooks/useServerUpdateCheck', () => ({
  applyServerUpdate: mocks.applyServerUpdate,
}))
vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  updateTargetLabel: () => 'Local',
}))

const openMenu = () => userEvent.click(screen.getByTestId('updates-indicator'))

describe('UpdatesIndicator', () => {
  beforeEach(() => {
    mocks.applyServerUpdate.mockReset()
    useUIStore.setState({
      pendingUpdateVersion: null,
      updateReadyVersion: null,
      isUpdateInstalling: false,
      pendingServerUpdate: null,
      minimizedCliUpdate: null,
      availableCliUpdates: [],
      cliUpdateModalOpen: false,
      cliUpdateModalType: null,
    })
  })

  it('renders nothing without pending updates', () => {
    render(<UpdatesIndicator />)

    expect(screen.queryByTestId('updates-indicator')).toBeNull()
  })

  it('collapses app, server and CLI updates into one trigger', async () => {
    useUIStore.setState({
      updateReadyVersion: '2.0.0',
      pendingServerUpdate: {
        latestVersion: '1.5.0',
        currentVersion: '1.4.0',
        canUpdate: true,
      },
      availableCliUpdates: [
        { type: 'codex', currentVersion: '0.1.0', latestVersion: '0.2.0' },
      ],
    })
    render(<UpdatesIndicator />)

    expect(screen.getByTestId('updates-indicator')).toHaveTextContent(
      '3 updates'
    )
    await openMenu()
    expect(screen.getByText('Restart to apply v2.0.0 · Local')).toBeVisible()
    expect(screen.getByText('Local · v1.4.0 → v1.5.0')).toBeVisible()
    expect(screen.getByText('Local · v0.1.0 → v0.2.0')).toBeVisible()
  })

  it('installs the app update like the old pill', async () => {
    const onInstall = vi.fn()
    window.addEventListener('install-pending-update', onInstall)
    useUIStore.setState({ pendingUpdateVersion: '2.0.0' })
    render(<UpdatesIndicator />)

    await openMenu()
    await userEvent.click(screen.getByText('Update to v2.0.0 · Local'))

    expect(onInstall).toHaveBeenCalledTimes(1)
    window.removeEventListener('install-pending-update', onInstall)
  })

  it('applies a self-updatable server update', async () => {
    useUIStore.setState({
      pendingServerUpdate: {
        latestVersion: '1.5.0',
        currentVersion: '1.4.0',
        canUpdate: true,
      },
    })
    render(<UpdatesIndicator />)

    await openMenu()
    await userEvent.click(screen.getByText('jean-server'))

    expect(mocks.applyServerUpdate).toHaveBeenCalledWith('1.5.0')
  })

  it('opens the CLI update modal and clears the notice', async () => {
    useUIStore.setState({
      availableCliUpdates: [
        {
          type: 'codex',
          currentVersion: '0.1.0',
          latestVersion: '0.2.0',
          cliSource: 'jean',
        },
      ],
    })
    render(<UpdatesIndicator />)

    await openMenu()
    await userEvent.click(screen.getByText('Local · v0.1.0 → v0.2.0'))

    expect(useUIStore.getState().cliUpdateModalType).toBe('codex')
    expect(useUIStore.getState().availableCliUpdates).toEqual([])
  })

  it('dismisses a CLI update without opening the modal', async () => {
    useUIStore.setState({
      availableCliUpdates: [
        { type: 'codex', currentVersion: '0.1.0', latestVersion: '0.2.0' },
      ],
    })
    render(<UpdatesIndicator />)

    await openMenu()
    await userEvent.click(
      screen.getByRole('button', { name: /^Dismiss .* update$/ })
    )

    expect(useUIStore.getState().availableCliUpdates).toEqual([])
    expect(useUIStore.getState().cliUpdateModalOpen).toBe(false)
    expect(screen.queryByTestId('updates-indicator')).toBeNull()
  })

  it('shows minimized CLI progress and restores its modal', async () => {
    useUIStore.getState().setMinimizedCliUpdate({
      type: 'codex',
      name: 'Codex CLI',
      target: 'Remote: devbox',
      kind: 'reinstall',
      progress: 42,
    })
    render(<UpdatesIndicator />)

    expect(screen.getByTestId('updates-indicator')).toHaveTextContent('Update')
    await openMenu()
    await userEvent.click(screen.getByText('Remote: devbox · 42%'))

    expect(useUIStore.getState().minimizedCliUpdate).toBeNull()
  })

  it('keeps a downloading app update listed but inert', async () => {
    useUIStore.setState({
      pendingUpdateVersion: '2.0.0',
      isUpdateInstalling: true,
    })
    render(<UpdatesIndicator />)

    await openMenu()
    expect(
      screen.getByText('Downloading v2.0.0… · Local').closest('button')
    ).toBeDisabled()
  })
})
