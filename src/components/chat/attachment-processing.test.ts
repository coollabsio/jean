import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachDroppedPaths,
  classifyAttachmentFile,
  classifyAttachmentPath,
  pendingFileFromPath,
  processAttachmentFile,
} from './attachment-processing'
import { MAX_FILE_SIZE, MAX_IMAGE_SIZE } from './image-constants'

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
    addPendingFile: vi.fn(),
  },
}))

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('@/lib/environment', () => ({
  isLocalBackend: () => false,
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
    storeState.addPendingFile.mockReset()
  })

  it('classifies raster, svg, and generic files', () => {
    expect(
      classifyAttachmentFile(makeFile('photo.png', { type: 'image/png' }))
    ).toBe('raster')
    expect(classifyAttachmentFile(makeFile('vector.svg', { type: '' }))).toBe(
      'svg'
    )
    expect(
      classifyAttachmentFile(makeFile('notes.txt', { type: 'text/plain' }))
    ).toBe('file')
  })

  it('classifies dropped paths by extension', () => {
    expect(classifyAttachmentPath('/tmp/a.PNG')).toBe('raster')
    expect(classifyAttachmentPath('C:\\tmp\\logo.svg')).toBe('svg')
    expect(classifyAttachmentPath('/tmp/report.pdf')).toBe('file')
    expect(classifyAttachmentPath('/tmp/Makefile')).toBe('file')
  })

  it('builds a pending file from posix and windows paths', () => {
    expect(pendingFileFromPath('/tmp/docs/report.pdf', { id: 'f-1' })).toEqual({
      id: 'f-1',
      relativePath: 'report.pdf',
      sourceRootPath: '/tmp/docs',
      extension: '.pdf',
      isDirectory: false,
      attached: true,
    })
    const win = pendingFileFromPath('C:\\Users\\x\\a.pdf')
    expect(win.id).toMatch(/^file-/)
    expect(win.relativePath).toBe('a.pdf')
    expect(win.sourceRootPath).toBe('C:/Users/x')
    expect(win.extension).toBe('.pdf')
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

  it('uploads generic files via save_pasted_file and attaches them by path', async () => {
    invoke.mockResolvedValueOnce({
      id: 'file-1',
      path: '/app/pasted-files/report.pdf',
      filename: 'report.pdf',
      size: 5,
    })

    await processAttachmentFile(
      makeFile('report.pdf', { type: 'application/pdf', content: 'hello' }),
      'session-1'
    )

    expect(invoke).toHaveBeenCalledWith('save_pasted_file', {
      data: btoa('hello'),
      filename: 'report.pdf',
    })
    expect(storeState.addPendingFile).toHaveBeenCalledWith('session-1', {
      id: 'file-1',
      relativePath: 'report.pdf',
      sourceRootPath: '/app/pasted-files',
      extension: '.pdf',
      isDirectory: false,
      attached: true,
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('uploads video files as generic files', async () => {
    invoke.mockResolvedValueOnce({
      id: 'file-2',
      path: '/app/pasted-files/clip.mov',
      filename: 'clip.mov',
      size: 3,
    })

    await processAttachmentFile(
      makeFile('clip.mov', { type: 'video/quicktime', content: 'mov' }),
      'session-1'
    )

    expect(invoke).toHaveBeenCalledWith('save_pasted_file', {
      data: expect.any(String),
      filename: 'clip.mov',
    })
    expect(storeState.addPendingFile).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ relativePath: 'clip.mov' })
    )
  })

  it('rejects oversized generic files before upload', async () => {
    await processAttachmentFile(
      makeFile('big.zip', { type: 'application/zip', size: MAX_FILE_SIZE + 1 }),
      'session-1'
    )

    expect(invoke).not.toHaveBeenCalled()
    expect(storeState.addPendingFile).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('File too large', {
      description: 'Maximum size is 25MB',
    })
  })

  it('surfaces save failures for generic files', async () => {
    invoke.mockRejectedValueOnce(new Error('disk full'))

    await processAttachmentFile(
      makeFile('notes.md', { type: 'text/markdown', content: '# hi' }),
      'session-1'
    )

    expect(storeState.addPendingFile).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Failed to save file', {
      description: 'Error: disk full',
    })
  })

  describe('attachDroppedPaths', () => {
    it('references generic files by path without copying', async () => {
      await attachDroppedPaths(
        [{ path: '/tmp/docs/spec.pdf', isDir: false }],
        'session-1'
      )

      expect(invoke).not.toHaveBeenCalled()
      expect(storeState.addPendingFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          relativePath: 'spec.pdf',
          sourceRootPath: '/tmp/docs',
          extension: '.pdf',
          isDirectory: false,
        })
      )
    })

    it('routes raster images through save_dropped_image', async () => {
      invoke.mockResolvedValueOnce({
        id: 'img-9',
        path: '/app/pasted-images/shot.png',
        filename: 'shot.png',
      })

      await attachDroppedPaths(
        [{ path: '/tmp/shot.png', isDir: false }],
        'session-1'
      )

      expect(invoke).toHaveBeenCalledWith('save_dropped_image', {
        sourcePath: '/tmp/shot.png',
      })
      expect(storeState.updatePendingImage).toHaveBeenCalledWith(
        'session-1',
        expect.any(String),
        expect.objectContaining({ id: 'img-9', loading: false })
      )
      expect(storeState.addPendingFile).not.toHaveBeenCalled()
    })

    it('references svg paths in place instead of reading them via plugin-fs', async () => {
      await attachDroppedPaths(
        [{ path: '/tmp/art/logo.svg', isDir: false }],
        'session-1'
      )

      expect(invoke).not.toHaveBeenCalled()
      expect(storeState.addPendingTextFile).not.toHaveBeenCalled()
      expect(storeState.addPendingFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          relativePath: 'logo.svg',
          sourceRootPath: '/tmp/art',
          extension: '.svg',
          isDirectory: false,
        })
      )
    })

    it('attaches directories as directory chips', async () => {
      await attachDroppedPaths(
        [
          { path: '/tmp/proj/src', isDir: true },
          { path: '/tmp/proj/src', isDir: true },
        ],
        'session-1'
      )

      expect(invoke).not.toHaveBeenCalled()
      expect(storeState.addPendingFile).toHaveBeenCalledTimes(1)
      expect(storeState.addPendingFile).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          relativePath: 'src',
          sourceRootPath: '/tmp/proj',
          extension: '',
          isDirectory: true,
        })
      )
    })
  })
})
