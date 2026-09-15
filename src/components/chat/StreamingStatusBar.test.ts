import { describe, expect, it } from 'vitest'
import { shouldShowRestoredRun } from './StreamingStatusBar'

describe('shouldShowRestoredRun', () => {
  it('hides stale persisted running state after this client observed completion', () => {
    expect(
      shouldShowRestoredRun({
        isSending: false,
        restoredRunStatus: 'running',
        completedDurationMs: 1200,
      })
    ).toBe(false)
  })
})
