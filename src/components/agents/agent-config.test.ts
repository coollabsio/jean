import { describe, expect, it } from 'vitest'
import type { AgentSkill } from '@/services/agents'
import {
  AGENT_DEFAULT_OPTION,
  agentRunPatch,
  agentRunSummary,
  backendChoices,
  draftFromAgent,
  effortOptionsForBackend,
  EMPTY_AGENT_RUN,
  fromPickerValue,
  modelOptionsForBackend,
  pickerBackend,
  sameAgentRun,
  skillChoices,
  thinkingOptionsForBackend,
  toggleSkill,
  toPickerValue,
  withBackend,
  withBackendModel,
  withDefaultReasoningOption,
  type AgentRunDraft,
} from './agent-config'
import type { AgentSummary } from '@/services/agents'

function draft(overrides: Partial<AgentRunDraft> = {}): AgentRunDraft {
  return { ...EMPTY_AGENT_RUN, ...overrides }
}

describe('backend and model choices', () => {
  it('offers every backend until install detection finishes or finds nothing', () => {
    expect(backendChoices([], '', true).map(option => option.value)).toContain(
      'codex'
    )
    expect(backendChoices([], '', false)).toHaveLength(
      backendChoices([], '', true).length
    )
    expect(
      backendChoices(['claude'], '', false).map(option => option.value)
    ).toEqual(['claude'])
    expect(
      backendChoices(['claude'], 'codex', false).map(option => option.value)
    ).toEqual(['claude', 'codex'])
  })

  it('lists models and reasoning only after a backend is chosen', () => {
    expect(modelOptionsForBackend('')).toEqual([])
    expect(
      modelOptionsForBackend('codex').map(option => option.value)
    ).toContain('gpt-5.5')
    expect(
      effortOptionsForBackend('codex').map(option => option.value)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(
      effortOptionsForBackend('antigravity').map(option => option.value)
    ).toContain('adaptive')
    expect(effortOptionsForBackend('cursor')).toEqual([])
    expect(
      thinkingOptionsForBackend('claude').map(option => option.value)
    ).toContain('ultrathink')
    expect(thinkingOptionsForBackend('codex')).toEqual([])
  })
})

describe('withBackend', () => {
  it('clears a model, effort, and skills from the previous backend', () => {
    const next = withBackend(
      draft({
        backend: 'claude',
        model: 'claude-opus-5',
        effort: 'max',
        thinkingLevel: 'ultrathink',
        skills: [
          { name: 'review', path: '/claude/SKILL.md', backend: 'claude' },
          { name: 'ship', path: '/codex/SKILL.md', backend: 'codex' },
        ],
      }),
      'codex'
    )
    expect(next.backend).toBe('codex')
    expect(next.model).toBe('')
    expect(next.effort).toBe('')
    expect(next.thinkingLevel).toBe('')
    expect(next.skills.map(skill => skill.path)).toEqual(['/codex/SKILL.md'])
  })
})

describe('skills', () => {
  const groups = [
    {
      backend: 'codex' as const,
      skills: [
        {
          name: 'review',
          path: '/skills/review/SKILL.md',
          description: 'Review',
        },
        { name: 'review-dup', path: '/skills/review/SKILL.md' },
      ],
    },
    {
      backend: 'claude' as const,
      skills: [{ name: 'plan', path: '/skills/plan/SKILL.md' }],
    },
  ]

  it('filters by backend and dedupes paths', () => {
    expect(skillChoices(groups, 'codex')).toEqual([
      {
        name: 'review',
        path: '/skills/review/SKILL.md',
        description: 'Review',
        backend: 'codex',
      },
    ])
    expect(skillChoices(groups, '').map(skill => skill.path)).toEqual([
      '/skills/review/SKILL.md',
      '/skills/plan/SKILL.md',
    ])
  })

  it('toggles a skill by path', () => {
    const skill = skillChoices(groups, 'codex')[0]
    expect(skill).toBeDefined()
    if (!skill) return
    const selected = toggleSkill([], skill, true)
    expect(selected).toEqual([
      {
        name: 'review',
        path: '/skills/review/SKILL.md',
        backend: 'codex',
      },
    ])
    expect(toggleSkill(selected, skill, true)).toBe(selected)
    expect(toggleSkill(selected, skill, false)).toEqual([])
  })
})

describe('agent run patch and summary', () => {
  it('maps an empty draft to cleared fields', () => {
    expect(agentRunPatch(EMPTY_AGENT_RUN)).toEqual({
      backend: null,
      model: null,
      effort: null,
      thinkingLevel: null,
      skills: [],
    })
  })

  it('keeps a selected backend, model, and skills', () => {
    const skills: AgentSkill[] = [
      { name: 'review', path: '/skills/review/SKILL.md', backend: 'codex' },
    ]
    expect(
      agentRunPatch(
        draft({
          backend: 'codex',
          model: 'gpt-5.5',
          effort: 'high',
          skills,
        })
      )
    ).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      thinkingLevel: null,
      skills,
    })
  })

  it('summarizes only the fields that are set', () => {
    expect(
      agentRunSummary({ backend: null, model: null, skills: [] })
    ).toBeNull()
    expect(
      agentRunSummary({
        backend: 'codex',
        model: 'gpt-5.5',
        skills: [{ name: 'review' }],
      })
    ).toBe('Codex · gpt-5.5 · 1 skill')
    expect(
      agentRunSummary({
        backend: 'grok',
        model: null,
        skills: [{ name: 'a' }, { name: 'b' }],
      })
    ).toBe('Grok · 2 skills')
  })

  it('treats the same skill paths as the same draft', () => {
    const saved = draftFromAgent({
      backend: 'codex',
      model: null,
      effort: null,
      thinkingLevel: null,
      skills: [{ name: 'review', path: '/skills/review/SKILL.md' }],
    } as AgentSummary)
    expect(saved.backend).toBe('codex')
    expect(saved.model).toBe('')
    expect(
      sameAgentRun(saved, {
        ...saved,
        skills: [{ name: 'other', path: '/skills/review/SKILL.md' }],
      })
    ).toBe(true)
    expect(sameAgentRun(saved, { ...saved, model: 'gpt-5.5' })).toBe(false)
  })
})

