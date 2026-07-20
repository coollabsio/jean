import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import type * as TransportModule from '@/lib/transport'
import { CloneProjectModal } from './CloneProjectModal'
import { useProjectsStore } from '@/store/projects-store'
import {
  addRemoteConnection,
  selectConnection,
  LOCAL_CONNECTION_ID,
} from '@/lib/remote-connections'

const saveMock = vi.fn()
const browseDirectoryMock = vi.fn()

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => saveMock(...args),
}))

vi.mock('@/lib/transport', async () => {
  const actual =
    await vi.importActual<typeof TransportModule>('@/lib/transport')
  return {
    ...actual,
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'browse_directory') {
        return browseDirectoryMock(args)
      }
      return actual.invoke(cmd, args)
    },
  }
})

describe('CloneProjectModal', () => {
  const longDestination =
    '/Users/stacylia/Developer/coolify/this is a long name for a folder'

  beforeEach(() => {
    vi.clearAllMocks()
    saveMock.mockResolvedValue(longDestination)
    browseDirectoryMock.mockResolvedValue({
      current_path: '/remote/home',
      parent_path: '/remote',
      entries: [
        {
          name: 'projects',
          path: '/remote/home/projects',
          is_dir: true,
          is_git_repo: false,
          is_hidden: false,
        },
      ],
    })
    ;(
      window as unknown as { __TAURI_INTERNALS__?: { invoke: () => void } }
    ).__TAURI_INTERNALS__ = { invoke: vi.fn() }
    selectConnection(LOCAL_CONNECTION_ID)
    useProjectsStore.setState({
      cloneModalOpen: true,
      addProjectDialogOpen: true,
      addProjectParentFolderId: null,
    })
  })

  it('keeps long destination paths constrained and accessible', async () => {
    render(<CloneProjectModal />)

    const destinationButton = screen.getByRole('button', {
      name: /choose destination/i,
    })

    await userEvent.click(destinationButton)

    const updatedDestinationButton = await screen.findByRole('button', {
      name: longDestination,
    })
    const destinationText = within(updatedDestinationButton).getByText(
      longDestination
    )
    const destinationPreview = screen.getByText(longDestination, {
      selector: 'p',
    })

    expect(updatedDestinationButton).toHaveClass(
      'min-w-0',
      'flex-1',
      'overflow-hidden'
    )
    expect(updatedDestinationButton).toHaveAttribute('title', longDestination)
    expect(destinationText).toHaveClass(
      'min-w-0',
      'flex-1',
      'truncate',
      'text-left'
    )
    expect(destinationPreview).toHaveClass('max-w-full', 'truncate')
    expect(destinationPreview).toHaveAttribute('title', longDestination)
    expect(saveMock).toHaveBeenCalled()
  })

  it('opens the remote directory browser when connected to a remote backend', async () => {
    const remote = addRemoteConnection({
      name: 'Remote host',
      url: 'https://remote.example.com',
      token: 'test-token',
    })
    selectConnection(remote.id)

    render(<CloneProjectModal />)

    await userEvent.click(
      screen.getByRole('button', {
        name: /choose destination/i,
      })
    )

    expect(
      await screen.findByRole('heading', { name: /choose clone destination/i })
    ).toBeInTheDocument()
    expect(saveMock).not.toHaveBeenCalled()
    expect(browseDirectoryMock).toHaveBeenCalled()
  })
})
