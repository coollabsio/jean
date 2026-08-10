import { describe, expect, it } from 'vitest'
import {
  getNewSessionDialogSizeClass,
  getNewSessionSubmitLabel,
  getNewSessionContextDescription,
  sourceContextOwnsBranch,
  type NewSessionSourceContext,
} from './new-session-draft'

describe('new session draft presentation', () => {
  it.each(['pr', 'stack-pr', 'branch', 'base'] as const)(
    'hides the base branch picker for a %s source',
    type => {
      const source: NewSessionSourceContext = {
        type,
        kind: type,
        label: 'source',
      }

      expect(sourceContextOwnsBranch(source)).toBe(true)
    }
  )

  it.each(['issue', 'security', 'advisory', 'linear', 'sentry'] as const)(
    'keeps the base branch picker for a %s source',
    type => {
      const source: NewSessionSourceContext = {
        type,
        kind: type,
        label: 'source',
      }

      expect(sourceContextOwnsBranch(source)).toBe(false)
    }
  )

  it('uses a compact composer and a large source browser', () => {
    expect(getNewSessionDialogSizeClass('quick')).toContain('760px')
    expect(getNewSessionDialogSizeClass('quick')).toContain('h-auto')
    expect(getNewSessionDialogSizeClass('quick')).not.toContain('h-[340px]')
    expect(getNewSessionDialogSizeClass('prs')).toContain('90vw')
    expect(getNewSessionDialogSizeClass('issues')).toContain('90vw')
  })

  it.each([
    [null, 'Create worktree & start'],
    [{ type: 'issue' }, 'Create worktree & start'],
    [{ type: 'pr' }, 'Check out PR & start'],
    [{ type: 'stack-pr' }, 'Create stacked worktree'],
    [{ type: 'branch' }, 'Open branch in worktree'],
    [{ type: 'base' }, 'Start in project folder'],
  ] as const)('uses an action-specific submit label', (source, expected) => {
    expect(getNewSessionSubmitLabel(source as never)).toBe(expected)
  })

  it.each([
    [{ type: 'issue' }, 'title, description, labels and discussion'],
    [{ type: 'pr' }, 'description, comments, reviews and branch details'],
    [{ type: 'security' }, 'advisory, dependency and remediation details'],
    [{ type: 'linear' }, 'description, status and labels'],
    [{ type: 'sentry' }, 'error details, stack trace and event metadata'],
  ] as const)('explains the context sent to the agent', (source, expected) => {
    expect(getNewSessionContextDescription(source as never)).toContain(expected)
  })
})
