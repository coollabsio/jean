import { describe, expect, it } from 'vitest'
import { withCloseSessionStep } from './close-session-prompt'

describe('withCloseSessionStep', () => {
  it('asks the agent to close the session through Jean MCP', () => {
    const prompt = withCloseSessionStep('Do the task.', 's-1')

    expect(prompt.startsWith('Do the task. ')).toBe(true)
    expect(prompt).toContain('`delete_session`')
    expect(prompt).toContain('sessionId: "s-1"')
    expect(prompt).not.toContain('\n')
  })

  it('keeps the prompt without a session id', () => {
    expect(withCloseSessionStep('Do the task.', null)).toBe('Do the task.')
  })
})
