import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileContentModal } from './FileContentModal'
import { FileEditsDiffModal } from './FileEditsDiffModal'

const { copyToClipboard, toastSuccess, toastError } = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/lib/clipboard', () => ({ copyToClipboard }))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))
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
vi.mock('./InlineFileDiff', () => ({
  InlineFileDiff: () => <div data-testid="inline-file-diff" />,
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue('file contents'),
}))

describe('file path copy buttons', () => {
  beforeEach(() => {
    copyToClipboard.mockReset()
    toastSuccess.mockReset()
    toastError.mockReset()
  })

  it.each([
    [
      'content modal',
      () => <FileContentModal filePath="/tmp/example.ts" onClose={vi.fn()} />,
    ],
    [
      'diff modal',
      () => (
        <FileEditsDiffModal
          filePath="/tmp/example.ts"
          edits={[{ oldString: 'old', newString: 'new' }]}
          onClose={vi.fn()}
        />
      ),
    ],
  ])(
    'shows success only after copying succeeds in the %s',
    async (_, component) => {
      let resolveCopy!: () => void
      copyToClipboard.mockReturnValueOnce(
        new Promise<void>(resolve => (resolveCopy = resolve))
      )
      render(component())

      const button = await screen.findByRole('button', {
        name: 'Copy file path',
      })
      fireEvent.click(button)

      expect(toastSuccess).not.toHaveBeenCalled()
      expect(button.querySelector('svg')).not.toHaveClass('text-green-500')

      resolveCopy()
      await waitFor(() =>
        expect(toastSuccess).toHaveBeenCalledWith(
          'Copied file path to clipboard'
        )
      )
      expect(button.querySelector('svg')).toHaveClass('text-green-500')
    }
  )

  it.each([
    [
      'content modal',
      () => <FileContentModal filePath="/tmp/example.ts" onClose={vi.fn()} />,
    ],
    [
      'diff modal',
      () => (
        <FileEditsDiffModal
          filePath="/tmp/example.ts"
          edits={[{ oldString: 'old', newString: 'new' }]}
          onClose={vi.fn()}
        />
      ),
    ],
  ])('reports copy failures in the %s', async (_, component) => {
    copyToClipboard.mockRejectedValueOnce(new Error('permission denied'))
    render(component())

    const button = await screen.findByRole('button', { name: 'Copy file path' })
    fireEvent.click(button)

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Failed to copy: permission denied'
      )
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(button.querySelector('svg')).not.toHaveClass('text-green-500')
  })
})
