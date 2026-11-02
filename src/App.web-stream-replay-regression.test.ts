import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web running-session bootstrap', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')

  it('deduplicates replay events already included in the running snapshot', () => {
    expect(source).toMatch(
      /for \(const \{ sessionId, message \} of runningSnapshotMessages\)[\s\S]*?hydrateRunningSnapshot\(sessionId, message, \{[\s\S]*?allowWhileSending: true,[\s\S]*?dedupeReplayedOutput: true,[\s\S]*?\}\)/
    )
  })

  it('leaves the sending set to the run-state snapshot during recovery', () => {
    // check_resumable_sessions can omit a live run whose metadata is briefly
    // unavailable; the backend snapshot (applyRunStateSnapshot) owns clears.
    const recovery = source.slice(
      source.indexOf("invoke<ResumableSession[]>('check_resumable_sessions')"),
      source.indexOf('clearConnectionSwitch()')
    )
    expect(recovery).not.toMatch(/removeSendingSession\(sessionId\)/)
    expect(source).toMatch(
      /applyRunStateSnapshot\(data\.runStates \?\? \[\], \{[\s\S]*?ownsSession: \(\) => true,/
    )
  })

  it('deduplicates resume-path snapshot replay for all backends, not only Claude', () => {
    // Grok/Pi/Kimi re-emit tools and re-tail from the start of the run log.
    // Restricting dedupeReplayedOutput to Claude left those backends doubling
    // streaming content on web reconnect while a prompt was still running.
    expect(source).toMatch(
      /hydrateRunningSnapshot\(session\.session_id, lastMsg, \{\s*allowWhileSending: true,\s*dedupeReplayedOutput: true,\s*\}\)/
    )
    expect(source).not.toMatch(
      /dedupeReplayedOutput:\s*sessionSnapshot\?\.backend === ['"]claude['"]/
    )
  })
})
