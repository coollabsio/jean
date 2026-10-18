import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { ImagePreview } from './ImagePreview'
import type { PendingImage } from '@/types/chat'

const invoke = vi.fn()

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => `local:${path}`,
  convertServerFileSrc: (serverId: string, path: string) =>
    `remote:${serverId}:${path}`,
}))

const image: PendingImage = {
  id: 'image-1',
  path: '/srv/pasted-images/image.png',
  filename: 'image.png',
}

describe('ImagePreview', () => {
  it('loads and removes a pending image through its remote session owner', async () => {
    invoke.mockResolvedValueOnce(undefined)
    const onRemove = vi.fn()

    render(
      <ImagePreview
        images={[image]}
        onRemove={onRemove}
        sessionId="remote-a:session-1"
      />
    )

    expect(screen.getByRole('img', { name: 'image.png' })).toHaveAttribute(
      'src',
      `remote:remote-a:${image.path}`
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('delete_pasted_image', {
        path: image.path,
        sessionId: 'remote-a:session-1',
      })
      expect(onRemove).toHaveBeenCalledWith(image.id)
    })
  })
})
