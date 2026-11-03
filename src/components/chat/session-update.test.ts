import { describe, expect, it } from 'vitest'
import { parseSessionUpdate } from './session-update'

const VALID = [
  '[Jean session update]',
  'session: s-child',
  'worktree: w-child',
  'name: Fix login',
  'status: done',
  '---',
  'Fixed the redirect.',
  'Call read_session_messages for the full history.',
].join('\n')

describe('parseSessionUpdate', () => {
  it('parses the header fields and the body', () => {
    expect(parseSessionUpdate(VALID)).toEqual({
      sessionId: 's-child',
      worktreeId: 'w-child',
      name: 'Fix login',
      status: 'done',
      body: 'Fixed the redirect.\nCall read_session_messages for the full history.',
    })
  })

  it('accepts CRLF line endings and extra whitespace', () => {
    const text = `\r\n  ${VALID.replace(/\n/g, '\r\n').replace('status: done', '  status :   waiting_plan  ')}\r\n\r\n`
    expect(parseSessionUpdate(text)).toEqual({
      sessionId: 's-child',
      worktreeId: 'w-child',
      name: 'Fix login',
      status: 'waiting_plan',
      body: 'Fixed the redirect.\nCall read_session_messages for the full history.',
    })
  })

  it('keeps colons inside values and the body', () => {
    const text = VALID.replace('name: Fix login', 'name: Fix: login').replace(
      'Fixed the redirect.',
      'Error: exit code 1'
    )
    expect(parseSessionUpdate(text)).toMatchObject({
      name: 'Fix: login',
      body: 'Error: exit code 1\nCall read_session_messages for the full history.',
    })
  })

  it('returns null without the header line', () => {
    expect(
      parseSessionUpdate(VALID.replace('[Jean session update]\n', ''))
    ).toBeNull()
    expect(parseSessionUpdate(`Hi\n${VALID}`)).toBeNull()
    expect(parseSessionUpdate('[Jean agent update]\nstatus: done')).toBeNull()
  })

  it('returns null for an unknown status', () => {
    expect(
      parseSessionUpdate(VALID.replace('status: done', 'status: running'))
    ).toBeNull()
  })

  it('returns null when the session or worktree is missing', () => {
    expect(
      parseSessionUpdate(VALID.replace('session: s-child\n', ''))
    ).toBeNull()
    expect(
      parseSessionUpdate(VALID.replace('worktree: w-child', 'worktree:'))
    ).toBeNull()
  })
})

describe('backend contract', () => {
  it('parses the exact text jean-core/src/chat/delegation.rs produces', () => {
    const text =
      '[Jean session update]\nsession: child\nworktree: wt\nname: Child\nstatus: failed\n---\nError: claude exited with status 1\n\nFixed the bug.\n\nUse read_session_messages for the full transcript.'
    expect(parseSessionUpdate(text)).toEqual({
      sessionId: 'child',
      worktreeId: 'wt',
      name: 'Child',
      status: 'failed',
      body: 'Error: claude exited with status 1\n\nFixed the bug.\n\nUse read_session_messages for the full transcript.',
    })
  })
})
