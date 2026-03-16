import { getFilename } from '@/lib/path-utils'

/** File extension to icon color mapping */
export const EXTENSION_COLORS: Record<string, string> = {
  ts: 'text-blue-500',
  tsx: 'text-blue-500',
  js: 'text-yellow-500',
  jsx: 'text-yellow-500',
  rs: 'text-orange-500',
  py: 'text-green-500',
  json: 'text-yellow-600',
  md: 'text-gray-500',
  css: 'text-pink-500',
  html: 'text-orange-400',
  toml: 'text-gray-400',
  yaml: 'text-red-400',
  yml: 'text-red-400',
}

/** Get color class for a file extension */
export function getExtensionColor(ext: string): string {
  return EXTENSION_COLORS[ext] ?? 'text-muted-foreground'
}

/** Extract extension from filename or path */
export function getExtension(path: string): string {
  const filename = getFilename(path)
  const parts = filename.split('.')
  return parts.length > 1 ? (parts.pop()?.toLowerCase() ?? '') : ''
}
