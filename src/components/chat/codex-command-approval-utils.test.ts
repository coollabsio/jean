import { describe, expect, it } from 'vitest'
import {
  isCodexDecisionAvailable,
  normalizeCodexAvailableDecisions,
  resolveCodexYoloDecision,
} from './codex-command-approval-utils'

describe('codex-command-approval-utils', () => {
  it('treats missing availableDecisions as all decisions available', () => {
    expect(isCodexDecisionAvailable(null, 'acceptForSession')).toBe(true)
    expect(isCodexDecisionAvailable(undefined, 'acceptForSession')).toBe(true)
    expect(isCodexDecisionAvailable([], 'acceptForSession')).toBe(true)
  })

  it('hides acceptForSession when Codex only offers accept/cancel', () => {
    const available = ['accept', 'cancel']
    expect(isCodexDecisionAvailable(available, 'accept')).toBe(true)
    expect(isCodexDecisionAvailable(available, 'cancel')).toBe(true)
    expect(isCodexDecisionAvailable(available, 'acceptForSession')).toBe(false)
    expect(isCodexDecisionAvailable(available, 'decline')).toBe(false)
  })

  it('normalizes object-form decision keys', () => {
    const decisions = normalizeCodexAvailableDecisions([
      'accept',
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git'] } },
    ])
    expect(decisions.has('accept')).toBe(true)
    expect(decisions.has('acceptWithExecpolicyAmendment')).toBe(true)
  })

  it('resolves YOLO to acceptForSession when available, else accept', () => {
    expect(resolveCodexYoloDecision(null)).toBe('acceptForSession')
    expect(resolveCodexYoloDecision(['accept', 'acceptForSession', 'cancel'])).toBe(
      'acceptForSession'
    )
    expect(resolveCodexYoloDecision(['accept', 'cancel'])).toBe('accept')
  })
})
