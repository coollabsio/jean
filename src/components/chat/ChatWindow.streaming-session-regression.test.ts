import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ChatWindow live output session routing', () => {
  it('keys the timer and all live output from the active session', () => {
    const source = readFileSync(
      `${process.cwd()}/src/components/chat/ChatWindow.tsx`,
      'utf8'
    )

    expect(source).toMatch(
      /sendingSessionIds\[activeSessionId\][\s\S]*streamingContents\[activeSessionId\][\s\S]*activeToolCalls\[activeSessionId\][\s\S]*streamingContentBlocks\[activeSessionId\]/
    )
    expect(source).not.toMatch(/streamingContents\[deferredSessionId\]/)
    expect(source).not.toMatch(/activeToolCalls\[deferredSessionId\]/)
    expect(source).not.toMatch(/streamingContentBlocks\[deferredSessionId\]/)
  })
})
