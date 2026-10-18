const STORAGE_KEY = 'jean-project-destinations-v1'

type ProjectDestinations = Record<string, string>

function readDestinations(): ProjectDestinations {
  if (typeof window === 'undefined') return {}
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    return stored && typeof stored === 'object'
      ? (stored as ProjectDestinations)
      : {}
  } catch {
    return {}
  }
}

export function getParentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const separator = Math.max(
    trimmed.lastIndexOf('/'),
    trimmed.lastIndexOf('\\')
  )
  if (separator === 0) return trimmed.charAt(0)
  if (separator === 2 && /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed.slice(0, 3)
  }
  return separator > 0 ? trimmed.slice(0, separator) : trimmed
}

export function buildProjectDestination(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`
}

export function getLastProjectDestination(
  serverId: string
): string | undefined {
  return readDestinations()[serverId]
}

export function rememberProjectDestination(
  serverId: string,
  projectPath: string
) {
  if (typeof window === 'undefined') return
  const parent = getParentDirectory(projectPath)
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readDestinations(), [serverId]: parent })
    )
  } catch {
    // Continue without persistence when browser storage is unavailable.
  }
}
