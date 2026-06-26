import { looksLikeFilePath } from './link-utils'

const PATH_TOKEN =
  /(^|[\s([{])((?:file:\/\/[^\s<>"'`]+|(?:\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[^\s<>"'`]+)(?::\d+(?::\d+)?)?)/g

function isProbablyAlreadyLinked(prefix: string): boolean {
  return prefix.endsWith('](') || prefix.endsWith('href="') || prefix.endsWith("href='")
}

function enrichLine(line: string): string {
  return line.replace(PATH_TOKEN, (match, prefix: string, path: string, offset) => {
    const before = line.slice(Math.max(0, offset - 3), offset) + prefix
    if (isProbablyAlreadyLinked(before) || !looksLikeFilePath(path)) return match
    return `${prefix}[${path}](${path})`
  })
}

export function enrichFilePaths(markdown: string): string {
  const lines = markdown.split('\n')
  let inFence = false

  return lines
    .map(line => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      if (line.includes('`')) return line
      return enrichLine(line)
    })
    .join('\n')
}
