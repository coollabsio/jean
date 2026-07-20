import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web running-session bootstrap', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')

  it('deduplicates replay events already included in the running snapshot', () => {
    expect(source).toMatch(
      /for \(const \{ sessionId, message \} of runningSnapshotMessages\)[\s\S]*?hydrateRunningSnapshot\(sessionId, message, \{[\s\S]*?allowWhileSending: true,[\s\S]*?dedupeReplayedOutput: true,[\s\S]*?\}\)/
    )
  })

  it('does not clear the authoritative web bootstrap running-session set during recovery', () => {
    expect(source).toMatch(
      /const resumableIds = new Set[\s\S]*?if \(!webBackend\) \{[\s\S]*?removeSendingSession\(sessionId\)[\s\S]*?\}/
    )
  })
})
