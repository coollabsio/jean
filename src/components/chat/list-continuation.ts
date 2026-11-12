/**
 * List continuation for the chat composer.
 *
 * Shift+Enter (or Enter on mobile) normally inserts a plain newline. When the
 * caret sits in a numbered or bulleted list item, it should instead start the
 * next item the way Claude's composer does:
 *
 *   `1. Fix the queue`  →  `1. Fix the queue\n2. `
 *   `  - one`           →  `  - one\n  - `
 *
 * Pure so the behaviour is unit-testable without mounting the textarea.
 */

export interface ListContinuation {
  /** The full textarea value after the edit. */
  text: string
  /** Where the caret should land. */
  caret: number
}

/** `{indent}{number}{delimiter} ` or `{indent}{bullet} ` at line start. */
const LIST_LINE = /^([ \t]*)(?:(\d+)([.)])|([-*+]))[ \t]+(.*)$/

/**
 * Compute the edit for a newline pressed at `caret`.
 *
 * Returns `null` when the line is not a list item, so the caller keeps the
 * default newline behaviour.
 */
export function continueListOnNewline(
  text: string,
  caret: number
): ListContinuation | null {
  if (caret < 0 || caret > text.length) return null

  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const line = text.slice(lineStart, caret)
  const match = LIST_LINE.exec(line)
  if (!match) return null

  const indent = match[1] ?? ''
  const number = match[2]
  const delimiter = match[3] ?? '.'
  const bullet = match[4] ?? '-'
  const content = match[5] ?? ''

  // An empty item ends the list: drop the marker instead of adding another
  // number, leaving the caret on the now-plain line.
  if (!content.trim()) {
    return {
      text: text.slice(0, lineStart) + text.slice(caret),
      caret: lineStart,
    }
  }

  let marker: string
  if (number) {
    const next = Number.parseInt(number, 10) + 1
    if (!Number.isSafeInteger(next)) return null
    marker = `${indent}${next}${delimiter} `
  } else {
    marker = `${indent}${bullet} `
  }

  const insert = `\n${marker}`
  return {
    text: text.slice(0, caret) + insert + text.slice(caret),
    caret: caret + insert.length,
  }
}
