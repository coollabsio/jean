import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDragAndDropFiles } from './useDragAndDropFiles'
import { clearDragPaths } from '../drag-path-cache'
// Warm the mocked module so the hook's first dynamic import resolves the mock.
await import('@tauri-apps/api/window')

const { invoke, localBackend, attachDroppedPaths, processAttachmentFiles } =
  vi.hoisted(() => ({
    invoke: vi.fn(),
    localBackend: { value: false },
    attachDroppedPaths: vi.fn(),
    processAttachmentFiles: vi.fn(),
  }))

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))
vi.mock('@/lib/environment', () => ({
  isLocalBackend: () => localBackend.value,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()),
  }),
}))
vi.mock('../attachment-processing', () => ({
  attachDroppedPaths: (...args: unknown[]) => attachDroppedPaths(...args),
  processAttachmentFiles: (...args: unknown[]) =>
    processAttachmentFiles(...args),
}))

function dragOverFiles(files: File[]) {
  const event = new Event('dragover', { cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files },
  })
  act(() => {
    window.dispatchEvent(event)
  })
}

function dropFiles(files: File[]) {
  const event = new Event('drop', { cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files },
  })
  window.dispatchEvent(event)
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useDragAndDropFiles browser drop', () => {
  const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' })

  beforeEach(() => {
    invoke.mockReset()
    attachDroppedPaths.mockReset()
    processAttachmentFiles.mockReset()
    localBackend.value = false
    clearDragPaths()
  })

  it('uses real paths from the drag pasteboard when counts match', async () => {
    localBackend.value = true
    const entries = [{ path: '/tmp/a.pdf', isDir: false }]
    invoke.mockResolvedValue(entries)
    renderHook(() => useDragAndDropFiles('session-1'))

    dropFiles([pdf])
    await flush()

    expect(invoke).toHaveBeenCalledWith('read_drag_file_paths')
    expect(attachDroppedPaths).toHaveBeenCalledWith(entries, 'session-1')
    expect(processAttachmentFiles).not.toHaveBeenCalled()
  })

  it('uses the paths read during the drag when the pasteboard is empty on drop', async () => {
    localBackend.value = true
    const entries = [{ path: '/tmp/a.pdf', isDir: false }]
    // macOS empties the drag pasteboard once the drop lands, so the pasteboard
    // only answers while the drag is in flight.
    let dragActive = false
    invoke.mockImplementation(async () => (dragActive ? entries : []))
    renderHook(() => useDragAndDropFiles('session-1'))

    dragActive = true
    dragOverFiles([pdf])
    await flush()
    dragActive = false
    dropFiles([pdf])
    await flush()

    expect(attachDroppedPaths).toHaveBeenCalledWith(entries, 'session-1')
    expect(processAttachmentFiles).not.toHaveBeenCalled()
  })

  it('does not hand a cancelled drag paths to the next drag', async () => {
    localBackend.value = true
    const stale = [{ path: '/tmp/stale.pdf', isDir: false }]
    let dragActive = true
    invoke.mockImplementation(async () => (dragActive ? stale : []))
    renderHook(() => useDragAndDropFiles('session-1'))

    // First drag hovers, then is cancelled without ever dropping.
    dragOverFiles([pdf])
    await flush()
    dragActive = false

    // Second drag drops a different file the pasteboard no longer describes.
    dropFiles([pdf])
    await flush()

    expect(attachDroppedPaths).not.toHaveBeenCalled()
    expect(processAttachmentFiles).toHaveBeenCalledWith(
      expect.anything(),
      'session-1'
    )
  })

  it('falls back to uploading files when the path count mismatches', async () => {
    localBackend.value = true
    invoke.mockResolvedValue([
      { path: '/tmp/stale.png', isDir: false },
      { path: '/tmp/stale2.png', isDir: false },
    ])
    renderHook(() => useDragAndDropFiles('session-1'))

    dropFiles([pdf])
    await flush()

    expect(attachDroppedPaths).not.toHaveBeenCalled()
    expect(processAttachmentFiles).toHaveBeenCalledWith(
      expect.anything(),
      'session-1'
    )
  })

  it('never asks the shell for paths outside the local backend', async () => {
    renderHook(() => useDragAndDropFiles('session-1'))

    dropFiles([pdf])
    await flush()

    expect(invoke).not.toHaveBeenCalled()
    expect(processAttachmentFiles).toHaveBeenCalled()
  })
})
