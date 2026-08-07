import { describe, expect, it } from 'vitest'
import {
  buildMagicPromptCommandArgs,
  isWindowsShimCommand,
  MAX_ARGV_PROMPT_CHARS,
  planPromptDelivery,
  YOLO_ARGS_BY_BACKEND,
} from './magic-prompt-terminal'

const plan = (
  overrides: Partial<Parameters<typeof planPromptDelivery>[0]> = {}
) =>
  planPromptDelivery({
    backend: 'claude',
    command: '/usr/local/bin/claude',
    prompt: 'Review this branch.',
    serverIsWindows: false,
    ...overrides,
  })

describe('planPromptDelivery', () => {
  it('passes the prompt positionally for backends that auto-submit', () => {
    for (const backend of ['claude', 'codex', 'cursor'] as const) {
      const delivery = plan({ backend })
      expect(delivery.via).toBe('argv')
      expect(delivery.promptArgs).toEqual(['Review this branch.'])
      // These submit on their own, so no synthetic Enter.
      expect(delivery.pendingWrite).toBeNull()
    }
  })

  it('adds a submit key for opencode, which only pre-fills the composer', () => {
    const delivery = plan({ backend: 'opencode' })
    expect(delivery.via).toBe('argv')
    expect(delivery.promptArgs).toEqual(['--prompt', 'Review this branch.'])
    expect(delivery.pendingWrite).toBe('\r')
  })

  it('writes the prompt for backends with no verified argv support', () => {
    for (const backend of ['grok', 'kimi', 'pi', 'commandcode'] as const) {
      const delivery = plan({ backend })
      expect(delivery.via).toBe('write')
      expect(delivery.writeReason).toBe('unsupported-backend')
      expect(delivery.promptArgs).toEqual([])
      expect(delivery.pendingWrite).toBe('Review this branch.\r')
    }
  })

  it('writes instead of overflowing the command line on long prompts', () => {
    const longPrompt = 'x'.repeat(MAX_ARGV_PROMPT_CHARS + 1)
    const delivery = plan({ prompt: longPrompt })

    expect(delivery.via).toBe('write')
    expect(delivery.writeReason).toBe('prompt-too-long')
    expect(delivery.pendingWrite).toBe(`${longPrompt}\r`)
  })

  it('keeps a prompt exactly at the limit on argv', () => {
    const delivery = plan({ prompt: 'x'.repeat(MAX_ARGV_PROMPT_CHARS) })
    expect(delivery.via).toBe('argv')
  })

  it('writes multi-line prompts for Windows batch shims', () => {
    // jean-core runs .cmd/.bat through `cmd.exe /C`, which mangles newlines.
    const delivery = plan({
      command: 'C:\\Program Files\\nodejs\\claude.cmd',
      prompt: 'Review this.\nThen report.',
      serverIsWindows: true,
    })

    expect(delivery.via).toBe('write')
    expect(delivery.writeReason).toBe('windows-shim')
  })

  it('writes prompts containing cmd metacharacters for Windows shims', () => {
    const delivery = plan({
      command: 'claude.cmd',
      prompt: 'Check foo & bar | baz',
      serverIsWindows: true,
    })

    expect(delivery.via).toBe('write')
    expect(delivery.writeReason).toBe('windows-shim')
  })

  it('keeps argv for native Windows executables', () => {
    // Direct .exe invocation passes argv through without a shell.
    const delivery = plan({
      command: 'C:\\Program Files\\claude\\claude.exe',
      prompt: 'Review this.\nThen report.',
      serverIsWindows: true,
    })

    expect(delivery.via).toBe('argv')
  })

  it('keeps argv for a single-line prompt even on a Windows shim', () => {
    const delivery = plan({
      command: 'claude.cmd',
      prompt: 'Review this branch.',
      serverIsWindows: true,
    })

    expect(delivery.via).toBe('argv')
  })

  it('ignores the shim rule when the server is not Windows', () => {
    // Unix wraps the command in sh -c with single-quote escaping, which is
    // newline-safe, so a .cmd-suffixed name there is not a hazard.
    const delivery = plan({
      command: 'claude.cmd',
      prompt: 'Review this.\nThen report.',
      serverIsWindows: false,
    })

    expect(delivery.via).toBe('argv')
  })
})

describe('isWindowsShimCommand', () => {
  it('detects batch shims regardless of case or padding', () => {
    expect(isWindowsShimCommand('claude.cmd')).toBe(true)
    expect(isWindowsShimCommand('  claude.BAT  ')).toBe(true)
    expect(isWindowsShimCommand('C:\\tools\\codex.Cmd')).toBe(true)
  })

  it('does not flag executables or extensionless binaries', () => {
    expect(isWindowsShimCommand('claude.exe')).toBe(false)
    expect(isWindowsShimCommand('/usr/local/bin/claude')).toBe(false)
    expect(isWindowsShimCommand('claude.cmdline')).toBe(false)
  })
})

describe('buildMagicPromptCommandArgs', () => {
  it('orders yolo flags before the session id and prompt', () => {
    const delivery = plan({ backend: 'claude' })
    const args = buildMagicPromptCommandArgs({
      backend: 'claude',
      delivery,
      yolo: true,
      nativeSessionId: 'abc-123',
    })

    expect(args).toEqual([
      ...(YOLO_ARGS_BY_BACKEND.claude ?? []),
      '--session-id',
      'abc-123',
      'Review this branch.',
    ])
    // Guard the assertion above against silently passing on an empty array.
    expect(YOLO_ARGS_BY_BACKEND.claude).toEqual([
      '--permission-mode',
      'bypassPermissions',
    ])
  })

  it('omits yolo flags when not requested', () => {
    const delivery = plan({ backend: 'claude' })
    const args = buildMagicPromptCommandArgs({
      backend: 'claude',
      delivery,
      yolo: false,
      nativeSessionId: 'abc-123',
    })

    expect(args).toEqual(['--session-id', 'abc-123', 'Review this branch.'])
  })

  it('only passes --session-id for claude', () => {
    const delivery = plan({ backend: 'codex' })
    const args = buildMagicPromptCommandArgs({
      backend: 'codex',
      delivery,
      yolo: false,
      nativeSessionId: 'abc-123',
    })

    expect(args).not.toContain('--session-id')
    expect(args).toEqual(['Review this branch.'])
  })

  it('carries no prompt on argv when delivery is by write', () => {
    const delivery = plan({ backend: 'grok' })
    const args = buildMagicPromptCommandArgs({
      backend: 'grok',
      delivery,
      yolo: true,
    })

    // Only the permission flags — the prompt goes into the PTY afterwards.
    expect(args).toEqual(YOLO_ARGS_BY_BACKEND.grok)
    expect(args).not.toContain('Review this branch.')
  })

  it('drops yolo flags for backends that define none', () => {
    const delivery = plan({ backend: 'opencode' })
    const args = buildMagicPromptCommandArgs({
      backend: 'opencode',
      delivery,
      yolo: true,
    })

    expect(args).toEqual(['--prompt', 'Review this branch.'])
  })
})
