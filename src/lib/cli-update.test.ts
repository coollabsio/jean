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
  it('resolves a PATH Devin CLI to devin update', () => {
    expect(
      resolveCliPathUpdateAction(
        'devin',
        '/usr/local/bin/devin',
        'homebrew',
        '3000.11.92'
      )
    ).toEqual(['/usr/local/bin/devin', ['update']])
  })

  it('resolves a PATH Grok CLI to grok update', () => {
    expect(
      resolveCliPathUpdateAction('grok', '/usr/local/bin/grok', 'npm', '1.0.40')
    ).toEqual(['/usr/local/bin/grok', ['update']])
  })

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

describe('resolveCliPathUpdateAction — Windows package managers', () => {
  const winget = [
    'winget',
    [
      'upgrade',
      '--id',
      'GitHub.cli',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ],
  ]

  it('uses winget for the gh MSI install when no manager is detected', () => {
    expect(
      resolveCliPathUpdateAction(
        'gh',
        'C:/Program Files/GitHub CLI/gh.exe',
        null,
        '2.103.3'
      )
    ).toEqual(winget)
  })

  it('uses winget when it owns the install', () => {
    expect(
      resolveCliPathUpdateAction(
        'gh',
        'C:/Users/me/AppData/Local/Microsoft/WinGet/Packages/GitHub.cli_x/gh.exe',
        'winget',
        '2.103.3'
      )
    ).toEqual(winget)
  })

  it('uses scoop and chocolatey when they own the install', () => {
    expect(
      resolveCliPathUpdateAction(
        'gh',
        'C:/Users/me/scoop/apps/gh/current/bin/gh.exe',
        'scoop',
        '2.103.3'
      )
    ).toEqual(['scoop', ['update', 'gh']])
    expect(
      resolveCliPathUpdateAction(
        'gh',
        'C:/ProgramData/chocolatey/bin/gh.exe',
        'choco',
        '2.103.3'
      )
    ).toEqual(['choco', ['upgrade', 'gh', '-y']])
  })

  it('does not invent a winget action for other CLIs', () => {
    expect(
      resolveCliPathUpdateAction(
        'codex',
        'C:/Program Files/Codex/codex.exe',
        null,
        '0.1.0'
      )
    ).toBeNull()
  })
})
