import { describe, expect, it } from 'vitest'
import {
  buildTimeline,
  coalesceContentBlocks,
  getIntroTextBeforeDuplicatePlan,
  isDuplicatePlanTextBlock,
  resolvePlanContent,
  splitTextAroundPlan,
} from './tool-call-utils'
import type { ContentBlock, ToolCall } from '@/types/chat'

describe('splitTextAroundPlan', () => {
  it('separates prose before a trailing plan block', () => {
    expect(
      splitTextAroundPlan(
        'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests'
      )
    ).toEqual({
      beforePlan: 'Repo inspected.',
      plan: 'Plan:\n- Implement changes\n- Add tests',
    })
  })

  it('returns the full text as non-plan content when no plan heading exists', () => {
    expect(splitTextAroundPlan('Repo inspected.')).toEqual({
      beforePlan: 'Repo inspected.',
      plan: null,
    })
  })
})

describe('resolvePlanContent', () => {
  it('extracts only the plan section from assistant text when tool only has explanation', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'plan-1',
        name: 'CodexPlan',
        input: {
          explanation: 'Repo inspected. Native plan had no prose body.',
          steps: [{ step: 'Clarify scope', status: 'in_progress' }],
        },
      },
    ]

    expect(
      resolvePlanContent({
        toolCalls,
        messageContent:
          'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
      })
    ).toEqual({
      content: 'Plan:\n- Implement changes\n- Add tests',
      source: 'message_text',
    })
  })

  it('keeps tool-provided plan content ahead of assistant text', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'plan-1',
        name: 'CodexPlan',
        input: {
          plan: 'Plan:\n- Tool plan wins',
          explanation: 'Fallback explanation',
        },
      },
    ]

    expect(
      resolvePlanContent({
        toolCalls,
        messageContent: 'Plan:\n- Message text loses',
      })
    ).toEqual({
      content: 'Plan:\n- Tool plan wins',
      source: 'plan',
    })
  })

  it('ignores non-string tool plan payloads and falls back to assistant text', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'plan-1',
        name: 'CodexPlan',
        input: {
          plan: [{ step: 'Wrong runtime shape' }],
          explanation: 'Summary only',
          steps: [{ step: 'Clarify scope', status: 'in_progress' }],
        },
      },
    ]

    expect(
      resolvePlanContent({
        toolCalls,
        messageContent:
          'Repo inspected.\n\nPlan:\n- Remove auto-continue\n- Add tests',
      })
    ).toEqual({
      content: 'Plan:\n- Remove auto-continue\n- Add tests',
      source: 'message_text',
    })
  })

  it('extracts a plan section from fragmented text blocks before explanation fallback', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'plan-1',
        name: 'CodexPlan',
        input: {
          explanation: 'Summary only',
          steps: [{ step: 'Clarify scope', status: 'in_progress' }],
        },
      },
    ]

    expect(
      resolvePlanContent({
        toolCalls,
        contentBlocks: [
          { type: 'text', text: 'Repo inspected.\n\n' },
          { type: 'text', text: 'Plan:\n- Remove auto-continue' },
          { type: 'text', text: '\n- Add tests' },
        ],
      })
    ).toEqual({
      content: 'Plan:\n- Remove auto-continue\n- Add tests',
      source: 'message_text',
    })
  })

  it('formats structured Codex steps when no plan text was persisted', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'plan-1',
        name: 'CodexPlan',
        input: {
          explanation: 'Extend the existing backup pipeline.',
          steps: [
            { step: 'Generalize the schema', status: 'completed' },
            { step: 'Update the backup UI', status: 'in_progress' },
            { step: 'Run regression tests', status: 'pending' },
          ],
        },
      },
    ]

    expect(resolvePlanContent({ toolCalls })).toEqual({
      content:
        'Extend the existing backup pipeline.\n\n- [x] Generalize the schema\n- [ ] **In progress:** Update the backup UI\n- [ ] Run regression tests',
      source: 'steps',
    })
  })

  it('prefers the richest body when multiple CodexPlan tools exist', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'codex-plan-turn-1',
        name: 'CodexPlan',
        input: {
          explanation: 'Plan created and ready for approval.',
          steps: [{ step: 'Touch files', status: 'pending' }],
        },
      },
      {
        id: 'codex-plan-plan-1',
        name: 'CodexPlan',
        input: {
          plan: 'Plan:\n- Rewrite the parser in codex.rs\n- Add merge tests for split plan tools\n- Verify YOLO handoff content',
        },
      },
    ]

    expect(resolvePlanContent({ toolCalls })).toEqual({
      content:
        'Plan:\n- Rewrite the parser in codex.rs\n- Add merge tests for split plan tools\n- Verify YOLO handoff content',
      source: 'plan',
    })
  })

  it('does not treat status-only explanation as authoritative plan content when assistant text is richer', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'plan-1',
        name: 'CodexPlan',
        input: {
          explanation: 'Plan created and ready for approval.',
          steps: [{ step: 'Do the thing', status: 'pending' }],
        },
      },
    ]

    const detailed =
      'Goal: rewrite plan extraction.\n\n1. Unify CodexPlan tool ids across live and history paths.\n2. Prefer richest plan body when tools split.\n3. Require handoff-quality plan prompts for Codex.\n4. Cover with unit tests for multi-tool resolution.'

    expect(
      resolvePlanContent({
        toolCalls,
        messageContent: detailed,
      })
    ).toEqual({
      content: detailed,
      source: 'message_text',
    })
  })
})