describe('shared backend/model picker mapping', () => {
  it('maps the inherit option to an empty draft value and back', () => {
    expect(toPickerValue('')).toBe(AGENT_DEFAULT_OPTION)
    expect(toPickerValue('high')).toBe('high')
    expect(fromPickerValue(AGENT_DEFAULT_OPTION)).toBe('')
    expect(fromPickerValue('high')).toBe('high')
  })

  it('pins a backend and model picked from an inheriting draft', () => {
    const next = withBackendModel(EMPTY_AGENT_RUN, 'codex', 'gpt-5.5')
    expect(next).toMatchObject({ backend: 'codex', model: 'gpt-5.5' })
  })

  it('keeps models the static list does not know (dynamic CLI models)', () => {
    const next = withBackendModel(
      draft({ backend: 'opencode' }),
      'opencode',
      'opencode/some-provider/new-model'
    )
    expect(next.model).toBe('opencode/some-provider/new-model')
  })

  it('stores "Default model" as an empty model that saves as null', () => {
    const next = withBackendModel(
      draft({ backend: 'claude', model: 'claude-opus-5', effort: 'max' }),
      'claude',
      AGENT_DEFAULT_OPTION
    )
    expect(next).toMatchObject({ backend: 'claude', model: '', effort: 'max' })
    expect(agentRunPatch(next)).toMatchObject({
      backend: 'claude',
      model: null,
      effort: 'max',
    })
  })

  it('clears reasoning and skills of the old backend when switching', () => {
    const next = withBackendModel(
      draft({
        backend: 'claude',
        model: 'claude-opus-5',
        effort: 'max',
        thinkingLevel: 'ultrathink',
        skills: [{ name: 'a', path: '/claude/SKILL.md', backend: 'claude' }],
      }),
      'codex',
      'gpt-5.5'
    )
    expect(next).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.5',
      effort: '',
      thinkingLevel: '',
      skills: [],
    })
  })

  it('resets to inherit with every override cleared', () => {
    const reset = withBackend(
      draft({ backend: 'claude', model: 'claude-opus-5', effort: 'max' }),
      ''
    )
    expect(agentRunPatch(reset)).toMatchObject({
      backend: null,
      model: null,
      effort: null,
      thinkingLevel: null,
    })
  })

  it('opens the picker on the agent backend, then the new-chat default', () => {
    expect(
      pickerBackend(draft({ backend: 'codex' }), 'claude', ['claude'])
    ).toBe('codex')
    expect(pickerBackend(EMPTY_AGENT_RUN, 'codex', ['claude', 'codex'])).toBe(
      'codex'
    )
    expect(pickerBackend(EMPTY_AGENT_RUN, 'codex', ['claude'])).toBe('claude')
    expect(pickerBackend(EMPTY_AGENT_RUN, undefined, [])).toBe('claude')
  })

  it('adds a leading Default option to effort and thinking lists', () => {
    const options = withDefaultReasoningOption(effortOptionsForBackend('codex'))
    expect(options[0]).toMatchObject({
      value: AGENT_DEFAULT_OPTION,
      label: 'Default',
    })
    expect(options.slice(1).map(option => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })
})
