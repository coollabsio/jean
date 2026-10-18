import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ChatWindow running snapshot hydration', () => {
  const source = readFileSync(
    `${process.cwd()}/src/components/chat/ChatWindow.tsx`,
    'utf8'
  )

  it('hydrates the persisted snapshot even when live chunks arrive before the query', () => {
    expect(source).toMatch(
      /lastMsg\.id\.startsWith\('running-'\)[\s\S]*?hydrateRunningSnapshot\(deferredSessionId, lastMsg, \{[\s\S]*?allowWhileSending: true,[\s\S]*?dedupeReplayedOutput: true/
    )
    expect(source).not.toContain('if (isSending && hasLiveStreamingState) return')
  })

  it('hydrates each running message only once so refetches do not duplicate live output', () => {
    expect(source).toMatch(
      /hydratedRunningSnapshotsRef\.current\.has\(hydrateKey\)\) return[\s\S]*?hydratedRunningSnapshotsRef\.current\.add\(hydrateKey\)[\s\S]*?hydrateRunningSnapshot\(deferredSessionId, lastMsg/
    )
  })
})
