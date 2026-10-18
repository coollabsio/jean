import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TextFileLightbox } from './TextFileLightbox'

const invokeForOptionalServer = vi.hoisted(() => vi.fn())

vi.mock('@/lib/transport', () => ({
  invokeForOptionalServer,
}))

describe('TextFileLightbox', () => {
  beforeEach(() => {
    invokeForOptionalServer.mockReset()
    invokeForOptionalServer.mockResolvedValue({
      content: 'remote text',
      size: 11,
    })
  })

  it('reads a persisted attachment from its owning server', async () => {
    render(
      <TextFileLightbox
        path="/remote/app-data/pasted-texts/paste.txt"
        serverId="remote-1"
      />
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
})
