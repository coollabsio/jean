import { readFileSync } from 'node:fs'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSummary } from '@/services/agents'
import { useUIStore } from '@/store/ui-store'
import { AgentsTitleSync, resolveWindowTitle } from './window-title'

const mocks = vi.hoisted(() => ({
  agents: undefined as AgentSummary[] | undefined,
}))

vi.mock('@/components/agents/agents-feature', () => ({
  useAgentsEnabledServers: () => ['local'],
}))

vi.mock('@/services/agents', () => ({
  useAgentsList: () => ({ data: mocks.agents }),
}))

function agent(id: string, name: string): AgentSummary {
  return { id, name } as AgentSummary
}

describe('resolveWindowTitle', () => {
  const project = {
    showAgents: false,
    projectName: 'Jean App',
    worktreeName: 'feature',
    worktreeBranch: 'feature/title',
    isMobile: false,
  }

  it('uses the selected agent name on the Agents view', () => {
    expect(
      resolveWindowTitle({
        ...project,
        showAgents: true,
        agentName: 'Jean',
        isMobile: true,
      })
    ).toBe('Jean')
    expect(
      resolveWindowTitle({
        ...project,
        showAgents: true,
        agentName: 'Reviewer',
      })
    ).toBe('Reviewer')
  })

  it('falls back to Jean when the selected agent name is not loaded', () => {
    expect(
      resolveWindowTitle({
        showAgents: true,
        agentName: undefined,
        isMobile: true,
      })
    ).toBe('Jean')
    expect(
      resolveWindowTitle({
        showAgents: true,
        agentName: '   ',
        isMobile: false,
      })
    ).toBe('Jean')
  })

  it('keeps the project title off the Agents view', () => {
    expect(resolveWindowTitle({ ...project, isMobile: true })).toBe('Jean App')
    expect(resolveWindowTitle(project)).toBe(
      'Jean App › feature (feature/title)'
    )
    expect(
      resolveWindowTitle({
        ...project,
        worktreeBranch: 'feature',
      })
    ).toBe('Jean App › feature')
    expect(
      resolveWindowTitle({
        showAgents: false,
        isMobile: false,
      })
    ).toBe('Jean')
  })
})

describe('AgentsTitleSync', () => {
  beforeEach(() => {
    mocks.agents = undefined
    useUIStore.setState({ selectedAgentId: 'jean' })
  })

  it('reports the selected agent name', () => {
    mocks.agents = [agent('jean', 'Jean'), agent('reviewer', 'Reviewer')]
    useUIStore.setState({ selectedAgentId: 'reviewer' })
    const onName = vi.fn()

    render(<AgentsTitleSync onName={onName} />)

    expect(onName).toHaveBeenCalledWith('Reviewer')
  })

  it('reports nothing until the agent list has loaded', () => {
    const onName = vi.fn()

    render(<AgentsTitleSync onName={onName} />)

    expect(onName).toHaveBeenCalledWith(undefined)
  })
})

describe('MainWindow agents title wiring', () => {
  it('does not use a static Agents chrome title', () => {
    const source = readFileSync('src/components/layout/MainWindow.tsx', 'utf8')

    expect(source).not.toContain("return 'Agents'")
    expect(source).toContain('resolveWindowTitle')
    expect(source).toContain('hideTitle={!isMobile}')
    expect(source).toContain('<AgentsTitleSync')
  })
})
