/** Maximum image size in bytes (10MB) */
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024

/** Maximum generic file attachment size in bytes (25MB, matches save_pasted_file) */
export const MAX_FILE_SIZE = 25 * 1024 * 1024

/** Maximum text-based attachment size in bytes (10MB) */
export const MAX_TEXT_SIZE = 10 * 1024 * 1024

/** Allowed MIME types for raster image attachments */
export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

/** Allowed filename extensions for raster image attachments */
export const ALLOWED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

/** SVGs are handled via the text-file attachment flow */
export const SVG_MIME_TYPE = 'image/svg+xml'
export const SVG_EXTENSION = 'svg'

/** Infer MIME type from filename when the browser does not provide one */
export function getImageMimeTypeFromFilename(filename: string): string | null {
  const extension = filename.split('.').pop()?.toLowerCase()

  switch (extension) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return SVG_MIME_TYPE
    default:
      return null
  }
}
