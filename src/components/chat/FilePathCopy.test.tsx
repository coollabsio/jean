import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileContentModal } from './FileContentModal'
import { FileEditsDiffModal } from './FileEditsDiffModal'
import { FilePathCopyRow } from './FilePathCopyRow'
import { MessageDiffModal } from './MessageDiffModal'

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
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))
vi.mock('@/lib/environment', () => ({
  canOpenInEditor: () => false,
  isNativeApp: () => false,
  isLocalBackend: () => false,
}))
vi.mock('@/hooks/useSyntaxHighlighting', () => ({
  useSyntaxHighlighting: () => ({ html: '', isLoading: false, error: null }),
}))
vi.mock('@/components/ui/code-editor', () => ({
  default: () => <div data-testid="code-editor" />,
}))
vi.mock('./InlineFileDiff', () => ({
  InlineFileDiff: () => <div data-testid="inline-file-diff" />,
}))
vi.mock('@pierre/diffs/react', () => ({
  FileDiff: () => <div data-testid="file-diff" />,
  EditProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@pierre/diffs/edit', () => ({
  Editor: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue('file contents'),
}))

function clickCopyButton() {
  const button = screen.getByRole('button', { name: 'Copy file path' })
  fireEvent.click(button)
  return button
}

describe('FilePathCopyRow', () => {
  beforeEach(() => {
    copyToClipboard.mockReset()
    toastSuccess.mockReset()
    toastError.mockReset()
  })

  it('shows success only after copying succeeds', async () => {
    let resolveCopy!: () => void
    copyToClipboard.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveCopy = resolve
      })
    )
    render(<FilePathCopyRow filePath="/tmp/example.ts" />)

    const button = clickCopyButton()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(button.querySelector('svg')).not.toHaveClass('text-green-500')

    resolveCopy()
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Copied file path to clipboard')
    )
    expect(button.querySelector('svg')).toHaveClass('text-green-500')
  })

  it('reports copy failures without a success checkmark', async () => {
    copyToClipboard.mockRejectedValueOnce(new Error('permission denied'))
    render(<FilePathCopyRow filePath="/tmp/example.ts" />)

    const button = clickCopyButton()
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Failed to copy: permission denied'
      )
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(button.querySelector('svg')).not.toHaveClass('text-green-500')
  })

  it('does not show a checkmark on a new path when an in-flight copy resolves', async () => {
    let resolveCopy!: () => void
    copyToClipboard.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveCopy = resolve
      })
    )
    const { rerender } = render(<FilePathCopyRow filePath="/tmp/a.ts" />)

    clickCopyButton()
    rerender(<FilePathCopyRow filePath="/tmp/b.ts" />)
    resolveCopy()

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Copied file path to clipboard')
    )
    expect(
      screen
        .getByRole('button', { name: 'Copy file path' })
        .querySelector('svg')
    ).not.toHaveClass('text-green-500')
  })
})

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
    [
      'message diff modal',
      () => (
        <MessageDiffModal
          isOpen
          filePath="/tmp/example.ts"
          edits={[]}
          onClose={vi.fn()}
          patch={`Index: example.ts
===================================================================
--- example.ts
+++ example.ts
@@ -1,1 +1,2 @@
 old
+new
`}
        />
      ),
    ],
  ])(
    'shows success only after copying succeeds in the %s',
    async (_, component) => {
      let resolveCopy!: () => void
      copyToClipboard.mockReturnValueOnce(
        new Promise<void>(resolve => {
          resolveCopy = resolve
        })
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
    [
      'message diff modal',
      () => (
        <MessageDiffModal
          isOpen
          filePath="/tmp/example.ts"
          edits={[]}
          onClose={vi.fn()}
          patch={`Index: example.ts
===================================================================
--- example.ts
+++ example.ts
@@ -1,1 +1,2 @@
 old
+new
`}
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
