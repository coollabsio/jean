import { describe, expect, it } from 'vitest'
import type { AgentSkill, SubagentType } from '@/services/agents'
import {
  resolveSubagentRun,
  subagentRunSummary,
  subagentTypeInput,
  taskKindLabel,
  validateSubagentTypeDraft,
  type SubagentTypeDraft,
} from './subagent-types'

const parentSkill: AgentSkill = {
  name: 'parent',
  path: '/skills/parent/SKILL.md',
  backend: 'claude',
}

const agent = {
  rolePrompt: 'Be thorough',
  backend: 'claude',
  model: 'claude-sonnet',
  effort: 'low',
  thinkingLevel: 'think',
  skills: [parentSkill],
}

function type(overrides: Partial<SubagentType> = {}): SubagentType {
  return {
    id: 1,
    agentId: 'reviewer',
    shared: false,
    name: 'Investigator',
    description: '',
    instructions: '',
    backend: null,
    model: null,
    effort: null,
    thinkingLevel: null,
    skills: [],
    permissionMode: null,
    toolMode: null,
    ...overrides,
  }
}

function draft(overrides: Partial<SubagentTypeDraft> = {}): SubagentTypeDraft {
  return {
    id: null,
    name: 'Investigator',
    description: 'reads',
    instructions: 'Report facts',
    shared: false,
    backend: 'codex',
    model: 'gpt-5.5',
    effort: '',
    thinkingLevel: '',
    skills: [],
    permissionMode: 'plan',
    toolMode: 'read_only',
    ...overrides,
  }
}

describe('resolveSubagentRun', () => {
  it('inherits blank overrides and replaces set ones', () => {
    const inherited = resolveSubagentRun(agent, type())
    expect(inherited.instructions).toBe('Be thorough')
    expect(inherited.backend).toBe('claude')
    expect(inherited.model).toBe('claude-sonnet')
    expect(inherited.effort).toBe('low')
    expect(inherited.thinkingLevel).toBe('think')
    expect(inherited.skills).toEqual([parentSkill])
    expect(inherited.permissionMode).toBeNull()
    expect(inherited.toolMode).toBeNull()

    const replaced = resolveSubagentRun(
      agent,
      type({
        instructions: 'Report facts only',
        backend: 'codex',
        model: 'gpt-5.5',
        effort: 'high',
        skills: [{ name: 'diff', path: '/skills/diff/SKILL.md' }],
        permissionMode: 'plan',
        toolMode: 'read_only',
      })
    )
    expect(replaced.instructions).toBe('Report facts only')
    expect(replaced.backend).toBe('codex')
    expect(replaced.model).toBe('gpt-5.5')
    expect(replaced.effort).toBe('high')
    expect(replaced.thinkingLevel).toBe('think')
    expect(replaced.skills.map(skill => skill.path)).toEqual([
      '/skills/diff/SKILL.md',
    ])
    expect(replaced.permissionMode).toBe('plan')
    expect(replaced.toolMode).toBe('read_only')
    expect(subagentRunSummary(replaced)).toBe(
      'codex · gpt-5.5 · high · plan · read only · 1 skill'
    )
  })
})

describe('validateSubagentTypeDraft', () => {
  it('requires a name and rejects text that is too long', () => {
    expect(validateSubagentTypeDraft(draft({ name: '  ' }))).toBe(
      'Name is required'
    )
    expect(validateSubagentTypeDraft(draft({ name: 'a\nb' }))).toBe(
      'Name cannot contain a newline'
    )
    expect(validateSubagentTypeDraft(draft())).toBeNull()
    expect(
      validateSubagentTypeDraft(draft({ instructions: 'x'.repeat(8001) }))
    ).toBe('Instructions are too long')
  })
})

describe('subagentTypeInput', () => {
  it('sends blank overrides as null and keeps an id when editing', () => {
    expect(subagentTypeInput(draft())).toMatchObject({
      name: 'Investigator',
      shared: false,
      backend: 'codex',
      model: 'gpt-5.5',
      effort: null,
      thinkingLevel: null,
      permissionMode: 'plan',
      toolMode: 'read_only',
    })
    expect(subagentTypeInput(draft())).not.toHaveProperty('id')
    expect(subagentTypeInput(draft({ id: 4, shared: true })).id).toBe(4)
  })
})

describe('taskKindLabel', () => {
  it('shows the subagent type on a spawned task', () => {
    expect(taskKindLabel('schedule', null)).toBe('Schedule')
    expect(taskKindLabel('subagent', 'Investigator')).toBe(
      'Subagent · Investigator'
    )
    expect(taskKindLabel('subagent', '  ')).toBe('Subagent')
    expect(taskKindLabel('message', undefined)).toBe('Agent request')
  })
})
