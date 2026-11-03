import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewDialogHost } from '@/components/ui/preview-dialog-host'
import { usePreviewStore } from '@/store/preview-store'
import { TextFileLightbox } from './TextFileLightbox'

const invokeForOptionalServer = vi.hoisted(() => vi.fn())

vi.mock('@/lib/transport', () => ({
  invokeForOptionalServer,
}))

describe('TextFileLightbox', () => {
  beforeEach(() => {
    usePreviewStore.setState({ preview: null, open: false })
    invokeForOptionalServer.mockReset()
    invokeForOptionalServer.mockResolvedValue({
      content: 'remote text',
      size: 11,
    })
  })

  it('reads a persisted attachment from its owning server', async () => {
    render(
      <>
        <TextFileLightbox
          path="/remote/app-data/pasted-texts/paste.txt"
          serverId="remote-1"
        />
        <PreviewDialogHost />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: /paste\.txt/i }))

    await waitFor(() => {
      expect(invokeForOptionalServer).toHaveBeenCalledWith(
        'remote-1',
        'read_pasted_text',
        { path: '/remote/app-data/pasted-texts/paste.txt' }
      )
    })
    expect(await screen.findByText('remote text')).toBeVisible()
  })

  it('stays open when the message that opened it remounts', async () => {
    const { rerender } = render(
      <>
        <TextFileLightbox key="row-a" path="/tmp/paste.txt" />
        <PreviewDialogHost />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: /paste\.txt/i }))
    expect(await screen.findByText('remote text')).toBeVisible()

    // New chat messages can change the row key, which remounts the trigger
    rerender(
      <>
        <TextFileLightbox key="row-b" path="/tmp/paste.txt" />
        <PreviewDialogHost />
      </>
    )

    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByText('remote text')).toBeVisible()
  })
})
