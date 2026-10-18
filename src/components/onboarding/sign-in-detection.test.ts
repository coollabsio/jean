import { describe, expect, it } from 'vitest'
import { detectSignIn, stripAnsi } from './sign-in-detection'

describe('stripAnsi', () => {
  it('removes color and cursor sequences', () => {
    expect(stripAnsi('\x1b[1;33m!\x1b[0m hello\x1b[2K\x1b[1G')).toBe('! hello')
  })

  it('keeps the target of OSC 8 hyperlinks', () => {
    const text =
      'Open \x1b]8;;https://example.com/login\x07here\x1b]8;;\x07 now'
    expect(stripAnsi(text)).toContain('https://example.com/login')
    expect(stripAnsi(text)).not.toContain('\x1b')
  })
})

describe('detectSignIn', () => {
  it('detects gh device flow', () => {
    const output = [
      '? What account do you want to log into? GitHub.com',
      '? How would you like to authenticate GitHub CLI? Login with a web browser',
      '',
      '! First copy your one-time code: 1A2B-3C4D',
      'Press Enter to open github.com in your browser... ',
      '! Failed opening a web browser at https://github.com/login/device',
      'Please try entering the URL in your browser manually',
    ].join('\r\n')
    expect(detectSignIn(output)).toEqual({
      url: 'https://github.com/login/device',
      code: '1A2B-3C4D',
    })
  })

  it('detects gh output with ANSI colors', () => {
    const output =
      '\x1b[0;33m!\x1b[0m First copy your one-time code: \x1b[1mABCD-EFGH\x1b[0m\r\n' +
      'Open this URL to continue in your web browser: \x1b[4mhttps://github.com/login/device\x1b[0m\r\n'
    expect(detectSignIn(output)).toEqual({
      url: 'https://github.com/login/device',
      code: 'ABCD-EFGH',
    })
  })

  it('detects codex device auth with code on the next line', () => {
    const output = [
      'Welcome to Codex [v0.50.0]',
      'Follow these steps to sign in with ChatGPT using device code authorization:',
      '',
      '1. Open this link in your browser and sign in to your account',
      '   https://auth.openai.com/codex/device',
      '',
      '2. Enter this one-time code (expires in 15 minutes)',
      '   ABCD-12345',
      '',
      'Device codes are a common phishing target. Never share this code.',
    ].join('\n')
    expect(detectSignIn(output)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-12345',
    })
  })

  it('detects a long claude oauth URL without a code', () => {
    const url =
      'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=abc123&state=xyz'
    const output = `Browser didn't open? Use the url below to sign in:\n\n${url}\n\nPaste code here if prompted > `
    expect(detectSignIn(output)).toEqual({ url, code: null })
  })

  it('detects cursor login URL', () => {
    const output =
      'Starting login process...\n\nOpen the following URL to authenticate:\nhttps://cursor.com/loginDeepControl?challenge=abc&uuid=1234-5678&mode=login.\n\nWaiting for authentication...'
    expect(detectSignIn(output)).toEqual({
      url: 'https://cursor.com/loginDeepControl?challenge=abc&uuid=1234-5678&mode=login',
      code: null,
    })
  })

  it('prefers the last auth-looking URL over later unrelated URLs', () => {
    const output =
      'Go to https://example.com/oauth/authorize?x=1 to sign in.\nDocs: https://docs.example.com/help'
    expect(detectSignIn(output).url).toBe(
      'https://example.com/oauth/authorize?x=1'
    )
  })

  it('falls back to the last https URL', () => {
    const output = 'Visit (https://one.example.com) or https://two.example.com.'
    expect(detectSignIn(output).url).toBe('https://two.example.com')
  })

  it('returns nulls when there is no URL or code', () => {
    expect(detectSignIn('Select a provider\n> Anthropic\n  OpenAI')).toEqual({
      url: null,
      code: null,
    })
    expect(detectSignIn('')).toEqual({ url: null, code: null })
  })

  it('ignores dates and codes inside URLs', () => {
    const output =
      'Code expires 2026-10-12.\nhttps://example.com/device?code=WXYZ-9876'
    expect(detectSignIn(output).code).toBeNull()
  })

  it('ignores ids that are not near the word code', () => {
    expect(detectSignIn('Request ID ABCD-1234 logged.').code).toBeNull()
  })

  it('accepts XXXX-XXXX-XX style codes and keeps the latest one', () => {
    const output =
      'Your code is AAAA-BBBB-11\n...expired...\nYour code is WXYZ-9876-QR'
    expect(detectSignIn(output).code).toBe('WXYZ-9876-QR')
  })
})
