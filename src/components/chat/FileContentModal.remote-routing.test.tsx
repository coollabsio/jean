import { render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileContentModal } from './FileContentModal'

const { invoke, invokeForServer } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue('local contents'),
  invokeForServer: vi.fn().mockResolvedValue('remote contents'),
}))

vi.mock('@/lib/transport', () => ({ invoke, invokeForServer }))
vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))
vi.mock('@/lib/environment', () => ({ canOpenInEditor: () => false }))
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
  })
})
