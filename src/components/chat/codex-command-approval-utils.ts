/**
 * Helpers for Codex command-approval UI and YOLO promotion.
 *
 * Codex sometimes restricts `availableDecisions` (e.g. only `accept` + `cancel`
 * for unknown shell commands). Jean still always offers a session-level YOLO
 * promote action: accept the current prompt, switch the Jean session to yolo,
 * and auto-approve residual Codex sandbox prompts mid-turn.
 */

export type CodexCommandDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'

/** Normalize available_decisions entries into string decision ids. */
export function normalizeCodexAvailableDecisions(
  availableDecisions: unknown[] | null | undefined
): Set<string> {
  if (!availableDecisions?.length) return new Set()

  const decisions = new Set<string>()
  for (const entry of availableDecisions) {
    if (typeof entry === 'string') {
      decisions.add(entry)
      continue
    }
    if (entry && typeof entry === 'object') {
      // Object-form decisions: { acceptWithExecpolicyAmendment: ... } etc.
      const keys = Object.keys(entry as Record<string, unknown>)
      for (const key of keys) {
        decisions.add(key)
      }
    }
  }
  return decisions
}

/**
 * Whether a Codex-native decision should be offered in the UI.
 * Empty/missing availableDecisions means all decisions are available.
 */
export function isCodexDecisionAvailable(
  availableDecisions: unknown[] | null | undefined,
  decision: CodexCommandDecision
): boolean {
  if (!availableDecisions?.length) return true
  return normalizeCodexAvailableDecisions(availableDecisions).has(decision)
}

/**
 * Decision sent to Codex when the user clicks Jean's Approve (yolo).
 * Prefer acceptForSession when Codex allows it; otherwise fall back to accept
 * and rely on Jean's mid-turn auto-approve flag.
 */
export function resolveCodexYoloDecision(
  availableDecisions: unknown[] | null | undefined
): 'accept' | 'acceptForSession' {
  if (isCodexDecisionAvailable(availableDecisions, 'acceptForSession')) {
    return 'acceptForSession'
  }
  return 'accept'
}
