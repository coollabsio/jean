import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { isLocalBackend } from '@/lib/environment'
import { getDirname, getExtension, getFilename } from '@/lib/path-utils'
import { useChatStore } from '@/store/chat-store'
import type {
  DroppedPath,
  PendingFile,
  SaveFileResponse,
  SaveImageResponse,
  SaveTextResponse,
} from '@/types/chat'
import {
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_IMAGE_TYPES,
  getImageMimeTypeFromFilename,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
  MAX_TEXT_SIZE,
  SVG_EXTENSION,
  SVG_MIME_TYPE,
} from './image-constants'

function createPlaceholderId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function lowerExtension(filename: string): string {
  return getExtension(filename).slice(1).toLowerCase()
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Concatenate in chunks: `binary += fromCharCode(byte)` per byte is O(n²) and
  // janks on multi-MB images; apply() over ~32KB slices keeps it linear.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export type AttachmentFileKind = 'raster' | 'svg' | 'file'

export function classifyAttachmentFile(
  file: Pick<File, 'name' | 'type'>
): AttachmentFileKind {
  const mimeType = file.type.toLowerCase()
  const extension = lowerExtension(file.name)

  if (mimeType === SVG_MIME_TYPE || extension === SVG_EXTENSION) return 'svg'
  if (
    ALLOWED_IMAGE_TYPES.includes(
      mimeType as (typeof ALLOWED_IMAGE_TYPES)[number]
    ) ||
    ALLOWED_IMAGE_EXTENSIONS.includes(extension)
  ) {
    return 'raster'
  }

  return 'file'
}

/** Classify a filesystem path by extension (same rules as File objects). */
export function classifyAttachmentPath(path: string): AttachmentFileKind {
  return classifyAttachmentFile({ name: getFilename(path), type: '' })
}

/**
 * Build a PendingFile chip that references an absolute path on disk. The
 * message builder joins sourceRootPath + relativePath back into the path.
 */
export function pendingFileFromPath(
  path: string,
  opts?: { id?: string; isDirectory?: boolean }
): PendingFile {
  const isDirectory = opts?.isDirectory ?? false
  return {
    id: opts?.id ?? createPlaceholderId('file'),
    relativePath: getFilename(path),
    sourceRootPath: getDirname(path),
    extension: isDirectory ? '' : getExtension(path),
    isDirectory,
    attached: true,
  }
}

function fileTooLargeToast(): void {
  toast.error('File too large', {
    description:
      'Maximum size is 25MB' +
      (isLocalBackend()
        ? '. Use the attach button to reference larger files by path.'
        : ''),
  })
}

async function uploadFile(file: File): Promise<SaveFileResponse> {
  const data = await fileToBase64(file)
  return invoke<SaveFileResponse>('save_pasted_file', {
    data,
    filename: file.name,
  })
}

export async function processAttachmentFile(
  file: File,
  sessionId: string
): Promise<void> {
  const kind = classifyAttachmentFile(file)

  if (kind === 'file') {
    if (file.size > MAX_FILE_SIZE) {
      fileTooLargeToast()
      return
    }

    try {
      const result = await uploadFile(file)
      useChatStore
        .getState()
        .addPendingFile(
          sessionId,
          pendingFileFromPath(result.path, { id: result.id })
        )
    } catch (error) {
      console.error('Failed to save file:', error)
      toast.error('Failed to save file', { description: String(error) })
    }
    return
  }

  if (kind === 'svg') {
    if (file.size > MAX_TEXT_SIZE) {
      toast.error('SVG too large', {
        description: 'Maximum size is 10MB',
      })
      return
    }

    try {
      const svgText = await file.text()
      const result = await invoke<SaveTextResponse>('save_pasted_text', {
        content: svgText,
      })

      useChatStore.getState().addPendingTextFile(sessionId, {
        id: result.id,
        path: result.path,
        filename: file.name || result.filename,
        size: result.size,
        content: svgText,
      })
    } catch (error) {
      console.error('Failed to save SVG:', error)
      toast.error('Failed to save SVG', {
        description: String(error),
      })
    }

    return
  }

  if (file.size > MAX_IMAGE_SIZE) {
    toast.error('Image too large', {
      description: 'Maximum size is 10MB',
    })
    return
  }

  const mimeType = file.type || getImageMimeTypeFromFilename(file.name)
  if (!mimeType) {
    toast.error('Unsupported image type', {
      description: 'Allowed types: PNG, JPEG, GIF, WebP, SVG',
    })
    return
  }

  const placeholderId = createPlaceholderId('loading')
  const { addPendingImage, updatePendingImage, removePendingImage } =
    useChatStore.getState()

  addPendingImage(sessionId, {
    id: placeholderId,
    path: '',
    filename: 'Processing...',
    loading: true,
  })

  try {
    const base64Data = await fileToBase64(file)

    const result = await invoke<SaveImageResponse>('save_pasted_image', {
      data: base64Data,
      mimeType,
    })

    updatePendingImage(sessionId, placeholderId, {
      id: result.id,
      path: result.path,
      filename: result.filename,
      loading: false,
    })
  } catch (error) {
    console.error('Failed to save image:', error)
    removePendingImage(sessionId, placeholderId)
    toast.error('Failed to save image', {
      description: String(error),
    })
  }
}

export async function processAttachmentFiles(
  files: Iterable<File>,
  sessionId: string
): Promise<void> {
  // Independent per-file I/O (save image/SVG/file); run in parallel.
  await Promise.all(
    Array.from(files, file => processAttachmentFile(file, sessionId))
  )
}

/**
 * Save an attachment file to disk and return its absolute path, WITHOUT
 * attaching it to any chat session. Used when a file is dropped onto a terminal
 * so the saved path can be written into the pty. Returns null (and surfaces a
 * toast) when the file is too large or fails to save.
 */
export async function saveAttachmentFileToDisk(
  file: File
): Promise<string | null> {
  const kind = classifyAttachmentFile(file)

  try {
    if (kind === 'file') {
      if (file.size > MAX_FILE_SIZE) {
        fileTooLargeToast()
        return null
      }
      const result = await uploadFile(file)
      return result.path
    }

    if (kind === 'svg') {
      if (file.size > MAX_TEXT_SIZE) {
        toast.error('SVG too large', { description: 'Maximum size is 10MB' })
        return null
      }
      const svgText = await file.text()
      const result = await invoke<SaveTextResponse>('save_pasted_text', {
        content: svgText,
      })
      return result.path
    }

    if (file.size > MAX_IMAGE_SIZE) {
      toast.error('Image too large', { description: 'Maximum size is 10MB' })
      return null
    }

    const mimeType = file.type || getImageMimeTypeFromFilename(file.name)
    if (!mimeType) {
      toast.error('Unsupported image type', {
        description: 'Allowed types: PNG, JPEG, GIF, WebP, SVG',
      })
      return null
    }

    const base64Data = await fileToBase64(file)
    const result = await invoke<SaveImageResponse>('save_pasted_image', {
      data: base64Data,
      mimeType,
    })
    return result.path
  } catch (error) {
    console.error('Failed to save dropped file:', error)
    toast.error('Failed to save file', { description: String(error) })
    return null
  }
}

// ---------------------------------------------------------------------------
// Path-based attachment (native drops, file picker, clipboard file lists)
// ---------------------------------------------------------------------------

/** Tracks paths currently being processed to prevent duplicates */
const processingPaths = new Set<string>()

/**
 * Process a dropped image file by saving it via Tauri and adding to pending images.
 */
export async function processDroppedImage(
  sourcePath: string,
  sessionId: string
): Promise<void> {
  // Guard against duplicate processing of the same file
  if (processingPaths.has(sourcePath)) return
  processingPaths.add(sourcePath)

  // Add loading placeholder immediately
  const placeholderId = createPlaceholderId('loading')
  const { addPendingImage, updatePendingImage, removePendingImage } =
    useChatStore.getState()
  addPendingImage(sessionId, {
    id: placeholderId,
    path: '',
    filename: 'Processing...',
    loading: true,
  })

  try {
    const result = await invoke<SaveImageResponse>('save_dropped_image', {
      sourcePath,
    })

    updatePendingImage(sessionId, placeholderId, {
      id: result.id,
      path: result.path,
      filename: result.filename,
      loading: false,
    })
  } catch (error) {
    console.error('Failed to save dropped image:', error)
    removePendingImage(sessionId, placeholderId)

    // Parse error message for user-friendly display
    const errorStr = String(error)
    if (errorStr.includes('too large')) {
      toast.error('Image too large', {
        description: `Maximum size: ${MAX_IMAGE_SIZE / 1024 / 1024}MB`,
      })
    } else if (errorStr.includes('Invalid image type')) {
      toast.error('Unsupported image type', {
        description: 'Accepted types: PNG, JPEG, GIF, WebP',
      })
    } else {
      toast.error('Failed to save image', {
        description: errorStr,
      })
    }
  } finally {
    processingPaths.delete(sourcePath)
  }
}

/**
 * Attach paths that already exist on disk (native drag/drop, file picker,
 * clipboard file list). Images are copied into app data (save_dropped_image);
 * any other path — SVGs, arbitrary files, directories — is referenced in place
 * by its absolute path (plugin-fs scope forbids reading arbitrary user paths).
 */
export async function attachDroppedPaths(
  entries: DroppedPath[],
  sessionId: string
): Promise<void> {
  const { addPendingFile } = useChatStore.getState()
  const seen = new Set<string>()
  await Promise.all(
    entries.map(({ path, isDir }) => {
      if (seen.has(path)) return Promise.resolve()
      seen.add(path)
      if (isDir) {
        addPendingFile(
          sessionId,
          pendingFileFromPath(path, { isDirectory: true })
        )
        return Promise.resolve()
      }
      if (classifyAttachmentPath(path) === 'raster') {
        return processDroppedImage(path, sessionId)
      }
      addPendingFile(sessionId, pendingFileFromPath(path))
      return Promise.resolve()
    })
  )
}
