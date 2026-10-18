import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { CloneProjectModal } from './CloneProjectModal'
import { useProjectsStore } from '@/store/projects-store'
import {
  addRemoteConnection,
  selectConnection,
  LOCAL_CONNECTION_ID,
} from '@/lib/remote-connections'
import { rememberProjectDestination } from '@/lib/project-destination'

const saveMock = vi.fn()
const browseDirectoryMock = vi.fn()

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => saveMock(...args),
}))

vi.mock('@/lib/transport', async () => {
  const actual = (await vi.importActual('@/lib/transport')) as {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  } & Record<string, unknown>
  return {
    ...actual,
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'browse_directory') {
        return browseDirectoryMock(args)
      }
      return actual.invoke(cmd, args)
    },
    invokeForServer: (
      _serverId: string,
      cmd: string,
      args?: Record<string, unknown>
    ) => {
      if (cmd === 'browse_directory') return browseDirectoryMock(args)
      return actual.invoke(cmd, args)
    },
  }
})

describe('CloneProjectModal', () => {
  const longDestination =
    '/Users/stacylia/Developer/coolify/this is a long name for a folder'
  const storage = new Map<string, string>()

  beforeEach(() => {
    vi.clearAllMocks()
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    HTMLElement.prototype.scrollIntoView = vi.fn()
    storage.clear()
    vi.mocked(localStorage.getItem).mockImplementation(
      key => storage.get(key) ?? null
    )
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      storage.set(key, value)
    })
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
      selectedProjectId: null,
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

  it('opens the remote directory browser for the selected remote project', async () => {
    const remote = addRemoteConnection({
      name: 'Remote host',
      url: 'https://remote.example.com',
      token: 'test-token',
    })
    useProjectsStore.setState({
      selectedProjectId: `${remote.id}:project-1`,
    })

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

  it('prefills the destination saved for the selected Jean instance', async () => {
    const remote = addRemoteConnection({
      name: 'Remote host',
      url: 'https://remote.example.com',
      token: 'test-token',
    })
    rememberProjectDestination('local', '/Users/me/code/local-project')
    rememberProjectDestination(remote.id, '/home/me/apps/previous-project')
    useProjectsStore.setState({
      selectedProjectId: `${remote.id}:project-1`,
    })

    render(<CloneProjectModal />)
    await userEvent.type(
      screen.getByLabelText(/^repository$/i),
      'example/new-project.git'
    )

    expect(
      await screen.findByRole('button', {
        name: '/home/me/apps/new-project',
      })
    ).toBeInTheDocument()
  })

  it('offers GitHub, GitLab, and unrestricted custom URL modes', async () => {
    render(<CloneProjectModal />)

    const provider = screen.getByRole('combobox', { name: /git provider/i })
    expect(provider).toHaveTextContent('GitHub')
    expect(screen.getByLabelText(/^repository$/i)).toHaveAttribute(
      'placeholder',
      'user/repository'
    )

    await userEvent.click(provider)
    await userEvent.click(screen.getByRole('option', { name: 'GitLab' }))
    expect(provider).toHaveTextContent('GitLab')

    await userEvent.click(provider)
    await userEvent.click(screen.getByRole('option', { name: 'Custom' }))
    expect(screen.getByLabelText(/repository url/i)).toHaveAttribute(
      'placeholder',
      'https://example.com/user/repo.git'
    )
  })
})
