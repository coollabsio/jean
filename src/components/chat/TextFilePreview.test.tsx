import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { TextFilePreview } from './TextFilePreview'
import type { PendingTextFile } from '@/types/chat'

const invoke = vi.fn()

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

const textFile: PendingTextFile = {
  id: 'text-1',
  path: '/tmp/pasted-texts/paste-1.txt',
  filename: 'paste-1.txt',
  size: 1024,
  content: 'Pasted content',
}

describe('TextFilePreview', () => {
  it('shows a remove button for pending pasted text and removes it', async () => {
    invoke.mockResolvedValueOnce(undefined)
    const onRemove = vi.fn()

    render(
      <TextFilePreview
        textFiles={[textFile]}
        onRemove={onRemove}
        sessionId="session-1"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove paste-1.txt' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('delete_pasted_text', {
        path: textFile.path,
        sessionId: 'session-1',
      })
      expect(onRemove).toHaveBeenCalledWith(textFile.id)
    })
  })

  it('hides the remove button when explicitly disabled', () => {
    render(
      <TextFilePreview
        textFiles={[textFile]}
        onRemove={vi.fn()}
        sessionId="session-1"
        disabled
      />
    )

    expect(
      screen.queryByRole('button', { name: 'Remove paste-1.txt' })
    ).not.toBeInTheDocument()
  })
})
