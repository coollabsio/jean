import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/types/chat'
import { latestAgentStatus } from './agent-status'

const tool = (id: string, name: string, input: unknown): ToolCall => ({
  id,
  name,
  input,
})

describe('latestAgentStatus', () => {
  it('shows the text of the latest set_status call', () => {
    const calls = [
      tool('1', 'mcp__jean__set_status', { text: 'Reading the PRs' }),
      tool('2', 'Bash', { command: 'gh pr list' }),
      tool('3', 'mcp__jean__set_status', {
        text: ' Checking firewall logs ',
      }),
      tool('4', 'Bash', { command: 'wrangler tail' }),
    ]
    expect(latestAgentStatus(calls)).toBe('Checking firewall logs')
  })

  it('accepts the Codex and dev server name forms', () => {
    expect(
      latestAgentStatus([tool('1', 'mcp:jean:set_status', { text: 'A' })])
    ).toBe('A')
    expect(
      latestAgentStatus([tool('1', 'mcp__jean-dev__set_status', { text: 'B' })])
    ).toBe('B')
  })

  it('never shows tool calls or commands without a status', () => {
    const calls = [
      tool('1', 'Bash', { command: 'git status', description: 'Show status' }),
      tool('2', 'mcp__jean__set_status', { text: '  ' }),
      tool('3', 'mcp__other__set_status', { text: 'Not Jean' }),
    ]
    expect(latestAgentStatus(calls)).toBeUndefined()
  })
})
