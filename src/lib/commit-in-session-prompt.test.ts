import { describe, expect, it } from 'vitest'
import { buildCommitInSessionPrompt } from './commit-in-session-prompt'

describe('buildCommitInSessionPrompt', () => {
  it('adds a Closes footer rule when an issue number is given', () => {
    const prompt = buildCommitInSessionPrompt(42)

    expect(prompt).toContain('Commit all current changes')
    expect(prompt).toContain('"Closes #42"')
    expect(prompt).not.toContain('\n')
  })

  it('omits the Closes rule without an issue number', () => {
    expect(buildCommitInSessionPrompt(undefined)).not.toContain('Closes')
    expect(buildCommitInSessionPrompt(null)).not.toContain('Closes')
  })
})
