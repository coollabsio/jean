import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ChatWindow running snapshot hydration', () => {
  const source = readFileSync(
    `${process.cwd()}/src/components/chat/ChatWindow.tsx`,
    'utf8'
  )

  it('hydrates a restored running session when live streaming state is empty', () => {
    expect(source).toMatch(
      /hasLiveStreamingState[\s\S]*?if \(isSending && hasLiveStreamingState\) return[\s\S]*?hydrateRunningSnapshot\(deferredSessionId, lastMsg, \{[\s\S]*?allowWhileSending: true,[\s\S]*?dedupeReplayedOutput: true/
    )
  })
})
