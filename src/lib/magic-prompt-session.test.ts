import { describe, expect, it } from 'vitest'
import { resolveMagicPromptSessionTarget } from './magic-prompt-session'

describe('resolveMagicPromptSessionTarget', () => {
  it('keeps Jean Chat when the preference is chat or unset', () => {
    for (const newSessionKind of ['chat', undefined, null] as const) {
      expect(
        resolveMagicPromptSessionTarget({
          newSessionKind,
          promptBackend: 'claude',
          executionMode: 'yolo',
        })
      ).toEqual({ surface: 'chat' })
    }
  })

  it('uses the preferred CLI backend over the magic prompt backend', () => {
    expect(
      resolveMagicPromptSessionTarget({
        newSessionKind: 'claude',
        promptBackend: 'codex',
        executionMode: 'build',
      })
    ).toEqual({ surface: 'terminal', backend: 'claude', commandArgs: [] })
  })

  it('runs the magic prompt backend when the preference is a plain terminal', () => {
    expect(
      resolveMagicPromptSessionTarget({
        newSessionKind: 'terminal',
        promptBackend: 'codex',
        executionMode: 'yolo',
      })
    ).toEqual({
      surface: 'terminal',
      backend: 'codex',
      commandArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    })
  })

  it('starts yolo without approval flags when the CLI has none', () => {
    expect(
      resolveMagicPromptSessionTarget({
        newSessionKind: 'opencode',
        promptBackend: 'claude',
        executionMode: 'yolo',
      })
    ).toEqual({ surface: 'terminal', backend: 'opencode', commandArgs: [] })
  })

  it('starts Claude in its native plan mode', () => {
    expect(
      resolveMagicPromptSessionTarget({
        newSessionKind: 'claude',
        promptBackend: 'claude',
        executionMode: 'plan',
      })
    ).toEqual({
      surface: 'terminal',
      backend: 'claude',
      commandArgs: ['--permission-mode', 'plan'],
    })
  })

  it('keeps Jean Chat for plan mode on a CLI without a native plan mode', () => {
    expect(
      resolveMagicPromptSessionTarget({
        newSessionKind: 'codex',
        promptBackend: 'claude',
        executionMode: 'plan',
      })
    ).toEqual({ surface: 'chat' })
  })
})
