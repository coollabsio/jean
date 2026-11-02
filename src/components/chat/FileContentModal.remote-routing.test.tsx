import { render, screen, waitFor } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileContentModal } from './FileContentModal'

const { invokeForOptionalServer } = vi.hoisted(() => ({
  invokeForOptionalServer: vi.fn((serverId: string | undefined) =>
    Promise.resolve(serverId ? 'remote contents' : 'local contents')
  ),
}))

vi.mock('@/lib/transport', () => ({ invokeForOptionalServer }))
vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))
vi.mock('@/lib/environment', () => ({ canOpenInEditor: () => true }))
vi.mock('@/hooks/useSyntaxHighlighting', () => ({
  useSyntaxHighlighting: () => ({ html: '', isLoading: false, error: null }),
}))
vi.mock('@/components/ui/code-editor', () => ({
  default: () => <div data-testid="code-editor" />,
}))

describe('FileContentModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens a loaded text file in view mode', async () => {
    render(
      <FileContentModal
        filePath="/project/README.txt"
        serverId={undefined}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByText('local contents')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByTestId('code-editor')).not.toBeInTheDocument()
  })

  it('loads file content from the specified Jean server', async () => {
    render(
      <FileContentModal
        filePath="/srv/project/sponsors.json"
        serverId="remote-one"
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByText('remote contents')).toBeInTheDocument()
    expect(invokeForOptionalServer).toHaveBeenCalledWith(
      'remote-one',
      'read_file_content',
      { path: '/srv/project/sponsors.json' }
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open in Editor' })
    )
    expect(invokeForOptionalServer).toHaveBeenCalledWith(
      'remote-one',
      'open_file_in_default_app',
      { path: '/srv/project/sponsors.json', editor: undefined }
    )
  })

  it('offers the external editor for a local file', async () => {
    render(
      <FileContentModal
        filePath="/project/README.txt"
        serverId={undefined}
        onClose={vi.fn()}
      />
    )

    expect(
      await screen.findByRole('button', { name: 'Open in Editor' })
    ).toBeInTheDocument()
  })

  it('closes an image on the first Escape instead of a focused tooltip', async () => {
    const onClose = vi.fn()
    render(
      <FileContentModal
        filePath="/tmp/shot.png"
        serverId={undefined}
        onClose={onClose}
      />
    )

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog).toHaveFocus())
    await userEvent.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
