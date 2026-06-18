export interface ParsedFileLine {
  filePath: string
  line?: number
  column?: number
}

const LINE_COLUMN_SUFFIX = /:(\d+)(?::(\d+))?$/
const TRAILING_PUNCTUATION = /[),.;!?\]}]+$/
const KNOWN_RELATIVE_PATH_PREFIX =
  /^(?:\.github|app|assets|client|components|config|crates|docs|examples|fixtures|lib|migrations|packages|pages|public|scripts|server|services|src|styles|test|tests|tools|types|utils)\//
const FILE_EXTENSION = /\/[^/\s]+\.[A-Za-z0-9]{1,12}$/

export function parseFileLine(input: string): ParsedFileLine {
  const trimmed = input.trim().replace(TRAILING_PUNCTUATION, '')
  const match = LINE_COLUMN_SUFFIX.exec(trimmed)
  if (!match) return { filePath: trimmed }

  return {
    filePath: trimmed.slice(0, match.index),
    line: Number(match[1]),
    column: match[2] ? Number(match[2]) : undefined,
  }
}

export function looksLikeFilePath(input: string): boolean {
  if (!input || /^https?:\/\//i.test(input) || /^mailto:/i.test(input)) {
    return false
  }

  const { filePath } = parseFileLine(input)
  if (filePath.startsWith('file://')) return true
  if (filePath.startsWith('/') || filePath.startsWith('./')) return true
  if (filePath.startsWith('../')) return true
  if (!/[A-Za-z0-9_.-]+\/[^\s<>"'`]+/.test(filePath)) return false
  return (
    KNOWN_RELATIVE_PATH_PREFIX.test(filePath) ||
    FILE_EXTENSION.test(filePath) ||
    filePath.split('/').length > 2
  )
}

export function resolveFilePath(
  input: string,
  worktreePath?: string | null
): ParsedFileLine | null {
  const parsed = parseFileLine(input)
  let filePath = parsed.filePath

  if (filePath.startsWith('file://')) {
    try {
      filePath = decodeURIComponent(new URL(filePath).pathname)
    } catch {
      return null
    }
  }

  if (filePath.startsWith('/')) return { ...parsed, filePath }
  if (!worktreePath) return null

  const base = worktreePath.replace(/\/+$/, '')
  const normalized = new URL(filePath, `file://${base}/`).pathname
  if (!normalized.startsWith(`${base}/`) && normalized !== base) return null
  return { ...parsed, filePath: normalized }
}
