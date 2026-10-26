import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { AgentTemplate } from '@/services/agents'
import { NewAgentDialog } from './NewAgentDialog'

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  create: vi.fn(),
  onCreated: vi.fn(),
  onOpenChange: vi.fn(),
}))

const support: AgentTemplate = {
  id: 'support-triage',
  name: 'Support triage',
  description: 'Triage the support inbox.',
  icon: 'blue',
  rolePrompt: 'You are the support triage agent. Jean MCP is on.',
  skillHints: ['github-issues'],
  schedules: [
    {
      name: 'Morning support sweep',
      prompt: 'Triage new issues.',
      kind: 'cron',
      cron: '0 9 * * 1-5',
      timezone: 'UTC',
    },
  ],
}

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('./AgentRunFields', () => ({
  AgentRunFields: () => <div>Run fields</div>,
}))

vi.mock('./agents-feature', () => ({
  useAgentsEnabledServers: () => ['local'],
}))

vi.mock('@/services/multi-server-sessions', () => ({
  useSessionServerSources: () => [
    { serverId: 'local', name: 'Local', online: true },
  ],
}))

vi.mock('@/services/agents', () => ({
  useCreateAgent: () => ({ mutate: mocks.create, isPending: false }),
  useAgentTemplates: () => ({
    data: [support],
    isLoading: false,
    error: null,
  }),
  useInstallAgentTemplate: () => ({
    mutate: (
      vars: { serverId: string; templateId: string },
      options?: { onSuccess?: (agent: { key: string; name: string }) => void }
    ) => {
      mocks.install(vars)
      options?.onSuccess?.({ key: 'support-triage', name: 'Support triage' })
    },
    isPending: false,
  }),
}))

describe('NewAgentDialog templates', () => {
  beforeEach(() => {
    mocks.install.mockClear()
    mocks.create.mockClear()
    mocks.onCreated.mockClear()
  })

  it('installs the selected template as a custom agent', async () => {
    const user = userEvent.setup()
    render(
      <NewAgentDialog
        open
        onOpenChange={mocks.onOpenChange}
        onCreated={mocks.onCreated}
      />
    )

    await user.click(screen.getByRole('tab', { name: 'From template' }))
    expect(
      screen.getByTestId('agent-template-support-triage')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Suggested skills: github-issues/)
    ).toBeInTheDocument()
    expect(screen.getByText(/0 9 \* \* 1-5 UTC/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Install template' }))
    expect(mocks.install).toHaveBeenCalledWith({
      serverId: 'local',
      templateId: 'support-triage',
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.onCreated).toHaveBeenCalledWith('support-triage')
  })
})
