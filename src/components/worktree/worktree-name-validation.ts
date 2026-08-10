const INVALID_BRANCH_CHAR = /[\s:?*~^[\]\\]/

export function isInvalidWorktreeName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  return (
    INVALID_BRANCH_CHAR.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.startsWith('.') ||
    trimmed.endsWith('.') ||
    trimmed.includes('..') ||
    trimmed.endsWith('.lock')
  )
}
