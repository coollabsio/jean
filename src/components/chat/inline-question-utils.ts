/** Cue from the inline-question prompt ("Reply with a number:"). */
const REPLY_CUE_RE =
  /\breply with (?:a|the|one) (?:number|option)\b[^.:?!\n]*[.:]?/i
const ITEM_RE = /^\s{0,3}(\d{1,2})[.)]\s+(.+?)\s*$/
const MAX_OPTIONS = 8

export interface InlineQuestion {
  /** Last line before the list, without the cue */
  question: string
  options: string[]
  /** The text without the question, the cue, and the numbered list */
  rest: string
}

interface NumberedList {
  start: number
  end: number
  options: string[]
}

function plain(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/, '')
    .trim()
}

/** Index of the nearest non-blank line from `from` in `step` direction. */
function nearestLine(lines: string[], from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < lines.length; i += step) {
    if (lines[i]?.trim()) return i
  }
  return -1
}

/**
 * Question that a backend asked as text: "Reply with a number:" next to a
 * numbered list of 2 to 8 options. Uses the last such list. Null when the
 * text has no such question.
 */
export function parseInlineNumberedQuestion(
  text: string
): InlineQuestion | null {
  const lines = text.split('\n')
  let found: NumberedList | null = null
  let current: NumberedList | null = null

  const closeList = () => {
    if (!current || current.options.length < 2) return
    const before = nearestLine(lines, current.start - 1, -1)
    const after = nearestLine(lines, current.end + 1, 1)
    const cued = [before, after].some(
      i => i >= 0 && REPLY_CUE_RE.test(lines[i] ?? '')
    )
    if (cued) found = current
  }

  for (const [index, line] of lines.entries()) {
    const item = ITEM_RE.exec(line)
    if (!item) {
      // Blank lines and indented continuation lines stay inside a list
      if (line.trim() && !/^\s{2,}\S/.test(line)) {
        closeList()
        current = null
      }
      continue
    }
    const number = Number(item[1])
    if (number === 1) {
      closeList()
      current = { start: index, end: index, options: [] }
    }
    if (current && number === current.options.length + 1) {
      current.options.push(plain(item[2] ?? ''))
      current.end = index
    } else {
      closeList()
      current = null
    }
  }
  closeList()

  const list = found as NumberedList | null
  if (!list || list.options.length > MAX_OPTIONS) return null
  if (new Set(list.options).size !== list.options.length) return null

  // The question is the last non-blank line before the list, without the cue
  const withoutCue = (line: string) => line.replace(REPLY_CUE_RE, '').trimEnd()
  let questionIndex = -1
  for (let i = list.start - 1; i >= 0; i--) {
    if (plain(withoutCue(lines[i] ?? ''))) {
      questionIndex = i
      break
    }
  }
  const question =
    questionIndex >= 0 ? plain(withoutCue(lines[questionIndex] ?? '')) : ''

  // The rest drops the question, the cue, and the list
  const rest = lines
    .filter(
      (_, index) =>
        index !== questionIndex && (index < list.start || index > list.end)
    )
    .map(withoutCue)

  return {
    question: question || 'Choose an option',
    options: list.options,
    rest: rest
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  }
}

/**
 * Text without the inline question when it asks the same question as `asked`
 * (the buttons show it). Otherwise the text as it is.
 */
export function withoutInlineQuestion(
  text: string,
  asked: InlineQuestion
): string {
  const parsed = parseInlineNumberedQuestion(text)
  const same =
    parsed?.question === asked.question &&
    parsed.options.length === asked.options.length &&
    parsed.options.every((option, index) => option === asked.options[index])
  return same && parsed ? parsed.rest : text
}

/** User reply for a picked option: its number and text. */
export function inlineQuestionAnswer(options: string[], index: number): string {
  return `${index + 1}. ${options[index] ?? ''}`
}
