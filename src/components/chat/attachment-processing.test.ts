import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyAttachmentFile,
  processAttachmentFile,
} from './attachment-processing'
import { MAX_IMAGE_SIZE } from './image-constants'

const { invoke, toast, storeState } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: {
    error: vi.fn(),
  },
  storeState: {
    addPendingImage: vi.fn(),
    updatePendingImage: vi.fn(),
    removePendingImage: vi.fn(),
    addPendingTextFile: vi.fn(),
  },
}))

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('sonner', () => ({
  toast,
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: {
    getState: () => storeState,
  },
}))

function makeFile(
  name: string,
  options: {
    type: string
    content?: string
    size?: number
  }
): File {
  const content = options.content ?? 'file-content'
  const bytes = new TextEncoder().encode(content)

  return {
    name,
    type: options.type,
    size: options.size ?? bytes.byteLength,
    arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
    text: vi.fn().mockResolvedValue(content),
  } as unknown as File
}

describe('attachment-processing', () => {
  beforeEach(() => {
    invoke.mockReset()
    toast.error.mockReset()
    storeState.addPendingImage.mockReset()
    storeState.updatePendingImage.mockReset()
    storeState.removePendingImage.mockReset()
    storeState.addPendingTextFile.mockReset()
  })

  it('classifies raster, svg, and unsupported files', () => {
    expect(
      classifyAttachmentFile(makeFile('photo.png', { type: 'image/png' }))
    ).toBe('raster')
    expect(classifyAttachmentFile(makeFile('vector.svg', { type: '' }))).toBe(
      'svg'
    )
    expect(
      classifyAttachmentFile(makeFile('notes.txt', { type: 'text/plain' }))
    ).toBe('unsupported')
  })

  it('saves raster files via save_pasted_image', async () => {
    invoke.mockResolvedValueOnce({
      id: 'img-1',
      path: '/tmp/image.png',
      filename: 'image.png',
    })

    await processAttachmentFile(
      makeFile('image.png', {
        type: 'image/png',
        content: 'image-bytes',
      }),
      'session-1'
    )

    expect(storeState.addPendingImage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        path: '',
        filename: 'Processing...',
        loading: true,
      })
    )
    expect(invoke).toHaveBeenCalledWith('save_pasted_image', {
      data: expect.any(String),
      mimeType: 'image/png',
      sessionId: 'session-1',
    })
    expect(storeState.updatePendingImage).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      {
        id: 'img-1',
        path: '/tmp/image.png',
        filename: 'image.png',
        loading: false,
      }
    )
  })

  it('infers mime type from filename when browser omits it', async () => {
    invoke.mockResolvedValueOnce({
      id: 'img-2',
      path: '/tmp/photo.jpg',
      filename: 'photo.jpg',
    })

    await processAttachmentFile(
      makeFile('photo.jpg', {
        type: '',
        content: 'image-bytes',
      }),
      'session-1'
    )

    expect(invoke).toHaveBeenCalledWith('save_pasted_image', {
      data: expect.any(String),
      mimeType: 'image/jpeg',
      sessionId: 'session-1',
    })
  })

  it('routes svg files through save_pasted_text', async () => {
    invoke.mockResolvedValueOnce({
      id: 'txt-1',
      path: '/tmp/vector.svg',
      filename: 'vector.svg',
      size: 11,
    })

    await processAttachmentFile(
      makeFile('vector.svg', {
        type: 'image/svg+xml',
        content: '<svg></svg>',
      }),
      'session-1'
    )

    expect(invoke).toHaveBeenCalledWith('save_pasted_text', {
      content: '<svg></svg>',
      sessionId: 'session-1',
    })
    expect(storeState.addPendingTextFile).toHaveBeenCalledWith('session-1', {
      id: 'txt-1',
      path: '/tmp/vector.svg',
      filename: 'vector.svg',
      size: 11,
      content: '<svg></svg>',
    })
  })

  it('rejects oversized raster images before upload', async () => {
    const oversized = makeFile('huge.png', {
      type: 'image/png',
      size: MAX_IMAGE_SIZE + 1,
    })

    await processAttachmentFile(oversized, 'session-1')

    expect(invoke).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Image too large', {
      description: 'Maximum size is 10MB',
    })
  })

  it('rejects unsupported file types', async () => {
    await processAttachmentFile(
      makeFile('notes.txt', { type: 'text/plain', content: 'hello' }),
      'session-1'
    )

    expect(invoke).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Unsupported image type', {
      description: 'Allowed types: PNG, JPEG, GIF, WebP, SVG',
    })
  })
})
