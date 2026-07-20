import { describe, expect, it } from 'vitest'
import {
  looksLikeCollapsedStreamSpaces,
  shouldHydrateCompletedSessionFromBackend,
} from './completion-hydration'

describe('shouldHydrateCompletedSessionFromBackend', () => {
  it('requests hydration when plain-text plan content exists without a CodexPlan tool', () => {
    expect(
      shouldHydrateCompletedSessionFromBackend(
        'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
        [{ type: 'text', text: 'Repo inspected.' }],
        []
      )
    ).toBe(true)
  })

  it('requests hydration when a CodexPlan tool is present so cache picks up backend message id', () => {
    expect(
      shouldHydrateCompletedSessionFromBackend(
        'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
        [{ type: 'tool_use', tool_call_id: 'plan-1' }],
        [{ id: 'plan-1', name: 'CodexPlan', input: {} }]
      )
    ).toBe(true)
  })

  it('requests hydration when an ExitPlanMode tool is present (Claude plan)', () => {
    expect(
      shouldHydrateCompletedSessionFromBackend(
        '',
        [{ type: 'tool_use', tool_call_id: 'plan-1' }],
        [
          {
            id: 'plan-1',
            name: 'ExitPlanMode',
            input: { plan: '- step one\n- step two' },
          },
        ]
      )
    ).toBe(true)
  })

  it('requests hydration for Grok so run-log parse can repair space-glued streams', () => {
    expect(
      shouldHydrateCompletedSessionFromBackend(
        'Hello world with normal spaces',
        [{ type: 'text', text: 'Hello world with normal spaces' }],
        [],
        { backend: 'grok' }
      )
    ).toBe(true)
  })

  it('requests hydration when content looks space-collapsed', () => {
    expect(
      shouldHydrateCompletedSessionFromBackend(
        'bashbunrunprocess:invoices----v2--invoice=in_xxxxx Testfirst',
        [],
        []
      )
    ).toBe(true)
  })

  it('does not force hydrate for normal non-Grok completed text', () => {
    expect(
      shouldHydrateCompletedSessionFromBackend(
        'Hello world with normal spaces',
        [{ type: 'text', text: 'Hello world with normal spaces' }],
        [],
        { backend: 'claude' }
      )
    ).toBe(false)
  })
})

describe('looksLikeCollapsedStreamSpaces', () => {
  it('detects glued Grok fence + command tokens', () => {
    expect(
      looksLikeCollapsedStreamSpaces(
        'bashbunrunprocess:invoices----v2--invoice=in_xxxxx'
      )
    ).toBe(true)
  })

  it('accepts normal spaced markdown', () => {
    expect(
      looksLikeCollapsedStreamSpaces(
        '```bash\nbun run process:invoices -- --v2\n```\n\n**Test first**'
      )
    ).toBe(false)
  })
})
