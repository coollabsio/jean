import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeCommand, ClaudeSkill } from '@/types/chat'
import type { BackendSkillsGroup } from '@/services/skills'

const useAllBackendSkillsMock = vi.hoisted(() =>
  vi.fn((): BackendSkillsGroup[] => [])
)

vi.mock('@/services/skills', () => ({
  useAllBackendSkills: () => useAllBackendSkillsMock(),
}))

vi.mock('@/components/ui/backend-label', () => ({
  getBackendLabel: (backend: string) => {
    if (backend === 'grok') return 'Grok'
    if (backend === 'codex') return 'Codex'
    if (backend === 'claude') return 'Claude'
    if (backend === 'antigravity') return 'Antigravity CLI'
    return backend
  },
}))

class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
Element.prototype.scrollIntoView = vi.fn()

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  onSelectSkill: vi.fn(),
  onSelectCommand: vi.fn(),
  searchQuery: 'goal',
  anchorPosition: { top: 0, left: 0 },
  isAtPromptStart: true,
}

const codexSkill: ClaudeSkill = {
  name: 'review',
  path: '/tmp/.agents/skills/review/SKILL.md',
  description: 'Review changes',
}

const claudeSkill: ClaudeSkill = {
  name: 'summarize',
  path: '/tmp/.claude/skills/summarize/SKILL.md',
  description: 'Summarize text',
}

const claudeCommand: ClaudeCommand = {
  name: 'deploy',
  path: '/tmp/.claude/commands/deploy.md',
  description: 'Deploy app',
}

describe('SlashPopover /goal built-in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAllBackendSkillsMock.mockReturnValue([])
  })

  it('shows /goal for Grok sessions', async () => {
    const { SlashPopover } = await import('./SlashPopover')

    render(<SlashPopover {...baseProps} sessionBackend="grok" />)

    expect(screen.getByText('/goal')).toBeInTheDocument()
    expect(screen.getByText('Grok Commands')).toBeInTheDocument()
  })

  it('does not show /goal for Antigravity sessions (Codex/Grok-native built-in)', async () => {
    const { SlashPopover } = await import('./SlashPopover')

    render(<SlashPopover {...baseProps} sessionBackend="antigravity" />)

    expect(screen.queryByText('/goal')).not.toBeInTheDocument()
  })
})

describe('SlashPopover triggerKind and skill prefixes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAllBackendSkillsMock.mockReturnValue([
      {
        backend: 'codex',
        label: 'Codex',
        skills: [codexSkill],
        commands: [],
      },
      {
        backend: 'claude',
        label: 'Claude',
        skills: [claudeSkill],
        commands: [claudeCommand],
      },
    ])
  })

  it('shows only Codex skills with $ prefix when triggerKind is skill', async () => {
    const { SlashPopover } = await import('./SlashPopover')

    render(
      <SlashPopover
        {...baseProps}
        searchQuery=""
        sessionBackend="codex"
        triggerKind="skill"
      />
    )

    expect(screen.getByText('$review')).toBeInTheDocument()
    expect(screen.queryByText('$summarize')).not.toBeInTheDocument()
    expect(screen.queryByText('/summarize')).not.toBeInTheDocument()
    expect(screen.queryByText('/goal')).not.toBeInTheDocument()
    expect(screen.queryByText('/deploy')).not.toBeInTheDocument()
  })

  it('shows only commands when triggerKind is command for Codex', async () => {
    const { SlashPopover } = await import('./SlashPopover')

    render(
      <SlashPopover
        {...baseProps}
        searchQuery=""
        sessionBackend="codex"
        triggerKind="command"
      />
    )

    expect(screen.getByText('/goal')).toBeInTheDocument()
    expect(screen.queryByText('$review')).not.toBeInTheDocument()
  })

  it('keeps / prefix for non-Codex skills in mixed mode', async () => {
    const { SlashPopover } = await import('./SlashPopover')

    render(
      <SlashPopover
        {...baseProps}
        searchQuery=""
        sessionBackend="claude"
        triggerKind="mixed"
      />
    )

    expect(screen.getByText('/summarize')).toBeInTheDocument()
    expect(screen.getByText('/deploy')).toBeInTheDocument()
    // Codex skills may still appear when installed, but use $
    expect(screen.getByText('$review')).toBeInTheDocument()
  })
})
