import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolArtifactPreview } from './ToolArtifactPreview'

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(() => Promise.resolve()),
  invoke: vi.fn(() => Promise.resolve()),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: mocks.copyToClipboard,
}))

vi.mock('@/lib/transport', () => ({
  invoke: mocks.invoke,
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

describe('ToolArtifactPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a fallback when an image preview fails to load', () => {
    render(
      <ToolArtifactPreview
        artifacts={[
          {
            id: 'image-1',
            type: 'image',
            title: 'Preview',
            url: 'https://design.canva.ai/preview-token',
            alt: 'Preview',
            actions: [{ label: 'Open', url: 'https://www.canva.com/d/example' }],
          },
        ]}
      />
    )

    fireEvent.error(screen.getByAltText('Preview'))

    expect(screen.getByRole('status')).toHaveTextContent(
      'Preview unavailable'
    )
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'rel',
      'noopener noreferrer'
    )
  })

  it('copies file paths and opens the containing folder', async () => {
    const user = userEvent.setup()
    const onFileClick = vi.fn()

    render(
      <ToolArtifactPreview
        artifacts={[
          {
            id: 'file-1',
            type: 'file',
            title: 'report.pdf',
            path: '/tmp/report.pdf',
            subtitle: '/tmp/report.pdf',
            actions: [{ label: 'Open file', path: '/tmp/report.pdf' }],
          },
        ]}
        onFileClick={onFileClick}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Open file' }))
    await user.click(screen.getByRole('button', { name: /copy path/i }))
    await user.click(screen.getByRole('button', { name: /open containing folder/i }))

    expect(onFileClick).toHaveBeenCalledWith('/tmp/report.pdf')
    expect(mocks.copyToClipboard).toHaveBeenCalledWith('/tmp/report.pdf')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Path copied')
    expect(mocks.invoke).toHaveBeenCalledWith('open_worktree_in_finder', {
      worktreePath: '/tmp',
    })
  })
})
