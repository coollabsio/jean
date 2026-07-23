import { describe, expect, it } from 'vitest'
import {
  isCliAuthError,
  isLoginSlashCommand,
  loginArgsForBackend,
  rewriteCliAuthErrorMessage,
} from './cli-auth'

describe('isCliAuthError', () => {
  it('detects Claude not-logged-in guidance', () => {
    expect(isCliAuthError('Not logged in · Please run /login')).toBe(true)
  })

  it('detects headless /login unavailable message', () => {
    expect(
      isCliAuthError("/login isn't available in this environment.")
    ).toBe(true)
  })

  it('detects codex re-auth prompts', () => {
    expect(
      isCliAuthError('Codex token expired. Run `codex` to log in again.')
    ).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isCliAuthError('worktree path already exists')).toBe(false)
    expect(isCliAuthError('network timeout')).toBe(false)
  })
})

describe('rewriteCliAuthErrorMessage', () => {
  it('does not recommend interactive /login in chat', () => {
    const msg = rewriteCliAuthErrorMessage(
      'Not logged in · Please run /login',
      'claude'
    )
    expect(msg.toLowerCase()).toContain('not authenticated')
    expect(msg.toLowerCase()).toContain('settings')
    expect(msg).toMatch(/not available in Jean chat/i)
  })
})

describe('isLoginSlashCommand', () => {
  it('matches bare /login only', () => {
    expect(isLoginSlashCommand('/login')).toBe(true)
    expect(isLoginSlashCommand('  /login  ')).toBe(true)
    expect(isLoginSlashCommand('/login please')).toBe(false)
    expect(isLoginSlashCommand('please /login')).toBe(false)
  })
})

describe('loginArgsForBackend', () => {
  it('uses auth login for modern Claude', () => {
    expect(loginArgsForBackend('claude', true)).toEqual(['auth', 'login'])
    expect(loginArgsForBackend('claude', false)).toEqual(['login'])
  })

  it('uses expected args for codex and opencode', () => {
    expect(loginArgsForBackend('codex')).toEqual(['login'])
    expect(loginArgsForBackend('opencode')).toEqual(['auth', 'login'])
  })
})
