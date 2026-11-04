import { describe, expect, it } from 'vitest'
import { describeSessionUpdates, parseSessionUpdates } from './session-update'

const FOOTER =
  'Use read_session_messages for a full transcript. Reply briefly; the user sees sub-session status in the side panel.'

const ONE = [
  '[Jean session update]',
  'session: s-child',
  'worktree: w-child',
  'name: Fix login',
  'status: done',
  '---',
  'Fixed the redirect.',
  'Second line.',
  '',
  FOOTER,
].join('\n')

/** Exact text `jean-core/src/chat/delegation.rs` queues for two children. */
const TWO = [
  '[Jean session update]',
  'session: a',
  'worktree: wt',
  'name: Child',
  'status: done',
  '---',
  'Fixed the bug.',
  '',
  '[Jean session update]',
  'session: b',
  'worktree: wt',
  'name: Child',
  'status: failed',
  '---',
  'Error: claude exited with status 1',
  '',
  'Fixed the bug.',
  '',
  FOOTER,
].join('\n')

describe('parseSessionUpdates', () => {
  it('parses the header fields and the body without the footer', () => {
    expect(parseSessionUpdates(ONE)).toEqual([
      {
        sessionId: 's-child',
        worktreeId: 'w-child',
        name: 'Fix login',
        status: 'done',
        body: 'Fixed the redirect.\nSecond line.',
      },
    ])
  })

  it('parses every block of the message the backend queues', () => {
    expect(parseSessionUpdates(TWO)).toEqual([
      {
        sessionId: 'a',
        worktreeId: 'wt',
        name: 'Child',
        status: 'done',
        body: 'Fixed the bug.',
      },
      {
        sessionId: 'b',
        worktreeId: 'wt',
        name: 'Child',
        status: 'failed',
        body: 'Error: claude exited with status 1\n\nFixed the bug.',
      },
    ])
  })

  it('accepts CRLF line endings, extra whitespace, and no footer', () => {
    const text = `\r\n  ${ONE.replace(/\n/g, '\r\n')
      .replace('status: done', '  status :   waiting_plan  ')
      .replace(FOOTER, '')}\r\n\r\n`
    expect(parseSessionUpdates(text)).toEqual([
      {
        sessionId: 's-child',
        worktreeId: 'w-child',
        name: 'Fix login',
        status: 'waiting_plan',
        body: 'Fixed the redirect.\nSecond line.',
      },
    ])
  })

  it('keeps colons inside values and the body', () => {
    const text = ONE.replace('name: Fix login', 'name: Fix: login').replace(
      'Fixed the redirect.',
      'Error: exit code 1'
    )
    expect(parseSessionUpdates(text)?.[0]).toMatchObject({
      name: 'Fix: login',
      body: 'Error: exit code 1\nSecond line.',
    })
  })

  it('returns null without the header line', () => {
    expect(
      parseSessionUpdates(ONE.replace('[Jean session update]\n', ''))
    ).toBeNull()
    expect(parseSessionUpdates(`Hi\n${ONE}`)).toBeNull()
    expect(parseSessionUpdates('[Jean agent update]\nstatus: done')).toBeNull()
  })

  it('returns null when any block has an unknown status or misses a field', () => {
    expect(
      parseSessionUpdates(TWO.replace('status: failed', 'status: running'))
    ).toBeNull()
    expect(parseSessionUpdates(TWO.replace('worktree: wt\n', ''))).toBeNull()
  })
})

describe('describeSessionUpdates', () => {
  it('names each session with its outcome', () => {
    expect(
      describeSessionUpdates([
        {
          sessionId: 'a',
          worktreeId: 'w',
          name: 'Write changelog',
          status: 'done',
          body: '',
        },
        {
          sessionId: 'b',
          worktreeId: 'w',
          name: '',
          status: 'question',
          body: '',
        },
      ])
    ).toBe('Write changelog finished, Session asking a question')
  })
})
