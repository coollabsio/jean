import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/types/chat'
import {
  secretDeclinedMessage,
  secretRequest,
  secretSavedMessage,
} from './secret-request'

const tool = (name: string, input: unknown, isError = false): ToolCall =>
  ({ id: 't1', name, input, is_error: isError }) as ToolCall

describe('secretRequest', () => {
  it('reads request_secret calls from every Jean MCP name form', () => {
    for (const name of [
      'mcp__jean__request_secret',
      'mcp__jean-dev__request_secret',
    ]) {
      expect(
        secretRequest(
          tool(name, {
            label: ' Tailscale key ',
            reason: 'Create it',
            placeholder: 'tskey-',
          })
        )
      ).toEqual({
        label: 'Tailscale key',
        reason: 'Create it',
        placeholder: 'tskey-',
      })
    }
  })

  it('ignores failed calls, other tools, and calls without a label', () => {
    expect(
      secretRequest(tool('mcp__jean__request_secret', { label: 'x' }, true))
    ).toBeNull()
    expect(
      secretRequest(tool('mcp__other__request_secret', { label: 'x' }))
    ).toBeNull()
    expect(
      secretRequest(tool('mcp__jean__ask_user', { label: 'x' }))
    ).toBeNull()
    expect(
      secretRequest(tool('mcp__jean__request_secret', { label: '  ' }))
    ).toBeNull()
  })
})

describe('secret messages', () => {
  it('give the path and the label, never anything else', () => {
    const saved = secretSavedMessage('Key', {
      path: '/data/secrets/abc',
      retention: 'forever',
    })
    expect(saved).toContain('"Key"')
    expect(saved).toContain(`TOKEN="$(cat '/data/secrets/abc')"`)
    expect(saved).toContain('kept until the user forgets it')
    expect(secretDeclinedMessage('Key')).toBe('I declined to give "Key".')
  })
})
