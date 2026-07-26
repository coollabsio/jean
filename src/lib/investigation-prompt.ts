/**
 * When an investigation runs in YOLO mode, Jean appends an unconditional
 * "fix after investigation" directive instead of relying on weak
 * "if you are in yolo mode..." wording inside the prompt template.
 *
 * The marker keeps the transform idempotent across frontend + backend paths.
 */

export const YOLO_INVESTIGATION_FIX_MARKER = '<yolo_investigation_fix>'

export const YOLO_INVESTIGATION_FIX_APPEND = `${YOLO_INVESTIGATION_FIX_MARKER}

This investigation is running in YOLO mode. After investigation, fix the issue: implement the necessary code changes in the codebase. Do not stop at proposing a plan. Any earlier instruction to only investigate, only propose, not implement, or not edit code is overridden for this turn.

</yolo_investigation_fix>`

/**
 * Strip lines that are weak conditional yolo-fix hints or that actively
 * prevent implementing a fix. Used only when execution mode is yolo.
 */
export function stripInvestigationAntiFixLines(prompt: string): string {
  const cleaned = prompt
    .split('\n')
    .filter(line => !shouldStripLineForYoloFix(line))
    .join('\n')
  // Collapse runs of blank lines left by removals
  return cleaned.replace(/\n{3,}/g, '\n\n')
}

function shouldStripLineForYoloFix(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false

  // Strip list markers / numbering for matching
  const body = trimmed.replace(/^(\d+\.\s+|[-*]\s+)/, '')

  // Weak conditional that models often ignore
  if (/^if you are in yolo mode\b/i.test(body)) return true

  // Explicit anti-implementation restrictions
  if (/\bdo not implement\b/i.test(body)) return true
  if (/\bdon't implement\b/i.test(body)) return true
  if (/\bdo not apply (?:the )?fix(?:es)?\b/i.test(body)) return true
  if (/\bdon't apply (?:the )?fix(?:es)?\b/i.test(body)) return true
  if (/\bdo not make (?:any )?changes\b/i.test(body)) return true
  if (/\bdo not edit\b/i.test(body) && /\b(?:code|files?)\b/i.test(body))
    return true
  if (/\bdo not write\b/i.test(body) && /\b(?:code|files?)\b/i.test(body))
    return true
  if (/\bonly investigate\b/i.test(body) && !/\bfix\b/i.test(body)) return true
  if (/\bonly propose\b/i.test(body)) return true
  if (/\bpropose only\b/i.test(body)) return true
  if (/\bresearch only\b/i.test(body)) return true
  if (/\binvestigation only\b/i.test(body)) return true
  if (/\bdo not stop at proposing\b/i.test(body) && /yolo/i.test(body))
    return true

  return false
}

/**
 * If execution mode is yolo, strip anti-fix restrictions and append an
 * unconditional fix-after-investigation directive. Non-yolo modes are unchanged.
 */
export function applyYoloInvestigationFixDirective(
  prompt: string,
  executionMode: string | null | undefined
): string {
  if (executionMode !== 'yolo') {
    return prompt
  }

  if (prompt.includes(YOLO_INVESTIGATION_FIX_MARKER)) {
    return prompt
  }

  const cleaned = stripInvestigationAntiFixLines(prompt).trimEnd()
  return `${cleaned}\n\n${YOLO_INVESTIGATION_FIX_APPEND}\n`
}
