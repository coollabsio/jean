import { describe, expect, it } from 'vitest'
import type { ContentBlock, ToolCall } from '@/types/chat'
import { describeAgentActivity } from './agent-activity-hint'

const tool = (id: string, name: string, input: unknown): ToolCall => ({
  id,
  name,
  input,
})
const use = (id: string): ContentBlock => ({
  type: 'tool_use',
  tool_call_id: id,
})

describe('describeAgentActivity', () => {
  it('uses the tool description when the agent gives one', () => {
    const calls = [
      tool('1', 'Bash', {
        command: 'wrangler tail',
        description: 'Querying Cloudflare firewall logs',
      }),
    ]
    expect(describeAgentActivity([use('1')], calls)).toBe(
      'Querying Cloudflare firewall logs'
    )
  })

  it('builds a verb phrase for common tools', () => {
    const calls = [
      tool('1', 'Read', { file_path: '/repo/src/app.ts' }),
      tool('2', 'WebSearch', { query: 'tauri v2 docs' }),
      tool('3', 'Bash', { command: 'git status' }),
    ]
    expect(describeAgentActivity([use('1')], calls)).toBe('Reading app.ts')
    expect(describeAgentActivity([use('2')], calls)).toBe('Searching the web')
    expect(describeAgentActivity([use('3')], calls)).toBe('Running git status')
  })

  it('shows Thinking for a thinking block', () => {
    expect(
      describeAgentActivity([{ type: 'thinking', thinking: 'hmm' }], [])
    ).toBe('Thinking')
  })

  it('returns undefined for prose, questions, and an empty stream', () => {
    const question = tool('q', 'AskUserQuestion', { questions: [] })
    expect(describeAgentActivity([{ type: 'text', text: 'Hi' }], [])).toBe(
      undefined
    )
    expect(describeAgentActivity([use('q')], [question])).toBe(undefined)
    expect(describeAgentActivity([], [])).toBe(undefined)
  })

  it('keeps shell hints to the program and subcommand', () => {
    const calls = [
      tool('1', 'Bash', {
        command:
          'cd /repo && CI=1 bunx vitest run src/a.test.ts --reporter dot',
      }),
      tool('2', 'Bash', { command: '/usr/bin/ls -la /tmp' }),
    ]
    expect(describeAgentActivity([use('1')], calls)).toBe('Running bunx vitest')
    expect(describeAgentActivity([use('2')], calls)).toBe('Running ls')
  })

  it('cuts long descriptions to five words', () => {
    const calls = [
      tool('1', 'Bash', {
        command: 'find . -name "*.tmp" -delete',
        description: 'Find and delete all temporary files in the repo',
      }),
    ]
    expect(describeAgentActivity([use('1')], calls)).toBe(
      'Find and delete all temporary…'
    )
  })
})
