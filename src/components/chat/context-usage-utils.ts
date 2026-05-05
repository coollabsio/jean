/**
 * Detects and parses Claude Code's `/context` REPL response into structured data.
 *
 * The `/context` command returns markdown with:
 *   - A summary block (model + total tokens)
 *   - An "Estimated usage by category" table (always)
 *   - Optional detail tables: MCP Tools, Custom Agents, Memory Files, Skills
 */

export interface ContextCategory {
  label: string
  tokens: number
  percent: number
}

export interface ContextDetailRow {
  cells: string[]
  tokens: number
}

export interface ContextDetailSection {
  title: string
  columns: string[]
  rows: ContextDetailRow[]
}

export interface ContextUsageData {
  model: string
  tokensUsed: number
  tokensTotal: number
  percentUsed: number
  categories: ContextCategory[]
  sections: ContextDetailSection[]
}

const CONTEXT_HEADING_RE = /^##\s+Context Usage\s*$/m
const TOKENS_LINE_RE =
  /\*\*Tokens:\*\*\s*[\d.]+[kKmM]?\s*\/\s*[\d.]+[kKmM]?\s*\(\s*\d+(?:\.\d+)?%\s*\)/
const MODEL_LINE_RE = /\*\*Model:\*\*\s*(.+?)\s*$/m
const TOKENS_PARSE_RE =
  /\*\*Tokens:\*\*\s*([\d.]+[kKmM]?)\s*\/\s*([\d.]+[kKmM]?)\s*\(\s*(\d+(?:\.\d+)?)%\s*\)/

const findingsCache = new Map<string, ContextUsageData | null>()
const CACHE_MAX_SIZE = 20

/**
 * Cheap surface check — used to decide whether to attempt parsing.
 * Must be conservative (no false positives on normal markdown responses).
 */
export function hasContextUsage(content: string): boolean {
  return CONTEXT_HEADING_RE.test(content) && TOKENS_LINE_RE.test(content)
}

/**
 * Parse a token string with optional k/m suffix.
 *   "7.4k" -> 7400
 *   "1m" -> 1_000_000
 *   "849.8k" -> 849800
 *   "198" -> 198
 *   ""/non-numeric -> 0
 */
export function parseTokenString(s: string): number {
  const trimmed = s.trim()
  if (!trimmed) return 0
  const match = trimmed.match(/^([\d.]+)([kKmM]?)$/)
  if (!match) {
    const fallback = Number(trimmed.replace(/,/g, ''))
    return Number.isFinite(fallback) ? Math.round(fallback) : 0
  }
  const numStr = match[1] ?? '0'
  const suffix = (match[2] ?? '').toLowerCase()
  const base = Number(numStr)
  if (!Number.isFinite(base)) return 0
  let multiplier = 1
  if (suffix === 'k') multiplier = 1_000
  else if (suffix === 'm') multiplier = 1_000_000
  return Math.round(base * multiplier)
}

function parsePercent(s: string): number {
  const match = s.trim().match(/^([\d.]+)%?$/)
  if (!match) return 0
  const value = Number(match[1])
  return Number.isFinite(value) ? value : 0
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  const inner = trimmed.slice(1, -1)
  const cells = inner.split('|').map(c => c.trim())
  if (cells.length === 0) return null
  return cells
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every(c => /^:?-+:?$/.test(c))
}

interface ParsedTable {
  columns: string[]
  rows: string[][]
}

/**
 * Parse a markdown pipe table starting at lineIndex.
 * Returns the parsed table and the index of the first line *after* the table.
 */
function parseTable(
  lines: string[],
  startIndex: number
): { table: ParsedTable | null; nextIndex: number } {
  let i = startIndex
  // Skip blank lines
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  const headerCells = i < lines.length ? splitTableRow(lines[i] ?? '') : null
  if (!headerCells) return { table: null, nextIndex: startIndex }
  i++
  const sepCells = i < lines.length ? splitTableRow(lines[i] ?? '') : null
  if (!sepCells || !isSeparatorRow(sepCells)) {
    return { table: null, nextIndex: startIndex }
  }
  i++
  const rows: string[][] = []
  while (i < lines.length) {
    const cells = splitTableRow(lines[i] ?? '')
    if (!cells) break
    rows.push(cells)
    i++
  }
  return { table: { columns: headerCells, rows }, nextIndex: i }
}

/**
 * Parse Claude's `/context` markdown output into structured data.
 * Returns null if the content does not match the expected shape.
 * Results are cached by content string to avoid re-parsing on each render.
 */
export function parseContextUsage(content: string): ContextUsageData | null {
  if (findingsCache.has(content)) return findingsCache.get(content) ?? null
  const result = parseContextUsageImpl(content)
  if (findingsCache.size >= CACHE_MAX_SIZE) {
    const firstKey = findingsCache.keys().next().value
    if (firstKey !== undefined) findingsCache.delete(firstKey)
  }
  findingsCache.set(content, result)
  return result
}

function parseContextUsageImpl(content: string): ContextUsageData | null {
  if (!hasContextUsage(content)) return null

  const tokensMatch = content.match(TOKENS_PARSE_RE)
  if (!tokensMatch) return null
  const tokensUsed = parseTokenString(tokensMatch[1] ?? '')
  const tokensTotal = parseTokenString(tokensMatch[2] ?? '')
  const percentUsed = parsePercent(tokensMatch[3] ?? '')

  const modelMatch = content.match(MODEL_LINE_RE)
  const model = modelMatch ? (modelMatch[1] ?? '').trim() : ''

  const lines = content.split('\n')
  let categories: ContextCategory[] = []
  const sections: ContextDetailSection[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const headingMatch = line.match(/^###\s+(.+?)\s*$/)
    if (!headingMatch) {
      i++
      continue
    }
    const heading = (headingMatch[1] ?? '').trim()
    const { table, nextIndex } = parseTable(lines, i + 1)
    if (!table) {
      i++
      continue
    }
    if (/^Estimated usage by category$/i.test(heading)) {
      categories = table.rows
        .map(row => {
          const label = (row[0] ?? '').trim()
          const tokens = parseTokenString(row[1] ?? '')
          const percent = parsePercent(row[2] ?? '')
          return { label, tokens, percent }
        })
        .filter(c => c.label !== '')
    } else {
      const detailRows: ContextDetailRow[] = table.rows
        .map(cells => {
          const lastCell = cells[cells.length - 1] ?? ''
          return { cells, tokens: parseTokenString(lastCell) }
        })
        .filter(row => row.cells.some(cell => cell !== ''))
      sections.push({
        title: heading,
        columns: table.columns,
        rows: detailRows,
      })
    }
    i = nextIndex
  }

  if (categories.length === 0 && sections.length === 0) return null

  return {
    model,
    tokensUsed,
    tokensTotal,
    percentUsed,
    categories,
    sections,
  }
}

/**
 * Format a token count in compact form: 1234 -> "1.2k", 1_000_000 -> "1m", 198 -> "198".
 * Used by the card to render figures consistently with Claude's own output style.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    return `${trimTrailingZero(v.toFixed(1))}m`
  }
  if (n >= 1_000) {
    const v = n / 1_000
    return `${trimTrailingZero(v.toFixed(1))}k`
  }
  return String(Math.round(n))
}

function trimTrailingZero(s: string): string {
  return s.replace(/\.0$/, '')
}
