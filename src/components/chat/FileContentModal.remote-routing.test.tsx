import { render, screen, waitFor } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileContentModal } from './FileContentModal'

const { invoke, invokeForOptionalServer, invokeForServer } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue('local contents'),
  invokeForOptionalServer: vi.fn().mockResolvedValue(undefined),
  invokeForServer: vi.fn().mockResolvedValue('remote contents'),
}))

vi.mock('@/lib/transport', () => ({
  invoke,
  invokeForOptionalServer,
  invokeForServer,
}))
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
      <FileContentModal filePath="/project/README.txt" onClose={vi.fn()} />
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

    await waitFor(() => {
      expect(invokeForServer).toHaveBeenCalledWith(
        'remote-one',
        'read_file_content',
        { path: '/srv/project/sponsors.json' }
      )
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'read_file_content',
      expect.anything()
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
      <FileContentModal filePath="/project/README.txt" onClose={vi.fn()} />
    )

    expect(
      await screen.findByRole('button', { name: 'Open in Editor' })
    ).toBeInTheDocument()
  })
})
