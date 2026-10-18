import { expect, it, vi } from 'vitest'

const { writeImage, close, createImage } = vi.hoisted(() => {
  const close = vi.fn().mockResolvedValue(undefined)
  return {
    close,
    writeImage: vi.fn().mockResolvedValue(undefined),
    createImage: vi.fn().mockResolvedValue({ close }),
  }
})
vi.mock('./environment', () => ({ isNativeApp: () => true }))
vi.mock('@tauri-apps/api/image', () => ({ Image: { new: createImage } }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeImage }))

it('copies remote pixels to the local native clipboard and releases resources on failure', async () => {
  const { copyImageToClipboard } = await import('./clipboard')
  const pixels = new Uint8ClampedArray([255, 0, 0, 255])
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['image']),
    })
  )
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image')
  const revoke = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation(() => undefined)
  vi.spyOn(window, 'Image').mockImplementation(function () {
    return {
      naturalWidth: 1,
      naturalHeight: 1,
      decode: async () => undefined,
    } as HTMLImageElement
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: pixels }),
  } as unknown as CanvasRenderingContext2D)
  writeImage.mockRejectedValueOnce(new Error('clipboard denied'))
  try {
    await expect(
      copyImageToClipboard('https://remote/api/files/image?token=test')
    ).rejects.toThrow('clipboard denied')
    expect(createImage).toHaveBeenCalledWith(
      new Uint8Array(pixels.buffer),
      1,
      1
    )
    expect(close).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:image')
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('copies a Markdown data URL without a CSP-blocked fetch', async () => {
  const { copyImageToClipboard } = await import('./clipboard')
  const fetchMock = vi.fn().mockRejectedValue(new Error('CSP blocked fetch'))
  vi.stubGlobal('fetch', fetchMock)
  const pixels = new Uint8ClampedArray([0, 255, 0, 255])
  let decodedSrc = ''
  vi.spyOn(window, 'Image').mockImplementation(function () {
    return {
      src: '',
      naturalWidth: 1,
      naturalHeight: 1,
      async decode() {
        decodedSrc = this.src
      },
    } as HTMLImageElement
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: pixels }),
  } as unknown as CanvasRenderingContext2D)
  writeImage.mockClear()
  try {
    const src = 'data:image/png;base64,remoteScreenshot'
    await copyImageToClipboard(src)
    expect(decodedSrc).toBe(src)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(writeImage).toHaveBeenCalledWith(
      await createImage.mock.results.at(-1)?.value
    )
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
