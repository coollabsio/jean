/**
 * Cue from the inline-question prompt: "Reply with a number:" (one choice) or
 * "Reply with one or more numbers:" (several choices).
 */
const REPLY_CUE_RE =
  /\breply with (?:a|the|one|one or more|any) (?:numbers?|options?)\b[^.:?!\n]*[.:]?/i
const MULTIPLE_CUE_RE =
  /\breply with (?:one or more|any) |\b(?:numbers|options)\b/i
const ITEM_RE = /^\s{0,3}(\d{1,2})[.)]\s+(.+?)\s*$/
const MAX_OPTIONS = 8

export interface InlineQuestion {
  /** Last line before the list, without the cue */
  question: string
  options: string[]
  /** True when the user can pick more than one option */
  multiple: boolean
}

export interface InlineQuestions {
  questions: InlineQuestion[]
  /** The text without the questions, the cues, and the numbered lists */
  rest: string
}

interface NumberedList {
  start: number
  end: number
  options: string[]
  /** Line with the cue */
  cue: number
}

function plain(text: string): string {
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/, '')
    .trim()
}

const withoutCue = (line: string) => line.replace(REPLY_CUE_RE, '').trimEnd()

/** Index of the nearest non-blank line from `from` in `step` direction. */
function nearestLine(lines: string[], from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < lines.length; i += step) {
    if (lines[i]?.trim()) return i
  }
  return -1
}

/** Numbered lists of 2+ items with a reply cue on the line before or after. */
function cuedLists(lines: string[]): NumberedList[] {
  const found: NumberedList[] = []
  let current: NumberedList | null = null

  const closeList = () => {
    if (!current || current.options.length < 2) return
    const before = nearestLine(lines, current.start - 1, -1)
    const after = nearestLine(lines, current.end + 1, 1)
    const cue = [before, after].find(
      i => i >= 0 && REPLY_CUE_RE.test(lines[i] ?? '')
    )
    if (cue !== undefined) found.push({ ...current, cue })
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
      current = { start: index, end: index, options: [], cue: -1 }
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
  return found
}

/**
 * Questions that a backend asked as text: each one is a question line,
 * a reply cue ("Reply with a number:" or "Reply with one or more numbers:"),
 * and a numbered list of 2 to 8 options. Null when the text has no such
 * question.
 */
export function parseInlineQuestions(text: string): InlineQuestions | null {
  const lines = text.split('\n')
  const lists = cuedLists(lines)
  if (lists.length === 0) return null

  const removed = new Set<number>()
  const questions: InlineQuestion[] = []
  let previousEnd = -1
  for (const list of lists) {
    if (list.options.length > MAX_OPTIONS) return null
    if (new Set(list.options).size !== list.options.length) return null

    // The question is the last non-blank line before the list (and after the
    // previous list), without the cue
    let questionIndex = -1
    for (let i = list.start - 1; i > previousEnd; i--) {
      if (plain(withoutCue(lines[i] ?? ''))) {
        questionIndex = i
        break
      }
    }
    if (questionIndex >= 0) removed.add(questionIndex)
    for (let i = list.start; i <= list.end; i++) removed.add(i)
    questions.push({
      question:
        (questionIndex >= 0 && plain(withoutCue(lines[questionIndex] ?? ''))) ||
        'Choose an option',
      options: list.options,
      multiple: MULTIPLE_CUE_RE.test(
        REPLY_CUE_RE.exec(lines[list.cue] ?? '')?.[0] ?? ''
      ),
    })
    previousEnd = Math.max(list.end, list.cue)
  }

  const rest = lines
    .filter((_, index) => !removed.has(index))
    .map(withoutCue)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { questions, rest }
}

function sameQuestions(a: InlineQuestion[], b: InlineQuestion[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (q, i) =>
        q.question === b[i]?.question &&
        q.multiple === b[i]?.multiple &&
        q.options.length === b[i]?.options.length &&
        q.options.every((option, j) => option === b[i]?.options[j])
    )
  )
}

/**
 * Text without the inline questions when it asks the same questions as
 * `asked` (the buttons show them). Otherwise the text as it is.
 */
export function withoutInlineQuestions(
  text: string,
  asked: InlineQuestions
): string {
  const parsed = parseInlineQuestions(text)
  return parsed && sameQuestions(parsed.questions, asked.questions)
    ? parsed.rest
    : text
}

/**
 * User reply for the picked options: "N. option" per pick. With more than
 * one question, each answer block starts with its question.
 */
export function inlineQuestionsAnswer(
  questions: InlineQuestion[],
  picks: number[][]
): string {
  const answers = questions.map((q, i) =>
    (picks[i] ?? [])
      .slice()
      .sort((a, b) => a - b)
      .map(index => `${index + 1}. ${q.options[index] ?? ''}`)
      .join('\n')
  )
  if (questions.length === 1) return answers[0] ?? ''
  return questions
    .map((q, i) => `${q.question}\n${answers[i] || 'No answer'}`)
    .join('\n\n')
}
