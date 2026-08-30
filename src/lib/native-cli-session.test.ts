import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import {
  buildNativeResumeArgs,
  getNativeTerminalResumeLaunch,
  hasLegacyNativeResumeArgs,
} from './native-cli-session'

const session = (overrides: Partial<Session>): Session =>
  ({
    id: 'session-1',
    name: 'Native CLI',
    order: 0,
    created_at: 1,
    updated_at: 1,
    messages: [],
    version: 2,
    primary_surface: 'terminal',
    ...overrides,
  }) as Session

describe('buildNativeResumeArgs', () => {
  it('preserves Claude permission flags and replaces launch session IDs', () => {
    expect(
      buildNativeResumeArgs('claude', 'claude-session', [
        '--permission-mode',
        'bypassPermissions',
        '--session-id',
        'initial-session',
      ])
    ).toEqual([
      '--permission-mode',
      'bypassPermissions',
      '--resume',
      'claude-session',
    ])
  })

  it('preserves Codex global flags before the resume subcommand', () => {
    expect(
      buildNativeResumeArgs('codex', 'codex-thread', [
        '--dangerously-bypass-approvals-and-sandbox',
        'resume',
        'old-thread',
      ])
    ).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      'codex-thread',
    ])
  })

  it('replaces OpenCode session selectors', () => {
    expect(
      buildNativeResumeArgs('opencode', 'opencode-session', [
        '--model',
        'anthropic/claude-sonnet-4-6',
        '-s',
        'old-session',
      ])
    ).toEqual([
      '--model',
      'anthropic/claude-sonnet-4-6',
      '--session',
      'opencode-session',
    ])
  })

  it('replaces PI creation IDs with a resumable session selector', () => {
    expect(
      buildNativeResumeArgs('pi', 'pi-session', [
        '--model',
        'openai-codex/gpt-5.4',
        '--session-id',
        'initial-session',
      ])
    ).toEqual([
      '--model',
      'openai-codex/gpt-5.4',
      '--session',
      'pi-session',
    ])
  })
})

describe('getNativeTerminalResumeLaunch', () => {
  it('builds a typed Claude resume launch', () => {
    expect(
      getNativeTerminalResumeLaunch(
        session({
          backend: 'claude',
          terminal_command: '/usr/local/bin/claude',
          terminal_command_args: ['--session-id', 'claude-session'],
          claude_session_id: 'claude-session',
        })
      )
    ).toEqual({
      command: '/usr/local/bin/claude',
      args: ['--resume', 'claude-session'],
    })
  })

  it('keeps legacy persisted resume arguments', () => {
    const legacy = session({
      backend: 'codex',
      terminal_command: '/usr/local/bin/codex',
      terminal_command_args: ['resume', 'legacy-thread'],
    })

    expect(hasLegacyNativeResumeArgs(legacy)).toBe(true)
    expect(getNativeTerminalResumeLaunch(legacy)).toEqual({
      command: '/usr/local/bin/codex',
      args: ['resume', 'legacy-thread'],
    })
  })

  it('builds a typed PI resume launch', () => {
    expect(
      getNativeTerminalResumeLaunch(
        session({
          backend: 'pi',
          terminal_command: '/usr/local/bin/pi',
          terminal_command_args: ['--session-id', 'pi-session'],
          pi_session_id: 'pi-session',
        })
      )
    ).toEqual({
      command: '/usr/local/bin/pi',
      args: ['--session', 'pi-session'],
    })
  })

  it('refuses to relaunch a native terminal without a resume ID', () => {
    expect(
      getNativeTerminalResumeLaunch(
        session({
          backend: 'opencode',
          terminal_command: '/usr/local/bin/opencode',
          terminal_command_args: [],
        })
      )
    ).toBeNull()
  })
})
