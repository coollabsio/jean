import { describe, expect, it } from 'vitest'
import { getPathUpdateAction, resolveCliPathUpdateAction } from './cli-update'

describe('getPathUpdateAction', () => {
  it('prefers self-update over homebrew for Claude', () => {
    expect(
      getPathUpdateAction(
        '/opt/homebrew/bin/claude',
        'homebrew',
        'claude-code',
        ['update']
      )
    ).toEqual(['/opt/homebrew/bin/claude', ['update']])
  })

  it('uses brew upgrade when no self-update exists', () => {
    expect(
      getPathUpdateAction('/opt/homebrew/bin/codex', 'homebrew', 'codex', null)
    ).toEqual(['brew', ['upgrade', 'codex']])
  })

  it('uses npm global install when package manager is npm', () => {
    expect(
      getPathUpdateAction(
        '/usr/local/bin/codex',
        'npm',
        'codex',
        null,
        '@openai/codex',
        '0.1.0'
      )
    ).toEqual(['npm', ['install', '-g', '@openai/codex@0.1.0']])
  })
})

describe('resolveCliPathUpdateAction', () => {
  it('resolves Claude path update via self-update even when homebrew detected', () => {
    expect(
      resolveCliPathUpdateAction(
        'claude',
        '/opt/homebrew/bin/claude',
        'homebrew',
        '2.1.150'
      )
    ).toEqual(['/opt/homebrew/bin/claude', ['update']])
  })
})
