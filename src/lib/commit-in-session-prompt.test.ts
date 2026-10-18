import { describe, expect, it } from 'vitest'
import { buildCommitInSessionPrompt } from './commit-in-session-prompt'

describe('buildCommitInSessionPrompt', () => {
  it('adds a Closes footer rule when an issue number is given', () => {
    const prompt = buildCommitInSessionPrompt([42])

    expect(prompt).toContain('Commit the current session changes')
    expect(prompt).toContain('"Closes #42"')
    expect(prompt).not.toContain('\n')
  })

  it('adds one Closes rule per unique issue', () => {
    const prompt = buildCommitInSessionPrompt([42, 7, 42])

    expect(prompt).toContain('"Closes #42"')
    expect(prompt).toContain('"Closes #7"')
    expect(prompt.match(/Closes #42/g)).toHaveLength(1)
  })

  it('omits the Closes rule without issue numbers', () => {
    expect(buildCommitInSessionPrompt([])).not.toContain('Closes')
  })
})
