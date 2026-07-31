/**
 * Cross-platform path utilities
 *
 * These utilities handle path operations that work correctly on both
 * Windows (backslash separators) and Unix systems (forward slash).
 */

/**
 * Extract the filename from a path (cross-platform)
 *
 * Handles both forward slashes (Unix) and backslashes (Windows).
 *
 * @example
 * getFilename('/Users/test/file.txt') // 'file.txt'
 * getFilename('C:\\Users\\test\\file.txt') // 'file.txt'
 * getFilename('file.txt') // 'file.txt'
 */
export function getFilename(path: string): string {
  // Normalize backslashes to forward slashes, then split
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

/**
 * Normalize path separators to forward slashes
 *
 * Useful for consistent display and comparison of paths.
 *
 * @example
 * normalizePath('C:\\Users\\test') // 'C:/Users/test'
 * normalizePath('/Users/test') // '/Users/test'
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Get the directory part of a path (cross-platform)
 *
 * @example
 * getDirname('/Users/test/file.txt') // '/Users/test'
 * getDirname('C:\\Users\\test\\file.txt') // 'C:/Users/test'
 */
export function getDirname(path: string): string {
  const normalized = normalizePath(path)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return '.'
  if (lastSlash === 0) return '/'
  return normalized.slice(0, lastSlash)
}

/**
 * Get the file extension (cross-platform)
 *
 * @example
 * getExtension('file.txt') // '.txt'
 * getExtension('file') // ''
 * getExtension('.gitignore') // ''
 */
export function getExtension(path: string): string {
  const filename = getFilename(path)
  const lastDot = filename.lastIndexOf('.')
  if (lastDot <= 0) return ''
  return filename.slice(lastDot)
}

/**
 * Join a root directory path with a relative path (cross-platform).
 * Uses the separator style of the root when it looks Windows-like.
 */
export function joinPaths(root: string, relative: string): string {
  if (!relative) return root
  if (!root) return relative
  const usesBackslash = root.includes('\\') && !root.includes('/')
  const sep = usesBackslash ? '\\' : '/'
  const cleanRoot = root.replace(/[\\/]+$/, '')
  const cleanRelative = relative.replace(/^[\\/]+/, '').replace(/[\\/]+/g, sep)
  return `${cleanRoot}${sep}${cleanRelative}`
}