describe('isDuplicatePlanTextBlock', () => {
  it('matches blocks whose extracted plan equals resolved plan content', () => {
    expect(
      isDuplicatePlanTextBlock(
        'Repo inspected.\n\nPlan:\n- Implement changes',
        'Plan:\n- Implement changes'
      )
    ).toBe(true)
  })

  it('does not hide different assistant text just because it contains a plan heading', () => {
    expect(
      isDuplicatePlanTextBlock(
        'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
        'Plan:\n- Implement changes'
      )
    ).toBe(false)
  })

  it('matches Cursor CLI plan text that has no "Plan:" prefix (direct equality)', () => {
    const planText =
      '1. Do you want me to switch out of plan mode and implement now?\n\n- a) Yes, proceed\n- b) No, stay in plan mode'
    expect(isDuplicatePlanTextBlock(planText, planText)).toBe(true)
  })

  it('does not suppress unrelated text even when a plan exists', () => {
    expect(
      isDuplicatePlanTextBlock(
        'Here is some intro text.',
        '1. Do you want me to switch out of plan mode?'
      )
    ).toBe(false)
  })
})

describe('getIntroTextBeforeDuplicatePlan', () => {
  it('returns null when the whole assistant text is the rendered plan', () => {
    expect(
      getIntroTextBeforeDuplicatePlan(
        'Short answer: goal is separate from plan mode.',
        'Short answer: goal is separate from plan mode.'
      )
    ).toBeNull()
  })

  it('returns prose before a matching trailing plan section', () => {
    expect(
      getIntroTextBeforeDuplicatePlan(
        'Repo inspected.\n\nPlan:\n- Implement changes',
        'Plan:\n- Implement changes'
      )
    ).toBe('Repo inspected.')
  })
})

