import { describe, expect, it } from 'vitest'
import type { AgentChange } from '@/services/agents'
import {
  agentChangeActorLabel,
  agentChangeDetail,
  latestChangeIdForTarget,
} from './agent-changes'

function change(overrides: Partial<AgentChange>): AgentChange {
  return {
    id: 1,
    actorAgentId: 'user',
    targetAgentId: 'helper',
    action: 'update',
    summary: 'name: "Helper" -> "Docs"',
    before: { name: 'Helper' },
    after: { name: 'Docs' },
    sessionId: null,
    createdAt: 0,
    revertedChangeId: null,
    ...overrides,
  }
}

describe('agent change activity', () => {
  it('reverts only the newest change for that agent', () => {
    const changes = [
      change({ id: 3, targetAgentId: 'helper' }),
      change({ id: 2, targetAgentId: 'other', actorAgentId: 'helper' }),
      change({ id: 1, targetAgentId: 'helper' }),
    ]
    expect(latestChangeIdForTarget(changes, 'helper')).toBe(3)
    expect(latestChangeIdForTarget(changes, 'other')).toBe(2)
    expect(latestChangeIdForTarget(changes, 'missing')).toBeNull()
  })

  it('labels the user and shows a name or instruction change', () => {
    expect(agentChangeActorLabel('user')).toBe('You')
    expect(agentChangeActorLabel('helper')).toBe('helper')
    expect(agentChangeDetail(change({}))).toBe('Helper -> Docs')
    expect(
      agentChangeDetail(
        change({
          before: { rolePrompt: 'Ship' },
          after: { rolePrompt: 'Ship carefully' },
        })
      )
    ).toBe('Instructions changed')
    expect(
      agentChangeDetail(change({ before: { name: 'Same' }, after: { name: 'Same' } }))
    ).toBeNull()
  })
})