describe('coalesceContentBlocks', () => {
  it('merges consecutive text blocks into one', () => {
    const input: ContentBlock[] = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ]
    expect(coalesceContentBlocks(input)).toEqual([
      { type: 'text', text: 'Hello world' },
    ])
  })

  it('preserves tool_use and thinking boundaries', () => {
    const input: ContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'tool_use', tool_call_id: 't1' },
      { type: 'text', text: 'b1' },
      { type: 'text', text: 'b2' },
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'c' },
    ]
    expect(coalesceContentBlocks(input)).toEqual([
      { type: 'text', text: 'a' },
      { type: 'tool_use', tool_call_id: 't1' },
      { type: 'text', text: 'b1b2' },
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'c' },
    ])
  })

  it('is idempotent', () => {
    const input: ContentBlock[] = [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
      { type: 'tool_use', tool_call_id: 't1' },
      { type: 'text', text: 'three' },
      { type: 'text', text: 'four' },
    ]
    const once = coalesceContentBlocks(input)
    const twice = coalesceContentBlocks(once)
    expect(twice).toEqual(once)
  })

  it('preserves paragraph separators embedded in deltas', () => {
    const input: ContentBlock[] = [
      { type: 'text', text: 'para1' },
      { type: 'text', text: '\n\npara2' },
    ]
    expect(coalesceContentBlocks(input)).toEqual([
      { type: 'text', text: 'para1\n\npara2' },
    ])
  })
})

describe('buildTimeline with fragmented text deltas', () => {
  it('renders native Codex request_user_input in the inline question timeline slot', () => {
    const tools: ToolCall[] = [
      {
        id: 'codex-user-input-1',
        name: 'request_user_input',
        input: {
          questions: [
            {
              id: 'scope',
              header: 'Scope',
              question: 'Which scope?',
              options: [{ label: 'Backend' }],
            },
          ],
        },
      },
    ]
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Need one decision first.' },
      { type: 'tool_use', tool_call_id: 'codex-user-input-1' },
      { type: 'text', text: 'request_user_input UI unavailable here' },
    ]

    const timeline = buildTimeline(blocks, tools)

    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      type: 'askUserQuestion',
      introText: 'Need one decision first.',
      tool: expect.objectContaining({ id: 'codex-user-input-1' }),
    })
  })

  it('renders Claude AskUserQuestion when questions are encoded as JSON string', () => {
    const tools: ToolCall[] = [
      {
        id: 'claude-question-1',
        name: 'AskUserQuestion',
        input: {
          questions:
            '[{"question":"Pick one","header":"Choice","multiSelect":false,"options":[{"label":"A"}]}]',
        },
      },
    ]
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Need one decision.' },
      { type: 'tool_use', tool_call_id: 'claude-question-1' },
    ]

    const timeline = buildTimeline(blocks, tools)

    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      type: 'askUserQuestion',
      introText: 'Need one decision.',
      tool: {
        input: {
          questions: [
            {
              question: 'Pick one',
              header: 'Choice',
              multiSelect: false,
              options: [{ label: 'A' }],
            },
          ],
        },
      },
    })
  })

  it('renders fragmented text as one paragraph item', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'para1' },
      { type: 'text', text: '\n\npara2' },
    ]
    const timeline = buildTimeline(blocks, [])
    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      type: 'text',
      text: 'para1\n\npara2',
    })
  })

  it('tool grouping matches streaming when text deltas surround tools', () => {
    const tools: ToolCall[] = [
      { id: 'A', name: 'Read', input: {}, output: 'ok' },
      { id: 'B', name: 'Grep', input: {}, output: 'ok' },
      { id: 'C', name: 'Glob', input: {}, output: 'ok' },
    ]
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'intro-' },
      { type: 'text', text: 'start' },
      { type: 'tool_use', tool_call_id: 'A' },
      { type: 'tool_use', tool_call_id: 'B' },
      { type: 'text', text: 'mid-' },
      { type: 'text', text: 'summary' },
      { type: 'tool_use', tool_call_id: 'C' },
    ]
    const timeline = buildTimeline(blocks, tools)
    expect(timeline.map(i => i.type)).toEqual([
      'text',
      'stackedGroup',
      'text',
      'standalone',
    ])
    expect(timeline[0]).toMatchObject({ text: 'intro-start' })
    expect(timeline[2]).toMatchObject({ text: 'mid-summary' })
  })
})
